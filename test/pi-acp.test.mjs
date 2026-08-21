import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setImmediate as defer } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  authenticateResponse,
  consumeJsonLines,
  forwardLine,
  isAuthenticateRequest,
  MAX_ACP_ID_BYTES,
  requestKey,
  transformLegacySessionState,
  transformPiResponse,
} from "../src/pi-acp.mjs";
import {
  installPiProvider,
  installProvider,
  providerHarness,
  removePiProvider,
} from "../src/bridge.mjs";

function fakePi(directory, source) {
  const executable = path.join(directory, "fake-pi");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  return executable;
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
}

test("Pi ACP transforms legacy session state and intercepts local authentication", () => {
  const legacy = {
    models: [{ id: "gpt-5.6-terra", name: "Terra", provider: "openai-codex", extra: "ignored" }],
    modes: [{ slug: "default", name: "Default", description: "Normal", extra: "ignored" }],
    extra: "preserved",
  };
  assert.deepEqual(transformLegacySessionState(legacy), {
    models: { currentModelId: "gpt-5.6-terra", availableModels: [{ modelId: "gpt-5.6-terra", name: "Terra" }] },
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default", description: "Normal" }] },
    extra: "preserved",
  });
  assert.equal(
    transformLegacySessionState(legacy, { currentModelId: "gpt-5.6-sol" }).models.currentModelId,
    "gpt-5.6-sol",
  );
  assert.deepEqual(
    transformLegacySessionState({
      models: [
        { id: "gpt-5.6-terra", name: "Terra", provider: "openai-codex" },
        { id: "foreign-model", name: "Foreign", provider: "other-provider" },
      ],
    }, { currentModelId: "foreign-model", providerId: "openai-codex" }).models,
    {
      currentModelId: "gpt-5.6-terra",
      availableModels: [{ modelId: "gpt-5.6-terra", name: "Terra" }],
    },
  );
  const authentication = { jsonrpc: "2.0", id: 7, method: "authenticate", params: { token: "never-forwarded" } };
  assert.equal(isAuthenticateRequest(authentication), true);
  assert.deepEqual(authenticateResponse(authentication), { jsonrpc: "2.0", id: 7, result: {} });
});

test("Pi ACP normalizes only successful model switches and session responses", () => {
  assert.deepEqual(
    transformPiResponse({ jsonrpc: "2.0", id: "set", result: { model: { id: "gpt-5.6-terra" } } }, "session/set_model"),
    { jsonrpc: "2.0", id: "set", result: {} },
  );
  const failure = { jsonrpc: "2.0", id: "set", error: { code: -1, message: "unchanged" } };
  assert.equal(transformPiResponse(failure, "session/set_model"), failure);
  assert.deepEqual(
    transformPiResponse({ jsonrpc: "2.0", id: 1, result: { models: [{ id: "bare", name: "Bare" }] } }, "session/load").result.models,
    { currentModelId: "bare", availableModels: [{ modelId: "bare", name: "Bare" }] },
  );
});

test("Pi proxy suppresses authenticate and relays transformed session and bare model selection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-acp-"));
  const pi = fakePi(directory, `
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const index = input.indexOf("\\n");
    if (index < 0) return;
    const line = input.slice(0, index); input = input.slice(index + 1);
    const message = JSON.parse(line);
    if (message.method === "authenticate") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "FORWARDED" }) + "\\n");
    if (message.method === "session/new") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { models: [{ id: "gpt-5.6-terra", name: "Terra", provider: "openai-codex" }, { id: "foreign-model", name: "Foreign", provider: "other-provider" }], modes: [{ slug: "default", name: "Default", description: "Normal" }] } }) + "\\n");
    if (message.method === "session/set_model") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { selected: message.params.modelId, extra: true } }) + "\\n"); process.exit(0); }
  }
});`);
  const proxy = spawn(process.execPath, [path.resolve("src/pi-acp.mjs")], { env: { ...process.env, PI_BIN: pi, PI_PROVIDER: "openai-codex" }, stdio: ["pipe", "pipe", "pipe"] });
  const output = collect(proxy);
  proxy.stdin.end([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "authenticate", params: { token: "secret" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { modelId: "gpt-5.6-terra" } }),
  ].join("\n") + "\n");
  const { stdout } = await output;
  const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(JSON.stringify(messages).includes("FORWARDED"), false);
  assert.deepEqual(messages[1].result.models, { currentModelId: "gpt-5.6-terra", availableModels: [{ modelId: "gpt-5.6-terra", name: "Terra" }] });
  assert.deepEqual(messages[2], { jsonrpc: "2.0", id: 3, result: {} });
});

