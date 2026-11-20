import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { waitForTicket } from "../scripts/stock-t3-ready.mjs";

const serve = (statuses) => new Promise((resolve) => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.headers.authorization);
    response.writeHead(statuses[Math.min(calls.length - 1, statuses.length - 1)]).end("{}");
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, calls, baseUrl: `http://127.0.0.1:${server.address().port}` }));
});

test("waitForTicket retries a cold-start 503 until T3 answers", async () => {
  const { server, calls, baseUrl } = await serve([503, 503, 200]);
  try {
    const ready = await waitForTicket(baseUrl, "fake-bearer", { firstWaitMs: 10 });
    assert.deepEqual(ready, { status: 200, attempts: 3, notReady: 2 });
    assert.ok(calls.every((header) => header === "Bearer fake-bearer"));
  } finally { server.close(); }
});

test("waitForTicket gives up at the deadline and stops on a non-503 error", async () => {
  const stuck = await serve([503]);
  try {
    const ready = await waitForTicket(stuck.baseUrl, "fake-bearer", { deadlineMs: 100, firstWaitMs: 10, maxWaitMs: 20 });
    assert.equal(ready.status, 503);
  } finally { stuck.server.close(); }
  const denied = await serve([401]);
  try {
    assert.deepEqual(await waitForTicket(denied.baseUrl, "fake-bearer", { firstWaitMs: 10 }), { status: 401, attempts: 1, notReady: 1 });
  } finally { denied.server.close(); }
});
