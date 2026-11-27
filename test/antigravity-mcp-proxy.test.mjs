import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import {
  AntigravityMcpProxy,
  createAntigravityMcpProxy,
} from "../src/antigravity-mcp-proxy.mjs";

function listenServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        url: `http://127.0.0.1:${address.port}/mcp`,
        close: () => new Promise((done) => {
          try { server.closeAllConnections?.(); } catch {}
          server.close(() => done());
        }),
      });
    });
  });
}

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function rawHttpRequest({ port, method = "POST", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test("proxy binds loopback 127.0.0.1, coalesces concurrent ensureStarted, and validates server configs strictly", async (t) => {
  const proxy = createAntigravityMcpProxy();
  assert.ok(proxy instanceof AntigravityMcpProxy);
  t.after(() => proxy.close());

  // Cannot register servers before starting.
  assert.throws(() => proxy.setWorkspaceServers("/tmp/ws", []), /not started/);
  assert.equal(proxy.entryFor("/tmp/ws", "jack"), null);

  // Concurrent ensureStarted() calls share a single bind and port.
  const [a, b] = await Promise.all([proxy.ensureStarted(), proxy.ensureStarted()]);
  assert.equal(a.port, b.port);
  assert.ok(Number.isInteger(a.port) && a.port > 0);
  assert.equal(proxy.port, a.port);

  // Default allowLoopbackHttp === false rejects http:// URLs (even loopback).
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "http://127.0.0.1:9999/mcp", headers: [] }]),
    /Disallowed MCP server URL/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "http://example.com/mcp", headers: [] }]),
    /Disallowed MCP server URL/,
  );
  // Rejects embedded credentials, bad server names, duplicate names, invalid headers, CRLF, >16KiB headers.
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "https://user:pass@jack.example/mcp", headers: [] }]),
    /Disallowed MCP server URL/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "../bad", url: "https://jack.example/mcp", headers: [] }]),
    /Invalid MCP server name/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [
      { name: "jack", url: "https://jack.example/mcp", headers: [] },
      { name: "jack", url: "https://jack.example/mcp", headers: [] },
    ]),
    /Duplicate MCP server name/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "https://jack.example/mcp", headers: { "Bad Header": "v" } }]),
    /Invalid MCP server headers/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "https://jack.example/mcp", headers: { Authorization: "Bearer a\r\nX-Injected: 1" } }]),
    /Invalid MCP server headers/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "https://jack.example/mcp", headers: { Authorization: `Bearer ${"a".repeat(16 * 1024)}` } }]),
    /Invalid MCP server headers/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "https://jack.example/mcp", headers: { Host: "spoof.example" } }]),
    /Invalid MCP server headers/,
  );
  // P3-3: non-ByteString header values (> 0xff) must be rejected at registration time.
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "https://jack.example/mcp", headers: { Authorization: "Bearer \u0100bad" } }]),
    /Invalid MCP server headers/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("/tmp/ws", [{ name: "jack", url: "https://jack.example/mcp", headers: { Authorization: "Bearer token-🚀" } }]),
    /Invalid MCP server headers/,
  );
  assert.throws(
    () => proxy.setWorkspaceServers("", []),
    /Invalid workspace/,
  );

  // Valid HTTPS server registration returns loopback URL + Bearer secret.
  const entries = proxy.setWorkspaceServers("/tmp/ws", [
    { name: "jack", url: "https://jack.example/mcp", headers: [{ name: "Authorization", value: "Bearer up-1" }] },
  ]);
  assert.match(entries.jack.serverUrl, new RegExp(`^http://127\\.0\\.0\\.1:${a.port}/mcp/[A-Za-z0-9_-]{16,128}$`));
  assert.match(entries.jack.headers.Authorization, /^Bearer [A-Za-z0-9_-]{32,}$/);
  assert.deepEqual(proxy.entryFor("/tmp/ws", "jack"), entries.jack);
  assert.deepEqual(proxy.entryFor("/tmp/ws/", "jack"), entries.jack);
  assert.equal(proxy.entryFor("/tmp/ws", "other"), null);
});

