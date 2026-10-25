import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { threadEvents, threadArtifact, projectThreadEvents, recordThreadEvents, findSequenceGap } from "../src/thread-events.mjs";
import { LoopbackRuntimeAdapter, RemoteRpcShim } from "../src/outbound-pairer.mjs";

const THREAD = "313a9a59-ff51-405c-a655-d6ef4fc46b3a";
const WHEN = "2026-09-30T10:00:00.000Z";
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-events-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const thread = { id: THREAD, messages: [{ id: "m1", role: "user", text: "Hello", createdAt: WHEN }],
    session: { status: "ready" }, activities: [], checkpoints: [] };
  return { directory, thread, client: { thread: async () => ({ thread }) } };
}

test("journal is idempotent and resumes after a process/runtime reconnect", async (t) => {
  const { directory, thread, client } = setup(t);
  const first = await threadEvents(client, { threadId: THREAD, limit: 1 }, { directory });
  assert.equal(first.nextSequence, 1);
  assert.equal(first.events[0].payload.messageId, "m1");
  assert.equal(first.hasMore, true);
  assert.deepEqual(await threadEvents(client, { threadId: THREAD, limit: 1 }, { directory }), first);
  thread.messages.push({ id: "m2", role: "assistant", text: "Done", createdAt: WHEN });
  const resumed = await threadEvents(client, { threadId: THREAD, afterSequence: 1 }, { directory });
  assert.deepEqual(resumed.events.map((event) => event.sequence), [2, 3]);
  assert.equal(resumed.events.at(-1).eventId, "message:m2");
  assert.equal(fs.statSync(path.join(directory, `${THREAD}.json`)).mode & 0o777, 0o600);
});

test("streamed messages wait until completion and conflicting source IDs fail closed", async (t) => {
  const { directory, thread, client } = setup(t);
  thread.messages[0].role = "assistant"; thread.messages[0].streaming = true;
  assert.equal(projectThreadEvents(thread).events.length, 0);
  thread.messages[0].streaming = false;
  await threadEvents(client, { threadId: THREAD }, { directory });
  thread.messages[0].text = "Changed";
  await assert.rejects(threadEvents(client, { threadId: THREAD }, { directory }), /changed after journaling/);
});

test("tool summaries never include raw tool payloads; memory is explicit user only", (t) => {
  const { thread } = setup(t);
  thread.messages[0].text = "Remember: Blue is preferred.";
  thread.activities = [{ id: "tool1", kind: "tool.completed", summary: "Created report",
    createdAt: WHEN, payload: { rawOutput: "private-sentinel" } }];
  const projected = projectThreadEvents(thread);
  assert.equal(projected.events.find((event) => event.kind === "memory").payload.sourceEventId, "message:m1");
  assert.ok(!JSON.stringify(projected).includes("private-sentinel"));
  thread.messages[0].role = "assistant";
  assert.ok(!projectThreadEvents(thread).events.some((event) => event.kind === "memory"));
});

