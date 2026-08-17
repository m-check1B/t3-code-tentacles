import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutable } from "./config.mjs";
import {
  consumeJsonLines,
  forwardLine,
  MAX_ACP_LINE_BYTES,
  MAX_PENDING_ACP_REQUESTS,
  requestKey,
} from "./pi-acp.mjs";

export const DEFAULT_LAUNCH_DEEPSEEK_MODEL = "deepseek-v4-flash";
export const DEFAULT_DSH_PERMISSION_MODE = "workspace-write";
export const BRIDGE_DSH_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "dsh-acp.cordis.yml");
export const MAX_TRANSLATED_SET_MODEL_IDS = MAX_PENDING_ACP_REQUESTS;

const SHUTDOWN_GRACE_MS = 1_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function openCodeAuthFile(home = os.homedir()) {
  return path.join(home, ".local", "share", "opencode", "auth.json");
}

// Reads the DeepSeek key from the OpenCode auth store. Error messages name the
// file and JSON path only; key material is never included, even partially.
export function readDeepSeekApiKey(authFile = openCodeAuthFile()) {
  let raw;
  try {
    raw = fs.readFileSync(authFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`DeepSeek API key not found: ${authFile} is missing; log in through the OpenCode CLI so .deepseek.key exists`);
    }
    throw new Error(`DeepSeek API key unreadable: ${authFile} (${error.code || error.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek API key unreadable: ${authFile} is not valid JSON`);
  }
  const key = parsed?.deepseek?.key;
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`DeepSeek API key missing: ${authFile} has no non-empty .deepseek.key entry`);
  }
  return key;
}

export function resolveDshAcpBinary(env = process.env) {
  const configured = env.DSH_ACP_BIN;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("DSH_ACP_BIN must be an absolute path to the dsh-acp executable");
    fs.accessSync(configured, fs.constants.X_OK);
    return configured;
  }
  try {
    return resolveExecutable("dsh-acp", env.PATH || "");
  } catch {
    throw new Error("dsh-acp executable not found on PATH; install it with `npm i -g dsh-acp` or set DSH_ACP_BIN to an absolute path");
  }
}

// dsh-acp honors exactly four environment variables (lib/bin.js --help output:
// DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DSH_PERMISSION_MODE, DSH_SESSIONS_ROOT).
// It has no model env var; the model is set through the bridge-owned Cordis
// config passed via --config, which reads DEEPSEEK_MODEL itself.
//
// The default sessions root is per working directory: dsh-acp's session store
// is a SQLite database that does not tolerate concurrent processes, and every
// spawned dsh-acp sharing one root makes parallel T3 threads fail at
// session/prompt. T3 spawns the provider with the thread's workspace as cwd,
// so keying the store on a digest of the cwd keeps sessions resumable per
// workspace while isolating concurrent lanes in different directories. An
// explicit DSH_SESSIONS_ROOT override replaces the default entirely; such an
// override must be unique per concurrent lane.
export function workspaceSessionsSlug(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function buildLaunchPlan({ env = process.env, home = os.homedir(), configPath = BRIDGE_DSH_CONFIG_PATH, cwd = process.cwd() } = {}) {
  const apiKey = readDeepSeekApiKey(openCodeAuthFile(home));
  const binary = resolveDshAcpBinary(env);
  const sessionsRoot = env.DSH_SESSIONS_ROOT || path.join(home, ".dsh", "acp-sessions", workspaceSessionsSlug(cwd));
  fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sessionsRoot, 0o700);
  return {
    binary,
    args: ["--config", configPath],
    env: {
      ...env,
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_MODEL: env.DEEPSEEK_MODEL || DEFAULT_LAUNCH_DEEPSEEK_MODEL,
      DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE || DEFAULT_DSH_PERMISSION_MODE,
      DSH_SESSIONS_ROOT: sessionsRoot,
    },
  };
}

function parseJsonObject(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  return message;
}

function isResponseMessage(message) {
  return !Object.hasOwn(message, "method")
    && Object.hasOwn(message, "id")
    && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}