test("proxy enforces Host, Origin, path, constant-time Bearer auth, methods, JSON validation, DELETE, 413, 429, 502, redirect:error, and zero secret leaks", async (t) => {
  let upstreamMode = "ok";
  let releaseSlow = null;
  const UPSTREAM_SECRET = "SUPER_SECRET_UPSTREAM_TOKEN_987654";

  const upstream = await listenServer(async (req, res) => {
    await readHttpBody(req);
    if (upstreamMode === "redirect") {
      res.writeHead(302, { Location: `http://127.0.0.1:${upstream.port}/leaked?token=${UPSTREAM_SECRET}` });
      res.end();
      return;
    }
    if (upstreamMode === "oversized") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data: `${UPSTREAM_SECRET}${"x".repeat(4096)}` } }));
      return;
    }
    if (upstreamMode === "error500") {
      res.writeHead(500, { "Content-Type": "text/plain", "X-Debug-Token": UPSTREAM_SECRET });
      res.end(`Internal error at https://internal.secret/mcp with ${UPSTREAM_SECRET}`);
      return;
    }
    if (upstreamMode === "slow") {
      await new Promise((resolve) => { releaseSlow = resolve; });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "upstream-sid-secret-1" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }));
  });
  t.after(() => upstream.close());

  const proxy = createAntigravityMcpProxy({
    allowLoopbackHttp: true,
    maxRequestBytes: 512,
    maxResponseBytes: 1024,
    maxInFlight: 1,
    timeoutMs: 5_000,
  });
  t.after(() => proxy.close());
  const { port } = await proxy.ensureStarted();
  const { jack } = proxy.setWorkspaceServers("/tmp/ws-sec", [
    { name: "jack", url: upstream.url, headers: { Authorization: `Bearer ${UPSTREAM_SECRET}` } },
  ]);
  const routePath = new URL(jack.serverUrl).pathname;
  const auth = jack.headers.Authorization;

  // 1. Host header DNS-rebinding rejection (403).
  for (const badHost of [`evil.example:${port}`, `localhost:${port}`, "127.0.0.1:99999"]) {
    const res = await rawHttpRequest({
      port,
      method: "POST",
      path: routePath,
      headers: { Host: badHost, Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(res.status, 403, `expected 403 for Host: ${badHost}`);
  }

  // 2. Origin header CSRF rejection (403).
  const csrf = await rawHttpRequest({
    port,
    method: "POST",
    path: routePath,
    headers: { Host: `127.0.0.1:${port}`, Origin: "https://evil.example", Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(csrf.status, 403);

  // 3. Path validation (404).
  for (const badPath of ["/", "/mcp", "/mcp/short", `${routePath}?x=1`, `${routePath}/extra`, "/other/abcdefghijklmnop"]) {
    const res = await rawHttpRequest({
      port,
      method: "POST",
      path: badPath,
      headers: { Host: `127.0.0.1:${port}`, Authorization: auth, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404, `expected 404 for path: ${badPath}`);
  }

  // 4. Auth validation (401) for missing, malformed, wrong secret, and unknown routeId.
  for (const [p, h] of [
    [routePath, {}],
    [routePath, { Authorization: "Basic abc" }],
    [routePath, { Authorization: "Bearer wrong-token" }],
    ["/mcp/unknownRouteId1234567890", { Authorization: auth }],
  ]) {
    const res = await rawHttpRequest({
      port,
      method: "POST",
      path: p,
      headers: { Host: `127.0.0.1:${port}`, ...h, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers["www-authenticate"], "Bearer");
    assert.equal(res.body.includes(UPSTREAM_SECRET), false);
  }

  // 5. Method handling: GET & PUT -> 405 with Allow: POST, DELETE.
  for (const method of ["GET", "PUT"]) {
    const res = await rawHttpRequest({
      port,
      method,
      path: routePath,
      headers: { Host: `127.0.0.1:${port}`, Authorization: auth },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "POST, DELETE");
  }

  // 6. Invalid JSON and non-object JSON -> 400.
  for (const badBody of ["{not-json", "[]", '"str"', "123", "null"]) {
    const res = await fetch(jack.serverUrl, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: badBody,
    });
    assert.equal(res.status, 400);
  }

  // 7. Oversized request body -> 413 (both Content-Length and chunked).
  const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { pad: "a".repeat(1024) } });
  const res413 = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: huge,
  });
  assert.equal(res413.status, 413);

  const chunked413 = await rawHttpRequest({
    port,
    method: "POST",
    path: routePath,
    headers: { Host: `127.0.0.1:${port}`, Authorization: auth, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    body: `${Buffer.byteLength(huge).toString(16)}\r\n${huge}\r\n0\r\n\r\n`,
  });
  assert.equal(chunked413.status, 413);

  // 8. Initialize + DELETE session teardown (204) -> deleted session returns 404.
  const initRes = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "test" } } }),
  });
  assert.equal(initRes.status, 200);
  const localSid = initRes.headers.get("mcp-session-id");
  assert.ok(localSid && localSid !== "upstream-sid-secret-1");

  const delRes = await fetch(jack.serverUrl, {
    method: "DELETE",
    headers: { Authorization: auth, "Mcp-Session-Id": localSid },
  });
  assert.equal(delRes.status, 204);

  const afterDel = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", "Mcp-Session-Id": localSid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(afterDel.status, 404);

  // 9. Redirect blocked (`redirect: "error"`) -> 502 with zero secret leak.
  upstreamMode = "redirect";
  const redirRes = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "server/discover" }),
  });
  assert.equal(redirRes.status, 502);
  const redirText = await redirRes.text();
  assert.equal(redirText.includes(UPSTREAM_SECRET), false);
  assert.equal(redirText.includes(upstream.url), false);

  // 10. Oversized upstream response -> 502 with zero secret leak.
  upstreamMode = "oversized";
  const bigRes = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "server/discover" }),
  });
  assert.equal(bigRes.status, 502);
  const bigText = await bigRes.text();
  assert.equal(bigText.includes(UPSTREAM_SECRET), false);

  // 11. Upstream 500 error body & headers NEVER leak to client.
  upstreamMode = "error500";
  const err500 = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "server/discover" }),
  });
  assert.equal(err500.status, 500);
  assert.equal(err500.headers.get("x-debug-token"), null);
  const err500Text = await err500.text();
  assert.equal(err500Text.includes(UPSTREAM_SECRET), false);
  assert.equal(err500Text.includes("internal.secret"), false);
  assert.equal(JSON.parse(err500Text).error.message, "Upstream MCP HTTP 500");

  // 12. maxInFlight (1) returns 429 for concurrent overflow, then recovers.
  upstreamMode = "slow";
  const firstPromise = fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "server/discover" }),
  });
  while (!releaseSlow) await new Promise((r) => setTimeout(r, 5));
  const secondRes = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server/discover" }),
  });
  assert.equal(secondRes.status, 429);
  releaseSlow();
  const firstRes = await firstPromise;
  assert.equal(firstRes.status, 200);
});

