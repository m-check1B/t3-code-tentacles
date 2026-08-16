import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  MAX_TRANSLATED_SET_MODEL_IDS,
  startDeepSeekAcpProxy,
  transformAgentToClientLine,
  transformClientToAgentLine,
} from "../src/deepseek-acp-launch.mjs";

test("transformClientToAgentLine rewrites set_model and remembers numeric and string ids", () => {
  const ids = new Map();
  const numeric = transformClientToAgentLine(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/set_model", params: { sessionId: "s1", modelId: "deepseek-v4-flash" } }),
    ids,
  );
  assert.deepEqual(JSON.parse(numeric), {
    jsonrpc: "2.0",
    id: 7,
    method: "session/set_config_option",
    params: { sessionId: "s1", configId: "model", value: "deepseek-v4-flash" },
  });
  assert.equal(ids.has("number:7"), true);
  const stringId = transformClientToAgentLine(
    JSON.stringify({ jsonrpc: "2.0", id: "mdl-2", method: "session/set_model", params: { sessionId: "s2", modelId: "deepseek-v4-pro" } }),
    ids,
  );
  assert.deepEqual(JSON.parse(stringId).params, { sessionId: "s2", configId: "model", value: "deepseek-v4-pro" });
  assert.equal(ids.has("string:mdl-2"), true);
});

test("transformClientToAgentLine passes through other methods, missing params, and invalid JSON verbatim", () => {
  const ids = new Map();
  const other = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1" } });
  assert.equal(transformClientToAgentLine(other, ids), other);
  const noParams = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/set_model" });
  assert.equal(transformClientToAgentLine(noParams, ids), noParams);
  assert.equal(transformClientToAgentLine("not json at all", ids), "not json at all");
  assert.equal(ids.size, 0);
});

test("transformClientToAgentLine normalizes mcpServers to [] on session creation requests", () => {
  const ids = new Map();
  const t3Injected = [{ type: "http", headers: [{ name: "Authorization", value: "Bearer x" }], name: "t3-code", url: "http://127.0.0.1:3773/mcp" }];
  for (const method of ["session/new", "session/load", "session/resume"]) {
    // The live T3 case: a populated array (its loopback t3-code server) is dropped.
    const populated = JSON.parse(transformClientToAgentLine(
      JSON.stringify({ jsonrpc: "2.0", id: `pop-${method}`, method, params: { cwd: "/repo", mcpServers: t3Injected } }),
      ids,
    ));
    assert.deepEqual(populated, { jsonrpc: "2.0", id: `pop-${method}`, method, params: { cwd: "/repo", mcpServers: [] } });

    const absent = JSON.parse(transformClientToAgentLine(
      JSON.stringify({ jsonrpc: "2.0", id: `abs-${method}`, method, params: { cwd: "/repo" } }),
      ids,
    ));
    assert.deepEqual(absent.params, { cwd: "/repo", mcpServers: [] });

    const nullValue = JSON.parse(transformClientToAgentLine(
      JSON.stringify({ jsonrpc: "2.0", id: `null-${method}`, method, params: { cwd: "/repo", mcpServers: null } }),
      ids,
    ));
    assert.deepEqual(nullValue.params, { cwd: "/repo", mcpServers: [] });

    const empty = JSON.parse(transformClientToAgentLine(
      JSON.stringify({ jsonrpc: "2.0", id: `empty-${method}`, method, params: { cwd: "/repo", mcpServers: [] } }),
      ids,
    ));
    assert.deepEqual(empty.params, { cwd: "/repo", mcpServers: [] });
  }
  // Other methods keep mcpServers verbatim, and the rule remembers no ids.
  const prompt = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "s1", mcpServers: t3Injected } });
  assert.equal(transformClientToAgentLine(prompt, ids), prompt);
  assert.equal(ids.size, 0);
});

test("transformClientToAgentLine bounds the id map by evicting the oldest entry", () => {
  const ids = new Map();
  for (let index = 0; index < MAX_TRANSLATED_SET_MODEL_IDS; index += 1) {
    transformClientToAgentLine(JSON.stringify({ id: index, method: "session/set_model", params: { sessionId: "s", modelId: "m" } }), ids);
  }
  assert.equal(ids.size, MAX_TRANSLATED_SET_MODEL_IDS);
  transformClientToAgentLine(JSON.stringify({ id: "overflow", method: "session/set_model", params: { sessionId: "s", modelId: "m" } }), ids);
  assert.equal(ids.size, MAX_TRANSLATED_SET_MODEL_IDS);
  assert.equal(ids.has("number:0"), false);
  assert.equal(ids.has("string:overflow"), true);
});