test("Pi-originated request IDs cannot consume T3 request correlation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-collision-"));
  const pi = fakePi(directory, `
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const newline = input.indexOf("\\n");
  if (newline < 0) return;
  const message = JSON.parse(input.slice(0, newline));
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "session/request_permission", params: { reason: "same id, opposite direction" } }) + "\\n");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { models: [{ id: "gpt-5.6-terra", name: "Terra" }] } }) + "\\n");
  process.exit(0);
});`);
  const proxy = spawn(process.execPath, [path.resolve("src/pi-acp.mjs")], {
    env: { ...process.env, PI_BIN: pi },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = collect(proxy);
  proxy.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })}\n`);
  const messages = (await output).stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages[0].method, "session/request_permission");
  assert.deepEqual(messages[1].result.models, {
    currentModelId: "gpt-5.6-terra",
    availableModels: [{ modelId: "gpt-5.6-terra", name: "Terra" }],
  });
});

test("JSON-lines relay pauses for downstream backpressure and bounds buffered bytes", async () => {
  class GatedWritable extends Writable {
    constructor() {
      super({ highWaterMark: 1 });
      this.chunks = [];
      this.releases = [];
    }

    _write(chunk, _encoding, callback) {
      this.chunks.push(chunk.toString("utf8"));
      this.releases.push(callback);
    }

    release() {
      this.releases.shift()?.();
    }
  }

  const source = new PassThrough();
  const target = new GatedWritable();
  let overflowed = false;
  consumeJsonLines(source, (line) => forwardLine(target, line), () => { overflowed = true; }, 128, 256);
  source.end("first\nsecond\n");
  await defer();
  assert.equal(source.isPaused(), true);
  assert.deepEqual(target.chunks, ["first\n"]);
  target.release();
  await defer();
  assert.deepEqual(target.chunks, ["first\n", "second\n"]);
  target.release();
  await defer();
  assert.equal(overflowed, false);

  const overflowing = new PassThrough();
  consumeJsonLines(overflowing, () => true, () => { overflowed = true; }, 128, 8);
  overflowing.write("123456789");
  await defer();
  assert.equal(overflowed, true);
});

test("Pi proxy rejects oversized correlation IDs", () => {
  assert.equal(requestKey("bounded"), "string:bounded");
  assert.equal(requestKey("x".repeat(MAX_ACP_ID_BYTES + 1)), null);
  assert.equal(requestKey({ invalid: true }), null);
});

test("SIGTERM closes an open relay and terminates the Pi process group", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-shutdown-"));
  const pi = fakePi(directory, `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready", params: { grandchildPid: grandchild.pid } }) + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const proxy = spawn(process.execPath, [path.resolve("src/pi-acp.mjs")], {
    env: { ...process.env, PI_BIN: pi },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const [chunk] = await once(proxy.stdout, "data");
  const ready = JSON.parse(chunk.toString("utf8").trim());
  const grandchildPid = ready.params.grandchildPid;
  proxy.kill("SIGTERM");
  const exited = await Promise.race([
    once(proxy, "exit").then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => setTimeout(() => resolve(null), 1_500)),
  ]);
  if (!exited) proxy.kill("SIGKILL");
  assert.ok(exited, "wrapper must exit after SIGTERM while stdin remains open");
  assert.equal(exited.code, 0);
  let grandchildAlive = true;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(grandchildPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error.code === "ESRCH") {
        grandchildAlive = false;
        break;
      }
      throw error;
    }
  }
  assert.equal(grandchildAlive, false);
});