test("proxy handles full MCP lifecycle: server/discover, initialize, token rotation with single-flight concurrent calls, 404 stale-session recovery, SSE, session eviction, and workspace revocation", async (t) => {
  const upstreamCalls = [];
  let sidCounter = 0;
  let activeUpstreamSessions = new Map(); // upstreamSid -> expectedAuth
  let expireOnceForSid = null;

  const upstream = await listenServer(async (req, res) => {
    const body = JSON.parse(await readHttpBody(req));
    const auth = req.headers.authorization || null;
    const sid = req.headers["mcp-session-id"] || null;
    upstreamCalls.push({ method: body.method, id: body.id ?? null, auth, sid });

    if (body.method === "server/discover") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "should-never-leak" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }));
      return;
    }

    if (body.method === "initialize") {
      sidCounter += 1;
      const newSid = `up-sid-${sidCounter}`;
      activeUpstreamSessions.set(newSid, auth);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": newSid, "X-Upstream-Private": "secret" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-03-26", serverInfo: { name: "mock-jack" } },
      }));
      return;
    }

    if (body.method === "notifications/initialized") {
      if (!sid || activeUpstreamSessions.get(sid) !== auth) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "stale session" }));
        return;
      }
      res.writeHead(202, { "Mcp-Session-Id": sid });
      res.end();
      return;
    }

    if (expireOnceForSid && sid === expireOnceForSid) {
      expireOnceForSid = null;
      activeUpstreamSessions.delete(sid);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session expired" }));
      return;
    }

    if (!sid || activeUpstreamSessions.get(sid) !== auth) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session or token mismatch" }));
      return;
    }

    if (body.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ping" }] } }));
      return;
    }

    if (body.method === "tools/call" && body.params?.name === "sse_ping") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Mcp-Session-Id": sid, "X-Upstream-Private": "secret" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `sse:${auth}:${sid}` }] } })}\n\n`);
      return;
    }

    if (body.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: `ok:${body.params?.name}:${auth}:${sid}` }] },
      }));
      return;
    }

    res.writeHead(400);
    res.end();
  });
  t.after(() => upstream.close());

  const proxy = createAntigravityMcpProxy({ allowLoopbackHttp: true, maxSessionsPerRoute: 2 });
  t.after(() => proxy.close());
  await proxy.ensureStarted();

  const entriesV1 = proxy.setWorkspaceServers("/tmp/ws-a", [
    { name: "jack", url: upstream.url, headers: [{ name: "Authorization", value: "Bearer token-v1" }] },
    { name: "linear", url: upstream.url, headers: [{ name: "Authorization", value: "Bearer linear-v1" }] },
  ]);
  const entriesB = proxy.setWorkspaceServers("/tmp/ws-b", [
    { name: "jack", url: upstream.url, headers: [{ name: "Authorization", value: "Bearer ws-b-token" }] },
  ]);

  const post = (entry, payload, localSid = null) => fetch(entry.serverUrl, {
    method: "POST",
    headers: {
      Authorization: entry.headers.Authorization,
      "Content-Type": "application/json",
      ...(localSid ? { "Mcp-Session-Id": localSid } : {}),
    },
    body: JSON.stringify(payload),
  });

  // 1. server/discover (no Mcp-Session-Id) forwards directly without synthetic initialize.
  const discRes = await post(entriesV1.jack, { jsonrpc: "2.0", id: 1, method: "server/discover" });
  assert.equal(discRes.status, 200);
  assert.equal(discRes.headers.get("mcp-session-id"), null);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].method, "server/discover");
  assert.equal(upstreamCalls[0].sid, null);

  // 2. initialize allocates opaque localSid and hides upstream sid + private headers.
  const initRes = await post(entriesV1.jack, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", clientInfo: { name: "antigravity" } },
  });
  assert.equal(initRes.status, 200);
  const localSid = initRes.headers.get("mcp-session-id");
  assert.ok(localSid && localSid !== "up-sid-1");
  assert.equal(initRes.headers.get("x-upstream-private"), null);

  // 3. notifications/initialized -> 202 with localSid.
  const notifRes = await post(entriesV1.jack, { jsonrpc: "2.0", method: "notifications/initialized" }, localSid);
  assert.equal(notifRes.status, 202);
  assert.equal(notifRes.headers.get("mcp-session-id"), localSid);

  // 4. tools/list + tools/call (token v1).
  const listRes = await post(entriesV1.jack, { jsonrpc: "2.0", id: 3, method: "tools/list" }, localSid);
  assert.equal(listRes.status, 200);
  assert.deepEqual((await listRes.json()).result.tools, [{ name: "ping" }]);

  const callV1 = await post(entriesV1.jack, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ping" } }, localSid);
  assert.equal(callV1.status, 200);
  assert.equal((await callV1.json()).result.content[0].text, "ok:ping:Bearer token-v1:up-sid-1");

  // 5. Rotate token in RAM via setWorkspaceServers -> EXACT SAME serverUrl & localSecret!
  // Also drop `linear` to verify per-server revocation.
  const entriesV2 = proxy.setWorkspaceServers("/tmp/ws-a", [
    { name: "jack", url: upstream.url, headers: [{ name: "Authorization", value: "Bearer token-v2" }] },
  ]);
  assert.deepEqual(entriesV2.jack, entriesV1.jack);
  // Dropped `linear` route is immediately 401.
  const linearAfterDrop = await post(entriesV1.linear, { jsonrpc: "2.0", id: 99, method: "server/discover" });
  assert.equal(linearAfterDrop.status, 401);

  // 6. Two CONCURRENT tools/call requests after token rotation -> SINGLE-FLIGHT re-initialize!
  const callsBeforeRotate = upstreamCalls.length;
  const [c1, c2] = await Promise.all([
    post(entriesV1.jack, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "alpha" } }, localSid),
    post(entriesV1.jack, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "beta" } }, localSid),
  ]);
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);
  assert.equal((await c1.json()).result.content[0].text, "ok:alpha:Bearer token-v2:up-sid-2");
  assert.equal((await c2.json()).result.content[0].text, "ok:beta:Bearer token-v2:up-sid-2");
  const rotateCalls = upstreamCalls.slice(callsBeforeRotate);
  assert.equal(rotateCalls.filter((c) => c.method === "initialize").length, 1);
  assert.equal(rotateCalls.filter((c) => c.method === "notifications/initialized").length, 1);

  // 7. 404 stale upstream session recovery mid-turn: ONE re-initialize + retry succeeds.
  expireOnceForSid = "up-sid-2";
  const recovered = await post(entriesV1.jack, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "after404" } }, localSid);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).result.content[0].text, "ok:after404:Bearer token-v2:up-sid-3");

  // 8. SSE (text/event-stream) pass-through with sanitized Content-Type and hidden upstream headers.
  const sseRes = await post(entriesV1.jack, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "sse_ping" } }, localSid);
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get("content-type"), "text/event-stream");
  assert.equal(sseRes.headers.get("mcp-session-id"), localSid);
  assert.equal(sseRes.headers.get("x-upstream-private"), null);
  const sseText = await sseRes.text();
  assert.match(sseText, /event: message/);
  assert.match(sseText, /sse:Bearer token-v2:up-sid-3/);

  // 9. maxSessionsPerRoute (2): creating 2 more sessions evicts the oldest (`localSid`).
  const s2 = (await post(entriesV1.jack, { jsonrpc: "2.0", id: 9, method: "initialize", params: {} })).headers.get("mcp-session-id");
  const s3 = (await post(entriesV1.jack, { jsonrpc: "2.0", id: 10, method: "initialize", params: {} })).headers.get("mcp-session-id");
  assert.ok(s2 && s3);
  assert.equal((await post(entriesV1.jack, { jsonrpc: "2.0", id: 11, method: "tools/list" }, localSid)).status, 404);
  assert.equal((await post(entriesV1.jack, { jsonrpc: "2.0", id: 12, method: "tools/list" }, s3)).status, 200);

  // 10. clearWorkspace revokes ws-a immediately (401) while ws-b stays alive.
  proxy.clearWorkspace("/tmp/ws-a");
  assert.equal(proxy.entryFor("/tmp/ws-a", "jack"), null);
  assert.equal((await post(entriesV1.jack, { jsonrpc: "2.0", id: 13, method: "tools/list" }, s3)).status, 401);
  assert.equal((await post(entriesB.jack, { jsonrpc: "2.0", id: 14, method: "server/discover" })).status, 200);
});