// dsh-acp@0.1.9 tool-call relay defects repaired here (both verified on the
// live wire, T3 threads 5cbcbba9 and afc93148, and tee capture
// /tmp/acp2-out.log):
//
// 1. tool_call_update LACKS the required toolCallId field: the relay reads
//    the id from `message?.callId || resultData?.callId || resultData?.id`
//    (lib/bin.js tool/result handler), but DeepSeek Harness tool results
//    carry it at `message.source.callId`, so every tool result produces an
//    update without an id.
// 2. tool_call/tool_call_update content arrays hold BARE ContentBlocks
//    ({type:"text",...}) while T3's ToolCallContent schema only accepts
//    wrapped variants ({type:"content", content:...}, diff, terminal).
//
// T3's effect-acp client schema-validates every session/update notification
// and treats one undecodable frame as a fatal transport error (protocol.ts
// handleRequestEncoded -> handleTermination -> ClientProtocolError): the ACP
// connection is terminated and the in-flight session/prompt fails with
// "ACP transport operation call-rpc failed for method session/prompt" —
// even though the harness keeps running. Live capture (2026-08-16, T3 thread
// 5cbcbba9): the first tool result was relayed at 14:39:27.985 and the prompt
// RPC failed at 14:39:27.987; thread afc93148: the tool_call_update frame
// (776B) arrived at 15:06:37.699 and session/prompt failed at 15:06:37.700.
//
// The harness embeds the call id inside the tool-result payload dsh-acp
// forwards as rawOutput/content text: {"type":"tool-result","toolCallId":
// "call_..."}. Recovery order: extract it from that payload, then fall back
// to the most recently announced tool_call id for the session. A tool_call
// (in_progress) update always carries the id, so the fallback is exact for
// the sequential-tool case and only approximates out-of-order parallel
// results, which is strictly better than letting T3 kill the session.
export const TOOL_CALL_UPDATE_SESSION_CAP = 16;

// T3's ToolCallContent schema (t3code packages/effect-acp/src/_generated/
// schema.gen.ts, ToolCallContent union) only accepts WRAPPED variants:
// {type:"content", content: ContentBlock}, {type:"diff",...},
// {type:"terminal",...}. dsh-acp@0.1.9 emits bare ContentBlocks instead —
// content:[{type:"text",text:"..."}] — which match no union variant, so a
// tool_call/tool_call_update notification carrying them fails schema decode.
// T3's effect-acp client treats one undecodable session/update as a fatal
// transport error (protocol.ts handleRequestEncoded -> handleTermination ->
// ClientProtocolError), failing the in-flight session/prompt. Live capture
// (2026-08-16, T3 thread afc93148): the tool_call_update frame (776B) arrived
// at 15:06:37.699Z and session/prompt failed at 15:06:37.700Z; the identical
// frames are in the tee capture /tmp/acp2-out.log lines 44-45. Only bare
// ContentBlock shapes are wrapped; already-wrapped content/diff/terminal
// items pass through untouched.
const BARE_CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource_link", "resource"]);

function normalizeToolCallContent(content) {
  if (!Array.isArray(content) || content.length === 0) return null;
  let changed = false;
  const normalized = content.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    if (typeof item.type !== "string" || !BARE_CONTENT_BLOCK_TYPES.has(item.type)) return item;
    changed = true;
    return { type: "content", content: item };
  });
  return changed ? normalized : null;
}

function recoverToolCallIdFromPayload(payload) {
  if (typeof payload === "string") {
    const match = /"toolCallId"\s*:\s*"([^"]+)"/.exec(payload);
    return match ? match[1] : undefined;
  }
  if (Array.isArray(payload)) {
    for (const block of payload) {
      if (block && typeof block.text === "string") {
        const match = /"toolCallId"\s*:\s*"([^"]+)"/.exec(block.text);
        if (match) return match[1];
      }
    }
  }
  return undefined;
}

