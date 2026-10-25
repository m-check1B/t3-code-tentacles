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
    page = await threadEvents(client, { threadId: THREAD, afterSequence: cursor, limit: 2 }, { directory });
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

test("without latestTurn the newest turn ends from session state, never while live", (t) => {
  const { thread } = setup(t);
  thread.messages.push({ id: "a1", role: "assistant", text: "Hi", turnId: "turn-1", createdAt: WHEN });
  thread.session = { status: "running" };
  assert.equal(turnEnds(projectThreadEvents(thread).events).length, 0, "running without activeTurnId may be live");
  thread.session = { status: "ready" };
  assert.deepEqual(turnEnds(projectThreadEvents(thread).events)[0].payload, { turnId: "turn-1", outcome: "succeeded" });
  thread.session = { status: "error", lastError: "Provider instance 'grok' is not ready" };
  assert.equal(turnEnds(projectThreadEvents(thread).events)[0].payload.code, "lab_not_ready");
});