test("B3 P1-1: transient 500 or fetch error during 404 re-init invalidates upstreamConfigHash so next call recovers cleanly", async (t) => {
  let sidSeq = 0;
  const activeSids = new Set();
  let failNextInitWith500 = false;
  let throwNextInitFetch = false;

  const upstream = await listenServer(async (req, res) => {
    const msg = JSON.parse(await readHttpBody(req));
    const sid = req.headers["mcp-session-id"] || null;
    if (msg.method === "initialize") {
      if (failNextInitWith500) {
        failNextInitWith500 = false;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "transient upstream outage" }));
        return;
      }
      sidSeq += 1;
      const nextSid = `sid-${sidSeq}`;
      activeSids.add(nextSid);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": nextSid });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
      return;
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202, { ...(sid ? { "Mcp-Session-Id": sid } : {}) });
      res.end();
      return;
    }
    if (!sid || !activeSids.has(sid)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session expired" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sid } }));
  });
  t.after(() => upstream.close());

  const proxy = createAntigravityMcpProxy({
    allowLoopbackHttp: true,
    fetchImpl: async (url, init) => {
      if (throwNextInitFetch && typeof init?.body === "string" && init.body.includes('"method":"initialize"')) {
        throwNextInitFetch = false;
        throw new Error("ECONNRESET transient");
      }
      return globalThis.fetch(url, init);
    },
  });
  t.after(() => proxy.close());
  await proxy.ensureStarted();
  const { jack } = proxy.setWorkspaceServers("/tmp/ws-p1", [
    { name: "jack", url: upstream.url, headers: { Authorization: "Bearer tok-1" } },
  ]);

  const post = (payload, localSid = null) => fetch(jack.serverUrl, {
    method: "POST",
    headers: {
      Authorization: jack.headers.Authorization,
      "Content-Type": "application/json",
      ...(localSid ? { "Mcp-Session-Id": localSid } : {}),
    },
    body: JSON.stringify(payload),
  });

  const initRes = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const localSid = initRes.headers.get("mcp-session-id");
  assert.ok(localSid);

  // 1. Expire sid-1 and fail re-init with HTTP 500 -> returns 502, MUST NOT wedge session.
  activeSids.delete("sid-1");
  failNextInitWith500 = true;
  const failed500 = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "a" } }, localSid);
  assert.equal(failed500.status, 502);

  // Next call MUST detect invalidated upstreamConfigHash, re-init sid-2, and succeed!
  const recovered1 = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "b" } }, localSid);
  assert.equal(recovered1.status, 200);
  assert.equal((await recovered1.json()).result.sid, "sid-2");

  // 2. Expire sid-2 and fail re-init with fetch throw -> returns 502, MUST NOT wedge session.
  activeSids.delete("sid-2");
  throwNextInitFetch = true;
  const failedThrow = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "c" } }, localSid);
  assert.equal(failedThrow.status, 502);

  // Next call MUST re-init sid-3 and succeed!
  const recovered2 = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "d" } }, localSid);
  assert.equal(recovered2.status, 200);
  assert.equal((await recovered2.json()).result.sid, "sid-3");
});

