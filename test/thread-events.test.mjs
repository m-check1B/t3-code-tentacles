import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { threadEvents, threadArtifact, projectThreadEvents, recordThreadEvents } from "../src/thread-events.mjs";
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