function transformToolCallUpdate(message, toolCallState) {
  const update = message.params?.update;
  if (!update || typeof update !== "object" || Array.isArray(update)) return null;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
  const next = { ...update };
  let changed = false;
  if (update.sessionUpdate === "tool_call") {
    if (typeof update.toolCallId === "string" && update.toolCallId.length > 0) {
      const key = String(message.params.sessionId);
      if (!toolCallState.has(key) && toolCallState.size >= TOOL_CALL_UPDATE_SESSION_CAP) {
        toolCallState.delete(toolCallState.keys().next().value);
      }
      toolCallState.set(key, update.toolCallId);
    }
  } else if (typeof update.toolCallId !== "string" || update.toolCallId.length === 0) {
    const recovered =
      recoverToolCallIdFromPayload(update.rawOutput)
      ?? recoverToolCallIdFromPayload(update.content)
      ?? toolCallState.get(String(message.params.sessionId));
    if (typeof recovered === "string" && recovered.length > 0) {
      next.toolCallId = recovered;
      changed = true;
    }
  }
  const normalized = normalizeToolCallContent(update.content);
  if (normalized) {
    next.content = normalized;
    changed = true;
  }
  if (!changed) return null;
  return JSON.stringify({
    ...message,
    params: { ...message.params, update: next },
  });
}

function rememberTranslatedId(translatedIds, id) {
  const key = requestKey(id);
  if (!key) return;
  if (!translatedIds.has(key) && translatedIds.size >= MAX_TRANSLATED_SET_MODEL_IDS) {
    translatedIds.delete(translatedIds.keys().next().value);
  }
  translatedIds.set(key, true);
}

// Ground truth from a live T3 frame: T3's grok driver always injects its own
// loopback MCP server into session creation
// (mcpServers: [{ name: "t3-code", url: "http://127.0.0.1:3773/mcp", ... }]),
// while dsh-acp rejects any non-empty array ("Invalid params: mcpServers is
// not supported") AND rejects a missing key ("expected array, received
// undefined"). The contract is therefore: the key must be present as an
// array, but only zero entries are supported. The DeepSeek harness has its
// own fs/bash/todo tools and cannot consume MCP servers at all, so session
// creation params are always normalized to mcpServers: [] — deepseek sessions
// intentionally lose T3's built-in MCP tools (Hermes and Kimi accept MCP
// natively and never pass through this proxy).
const MCP_NORMALIZING_METHODS = new Set(["session/new", "session/load", "session/resume"]);

/**
 * Client→agent: rewrite T3's unstable `session/set_model` into the
 * `session/set_config_option` (configId "model") request dsh-acp implements.
 * The JSON-RPC id is remembered in translatedIds (bounded, oldest evicted) so
 * the response can be shaped back to T3's expected SetSessionModelResponse.
 * Independently, normalize `mcpServers` to [] on session/new, session/load,
 * and session/resume params (see above). Returns the line to forward;
 * anything unrecognized passes through verbatim.
 */
export function transformClientToAgentLine(line, translatedIds = new Map()) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  const message = parseJsonObject(text);
  if (!message || typeof message.method !== "string") return text;
  if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) return text;
  if (message.method === "session/set_model") {
    if (Object.hasOwn(message, "id") && message.id !== null && message.id !== undefined) {
      rememberTranslatedId(translatedIds, message.id);
    }
    return JSON.stringify({
      ...message,
      method: "session/set_config_option",
      params: { sessionId: message.params.sessionId, configId: "model", value: message.params.modelId },
    });
  }
  if (MCP_NORMALIZING_METHODS.has(message.method)) {
    return JSON.stringify({ ...message, params: { ...message.params, mcpServers: [] } });
  }
  return text;
}

/**
 * Agent→client: coerce dsh-acp's boolean ACP sessionCapabilities into the
 * object|null shape T3's schema expects, shape translated set_model
 * responses back to `{}`, and repair tool_call_update notifications that
 * dsh-acp emits without the required toolCallId (see
 * transformToolCallUpdate). Returns the line to forward; anything
 * unrecognized passes through verbatim.
 */