test("B3 P2-2: double token rotation (H1 -> H2 -> H3) during in-flight re-init and concurrent 404 recovery both converge without null sessionId", async (t) => {
  let sidSeq = 0;
  const sessions = new Map(); // sid -> auth
  const upstreamCalls = [];
  let onInitV2Started = null;
  let releaseInitV2 = null;

  const upstream = await listenServer(async (req, res) => {
    const msg = JSON.parse(await readHttpBody(req));
    const auth = req.headers.authorization || null;
    const sid = req.headers["mcp-session-id"] || null;
    upstreamCalls.push({ method: msg.method, auth, sid });

    if (msg.method === "initialize") {
      if (auth === "Bearer v2" && releaseInitV2 === null) {
        await new Promise((resolve) => {
          releaseInitV2 = resolve;
          onInitV2Started?.();
        });
      }
      sidSeq += 1;
      const newSid = `up-${sidSeq}`;
      sessions.set(newSid, auth);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": newSid });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
      return;
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202, { ...(sid ? { "Mcp-Session-Id": sid } : {}) });
      res.end();
      return;
    }
    if (!sid || sessions.get(sid) !== auth) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stale" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { auth, sid } }));
  });
  t.after(() => upstream.close());

  const proxy = createAntigravityMcpProxy({ allowLoopbackHttp: true });
  t.after(() => proxy.close());
  await proxy.ensureStarted();

  const { jack } = proxy.setWorkspaceServers("/tmp/ws-p22", [
    { name: "jack", url: upstream.url, headers: { Authorization: "Bearer v1" } },
  ]);
  const post = (payload, localSid = null) => fetch(jack.serverUrl, {
    method: "POST",
    headers: {
      Authorization: jack.headers.Authorization,
      "Content-Type": "application/json",
      ...(localSid ? { "Mcp-Session-Id": localSid } : {}),
    },
    body: JSON.stringify(payload),
  });

  // Establish session on H1 (v1 -> up-1).
  const initRes = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const localSid = initRes.headers.get("mcp-session-id");

  // Rotate H1 -> H2, start a tool call that triggers in-flight initialize(v2).
  proxy.setWorkspaceServers("/tmp/ws-p22", [
    { name: "jack", url: upstream.url, headers: { Authorization: "Bearer v2" } },
  ]);
  const initV2Entered = new Promise((resolve) => { onInitV2Started = resolve; });
  const callPromise = post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "double-rot" } }, localSid);
  await initV2Entered;

  // Rotate AGAIN H2 -> H3 while initialize(v2) is in flight, then release initialize(v2).
  proxy.setWorkspaceServers("/tmp/ws-p22", [
    { name: "jack", url: upstream.url, headers: { Authorization: "Bearer v3" } },
  ]);
  releaseInitV2();

  const callRes = await callPromise;
  assert.equal(callRes.status, 200);
  const body = await callRes.json();
  assert.deepEqual(body.result, { auth: "Bearer v3", sid: "up-3" });
  // Must NEVER have fired tools/call with sid: null!
  assert.equal(upstreamCalls.some((c) => c.method === "tools/call" && c.sid === null), false);

  // Concurrent 404 recovery: expire up-3 and fire two parallel tools/call requests.
  sessions.delete("up-3");
  const before404 = upstreamCalls.length;
  const [r1, r2] = await Promise.all([
    post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "c1" } }, localSid),
    post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "c2" } }, localSid),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.deepEqual((await r1.json()).result, { auth: "Bearer v3", sid: "up-4" });
  assert.deepEqual((await r2.json()).result, { auth: "Bearer v3", sid: "up-4" });
  // Only ONE single-flight re-initialize ran for both concurrent 404s.
  const recoveryCalls = upstreamCalls.slice(before404);
  assert.equal(recoveryCalls.filter((c) => c.method === "initialize").length, 1);
});

