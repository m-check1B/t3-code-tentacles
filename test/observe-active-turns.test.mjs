import assert from "node:assert/strict";
import test from "node:test";
import { observe } from "../src/orchestrate.mjs";
import { T3Client } from "../src/t3-client.mjs";
import { T3V2UnsupportedError } from "../src/t3-v2.mjs";

// Exercise the public read path, including protocol-specific HTTP projection.
function clientFor(protocol, threads, archivedThreads = []) {
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773",
    token: "synthetic",
    orchestrationProtocol: protocol,
    fetchImpl: async (url) => new Response(JSON.stringify({
      ...(protocol === 2 ? { schemaVersion: 2 } : {}),
      projects: [],
      threads: new URL(url).pathname.includes("archived") ? archivedThreads : threads,
    }), { headers: { "content-type": "application/json" } }),
  });
  client.rpc = async (method) => {
    assert.equal(method, "orchestration.getArchivedShellSnapshot");
    return { ...(protocol === 2 ? { schemaVersion: 2 } : {}), threads: archivedThreads };
  };
  return client;
}

const v1Thread = (id, status, activeTurnId = null) => ({ id, session: { status, activeTurnId } });
const v2Thread = (id, status, activeRunId = null) => ({ id, status, activeRunId });

for (const protocol of [1, 2]) {
  const thread = protocol === 1 ? v1Thread : v2Thread;
  test(`V${protocol} observe: 316 ready sessions do not block the idle gate`, async () => {
    const state = await observe(clientFor(protocol, Array.from({ length: 316 }, (_, index) =>
      thread(`neutral-${index}`, protocol === 1 ? "ready" : "idle"))));
    assert.equal(state.counts.activeTurns, 0);
    assert.equal(state.activeTurns.length, 0);
    assert.equal(state.counts.readySessions, 316);
    assert.equal(state.counts.interruptedSessions, 0);
    assert.equal(state.counts.threads, 316);
    assert.equal(state.counts.pendingApprovals, 0);
  });

  test(`V${protocol} observe: an active turn ID is counted even outside a running status`, async () => {
    const state = await observe(clientFor(protocol, [thread("neutral-active", protocol === 1 ? "ready" : "idle", "turn-1")]));
    assert.equal(state.counts.activeTurns, 1);
    assert.deepEqual(state.activeTurns.map((turn) => turn.activeTurnId), ["turn-1"]);
  });

  test(`V${protocol} observe: interrupted-only sessions have their own counter`, async () => {
    const state = await observe(clientFor(protocol, [thread("neutral-interrupted", "interrupted")]));
    assert.equal(state.counts.activeTurns, 0);
    assert.deepEqual(state.activeTurns, []);
    assert.equal(state.counts.interruptedSessions, 1);
    assert.equal(state.counts.readySessions, 0);
  });

  test(`V${protocol} observe: archived and deleted sessions do not enter active counters`, async () => {
    const state = await observe(clientFor(protocol, [
      { ...thread("neutral-archived", "running", "archived-turn"), archivedAt: "2026-10-20T00:00:00.000Z" },
      { ...thread("neutral-deleted", "running", "deleted-turn"), deletedAt: "2026-10-20T00:00:00.000Z" },
    ], [thread("neutral-old", "interrupted")]));
    assert.equal(state.counts.activeTurns, 0);
    assert.equal(state.counts.interruptedSessions, 0);
    assert.equal(state.counts.archivedThreads, 1);
  });
}

test("V1 observe preserves partial running sessions and counts every contract status", async () => {
  const statuses = ["idle", "starting", "running", "ready", "interrupted", "stopped", "error"];
  const state = await observe(clientFor(1, statuses.map((status) => v1Thread(status, status))));
  assert.deepEqual(state.activeTurns.map((turn) => turn.threadId), ["starting", "running"]);
  assert.equal(state.counts.activeTurns, 2);
  assert.equal(state.counts.readySessions, 1);
  assert.equal(state.counts.interruptedSessions, 1);
});