test("real T3 attachment and checkpoint producers yield bounded manifest/chunk transport", async (t) => {
  const { directory, thread, client } = setup(t);
  const content = Buffer.alloc(800000, 97);
  thread.messages[0].attachments = [{ type: "file", id: "att1", name: "result.bin", mimeType: "application/octet-stream", sizeBytes: content.length }];
  thread.checkpoints = [{ status: "ready", checkpointRef: "ref1", completedAt: WHEN,
    files: [{ path: "output/result.txt", kind: "added" }, { path: ".env", kind: "added" }] }];
  const resources = [];
  client.baseUrl = "http://127.0.0.1:3773";
  client.requestTimeoutMs = 1000;
  client.rpc = async (method, params) => {
    assert.equal(method, "assets.createUrl"); resources.push(params.resource);
    return { relativeUrl: "/api/assets/test/file" };
  };
  client.fetchImpl = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:3773/api/assets/test/file");
    assert.equal(options.redirect, "error");
    return new Response(content);
  };
  const page = await threadEvents(client, { threadId: THREAD }, { directory });
  assert.equal(page.events.filter((event) => event.kind === "artifact").length, 2);
  assert.equal(resources[0]._tag, "attachment");
  assert.equal(resources[1]._tag, "workspace-file");
  assert.equal(resources[1].path, "output/result.txt");
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 750000);
  const manifest = page.events.find((event) => event.kind === "artifact");
  const pieces = []; let offset = 0;
  while (offset < content.length) {
    const chunk = threadArtifact({ threadId: THREAD, eventId: manifest.eventId, offset }, { directory });
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 750000);
    pieces.push(Buffer.from(chunk.contentBase64, "base64")); offset = chunk.nextOffset;
  }
  assert.deepEqual(Buffer.concat(pieces), content);
  assert.throws(() => threadArtifact({ threadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", eventId: manifest.eventId }, { directory }), /not journaled/);
});

test("RPC advertises and routes thread events while sanitizing errors", async (t) => {
  const { directory, client } = setup(t);
  const shim = new RemoteRpcShim(new LoopbackRuntimeAdapter({ client, threadEventsDirectory: directory }));
  const response = await shim.handle({ version: 1, type: "rpc.request", id: "r1", method: "thread-events", params: { threadId: THREAD } });
  assert.equal(response.type, "rpc.result");
  assert.equal(response.result.events[0].eventId, "message:m1");
  const bad = await shim.handle({ version: 1, type: "rpc.request", id: "r2", method: "thread-artifact", params: { threadId: THREAD, eventId: "bad" } });
  assert.equal(bad.type, "rpc.error");
  assert.equal(bad.error.message, "Computer unavailable");
});

test("cursor ahead, pagination truncation, path traversal and symlink journals fail closed", async (t) => {
  const { directory, thread, client } = setup(t);
  await assert.rejects(threadEvents(client, { threadId: THREAD, afterSequence: 200 }, { directory }), /ahead/);
  await assert.rejects(threadEvents({ thread: async () => ({ thread, page: { hasMore: true } }) }, { threadId: THREAD }, { directory }), /Incomplete/);
  await assert.rejects(threadEvents(client, { threadId: "../bad" }, { directory }), /Invalid/);
  const file = path.join(directory, `${THREAD}.json`);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(directory, "missing"), file);
  assert.throws(() => recordThreadEvents(THREAD, [], { directory }));
});

test("dead exporter locks recover without resetting a committed cursor", async (t) => {
  const { directory, client } = setup(t);
  const first = await threadEvents(client, { threadId: THREAD }, { directory });
  const lock = path.join(directory, `${THREAD}.json.lock`);
  fs.writeFileSync(lock, JSON.stringify({ version: 1, owner: "11111111-1111-4111-8111-111111111111", pid: 2147483647 }), { mode: 0o600 });
  const resumed = await threadEvents(client, { threadId: THREAD, afterSequence: first.nextSequence }, { directory });
  assert.deepEqual(resumed.events, []);
  assert.equal(resumed.nextSequence, first.nextSequence);
  assert.equal(fs.existsSync(lock), false);
});

test("multiline explicit memory marks remain candidates for full-message Jack validation", (t) => {
  const { thread } = setup(t);
  thread.messages[0].text = "Please keep these preferences.\nRemember: Prefer blue.\n  Remember that Use metric units.\n```text\nFact: Quoted sample only.\n```\nDo not save this message.";
  const projected = projectThreadEvents(thread);
  const candidates = projected.events.filter((event) => event.kind === "memory");
  assert.deepEqual(candidates.map((event) => event.payload.text), [
    "Prefer blue.", "Use metric units.", "Quoted sample only.",
  ]);
  assert.ok(candidates.every((event) => event.payload.sourceEventId === "message:m1"));
  assert.equal(projected.events.find((event) => event.kind === "message").payload.text, thread.messages[0].text);
  assert.ok(candidates.every((event) => !Object.hasOwn(event.payload, "accepted")));
});

