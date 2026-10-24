import assert from "node:assert/strict";
import test from "node:test";
import { observe } from "../src/orchestrate.mjs";
import { T3Client } from "../src/t3-client.mjs";

// Exercise the V1 public read path with synthetic HTTP metadata.
function clientFor(threads, archivedThreads = []) {
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773",
    token: "synthetic",
    fetchImpl: async () => new Response(JSON.stringify({ projects: [], threads }), {
      headers: { "content-type": "application/json" },
    }),
  });
  client.rpc = async (method) => {
    assert.equal(method, "orchestration.getArchivedShellSnapshot");
    return { threads: archivedThreads };
  };
  return client;
}

const thread = (id, status, activeTurnId = null) => ({ id, session: { status, activeTurnId } });

test("V1 observe: 316 ready sessions do not block the idle gate", async () => {
  const state = await observe(clientFor(Array.from({ length: 316 }, (_, index) =>
    thread(`neutral-${index}`, "ready"))));
  assert.equal(state.counts.activeTurns, 0);
  assert.equal(state.activeTurns.length, 0);
  assert.equal(state.counts.readySessions, 316);
  assert.equal(state.counts.interruptedSessions, 0);
  assert.equal(state.counts.threads, 316);
  assert.equal(state.counts.pendingApprovals, 0);
});

test("V1 observe: an active turn ID is counted even outside a running status", async () => {
  const state = await observe(clientFor([thread("neutral-active", "ready", "turn-1")]));
  assert.equal(state.counts.activeTurns, 1);
  assert.deepEqual(state.activeTurns.map((turn) => turn.activeTurnId), ["turn-1"]);
});

test("V1 observe: interrupted-only sessions have their own counter", async () => {
  const state = await observe(clientFor([thread("neutral-interrupted", "interrupted")]));
  assert.equal(state.counts.activeTurns, 0);
  assert.deepEqual(state.activeTurns, []);
  assert.equal(state.counts.interruptedSessions, 1);
  assert.equal(state.counts.readySessions, 0);
});

test("V1 observe: archived and deleted sessions do not enter active counters", async () => {
  const state = await observe(clientFor([
    { ...thread("neutral-archived", "ready", "archived-turn"), archivedAt: "2026-10-20T00:00:00.000Z" },
    { ...thread("neutral-deleted", "interrupted", "deleted-turn"), deletedAt: "2026-10-20T00:00:00.000Z" },
  ], [thread("neutral-old", "interrupted")]));
  assert.equal(state.counts.activeTurns, 0);
  assert.equal(state.counts.readySessions, 0);
  assert.equal(state.counts.interruptedSessions, 0);
  assert.equal(state.counts.archivedThreads, 1);
});

test("V1 observe preserves partial running sessions and counts every contract status", async () => {
  const statuses = ["idle", "starting", "running", "ready", "interrupted", "stopped", "error"];
  const state = await observe(clientFor(statuses.map((status) => thread(status, status))));
  assert.deepEqual(state.activeTurns.map((turn) => turn.threadId), ["starting", "running"]);
  assert.equal(state.counts.activeTurns, 2);
  assert.equal(state.counts.readySessions, 1);
  assert.equal(state.counts.interruptedSessions, 1);
});

test("V1 observe never discards an explicit active turn ID with an unknown status", async () => {
  const state = await observe(clientFor([
    thread("neutral-unknown", "future-status"),
    thread("neutral-unknown-active", "future-status", "turn-unknown"),
  ]));
  assert.equal(state.counts.activeTurns, 1);
  assert.equal(state.activeTurns[0].threadId, "neutral-unknown-active");
  assert.equal(state.counts.readySessions, 0);
  assert.equal(state.counts.interruptedSessions, 0);
});
