import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { report } from "../src/orchestrate.mjs";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";

const execFileAsync = promisify(execFile);
const EXACT = "12345678-1111-4111-8111-111111111111";
const COLLISION = "12345678-2222-4222-8222-222222222222";
const UNIQUE = "abcdef01-3333-4333-8333-333333333333";
const UNAUTHORIZED = "fedcba98-4444-4444-8444-444444444444";
const GUIDANCE = /full thread UUID.*tentacles originate.*tentacles observe/s;
const prefixes = [
  ["unique", UNIQUE.slice(0, 8)],
  ["ambiguous", EXACT.slice(0, 8)],
  ["unknown", "00000000"],
  ["unauthorized", UNAUTHORIZED.slice(0, 8)],
];
const invalidIds = [undefined, null, 12345678, "", "1234567", `${EXACT}\n`, ` ${EXACT}`, `${EXACT}/extra`, "synthetic-input-canary"];

test("report rejects abbreviated IDs before calling any client", async () => {
  let calls = 0;
  const client = { thread: async () => { calls += 1; return {}; } };
  for (const [name, prefix] of prefixes) {
    await assert.rejects(report(client, prefix), GUIDANCE, name);
  }
  for (const id of invalidIds) await assert.rejects(report(client, id), GUIDANCE);
  assert.equal(calls, 0);
});

for (const protocol of [1, 2]) {
  test(`client.thread rejects prefixes before protocol discovery or HTTP (V${protocol})`, async () => {
    const calls = [];
    const client = new T3Client({
      token: "synthetic-fixture-token",
      orchestrationProtocol: "auto",
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ orchestrationProtocolVersion: protocol }));
      },
    });
    for (const [name, prefix] of prefixes) {
      await assert.rejects(client.thread(prefix), GUIDANCE, name);
    }
    for (const id of invalidIds) {
      await assert.rejects(client.thread(id), (error) => {
        assert.match(error.message, GUIDANCE);
        assert.equal(error.message.includes("synthetic-input-canary"), false);
        return true;
      });
    }
    assert.deepEqual(calls, []);
  });

  test(`report CLI full UUID and rejected-prefix contract over isolated HTTP (V${protocol})`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-report-id-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const tokenFile = path.join(directory, "synthetic.token");
    fs.writeFileSync(tokenFile, "synthetic-report-fixture-token-0000", { mode: 0o600 });
    const requests = [];
    const authorized = new Set([EXACT, COLLISION, UNIQUE]);
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/t3/environment") {
        res.end(JSON.stringify({ orchestrationProtocolVersion: protocol }));
        return;
      }
      const id = req.url.slice("/api/orchestration/threads/".length);
      if (req.method !== "GET" || !req.url.startsWith("/api/orchestration/threads/") || !authorized.has(id)) {
        res.statusCode = id === UNAUTHORIZED ? 403 : 404;
        res.end(JSON.stringify({ error: "synthetic-access-denied" }));
        return;
      }
      const thread = { id, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, session: { status: "ready" } };
      res.end(JSON.stringify(protocol === 1 ? { thread } : { projection: { thread, runs: [] } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const run = (id, overrides = {}) => execFileAsync(process.execPath, [path.resolve("src/cli.mjs"), "report", "--thread", id], {
      timeout: 10_000,
      env: { HOME: directory, T3_URL: baseUrl, T3_HERMES_TOKEN_FILE: tokenFile, T3_ORCHESTRATION_PROTOCOL: "auto", ...overrides },
    });

    const { stdout, stderr } = await run(EXACT);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { threadId: EXACT, status: "ready/idle", lastError: null, model: "gpt-6.1-sol" });
    assert.deepEqual(requests.splice(0), ["/.well-known/t3/environment", `/api/orchestration/threads/${EXACT}`]);
    for (const [name, prefix] of prefixes) {
      await assert.rejects(run(prefix), (error) => {
        assert.equal(error.code, 1, name);
        assert.equal(error.stdout, "", name);
        assert.match(error.stderr, GUIDANCE, name);
        return true;
      });
      assert.deepEqual(requests.splice(0), [], name);
    }
    await assert.rejects(run(UNIQUE.slice(0, 8), { T3_HERMES_TOKEN_FILE: path.join(directory, "absent.token") }), (error) => {
      assert.match(error.stderr, GUIDANCE);
      return true;
    });
    assert.deepEqual(requests.splice(0), []);

    await assert.rejects(run(UNAUTHORIZED), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /failed \(403\)/);
      assert.equal(error.stderr.includes("synthetic-access-denied"), false);
      return true;
    });
    assert.deepEqual(requests.splice(0), ["/.well-known/t3/environment", `/api/orchestration/threads/${UNAUTHORIZED}`]);
    const client = new T3Client({ token: "synthetic-fixture-token", baseUrl, orchestrationProtocol: protocol });
    await assert.rejects(report(client, UNAUTHORIZED), (error) => error instanceof T3HttpError && error.status === 403);
    assert.deepEqual(requests.splice(0), [`/api/orchestration/threads/${UNAUTHORIZED}`]);
  });
}