test("KRA-6577: one bad attachment or unreadable file never freezes the journal", async (t) => {
  const { directory, thread, client } = setup(t);
  thread.messages[0].attachments = [
    { type: "file", id: "bad", name: "a/b.txt", mimeType: "text/plain", sizeBytes: 3 },
    { type: "file", id: "late", name: "late.txt", mimeType: "text/plain", sizeBytes: 3 },
  ];
  thread.checkpoints = [{ status: "ready", checkpointRef: "ref1", completedAt: WHEN,
    files: [{ path: "../escape.txt", kind: "added" }, { path: "reports/q3.txt", kind: "added" }] }];
  let available = false;
  const read = [];
  client.baseUrl = "http://127.0.0.1:3773";
  client.requestTimeoutMs = 1000;
  client.rpc = async (_method, params) => { read.push(params.resource); return { relativeUrl: "/api/assets/x" }; };
  client.fetchImpl = async () => (available ? new Response("abc") : new Response("gone", { status: 404 }));

  const first = await threadEvents(client, { threadId: THREAD }, { directory });
  const kinds = (page) => page.events.map((event) => event.kind).filter((kind) => kind !== "state").sort();
  assert.deepEqual(kinds(first), ["message"]);
  // The traversal path and the bad name are never read.
  assert.ok(read.every((resource) => resource.fileName !== "a/b.txt" && resource.path !== "../escape.txt"));

  thread.messages.push({ id: "m2", role: "assistant", text: "Later", createdAt: WHEN });
  available = true;
  const second = await threadEvents(client, { threadId: THREAD, afterSequence: first.nextSequence }, { directory });
  assert.deepEqual(kinds(second), ["artifact", "artifact", "message"]);
  assert.ok(second.events.some((event) => event.eventId === "message:m2"));
});

// ── KRA-8958: gap-free sequence and exactly one terminal event per turn ──────

const LATER = "2026-09-30T11:00:00.000Z";
const turnEnds = (events) => events.filter((event) => event.kind === "turn_end");

async function drain(client, directory) {
  const all = []; let cursor = 0; let page;
  do {
    page = await threadEvents(client, { threadId: THREAD, afterSequence: cursor, limit: 2, includeTurnEnd: true }, { directory });
    assert.equal(findSequenceGap(page), null, "every page resumes exactly at its cursor");
    all.push(...page.events); cursor = page.nextSequence;
  } while (page.hasMore);
  return all;
}

test("a reader resuming from a cursor detects a missing sequence number", async (t) => {
  const { directory, thread, client } = setup(t);
  thread.messages.push({ id: "m2", role: "assistant", text: "One", turnId: "turn-1", createdAt: WHEN },
    { id: "m3", role: "user", text: "Again", createdAt: LATER });
  const page = await threadEvents(client, { threadId: THREAD, afterSequence: 1 }, { directory });
  assert.equal(findSequenceGap(page), null);
  assert.ok(page.events.length >= 3);
  assert.deepEqual(page.events.map((event) => event.sequence), page.events.map((_, index) => index + 2));
  const dropped = { ...page, events: [page.events[0], ...page.events.slice(2)] };
  assert.equal(findSequenceGap(dropped), 3);
  assert.equal(findSequenceGap({ ...page, events: page.events.slice(1) }), 2, "first event after the cursor missing");
  assert.equal(findSequenceGap({ ...page, nextSequence: page.nextSequence + 1 }), page.nextSequence + 1, "tail dropped");
  assert.equal(findSequenceGap({ ...page, events: [...page.events].reverse() }), 2, "reordered");
  // The durable journal itself refuses to serve a gapped history.
  const file = path.join(directory, `${THREAD}.json`);
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify(journal.filter((event) => event.sequence !== 2)), { mode: 0o600 });
  await assert.rejects(threadEvents(client, { threadId: THREAD, afterSequence: 0 }, { directory }), /Invalid thread journal sequence/);
});