test("B3 P2-3 & timeout: in-flight upstream calls abort and return 401 on clearWorkspace() and close(); upstream timeout returns 502 with zero secret leak", async (t) => {
  const SECRET = "UPSTREAM_TIMEOUT_SECRET_XYZ";
  let signalAbortedCount = 0;
  let onUpstreamEntered = null;
  let releaseUpstream = null;

  const proxy = createAntigravityMcpProxy({
    allowLoopbackHttp: true,
    timeoutMs: 120,
    fetchImpl: async (url, init) => {
      const msg = JSON.parse(init.body);
      if (msg.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "up-1" },
        });
      }
      if (msg.params?.mode === "hang_until_abort") {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            signalAbortedCount += 1;
            reject(init.signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" }));
          };
          if (init.signal?.aborted) return onAbort();
          init.signal?.addEventListener("abort", onAbort, { once: true });
          releaseUpstream = () => resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { leaked: SECRET } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
          onUpstreamEntered?.();
        });
      }
      if (msg.params?.mode === "resolve_after_revoke") {
        return new Promise((resolve) => {
          releaseUpstream = () => resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { leaked: SECRET } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
          onUpstreamEntered?.();
        });
      }
      // Timeout mode: wait for AbortSignal.timeout.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error(`Timed out calling ${url} with ${SECRET}`);
          err.name = "TimeoutError";
          reject(err);
        }, { once: true });
      });
    },
  });
  t.after(() => proxy.close());
  await proxy.ensureStarted();

  const post = (entry, payload, localSid = null) => fetch(entry.serverUrl, {
    method: "POST",
    headers: {
      Authorization: entry.headers.Authorization,
      "Content-Type": "application/json",
      ...(localSid ? { "Mcp-Session-Id": localSid } : {}),
    },
    body: JSON.stringify(payload),
  });

  // 1. Upstream timeout -> 502 with safe generic message and zero secret/URL leakage.
  const { jack: timeoutEntry } = proxy.setWorkspaceServers("/tmp/ws-timeout", [
    { name: "jack", url: "https://upstream.secret.example/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
  ]);
  const timeoutRes = await post(timeoutEntry, { jsonrpc: "2.0", id: 1, method: "server/discover" });
  assert.equal(timeoutRes.status, 502);
  const timeoutText = await timeoutRes.text();
  assert.equal(timeoutText.includes(SECRET), false);
  assert.equal(timeoutText.includes("upstream.secret.example"), false);
  assert.equal(JSON.parse(timeoutText).error.message, "Upstream MCP request timed out");

  // 2. clearWorkspace() aborts in-flight Case 3 (stateful) upstream fetch and returns 401.
  const { jack: revokeEntry } = proxy.setWorkspaceServers("/tmp/ws-revoke", [
    { name: "jack", url: "https://upstream.secret.example/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
  ]);
  const initRes = await post(revokeEntry, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  const localSid = initRes.headers.get("mcp-session-id");
  const entered1 = new Promise((resolve) => { onUpstreamEntered = resolve; });
  const inFlightStateful = post(revokeEntry, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { mode: "hang_until_abort" } }, localSid);
  await entered1;
  proxy.clearWorkspace("/tmp/ws-revoke");
  const resAfterClear = await inFlightStateful;
  assert.equal(resAfterClear.status, 401);
  assert.equal(signalAbortedCount, 1);
  assert.equal((await resAfterClear.text()).includes(SECRET), false);

  // 3. Even if an upstream fetch resolves right as clearWorkspace() runs (Case 2 stateless), proxy checks !route.active and returns 401.
  const { jack: revokeStateless } = proxy.setWorkspaceServers("/tmp/ws-revoke-2", [
    { name: "jack", url: "https://upstream.secret.example/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
  ]);
  const entered2 = new Promise((resolve) => { onUpstreamEntered = resolve; });
  const inFlightStateless = post(revokeStateless, { jsonrpc: "2.0", id: 4, method: "server/discover", params: { mode: "resolve_after_revoke" } });
  await entered2;
  proxy.clearWorkspace("/tmp/ws-revoke-2");
  releaseUpstream();
  const statelessRes = await inFlightStateless;
  assert.equal(statelessRes.status, 401);
  assert.equal((await statelessRes.text()).includes(SECRET), false);

  // 4. close() aborts in-flight upstream fetch cleanly.
  const { jack: closeEntry } = proxy.setWorkspaceServers("/tmp/ws-close", [
    { name: "jack", url: "https://upstream.secret.example/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
  ]);
  const entered3 = new Promise((resolve) => { onUpstreamEntered = resolve; });
  const inFlightClose = post(closeEntry, { jsonrpc: "2.0", id: 5, method: "server/discover", params: { mode: "hang_until_abort" } }).catch(() => ({ status: 401 }));
  await entered3;
  await proxy.close();
  await inFlightClose;
  assert.equal(signalAbortedCount, 2);
});

test("B3 P2-1: Slowloris mid-body timeout (408) and premature client TCP disconnect both release route.inFlight", async (t) => {
  const upstream = await listenServer(async (req, res) => {
    await readHttpBody(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  t.after(() => upstream.close());

  const proxy = createAntigravityMcpProxy({
    allowLoopbackHttp: true,
    maxInFlight: 1,
    bodyTimeoutMs: 120,
  });
  t.after(() => proxy.close());
  const { port } = await proxy.ensureStarted();
  const { jack } = proxy.setWorkspaceServers("/tmp/ws-slowloris", [
    { name: "jack", url: upstream.url, headers: { Authorization: "Bearer tok" } },
  ]);
  const routePath = new URL(jack.serverUrl).pathname;

  // 1. Slowloris: send headers + partial body and stall -> proxy responds 408 and frees inFlight slot.
  const slowRes = await new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `POST ${routePath} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + `Authorization: ${jack.headers.Authorization}\r\n`
        + `Content-Type: application/json\r\n`
        + `Content-Length: 100\r\n\r\n`
        + `{"jsonrpc":"2.0"`,
      );
    });
    let data = "";
    sock.on("data", (chunk) => { data += chunk.toString("utf8"); });
    sock.on("end", () => resolve(data));
    sock.on("close", () => resolve(data));
    sock.on("error", reject);
  });
  assert.match(slowRes, /^HTTP\/1\.1 408 /);

  // Subsequent request must succeed (200, NOT 429) proving route.inFlight was released!
  const afterSlow = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: jack.headers.Authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
  });
  assert.equal(afterSlow.status, 200);

  // 2. Premature client TCP disconnect mid-body -> frees route.inFlight immediately!
  await new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `POST ${routePath} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + `Authorization: ${jack.headers.Authorization}\r\n`
        + `Content-Type: application/json\r\n`
        + `Content-Length: 100\r\n\r\n`
        + `{"partial":`,
      );
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 20);
    });
  });
  // Give the server socket close event a brief tick to settle.
  await new Promise((r) => setTimeout(r, 30));

  const afterDisconnect = await fetch(jack.serverUrl, {
    method: "POST",
    headers: { Authorization: jack.headers.Authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover" }),
  });
  assert.equal(afterDisconnect.status, 200);
});
