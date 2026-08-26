import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  grokChildEnvironment,
  startGrokAcpProxy,
} from "../src/grok-acp-launch.mjs";

test("Grok child environment forces cached OIDC and removes inherited API keys", () => {
  const env = grokChildEnvironment({
    PATH: "/synthetic/bin",
    XAI_API_KEY: "synthetic-stale-key",
    GROK_OAUTH2_REFERRER: "t3-code",
  });
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, "true");
  assert.equal(env.GROK_OAUTH2_REFERRER, "t3-code");
  assert.equal(env.PATH, "/synthetic/bin");
});

test("Grok proxy intercepts T3 authentication and starts agent stdio", async () => {
  const fakeGrok = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (message.method === "authenticate") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } }) + "\\n");
  } else if (message.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-session" } }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = startGrokAcpProxy({
    grokBin: process.execPath,
    env: { ...process.env, XAI_API_KEY: "synthetic-stale-key" },
    spawnImpl: (binary, args, options) => {
      assert.equal(binary, process.execPath);
      assert.deepEqual(args, ["agent", "stdio"]);
      assert.equal(options.env.XAI_API_KEY, undefined);
      assert.equal(options.env.GROK_DISABLE_API_KEY_AUTH, "true");
      return spawn(binary, ["--input-type=module", "-e", fakeGrok], options);
    },
    stdin,
    stdout,
    exitImpl: () => {},
  });
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
  try {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
    assert.equal((await nextLine(1)).result.protocolVersion, 1);
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "cached_token" } }) + "\n");
    assert.deepEqual(await nextLine(2), { jsonrpc: "2.0", id: 2, result: {} });
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "/repo", mcpServers: [] } }) + "\n");
    assert.equal((await nextLine(3)).result.sessionId, "grok-session");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