test("each turn ends with exactly one terminal event across polls and turn changes", async (t) => {
  const { directory, thread, client } = setup(t);
  thread.messages[0].turnId = "turn-1";
  // turn-1 is live: no terminal event yet.
  thread.session = { status: "running", activeTurnId: "turn-1" };
  thread.latestTurn = { turnId: "turn-1", state: "running", completedAt: null };
  assert.equal(turnEnds(await drain(client, directory)).length, 0);
  // turn-1 fails on a usage limit; the terminal event is typed and redacted.
  thread.messages.push({ id: "a1", role: "assistant", text: "Partial", turnId: "turn-1", createdAt: WHEN });
  thread.session = { status: "error", activeTurnId: null, lastError: "You've hit your usage limit sk-FAKE0kra8958redactionCanary0000" };
  thread.latestTurn = { turnId: "turn-1", state: "error", completedAt: "2026-09-30T10:05:00.000Z" };
  await drain(client, directory);
  // Repeated polls, then turn-2 starts and succeeds: turn-1 is re-observed as
  // an older turn but keeps its first terminal event.
  await drain(client, directory);
  thread.messages.push({ id: "m4", role: "user", text: "Retry", turnId: "turn-2", createdAt: LATER });
  thread.session = { status: "running", activeTurnId: "turn-2", lastError: null };
  thread.latestTurn = { turnId: "turn-2", state: "running", completedAt: null };
  await drain(client, directory);
  thread.messages.push({ id: "a2", role: "assistant", text: "Done", turnId: "turn-2", createdAt: "2026-09-30T11:01:00.000Z" });
  thread.session = { status: "ready", activeTurnId: null, lastError: null };
  thread.latestTurn = { turnId: "turn-2", state: "completed", completedAt: "2026-09-30T11:02:00.000Z" };
  const events = await drain(client, directory);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1), "gap-free");
  const ends = turnEnds(events);
  assert.deepEqual(ends.map((event) => event.payload.turnId).sort(), ["turn-1", "turn-2"]);
  for (const turnId of ["turn-1", "turn-2"]) {
    assert.equal(ends.filter((event) => event.payload.turnId === turnId).length, 1, `${turnId} has exactly one end`);
  }
  const first = ends.find((event) => event.payload.turnId === "turn-1");
  assert.deepEqual(first.payload, { turnId: "turn-1", outcome: "failed", code: "usage_limit",
    message: "The provider usage limit was reached; route to a fallback lab or retry later." });
  assert.equal(JSON.stringify(events).includes("sk-FAKE0kra8958"), false);
  assert.deepEqual(ends.find((event) => event.payload.turnId === "turn-2").payload, { turnId: "turn-2", outcome: "succeeded" });
  // A turn never observed as latest still ends once, with an unknown outcome.
  const unobserved = projectThreadEvents({ ...thread, messages: [...thread.messages,
    { id: "a3", role: "assistant", text: "Three", turnId: "turn-3", createdAt: "2026-09-30T12:00:00.000Z" }],
    latestTurn: { turnId: "turn-4", state: "cancelled", completedAt: "2026-09-30T13:00:00.000Z" } });
  assert.deepEqual(turnEnds(unobserved.events).map((event) => [event.payload.turnId, event.payload.outcome]),
    [["turn-1", "unknown"], ["turn-2", "unknown"], ["turn-3", "unknown"], ["turn-4", "cancelled"]]);
});

test("the newest turn ends from session state, never while live", (t) => {
  const { thread } = setup(t);
  thread.messages.push({ id: "a1", role: "assistant", text: "Hi", turnId: "turn-1", createdAt: WHEN });
  thread.session = { status: "running" };
  assert.equal(turnEnds(projectThreadEvents(thread).events).length, 0, "running without activeTurnId may be live");
  // A stale terminal latestTurn never ends the turn the session still runs.
  thread.session = { status: "running", activeTurnId: "turn-1" };
  thread.latestTurn = { turnId: "turn-1", state: "completed", completedAt: LATER };
  assert.equal(turnEnds(projectThreadEvents(thread).events).length, 0, "live turn wins over a stale latestTurn");
  delete thread.latestTurn;
  thread.session = { status: "ready" };
  assert.deepEqual(turnEnds(projectThreadEvents(thread).events)[0].payload, { turnId: "turn-1", outcome: "succeeded" });
  thread.session = { status: "error", lastError: "Provider instance 'grok' is not ready" };
  assert.equal(turnEnds(projectThreadEvents(thread).events)[0].payload.code, "lab_not_ready");
});

// ── KRA-8958 R2: base readers never see turn_end; B3 repros ─────────────────

const BASE_KINDS = new Set(["message", "tool_summary", "artifact", "state", "memory"]);
const exactKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());