test("Pi proxy exits when Pi closes cleanly while T3 stdin remains open", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-clean-exit-"));
  const pi = fakePi(directory, "process.exit(0);");
  const proxy = spawn(process.execPath, [path.resolve("src/pi-acp.mjs")], {
    env: { ...process.env, PI_BIN: pi },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = await Promise.race([
    once(proxy, "exit").then(([code, signal]) => ({ code, signal })),
    new Promise((resolve) => setTimeout(() => resolve(null), 1_000)),
  ]);
  if (!exited) proxy.kill("SIGKILL");
  assert.ok(exited, "wrapper must close its ACP transport after Pi exits");
  assert.equal(exited.code, 0);
  assert.equal(exited.signal, null);
});

test("Pi wrapper delegates version, ignores T3 driver argv, and supplies configured Pi defaults", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-wrapper-"));
  const pi = fakePi(directory, `
if (process.argv[2] === "--version") { process.stdout.write("pi fake 1.0\\n"); process.exit(0); }
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n"); process.exit(0);`);
  const version = spawnSync("sh", [path.resolve("bin/t3-pi-acp"), "--version"], { env: { ...process.env, PI_BIN: pi }, encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, "pi fake 1.0\n");
  const wrapper = spawn("sh", [path.resolve("bin/t3-pi-acp"), "agent", "stdio"], {
    env: { ...process.env, PI_BIN: pi, PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-terra" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { stdout } = await collect(wrapper);
  assert.deepEqual(JSON.parse(stdout), {
    argv: ["--acp", "--provider", "openai-codex", "--model", "gpt-5.6-terra"],
  });
});

test("Pi providers coexist with Hermes and refuse foreign or cross-harness ownership", async () => {
  let patch;
  const hermes = {
    driver: "grok",
    environment: [{ name: "T3_HERMES_BRIDGE_OWNER", value: "t3-hermes-bridge/v1", sensitive: false }],
  };
  const client = {
    getSettings: async () => ({ providerInstances: { hermes, foreign: { driver: "codex" } } }),
    updateSettings: async (value) => { patch = value; },
    refreshProvider: async (instanceId) => ({ provider: { instanceId } }),
  };
  await installPiProvider(client, { wrapperPath: "/opt/t3-pi-acp", piBin: "/opt/pi", model: "gpt-5.6-terra" });
  assert.equal(providerHarness(patch.providerInstances.hermes), "hermes");
  assert.equal(patch.providerInstances.pi.displayName, "Pi");
  assert.deepEqual(patch.providerInstances.pi.config.customModels, ["gpt-5.6-terra"]);
  assert.equal(patch.providerInstances.pi.environment.find((entry) => entry.name === "PI_MODEL").value, "gpt-5.6-terra");
  await assert.rejects(installProvider({ getSettings: async () => ({ providerInstances: { pi: patch.providerInstances.pi } }) }, { wrapperPath: "/opt/hermes", instanceId: "pi" }), /Hermes harness/);
  await assert.rejects(removePiProvider({ getSettings: async () => ({ providerInstances: { pi: hermes } }) }), /Pi harness/);
  await assert.rejects(installPiProvider({ getSettings: async () => ({ providerInstances: { pi: { driver: "grok", environment: [] } } }) }, { wrapperPath: "/opt/t3-pi-acp", piBin: "/opt/pi" }), /Pi harness/);
  await assert.rejects(installPiProvider(client, { wrapperPath: "relative", piBin: "/opt/pi" }), /absolute ACP wrapper path/);
  await assert.rejects(installPiProvider(client, { wrapperPath: "/opt/t3-pi-acp", piBin: "relative-pi" }), /absolute Pi executable path/);
});

test("CLI help documents Pi provider commands", () => {
  const result = spawnSync(process.execPath, [path.resolve("src/cli.mjs"), "help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Tentacles — T3 Code tentacles — originate any ready lab/m);
  assert.match(result.stdout, /Hermes was the first tentacle/);
  assert.match(result.stdout, /install-pi-provider \[--instance pi\] \[--model gpt-5\.6-terra\] \[--pi-provider openai-codex\]/);
  assert.match(result.stdout, /remove-pi-provider \[--instance pi\]/);
  assert.match(result.stdout, /tentacles command is an exact alias of t3-agent-bridge/);
  assert.match(result.stdout, /legacy t3-hermes command remains an exact compatibility alias/);
});