export function transformAgentToClientLine(line, translatedIds = new Map(), toolCallState = new Map()) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  const message = parseJsonObject(text);
  if (!message || !isResponseMessage(message)) {
    const repaired = message?.method === "session/update" ? transformToolCallUpdate(message, toolCallState) : null;
    return repaired ?? text;
  }
  const key = requestKey(message.id);
  if (key && translatedIds.has(key)) {
    translatedIds.delete(key);
    if (Object.hasOwn(message, "error")) return text;
    return JSON.stringify({ ...message, result: {} });
  }
  const capabilities = message.result?.agentCapabilities?.sessionCapabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return text;
  let changed = false;
  const coerced = {};
  for (const [name, value] of Object.entries(capabilities)) {
    if (value === true) {
      coerced[name] = {};
      changed = true;
    } else if (value === false) {
      coerced[name] = null;
      changed = true;
    } else {
      coerced[name] = value;
    }
  }
  if (!changed) return text;
  return JSON.stringify({
    ...message,
    result: {
      ...message.result,
      agentCapabilities: { ...message.result.agentCapabilities, sessionCapabilities: coerced },
    },
  });
}

/**
 * Run the T3-to-dsh-acp ACP compatibility proxy. It deliberately has no
 * payload logging: ACP messages may contain prompts or authentication
 * material, and the DeepSeek API key travels only through the child
 * environment, never argv or stdout.
 */
export function startDeepSeekAcpProxy({
  plan,
  spawnImpl = spawn,
  stdin = process.stdin,
  stdout = process.stdout,
  maxLineBytes = MAX_ACP_LINE_BYTES,
  exitImpl = defaultExit,
} = {}) {
  const resolvedPlan = plan || buildLaunchPlan();
  const child = spawnImpl(resolvedPlan.binary, resolvedPlan.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: resolvedPlan.env,
    detached: process.platform !== "win32",
  });
  const translatedIds = new Map();
  const toolCallState = new Map();
  let stopping = false;
  let forceKillTimer;
  let stdinRelay;
  let stdoutRelay;

  const signalChildTree = (signal) => {
    if (!Number.isInteger(child.pid)) {
      try { child.kill(signal); } catch {}
      return;
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (error?.code === "ESRCH") return;
      }
    }
    try { child.kill(signal); } catch {}
  };

  const stopRelays = () => {
    stdinRelay?.stop();
    stdoutRelay?.stop();
    stdin.pause?.();
    translatedIds.clear();
    try { child.stdin.destroy(); } catch {}
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopRelays();
    signalChildTree("SIGTERM");
    forceKillTimer = setTimeout(() => signalChildTree("SIGKILL"), SHUTDOWN_GRACE_MS);
    forceKillTimer.unref();
  };

  const forwardSignal = (signal) => signalChildTree(signal);
  const forwarders = new Map(FORWARDED_SIGNALS.map((signal) => {
    const forwarder = () => forwardSignal(signal);
    return [signal, forwarder];
  }));
  const removeForwarders = () => {
    for (const [signal, forwarder] of forwarders) process.removeListener(signal, forwarder);
  };

  stdinRelay = consumeJsonLines(stdin, (line) => {
    const transformed = transformClientToAgentLine(line, translatedIds);
    return forwardLine(child.stdin, transformed);
  }, stop, maxLineBytes);
  stdin.once("end", () => {
    try { child.stdin.end(); } catch {}
  });

  stdoutRelay = consumeJsonLines(child.stdout, (line) => {
    const transformed = transformAgentToClientLine(line, translatedIds, toolCallState);
    return forwardLine(stdout, transformed);
  }, stop, maxLineBytes);

  child.stdin.on("error", () => stop());
  stdout.on?.("error", () => stop());
  child.once("error", (error) => {
    console.error(`t3-deepseek-acp: failed to start ${resolvedPlan.binary}: ${error.message}`);
    stop();
  });
  child.once("exit", (code, signal) => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    stopRelays();
    removeForwarders();
    if (signal && exitImpl === defaultExit) {
      process.kill(process.pid, signal);
      return;
    }
    exitImpl(code ?? 1);
  });
  for (const [signal, forwarder] of forwarders) process.on(signal, forwarder);
  return child;
}

function defaultExit(code) {
  process.exit(code);
}

export function main() {
  let plan;
  try {
    plan = buildLaunchPlan();
  } catch (error) {
    console.error(`t3-deepseek-acp: ${error.message}`);
    process.exit(1);
  }
  startDeepSeekAcpProxy({ plan });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