// Mirrors Jack's ThreadEventsPage: base kinds only, extra fields forbidden,
// contiguous sequences from the cursor and an exact nextSequence.
function strictBaseReader(page) {
  exactKeys(page, ["threadId", "afterSequence", "events", "nextSequence", "hasMore"]);
  let cursor = page.afterSequence;
  for (const event of page.events) {
    exactKeys(event, ["threadId", "eventId", "sequence", "occurredAt", "kind", "payload"]);
    assert.ok(BASE_KINDS.has(event.kind), `strict reader rejects kind ${event.kind}`);
    assert.equal(event.sequence, cursor + 1, "strict reader rejects a sequence gap");
    cursor = event.sequence;
  }
  assert.equal(page.nextSequence, cursor);
  assert.equal(page.hasMore && page.events.length === 0, false);
  return page;
}

function turnJournalThread(thread) {
  thread.messages[0].turnId = "turn-1";
  thread.messages.push({ id: "a1", role: "assistant", text: "One", turnId: "turn-1", createdAt: WHEN },
    { id: "u2", role: "user", text: "Two", createdAt: LATER },
    { id: "a2", role: "assistant", text: "Done", turnId: "turn-2", createdAt: "2026-09-30T11:01:00.000Z" });
  thread.session = { status: "ready" };
  thread.latestTurn = { turnId: "turn-2", state: "completed", completedAt: "2026-09-30T11:02:00.000Z" };
}

test("a strict base reader drains a journal with turn_end without gaps; opt-in sees the ends", async (t) => {
  const { directory, thread, client } = setup(t);
  turnJournalThread(thread);
  const optIn = await threadEvents(client, { threadId: THREAD, includeTurnEnd: true }, { directory });
  assert.equal(turnEnds(optIn.events).length, 2, "journal holds turn_end events");
  const base = []; let cursor = 0; let page;
  do {
    page = strictBaseReader(await threadEvents(client, { threadId: THREAD, afterSequence: cursor, limit: 2 }, { directory }));
    base.push(...page.events); cursor = page.nextSequence;
  } while (page.hasMore);
  assert.deepEqual(base.map((event) => event.eventId), optIn.events.filter((event) => event.kind !== "turn_end").map((event) => event.eventId));
  assert.deepEqual(base.map((event) => event.sequence), base.map((_, index) => index + 1));
  // The base cursor keeps advancing past later turn_end events.
  thread.messages.push({ id: "u3", role: "user", text: "Three", createdAt: "2026-09-30T12:00:00.000Z" });
  const next = strictBaseReader(await threadEvents(client, { threadId: THREAD, afterSequence: cursor }, { directory }));
  assert.deepEqual(next.events.map((event) => event.eventId), ["message:u3"]);
  assert.equal(next.events[0].sequence, cursor + 1);
  // A base cursor beyond the base view is refused, not silently reset.
  await assert.rejects(threadEvents(client, { threadId: THREAD, afterSequence: next.nextSequence + 1 }, { directory }),
    /cursor is ahead/);
  // The opt-in flag is strict and the journal keeps its own sequences.
  await assert.rejects(threadEvents(client, { threadId: THREAD, includeTurnEnd: "yes" }, { directory }), /Invalid thread-events/);
  const all = await threadEvents(client, { threadId: THREAD, includeTurnEnd: true, limit: 200 }, { directory });
  assert.deepEqual(all.events.map((event) => event.sequence), all.events.map((_, index) => index + 1));
});

test("B3 LIVE: a running session never ends a message turn newer than a terminal latestTurn", (t) => {
  const { thread } = setup(t);
  thread.messages = [
    { id: "a1", role: "assistant", text: "done", turnId: "t1", createdAt: WHEN },
    { id: "u2", role: "user", text: "go", createdAt: "2026-09-30T10:10:00.000Z" },
    { id: "a2", role: "assistant", text: "working, step 1", turnId: "t2", createdAt: "2026-09-30T10:11:00.000Z" }];
  thread.session = { status: "running" };
  thread.latestTurn = { turnId: "t1", state: "completed", completedAt: WHEN };
  assert.deepEqual(turnEnds(projectThreadEvents(thread).events).map((event) => [event.payload.turnId, event.payload.outcome]),
    [["t1", "succeeded"]]);
});

