#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { continueThread, doctor, originate } from "../src/bridge.mjs";
import { DEFAULT_OPENROUTER_TOKEN_FILE, DEFAULT_TOKEN_FILE } from "../src/config.mjs";
import { ORIGINATE_LABS } from "../src/model-selection.mjs";
import { servicePaths } from "../src/service.mjs";
import { T3Client } from "../src/t3-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.TENTACLES_E2E_TIMEOUT_MS || 600_000);
const pollMs = 1_000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function fileAttestation(file, { content = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    const result = {
      present: true,
      regular: stat.isFile(),
      symlink: stat.isSymbolicLink(),
      mode: stat.mode & 0o777,
      size: stat.size,
      uid: stat.uid,
    };
    if (content && stat.isFile()) result.content = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return result;
  } catch (error) {
    if (error.code === "ENOENT") return { present: false };
    return { present: true, readable: false };
  }
}

async function runtimeAttestation(client) {
  const settings = await client.getSettings();
  let service = {};
  try {
    const paths = servicePaths({ profile: "default", instance: "hermes" });
    service = {
      definition: fileAttestation(paths.plist || paths.unit, { content: true }),
      config: fileAttestation(paths.config, { content: true }),
    };
  } catch {
    service = { supported: false };
  }
  return {
    providerInstances: digest(settings.providerInstances || {}),
    t3Token: fileAttestation(process.env.T3_HERMES_TOKEN_FILE || DEFAULT_TOKEN_FILE),
    openrouterToken: fileAttestation(process.env.OPENROUTER_TOKEN_FILE || DEFAULT_OPENROUTER_TOKEN_FILE),
    service,
  };
}

function safeVersion(command) {
  try {
    const output = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    const line = output.split(/\r?\n/, 1)[0].trim();
    const unsafe = line.includes(os.homedir())
      || /(?:authorization|bearer|token|secret|api.?key)\s*[:=]/i.test(line)
      || /(?:file|https?):\/\//i.test(line);
    return !unsafe && /^[^\u0000-\u001f\u007f]{1,160}$/.test(line) ? line : "unavailable";
  } catch {
    return "unavailable";
  }
}

