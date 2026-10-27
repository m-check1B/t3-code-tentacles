import assert from "node:assert/strict";
import test from "node:test";
import { observe, projectThreadReport, report, streamStallIdleMs, threadStreamStall, STREAM_STALL_IDLE_MS } from "../src/orchestrate.mjs";

// KRA-9494: sanitized shape of the Codex 429 reconnect-exhausted tail as T3
// projects it into thread activities (runtime.warning, detail = notification params).
const THREAD_ID = "12345678-1111-4111-8111-111111111111";
const STALLED_AT = "2026-10-27T10:00:00.000Z";
const at = (minutes) => Date.parse(STALLED_AT) + minutes * 60_000;
const PROVIDER_CANARY = "PROVIDER-TEXT-CANARY";

const disconnect429 = (attempt) => ({
  id: `warn-${attempt}`, kind: "runtime.warning", createdAt: STALLED_AT, summary: `Reconnecting... ${attempt}/5`,
  payload: { message: `Reconnecting... ${attempt}/5`, detail: {
    willRetry: true,
    error: { message: `Reconnecting... ${attempt}/5`, additionalDetails: `exceeded retry limit, last status: 429 Too Many Requests ${PROVIDER_CANARY}`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } } } },
});
const tool = (createdAt) => ({ id: `tool-${createdAt}`, kind: "tool.completed", createdAt, summary: "ran tests" });
const thread = (activities, extra = {}) => ({ id: THREAD_ID, session: { status: "running", activeTurnId: "turn-1" },
  modelSelection: { model: "gpt-6-sol" }, updatedAt: STALLED_AT, activities, ...extra });
const stalled = () => thread([tool("2026-10-27T09:59:00.000Z"), disconnect429(5)]);

test("429 reconnect tail idle past the window is stalled with a parsed summary only", () => {
  const stall = threadStreamStall(stalled(), { now: at(11) });
  assert.deepEqual(stall, { reason: "stream-disconnected", idleSince: STALLED_AT, idleForMs: 11 * 60_000,
    lastError: { kind: "runtime.warning", httpStatusCode: 429, reconnectAttempt: "5/5", retryLimitExceeded: true,
      summary: "stream disconnected, HTTP 429, reconnect 5/5, retry limit exceeded" } });
  assert.doesNotMatch(JSON.stringify(stall), new RegExp(PROVIDER_CANARY));
});

test("the idle window is a strict bound and configurable", () => {
  assert.equal(threadStreamStall(stalled(), { now: at(10) }), null);
  assert.notEqual(threadStreamStall(stalled(), { now: at(3), idleMs: 2 * 60_000 }), null);
  assert.equal(streamStallIdleMs({}), STREAM_STALL_IDLE_MS);
  assert.equal(streamStallIdleMs({ TENTACLES_STALL_IDLE_MINUTES: "2" }), 120_000);
  assert.equal(streamStallIdleMs({ TENTACLES_STALL_IDLE_MINUTES: "-1" }), STREAM_STALL_IDLE_MS);
});

test("healthy threads are never stalled", () => {
  const healthy = thread([disconnect429(1), tool("2026-10-27T10:01:00.000Z")], { updatedAt: "2026-10-27T10:01:00.000Z" });
  assert.equal(threadStreamStall(healthy, { now: at(60) }), null, "an event after the warning");
  assert.equal(threadStreamStall(thread([tool(STALLED_AT)]), { now: at(60) }), null, "idle without a disconnect");
  const otherWarning = { id: "w", kind: "runtime.warning", createdAt: STALLED_AT, payload: { message: "Windows world-writable warning" } };
  assert.equal(threadStreamStall(thread([otherWarning]), { now: at(60) }), null, "an unrelated warning");
  assert.equal(threadStreamStall(stalled(), { now: at(60) - 50 * 60_000 }), null, "inside the window");
  // A later snapshot stamp (e.g. a streaming message) is activity too.
  assert.equal(threadStreamStall(thread([disconnect429(5)], { updatedAt: "2026-10-27T10:20:00.000Z" }), { now: at(25) }), null);
});

test("report says stalled only for a generating turn; other statuses keep their meaning", () => {
  const document = projectThreadReport(stalled(), THREAD_ID, { now: at(11) });
  assert.equal(document.status, "stalled");
  assert.equal(document.stall.lastError.httpStatusCode, 429);
  assert.equal(document.lastError, null);
  assert.equal(projectThreadReport(stalled(), THREAD_ID, { now: at(5) }).status, "generating");
  assert.equal(projectThreadReport(stalled(), THREAD_ID, { now: at(5) }).stall, undefined);
  const settled = projectThreadReport({ ...stalled(), settledAt: STALLED_AT }, THREAD_ID, { now: at(60) });
  assert.equal(settled.status, "Done");
  const idle = projectThreadReport({ ...stalled(), session: { status: "ready" } }, THREAD_ID, { now: at(60) });
  assert.equal(idle.status, "ready/idle");
  const blocked = projectThreadReport({ ...stalled(), hasPendingApprovals: true }, THREAD_ID, { now: at(60) });
  assert.equal(blocked.status, "blocked");
});

test("report() and observe() expose the stall through their public reads", async () => {
  const client = {
    thread: async () => ({ thread: stalled() }),
    snapshot: async () => ({ projects: [], threads: [stalled(), { ...thread([tool(STALLED_AT)]), id: "healthy" }] }),
    archivedShell: async () => ({ threads: [] }),
  };
  assert.equal((await report(client, THREAD_ID, { now: at(11) })).status, "stalled");
  const state = await observe(client, { now: at(11) });
  assert.deepEqual(state.stalledTurns.map((entry) => [entry.threadId, entry.status]), [[THREAD_ID, "stalled"]]);
  assert.equal(state.counts.stalledTurns, 1);
  assert.equal(state.counts.activeTurns, 2, "stalled turns still hold a seat");
  assert.deepEqual((await observe(client, { now: at(5) })).stalledTurns, []);
});