test("B3 RACE: a turn_end journaled by a concurrent poller drops the later observation", async (t) => {
  const { directory, thread, client } = setup(t);
  thread.messages.push({ id: "a1", role: "assistant", text: "x", turnId: "t1", createdAt: WHEN });
  thread.latestTurn = { turnId: "t1", state: "completed", completedAt: WHEN };
  const asOlder = structuredClone(thread);
  asOlder.messages.push({ id: "a2", role: "assistant", text: "y", turnId: "t2", createdAt: "2026-09-30T10:20:00.000Z" });
  asOlder.latestTurn = { turnId: "t2", state: "completed", completedAt: "2026-09-30T10:21:00.000Z" };
  // B projects before A journals, so B still carries turn:t1 as `unknown`.
  const projectedByB = projectThreadEvents(asOlder);
  assert.equal(turnEnds(projectedByB.events).find((event) => event.eventId === "turn:t1").payload.outcome, "unknown");
  await threadEvents(client, { threadId: THREAD }, { directory });
  const journal = recordThreadEvents(THREAD, projectedByB.events, { directory });
  const ends = turnEnds(journal);
  assert.deepEqual(ends.map((event) => [event.payload.turnId, event.payload.outcome]), [["t1", "succeeded"], ["t2", "succeeded"]]);
  // Content drift on other kinds still fails closed.
  assert.throws(() => recordThreadEvents(THREAD, [{ eventId: "message:a1", kind: "message", occurredAt: WHEN,
    payload: { role: "assistant", text: "changed", messageId: "a1", turnId: "t1" } }], { directory }), /Source event changed/);
});

test("B3 MISATTRIBUTION: without latestTurn, a failure after a newer user message ends no turn", (t) => {
  const { thread } = setup(t);
  thread.messages = [
    { id: "a1", role: "assistant", text: "done", turnId: "t1", createdAt: WHEN },
    { id: "u2", role: "user", text: "go", createdAt: "2026-09-30T10:10:00.000Z" }];
  thread.session = { status: "error", lastError: "boom" };
  assert.deepEqual(turnEnds(projectThreadEvents(thread).events), []);
  thread.session = { status: "interrupted" };
  assert.deepEqual(turnEnds(projectThreadEvents(thread).events), []);
  // Without a newer user message the failure is still attributed.
  thread.messages.pop();
  thread.session = { status: "error", lastError: "boom" };
  assert.deepEqual(turnEnds(projectThreadEvents(thread).events).map((event) => [event.payload.turnId, event.payload.outcome]),
    [["t1", "failed"]]);
});

test("KRA-8998: a ready session never ends a message turn newer than latestTurn as unknown", async (t) => {
  const { directory, thread, client } = setup(t);
  thread.messages = [
    { id: "a1", role: "assistant", text: "done", turnId: "t1", createdAt: WHEN },
    { id: "u2", role: "user", text: "go", createdAt: "2026-09-30T10:10:00.000Z" },
    { id: "a2", role: "assistant", text: "also done", turnId: "t2", createdAt: "2026-09-30T10:11:00.000Z" }];
  thread.session = { status: "ready" };
  thread.latestTurn = { turnId: "t1", state: "completed", completedAt: WHEN };
  const outcomes = (events) => turnEnds(events).map((event) => [event.payload.turnId, event.payload.outcome]);
  assert.deepEqual(outcomes(projectThreadEvents(thread).events), [["t1", "succeeded"]]);
  await threadEvents(client, { threadId: THREAD, includeTurnEnd: true }, { directory });
  // T3 publishes t2 as latestTurn on a later poll: its real outcome is journaled.
  thread.latestTurn = { turnId: "t2", state: "error", completedAt: "2026-09-30T10:12:00.000Z" };
  const page = await threadEvents(client, { threadId: THREAD, includeTurnEnd: true }, { directory });
  assert.deepEqual(outcomes(page.events), [["t1", "succeeded"], ["t2", "failed"]]);
});

test("KRA-8998: the sequence-gap finder refuses a cursor that is not a safe integer", () => {
  const page = { afterSequence: 0, events: [], nextSequence: 0 };
  assert.equal(findSequenceGap(page), null);
  for (const cursor of [Number.NaN, 1.5, -1, "0", Number.MAX_SAFE_INTEGER, 2 ** 60, Infinity]) {
    assert.throws(() => findSequenceGap({ ...page, afterSequence: cursor }), /Invalid thread-events cursor/, String(cursor));
  }
  assert.equal(findSequenceGap(null, 4), 5, "a malformed page at a valid cursor still reports the next sequence");
});