test("transformAgentToClientLine coerces boolean sessionCapabilities and leaves the rest untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: true, list: true, close: false, fork: { nested: true } },
      },
    },
  });
  const transformed = JSON.parse(transformAgentToClientLine(line, new Map()));
  assert.deepEqual(transformed.result.agentCapabilities.sessionCapabilities, {
    resume: {},
    list: {},
    close: null,
    fork: { nested: true },
  });
  assert.equal(transformed.result.agentCapabilities.loadSession, true);
  assert.equal(transformed.result.protocolVersion, 1);
});

test("transformAgentToClientLine passes through non-initialize, non-boolean, and invalid lines verbatim", () => {
  const ids = new Map();
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionCapabilities: { list: true } } });
  assert.equal(transformAgentToClientLine(notification, ids), notification);
  const alreadyObjects = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { agentCapabilities: { sessionCapabilities: { list: {} } } } });
  assert.equal(transformAgentToClientLine(alreadyObjects, ids), alreadyObjects);
  const plainResponse = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });
  assert.equal(transformAgentToClientLine(plainResponse, ids), plainResponse);
  assert.equal(transformAgentToClientLine("garbage", ids), "garbage");
});

test("transformAgentToClientLine replaces translated set_model results with {} and forgets the id", () => {
  const ids = new Map();
  transformClientToAgentLine(JSON.stringify({ id: 9, method: "session/set_model", params: { sessionId: "s1", modelId: "m" } }), ids);
  const response = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { configOptions: [{ id: "model" }] } });
  assert.deepEqual(JSON.parse(transformAgentToClientLine(response, ids)), { jsonrpc: "2.0", id: 9, result: {} });
  assert.equal(ids.size, 0);
  // A second response with the same id is no longer translated.
  assert.equal(transformAgentToClientLine(response, ids), response);
});

test("transformAgentToClientLine passes translated error responses through verbatim and forgets the id", () => {
  const ids = new Map();
  transformClientToAgentLine(JSON.stringify({ id: "e1", method: "session/set_model", params: { sessionId: "s1", modelId: "m" } }), ids);
  const error = JSON.stringify({ jsonrpc: "2.0", id: "e1", error: { code: -32602, message: "bad model" } });
  assert.equal(transformAgentToClientLine(error, ids), error);
  assert.equal(ids.size, 0);
});

test("the proxy coerces initialize capabilities and shapes set_model responses end to end", async () => {
  const fakeAgent = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true, list: true, close: false } } } }) + "\\n");
  } else if (msg.method === "session/set_config_option") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: "model", currentValue: msg.params?.value }] } }) + "\\n");
  } else if (msg.method === "session/new") {
    const mcpServers = msg.params?.mcpServers;
    if (!Array.isArray(mcpServers) || mcpServers.length > 0) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params: mcpServers is not supported" } }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } }) + "\\n");
    }
  } else if (msg.method === "session/set_model") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = startDeepSeekAcpProxy({
    plan: { binary: process.execPath, args: ["--input-type=module", "-e", fakeAgent], env: { ...process.env } },
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
      return JSON.parse(lines[count - 1]);
    };
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    const initialize = await nextLine(1);
    assert.deepEqual(initialize.result.agentCapabilities.sessionCapabilities, { resume: {}, list: {}, close: null });
    assert.equal(initialize.result.agentCapabilities.loadSession, true);
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "sel-1", method: "session/set_model", params: { sessionId: "s1", modelId: "deepseek-v4-flash" } }) + "\n");
    const setModel = await nextLine(2);
    assert.deepEqual(setModel, { jsonrpc: "2.0", id: "sel-1", result: {} });
    // The fake child mirrors dsh-acp's contract: mcpServers must be present
    // as an array with zero entries. T3's injected loopback MCP server (a
    // populated array) must be normalized away so session creation succeeds.
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "new-1", method: "session/new", params: { cwd: "/repo", mcpServers: [{ type: "http", headers: [{ name: "Authorization", value: "Bearer t3" }], name: "t3-code", url: "http://127.0.0.1:3773/mcp" }] } }) + "\n");
    const sessionNew = await nextLine(3);
    assert.deepEqual(sessionNew, { jsonrpc: "2.0", id: "new-1", result: { sessionId: "s1" } });
    // An absent key is normalized to [] as well.
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "new-2", method: "session/new", params: { cwd: "/repo" } }) + "\n");
    const sessionNewAbsent = await nextLine(4);
    assert.deepEqual(sessionNewAbsent, { jsonrpc: "2.0", id: "new-2", result: { sessionId: "s1" } });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
