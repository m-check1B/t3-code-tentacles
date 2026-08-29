import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildKimiLaunchPlan,
  KIMI_MODEL_MISMATCH,
  resolveKimiBinary,
  startKimiAcpProxy,
  transformClientToAgentLine,
} from "../src/kimi-acp-launch.mjs";

test("buildKimiLaunchPlan injects OpenRouter without putting the token in argv", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-kimi-openrouter-"));
  const tokenFile = path.join(directory, "openrouter.token");
  fs.writeFileSync(tokenFile, "sk-openrouter-test-material", { mode: 0o600 });
  const plan = buildKimiLaunchPlan({
    env: {
      KIMI_BIN: process.execPath,
      KIMI_MODEL: "anthropic/claude-3-haiku",
      OPENROUTER_TOKEN_FILE: tokenFile,
      PATH: "",
    },
  });
  assert.equal(plan.binary, process.execPath);
  assert.equal(plan.env.KIMI_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(plan.env.KIMI_API_KEY, "sk-openrouter-test-material");
  assert.equal(plan.env.KIMI_MODEL_NAME, "anthropic/claude-3-haiku");
  assert.equal(Object.hasOwn(plan, "args"), false);
  assert.equal(plan.binary.includes("sk-openrouter-test-material"), false);
});

test("buildKimiLaunchPlan fails closed when the OpenRouter token is absent", () => {
  assert.throws(
    () => buildKimiLaunchPlan({ env: { KIMI_BIN: process.execPath, OPENROUTER_TOKEN_FILE: "/definitely/missing/openrouter.token" } }),
    /OpenRouter API token file is missing/,
  );
});

test("transformClientToAgentLine intercepts authenticate with a synthesized success response", () => {
  const numeric = transformClientToAgentLine(
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "authenticate", params: { methodId: "cached_token" } }),
  );
  assert.deepEqual(numeric, { respond: { jsonrpc: "2.0", id: 3, result: {} } });
  const stringId = transformClientToAgentLine(
    JSON.stringify({ jsonrpc: "2.0", id: "auth-1", method: "authenticate", params: { methodId: "cached_token" } }),
  );
  assert.deepEqual(stringId, { respond: { jsonrpc: "2.0", id: "auth-1", result: {} } });
  // An authenticate notification (no id) is dropped, not answered.
  assert.deepEqual(
    transformClientToAgentLine(JSON.stringify({ jsonrpc: "2.0", method: "authenticate", params: { methodId: "cached_token" } })),
    { drop: true },
  );
});

test("transformClientToAgentLine passes non-authenticate messages and invalid JSON through verbatim", () => {
  const sessionNew = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/repo", mcpServers: [{ name: "t3-code" }] } });
  assert.deepEqual(transformClientToAgentLine(sessionNew), { line: sessionNew });
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
  assert.deepEqual(transformClientToAgentLine(initialize), { line: initialize });
  assert.deepEqual(transformClientToAgentLine("definitely not json"), { line: "definitely not json" });
});

test("transformClientToAgentLine acknowledges only the environment-selected Kimi model", () => {
  const configuredModel = "anthropic/claude-3-haiku";
  const selected = transformClientToAgentLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "model-1",
    method: "session/set_model",
    params: { sessionId: "s1", modelId: configuredModel },
  }), { configuredModel });
  assert.deepEqual(selected, { respond: { jsonrpc: "2.0", id: "model-1", result: {} } });

  const mismatch = transformClientToAgentLine(JSON.stringify({
    jsonrpc: "2.0",
    id: "model-2",
    method: "session/set_model",
    params: { sessionId: "s1", modelId: "moonshotai/kimi-k3" },
  }), { configuredModel });
  assert.equal(mismatch.respond.error.data.code, KIMI_MODEL_MISMATCH);
  assert.equal(mismatch.respond.error.message.includes(configuredModel), false);

  const notification = transformClientToAgentLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/set_model",
    params: { sessionId: "s1", modelId: configuredModel },
  }), { configuredModel });
  assert.deepEqual(notification, { drop: true });
});

test("resolveKimiBinary rejects relative KIMI_BIN and fails loud when kimi is missing", () => {
  assert.throws(() => resolveKimiBinary({ KIMI_BIN: "kimi" }), /absolute path/);
  assert.throws(() => resolveKimiBinary({ PATH: "" }), /kimi executable not found on PATH/);
  assert.equal(resolveKimiBinary({ KIMI_BIN: process.execPath }), process.execPath);
});

test("resolveKimiBinary rejects an explicit KIMI_BIN that is not executable, like the deepseek resolver", () => {
  // Same gate as resolveDshAcpBinary: an explicit override must pass X_OK or
  // fail loud instead of surfacing a confusing spawn error later.
  const file = path.join(os.tmpdir(), `kimi-bin-${process.pid}-${Date.now()}`);
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, 0o600);
  try {
    assert.throws(() => resolveKimiBinary({ KIMI_BIN: file }), (error) => error.code === "EACCES");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("the proxy answers authenticate itself and forwards everything else untouched", async () => {
  // The fake child mirrors real kimi: it validates authenticate strictly and
  // hard-errors on the unknown cached_token method.
  const fakeKimi = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true, sse: true } } } }) + "\\n");
  } else if (msg.method === "authenticate") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params: Unknown auth method: cached_token" } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "k1", echo: msg.params } }) + "\\n");
  } else if (msg.method === "debug/raw") {
    process.stdout.write("RAW-NONJSON-LINE\\n");
  }
});
setInterval(() => {}, 1000);
`;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = startKimiAcpProxy({
    kimiBin: process.execPath,
    spawnImpl: (binary, args, options) => {
      assert.equal(binary, process.execPath);
      assert.deepEqual(args, ["acp"]);
      return spawn(binary, ["--input-type=module", "-e", fakeKimi], options);
    },
    stdin,
    stdout,
    exitImpl: () => {},
  });
  try {
    const lines = [];
    let pending = "";
    stdout.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const split = pending.split("\n");
      pending = split.pop();
      lines.push(...split.filter(Boolean));
    });
    const nextLine = async (count) => {
      while (lines.length < count) await new Promise((resolve) => setTimeout(resolve, 10));
      return lines[count - 1];
    };
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
    const initialize = JSON.parse(await nextLine(1));
    assert.deepEqual(initialize.result.agentCapabilities.mcpCapabilities, { http: true, sse: true });
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "cached_token" } }) + "\n");
    const authenticate = JSON.parse(await nextLine(2));
    // The shim answered; the child's strict -32602 error never appears.
    assert.deepEqual(authenticate, { jsonrpc: "2.0", id: 2, result: {} });
    const t3Params = { cwd: "/repo", mcpServers: [{ type: "http", headers: [{ name: "Authorization", value: "Bearer t3" }], name: "t3-code", url: "http://127.0.0.1:3773/mcp" }] };
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: t3Params }) + "\n");
    const sessionNew = JSON.parse(await nextLine(3));
    assert.deepEqual(sessionNew.result.echo, t3Params);
    // Invalid JSON flows through both directions verbatim.
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "debug/raw", params: {} }) + "\n");
    assert.equal(await nextLine(4), "RAW-NONJSON-LINE");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