test("V2 observe counts validated active statuses and preserves interrupted classification", async () => {
  const statuses = ["idle", "preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"];
  const state = await observe(clientFor(2, statuses.map((status) => v2Thread(status, status))));
  assert.deepEqual(state.activeTurns.map((turn) => turn.threadId), ["preparing", "queued", "starting", "running", "waiting"]);
  assert.equal(state.counts.activeTurns, 5);
  assert.equal(state.counts.readySessions, 1);
  assert.equal(state.counts.interruptedSessions, 1);
});

test("V2 observe refuses unknown and coerced statuses before reporting idle (KRA-7187 R3-2)", async () => {
  for (const status of ["future-status", "toString", ["running"], {}, null]) {
    await assert.rejects(observe(clientFor(2, [v2Thread("neutral-unknown", status)])), T3V2UnsupportedError);
  }
});

test("V1 observe retains permissive summaries but never discards an explicit active turn ID", async () => {
  const state = await observe(clientFor(1, [
    v1Thread("neutral-unknown", "future-status"),
    v1Thread("neutral-unknown-active", "future-status", "turn-unknown"),
  ]));
  assert.equal(state.counts.activeTurns, 1);
  assert.equal(state.activeTurns[0].threadId, "neutral-unknown-active");
  assert.equal(state.counts.readySessions, 0);
  assert.equal(state.counts.interruptedSessions, 0);
});

// KRA-8952: fixed clock; stale turns stay counted as active and are listed by id only.
for (const protocol of [1, 2]) {
  const thread = protocol === 1 ? v1Thread : v2Thread;
  const [ready, stopped] = protocol === 1 ? ["ready", "stopped"] : ["idle", "completed"];
  const now = Date.parse("2026-10-25T06:00:00.000Z");
  const fresh = "2026-10-25T05:59:00.000Z";
  const old = "2026-10-24T23:59:00.000Z";
  test(`V${protocol} observe: staleTurns lists in-progress turns idle longer than 6 h`, async () => {
    const state = await observe(clientFor(protocol, [
      { ...thread("neutral-settled", stopped), settledAt: old, updatedAt: old },
      { ...thread("neutral-archived", "running", "archived-turn"), archivedAt: old, updatedAt: old },
      { ...thread("neutral-interrupted", "interrupted"), updatedAt: old },
      { ...thread("neutral-ready", ready), updatedAt: old },
      { ...thread("neutral-ready-turn", ready, "turn-ready"), updatedAt: fresh },
      { ...thread("neutral-fresh", "running", "turn-fresh"), updatedAt: fresh },
      { ...thread("neutral-stale", "running", "turn-stale"), title: "secret title", updatedAt: old },
    ]), { now });
    assert.equal(state.counts.activeTurns, 3);
    assert.deepEqual(state.activeTurns.map((turn) => turn.threadId).sort(), ["neutral-fresh", "neutral-ready-turn", "neutral-stale"]);
    assert.equal(state.counts.staleTurns, 1);
    assert.deepEqual(state.staleTurnThreadIds, ["neutral-stale"]);
    assert.equal(state.counts.readySessions, 1);
    assert.equal(state.counts.interruptedSessions, 1);
  });

  test(`V${protocol} observe: a turn idle exactly 6 h is not yet stale`, async () => {
    const boundary = "2026-10-25T00:00:00.000Z";
    const state = await observe(clientFor(protocol, [
      { ...thread("neutral-boundary", "running", "turn-boundary"), updatedAt: boundary },
    ]), { now });
    assert.equal(now - Date.parse(boundary), 6 * 60 * 60 * 1000);
    assert.equal(state.counts.activeTurns, 1);
    assert.equal(state.counts.staleTurns, 0);
    assert.deepEqual(state.staleTurnThreadIds, []);
  });

  test(`V${protocol} observe: an in-progress turn without an activity stamp is active but not stale`, async () => {
    const state = await observe(clientFor(protocol, [thread("neutral-unstamped", "running", "turn-unstamped")]), { now });
    assert.deepEqual(state.activeTurns.map((turn) => turn.threadId), ["neutral-unstamped"]);
    assert.equal(state.counts.activeTurns, 1);
    assert.equal(state.counts.staleTurns, 0);
    assert.deepEqual(state.staleTurnThreadIds, []);
  });
}