function gitOutput(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function deployedAdapterCommit(binaryPath) {
  if (typeof binaryPath !== "string") return "not-applicable";
  try {
    return gitOutput(["rev-parse", "HEAD"], path.dirname(binaryPath));
  } catch {
    return "unavailable";
  }
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return textOf(value.content);
}

function assistantMessages(thread) {
  return (Array.isArray(thread?.messages) ? thread.messages : [])
    .filter((message) => message?.role === "assistant")
    .map((message) => textOf(message))
    .filter((text) => text.trim().length > 0);
}

function identityResult(thread, lab, model) {
  const selection = thread?.modelSelection || {};
  const session = thread?.session || {};
  return {
    instance: selection.instanceId === lab,
    model: selection.model === model,
    provider: session.providerInstanceId === lab,
    runtimeMode: (session.runtimeMode || thread?.runtimeMode) === "full-access",
    terminal: ["ready", "stopped"].includes(session.status),
    noError: session.status !== "error" && !session.lastError,
  };
}

async function waitForAssistant(client, threadId, { baselineCount, marker, lab, model }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await client.thread(threadId);
    const thread = detail?.thread;
    const messages = assistantMessages(thread);
    const identity = identityResult(thread, lab, model);
    if (!identity.noError) return { passed: false, code: "session_error", identity };
    if (messages.length > baselineCount && messages.slice(baselineCount).some((text) => text.includes(marker)) && identity.terminal) {
      return { passed: Object.values(identity).every(Boolean), code: null, identity, assistantCount: messages.length };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { passed: false, code: "assistant_timeout", identity: null };
}

function failureCode(error) {
  if (error?.code === "ENOENT") return "executable_unavailable";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  return "e2e_error";
}

async function main() {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 1_800_000) {
    throw new Error("TENTACLES_E2E_TIMEOUT_MS must be between 30000 and 1800000");
  }
  const candidateSha = gitOutput(["rev-parse", "HEAD"]);
  const clean = gitOutput(["status", "--porcelain"]) === "";
  const client = new T3Client();
  const before = await runtimeAttestation(client);
  const settings = await client.getSettings();
  const matrix = await doctor(client);
  const byId = new Map(matrix.labs.map((lab) => [lab.instanceId, lab]));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-e2e-"));
  const stateFile = path.join(workspace, "origination-state.json");
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const results = [];

  for (const lab of ORIGINATE_LABS) {
    const row = byId.get(lab);
    const model = row?.defaultModel || row?.models?.[0] || null;
    const providerPath = settings.providerInstances?.[lab]?.config?.binaryPath;
    const result = {
      lab,
      model,
      doctorReady: row?.ready === true,
      deployedAdapterCommit: deployedAdapterCommit(providerPath),
      originateAssistant: false,
      continueAssistant: false,
      identity: false,
      threadCreated: false,
      verdict: "pending",
      code: null,
    };
    if (!row || !model) {
      result.verdict = "blocked";
      result.code = row?.code || "doctor_model_unavailable";
      process.stderr.write(`e2e ${lab}: blocked ${result.code}\n`);
      results.push(result);
      continue;
    }
    process.stderr.write(`e2e ${lab}: start${row.ready ? "" : ` (doctor ${row.code || "not_ready"})`}\n`);
    try {
      const markerOne = `TENTACLES_${runId}_${lab}_ONE`;
      const originated = await originate(client, {
        workspace,
        title: `Tentacles e2e ${lab} ${runId}`,
        message: `Reply with exactly ${markerOne} and nothing else.`,
        instanceId: lab,
        model,
        runtimeMode: "full-access",
        idempotencyKey: `${runId}:${lab}:originate`,
        stateFile,
      });
      result.threadCreated = true;
      const first = await waitForAssistant(client, originated.threadId, { baselineCount: 0, marker: markerOne, lab, model });
      result.originateAssistant = first.passed;
      if (!first.passed) {
        result.verdict = "failed";
        result.code = first.code;
        results.push(result);
        process.stderr.write(`e2e ${lab}: failed ${result.code}\n`);
        continue;
      }
      const markerTwo = `TENTACLES_${runId}_${lab}_TWO`;
      await continueThread(client, {
        threadId: originated.threadId,
        message: `Reply with exactly ${markerTwo} and nothing else.`,
        runtimeMode: "full-access",
      });
      const second = await waitForAssistant(client, originated.threadId, {
        baselineCount: first.assistantCount,
        marker: markerTwo,
        lab,
        model,
      });
      result.continueAssistant = second.passed;
      result.identity = Boolean(first.identity && second.identity
        && Object.values(first.identity).every(Boolean)
        && Object.values(second.identity).every(Boolean));
      result.verdict = result.originateAssistant && result.continueAssistant && result.identity ? "passed" : "failed";
      result.code = result.verdict === "passed" ? null : second.code || "identity_mismatch";
    } catch (error) {
      result.verdict = "failed";
      result.code = failureCode(error);
    }
    results.push(result);
    process.stderr.write(`e2e ${lab}: ${result.verdict}${result.code ? ` ${result.code}` : ""}\n`);
  }

  const after = await runtimeAttestation(client);
  const runtimeUnchanged = {
    providerInstances: before.providerInstances === after.providerInstances,
    t3Token: digest(before.t3Token) === digest(after.t3Token),
    openrouterToken: digest(before.openrouterToken) === digest(after.openrouterToken),
    service: digest(before.service) === digest(after.service),
  };
  const report = {
    schemaVersion: 1,
    product: "Tentacles",
    candidateSha,
    clean,
    generatedAt: new Date().toISOString(),
    platform: { os: os.platform(), release: os.release(), arch: os.arch() },
    versions: {
      node: process.version,
      t3: matrix.t3?.version || "unavailable",
      hermes: safeVersion("hermes"),
      pi: safeVersion("pi"),
      kimi: safeVersion("kimi"),
      dshAcp: safeVersion("dsh-acp"),
      codex: safeVersion("codex"),
      claude: safeVersion("claude"),
      grok: safeVersion("grok"),
      opencode: safeVersion("opencode"),
      cursor: safeVersion("cursor"),
    },
    advertisedLabs: [...ORIGINATE_LABS],
    results,
    runtimeUnchanged,
    syntheticProjectsCreated: 1,
    syntheticThreadsCreated: results.filter((result) => result.threadCreated).length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const passed = clean
    && results.length === ORIGINATE_LABS.length
    && results.every((result) => result.verdict === "passed")
    && Object.values(runtimeUnchanged).every(Boolean);
  if (!passed) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("tentacles e2e: failed before a public-safe receipt could be produced\n");
  process.exitCode = 1;
});
