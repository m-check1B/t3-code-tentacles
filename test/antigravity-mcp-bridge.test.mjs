import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAntigravityMcpBridge,
  MAX_TURN_FILE_BYTES,
  NOT_ACTIVE_ERROR_CODE,
  NOT_ACTIVE_ERROR_MESSAGE,
  readActiveServer,
} from "../src/antigravity-mcp-bridge.mjs";
import { ANTIGRAVITY_BRIDGE_PATH, writePrivate } from "../src/bot-connectors.mjs";

function writeTurnFile(file, servers) {
  writePrivate(file, `${JSON.stringify({ servers }, null, 2)}\n`);
}

function startMockMcpServer({ stateful = false } = {}) {
  const seen = [];
  let sessionCounter = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const msg = JSON.parse(bodyText);
    const auth = req.headers.authorization ?? null;
    const reqSessionId = req.headers["mcp-session-id"] ?? null;
    seen.push({ method: msg.method, id: msg.id, auth, sessionId: reqSessionId, contentType: req.headers["content-type"] });

    if (msg.method === "initialize") {
      const headers = { "Content-Type": "application/json" };
      if (stateful) {
        sessionCounter += 1;
        headers["Mcp-Session-Id"] = `sess-${sessionCounter}`;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-jack", version: "1.0.0" },
        },
      }));
      return;
    }

    if (msg.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    if (msg.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            { name: "ping_jack", description: "Ping mock Jack MCP", inputSchema: { type: "object", properties: {} } },
            { name: "ping_sse", description: "Ping via SSE", inputSchema: { type: "object", properties: {} } },
          ],
        },
      }));
      return;
    }

    if (msg.method === "tools/call" && msg.params?.name === "ping_sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": keepalive comment\n\n");
      res.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progress: 1, total: 1 },
      })}\n\n`);
      res.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `SSE_OK:${auth}:${reqSessionId ?? "none"}` }],
        },
      })}\n\n`);
      res.end();
      return;
    }

    if (msg.method === "tools/call" && msg.params?.name === "empty_200") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("");
      return;
    }

    if (msg.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `PONG:${auth}:${reqSessionId ?? "none"}` }],
        },
      }));
      return;
    }

    if (msg.method === "server/discover") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not supported");
      return;
    }

    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("boom");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        seen,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("antigravity-mcp-bridge forwards initialize, 202 notification, tools/list, JSON + SSE tools/call, and live token rotation over stdio", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-bridge-stdio-"));
  const turnFile = path.join(dir, ".jack-antigravity-servers.json");
  const mock = await startMockMcpServer({ stateful: false });
  t.after(async () => {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  writeTurnFile(turnFile, {
    jack: { url: mock.url, headers: { Authorization: "Bearer secret-turn-1" } },
  });

  const child = spawn(process.execPath, [ANTIGRAVITY_BRIDGE_PATH, turnFile, "jack"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TENTACLES_BRIDGE_ALLOW_LOOPBACK_HTTP: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const responses = [];
  let stdoutBuf = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      responses.push(JSON.parse(line));
      while (waiters.length && responses.length >= waiters[0].count) {
        waiters.shift().resolve();
      }
    }
  });
  const waitForCount = (count) => new Promise((resolve, reject) => {
    if (responses.length >= count) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} responses (got ${responses.length})`)), 5_000);
    waiters.push({ count, resolve: () => { clearTimeout(timer); resolve(); } });
  });

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

  // 1. initialize
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  await waitForCount(1);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, "mock-jack");

  // 2. notifications/initialized (HTTP 202 -> emits nothing) + tools/list
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await waitForCount(2);
  assert.equal(responses[1].id, 2);
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ["ping_jack", "ping_sse"]);

  // 3. tools/call JSON on Turn 1 token
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping_jack", arguments: {} } });
  await waitForCount(3);
  assert.equal(responses[2].id, 3);
  assert.equal(responses[2].result.content[0].text, "PONG:Bearer secret-turn-1:none");

  // 4. Rotate token in turnFile WITHOUT restarting bridge!
  writeTurnFile(turnFile, {
    jack: { url: mock.url, headers: { Authorization: "Bearer secret-turn-2" } },
  });

  // 5. tools/call SSE uses NEW token!
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ping_sse", arguments: {} } });
  await waitForCount(5);
  assert.equal(responses[3].method, "notifications/progress");
  assert.equal(responses[4].id, 4);
  assert.equal(responses[4].result.content[0].text, "SSE_OK:Bearer secret-turn-2:none");

  // 6. Non-200 / server/discover returns clean JSON-RPC error with matching id (never hangs or leaks token).
  send({ jsonrpc: "2.0", id: 5, method: "server/discover", params: {} });
  await waitForCount(6);
  assert.equal(responses[5].id, 5);
  assert.equal(responses[5].error.code, -32000);
  assert.match(responses[5].error.message, /HTTP 404/);
  assert.equal(JSON.stringify(responses[5]).includes("secret-turn-"), false);

  // 7. Empty HTTP 200 on request returns -32000 error; non-object JSON returns -32600 Invalid Request.
  send({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "empty_200", arguments: {} } });
  await waitForCount(7);
  assert.equal(responses[6].id, 50);
  assert.equal(responses[6].error.code, -32000);
  child.stdin.write("[]\n");
  await waitForCount(8);
  assert.deepEqual(responses[7], { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });

  // 8. Empty servers returns -32001 for requests with id and emits nothing for notifications.
  writeTurnFile(turnFile, {});
  send({ jsonrpc: "2.0", method: "notifications/cancelled" });
  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ping_jack", arguments: {} } });
  await waitForCount(9);
  assert.deepEqual(responses[8], {
    jsonrpc: "2.0",
    id: 6,
    error: { code: NOT_ACTIVE_ERROR_CODE, message: NOT_ACTIVE_ERROR_MESSAGE },
  });

  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0);
  assert.equal(stderr.includes("secret-turn-"), false);
  assert.equal(stderr, "");
});

test("antigravity-mcp-bridge preserves Mcp-Session-Id and resets/re-handshakes cleanly when token rotates on stateful servers", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-bridge-stateful-"));
  const turnFile = path.join(dir, ".jack-antigravity-servers.json");
  const mock = await startMockMcpServer({ stateful: true });
  t.after(async () => {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  writeTurnFile(turnFile, {
    jack: { url: mock.url, headers: { Authorization: "Bearer stateful-token-1" } },
  });

  const out = [];
  const bridge = createAntigravityMcpBridge({
    turnServersPath: turnFile,
    serverName: "jack",
    allowLoopbackHttp: true,
    writeLine: (line) => out.push(JSON.parse(line)),
  });

  await bridge.handleLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ag", version: "1" } },
  }));
  assert.equal(bridge.getSessionId(), "sess-1");

  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping_jack", arguments: {} } }));
  assert.equal(out.at(-1).result.content[0].text, "PONG:Bearer stateful-token-1:sess-1");

  // Rotate token: bridge resets sess-1, re-handshakes to get sess-2, and calls tool with new token + sess-2!
  writeTurnFile(turnFile, {
    jack: { url: mock.url, headers: { Authorization: "Bearer stateful-token-2" } },
  });
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping_jack", arguments: {} } }));
  assert.equal(bridge.getSessionId(), "sess-2");
  assert.equal(out.at(-1).result.content[0].text, "PONG:Bearer stateful-token-2:sess-2");

  // When server becomes inactive (!active), sessionId is cleared so stale state never survives.
  writeTurnFile(turnFile, {});
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ping_jack", arguments: {} } }));
  assert.equal(bridge.getSessionId(), null);
  assert.equal(out.at(-1).error.code, NOT_ACTIVE_ERROR_CODE);
});

test("B3 P1-4: concurrent stdin calls serialize token-rotation re-handshake and slow Turn-1 responses never clobber Turn-2 Mcp-Session-Id", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-bridge-race-"));
  const turnFile = path.join(dir, ".jack-antigravity-servers.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeTurnFile(turnFile, {
    jack: { url: "https://jack.example/mcp", headers: { Authorization: "Bearer race-token-1" } },
  });

  let releaseSlowTurn1;
  const slowTurn1Started = new Promise((resolve) => { /* resolved below */ });
  let markSlowStarted;
  const slowStartedPromise = new Promise((resolve) => { markSlowStarted = resolve; });
  let reinitCount = 0;

  const fetchImpl = async (_url, init) => {
    const auth = init.headers.get("authorization");
    const msg = JSON.parse(init.body);
    if (msg.method === "initialize") {
      const sess = auth === "Bearer race-token-1" ? "sess-turn-1" : "sess-turn-2";
      if (auth === "Bearer race-token-2") reinitCount += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": sess },
      });
    }
    if (msg.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (msg.id === 10) {
      // Slow in-flight call on Turn 1 that returns late with stale Mcp-Session-Id!
      markSlowStarted();
      await new Promise((resolve) => { releaseSlowTurn1 = resolve; });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 10, result: { turn: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-turn-1-stale" },
      });
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { auth, sessionId: init.headers.get("mcp-session-id") },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-turn-2" },
    });
  };

  const out = [];
  const bridge = createAntigravityMcpBridge({
    turnServersPath: turnFile,
    serverName: "jack",
    fetchImpl,
    writeLine: (line) => out.push(JSON.parse(line)),
  });

  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  assert.equal(bridge.getSessionId(), "sess-turn-1");

  // Start slow Turn 1 call
  const slowCall = bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "slow" } }));
  await slowStartedPromise;

  // Rotate to Turn 2 while Turn 1 is still in flight, and fire TWO concurrent Turn 2 calls!
  writeTurnFile(turnFile, {
    jack: { url: "https://jack.example/mcp", headers: { Authorization: "Bearer race-token-2" } },
  });
  const [c1, c2] = [
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "a" } })),
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "b" } })),
  ];
  await Promise.all([c1, c2]);
  assert.equal(reinitCount, 1, "Concurrent Turn-2 calls must trigger exactly one single-flight re-handshake");
  assert.equal(bridge.getSessionId(), "sess-turn-2");

  // Now let the slow Turn 1 response finish with stale Mcp-Session-Id: it MUST NOT clobber sess-turn-2!
  releaseSlowTurn1();
  await slowCall;
  assert.equal(bridge.getSessionId(), "sess-turn-2");
  const r11 = out.find((m) => m.id === 11);
  const r12 = out.find((m) => m.id === 12);
  assert.deepEqual(r11.result, { auth: "Bearer race-token-2", sessionId: "sess-turn-2" });
  assert.deepEqual(r12.result, { auth: "Bearer race-token-2", sessionId: "sess-turn-2" });
  void slowTurn1Started;
});

test("B3 P2-2/P2-3/P3-1: bridge enforces https-only by default, RFC 9110 headers, case-insensitive header precedence, and response size cap", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-bridge-hardening-"));
  const file = path.join(dir, ".jack-antigravity-servers.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // P3-1: loopback HTTP is rejected by default (without allowLoopbackHttp / env opt-in).
  const prevEnv = process.env.TENTACLES_BRIDGE_ALLOW_LOOPBACK_HTTP;
  delete process.env.TENTACLES_BRIDGE_ALLOW_LOOPBACK_HTTP;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.TENTACLES_BRIDGE_ALLOW_LOOPBACK_HTTP;
    else process.env.TENTACLES_BRIDGE_ALLOW_LOOPBACK_HTTP = prevEnv;
  });
  writeTurnFile(file, { jack: { url: "http://127.0.0.1:9999/mcp", headers: { Authorization: "Bearer x" } } });
  assert.equal(readActiveServer(file, "jack"), null);
  assert.ok(readActiveServer(file, "jack", { allowLoopbackHttp: true }));

  // P2-2: invalid RFC 9110 header name or control char in value is refused.
  writeTurnFile(file, { jack: { url: "https://jack.example/mcp", headers: { "Bad Header": "x" } } });
  assert.equal(readActiveServer(file, "jack"), null);
  writeTurnFile(file, { jack: { url: "https://jack.example/mcp", headers: { Authorization: "Bearer ok\u0007bell" } } });
  assert.equal(readActiveServer(file, "jack"), null);

  // P2-2: bridge-owned Content-Type, Accept, Mcp-Session-Id always win case-insensitively.
  writeTurnFile(file, {
    jack: {
      url: "https://jack.example/mcp",
      headers: {
        authorization: "Bearer ok-token",
        "content-type": "text/plain",
        accept: "text/plain",
        "mcp-session-id": "spoofed-session",
      },
    },
  });
  let seenHeaders = null;
  const out = [];
  const bridge = createAntigravityMcpBridge({
    turnServersPath: file,
    serverName: "jack",
    maxResponseBytes: 64,
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      const msg = JSON.parse(init.body);
      if (msg.id === 2) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { pad: "x".repeat(200) } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    writeLine: (line) => out.push(JSON.parse(line)),
  });
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.equal(seenHeaders.get("content-type"), "application/json");
  assert.equal(seenHeaders.get("accept"), "application/json, text/event-stream");
  assert.equal(seenHeaders.get("mcp-session-id"), null);
  assert.equal(seenHeaders.get("authorization"), "Bearer ok-token");

  // P2-3: response exceeding maxResponseBytes returns clean JSON-RPC error -32000.
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "big" } }));
  assert.equal(out.at(-1).id, 2);
  assert.equal(out.at(-1).error.code, -32000);
});

test("antigravity-mcp-bridge enforces custody on turnServersPath (missing, symlink, loose mode, wrong uid, oversized, invalid serverName) without leaking tokens", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-bridge-custody-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, ".jack-antigravity-servers.json");
  const secretToken = "Bearer ultra-secret-custody-token";

  // Missing file -> null
  assert.equal(readActiveServer(file, "jack"), null);

  // Valid 0600 file -> passes
  writeTurnFile(file, { jack: { url: "https://jack.example/mcp", headers: { Authorization: secretToken } } });
  assert.deepEqual(readActiveServer(file, "jack"), {
    url: "https://jack.example/mcp",
    headers: { Authorization: secretToken },
  });

  // Wrong UID -> null (POSIX)
  if (typeof process.getuid === "function") {
    assert.equal(readActiveServer(file, "jack", { uid: process.getuid() + 1 }), null);
  }

  // Group/world-readable mode -> null (POSIX)
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o644);
    assert.equal(readActiveServer(file, "jack"), null);
    fs.chmodSync(file, 0o640);
    assert.equal(readActiveServer(file, "jack"), null);
    fs.chmodSync(file, 0o600);
  }

  // Symlink -> refused
  const link = path.join(dir, "link.json");
  fs.symlinkSync(file, link);
  assert.equal(readActiveServer(link, "jack"), null);

  // Oversized (> 256 KiB) -> refused
  const big = path.join(dir, "big.json");
  fs.writeFileSync(big, JSON.stringify({ servers: { jack: { url: "https://jack.example/mcp", pad: "x".repeat(MAX_TURN_FILE_BYTES + 100) } } }), { mode: 0o600 });
  assert.equal(readActiveServer(big, "jack"), null);

  // Plaintext non-loopback HTTP -> refused even if allowLoopbackHttp is true
  const badUrl = path.join(dir, "bad-url.json");
  writeTurnFile(badUrl, { jack: { url: "http://evil.example/mcp", headers: { Authorization: secretToken } } });
  assert.equal(readActiveServer(badUrl, "jack", { allowLoopbackHttp: true }), null);

  // Invalid serverName -> rejected
  assert.equal(readActiveServer(file, "../evil"), null);
  assert.throws(() => createAntigravityMcpBridge({ turnServersPath: file, serverName: "bad name", writeLine: () => {} }), /Invalid MCP server name/);

  // Bridge refuses symlink and returns -32001 with zero token leak
  const out = [];
  const bridge = createAntigravityMcpBridge({ turnServersPath: link, serverName: "jack", writeLine: (line) => out.push(line) });
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }));
  assert.equal(out.length, 1);
  assert.equal(out[0].includes(secretToken), false);
  assert.deepEqual(JSON.parse(out[0]), {
    jsonrpc: "2.0",
    id: 9,
    error: { code: NOT_ACTIVE_ERROR_CODE, message: NOT_ACTIVE_ERROR_MESSAGE },
  });

  // Invalid CLI serverName exits non-zero cleanly
  const badChild = spawn(process.execPath, [ANTIGRAVITY_BRIDGE_PATH, file, "../bad"], { stdio: ["ignore", "pipe", "pipe"] });
  const badCode = await new Promise((resolve) => badChild.once("exit", resolve));
  assert.equal(badCode, 2);
});
