import assert from "node:assert/strict";
import test from "node:test";
import { T3Client } from "../src/t3-client.mjs";
import { threadArchive, threadTurnInterrupt, threadTurnStart } from "../src/orchestrate.mjs";
import { shellToV1, threadDetailToV1, translateCommand, T3V2UnsupportedError } from "../src/t3-v2.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("continue pins full-access then dispatches a V2 message with the same ids", async () => {
  const command = threadTurnStart({ commandId: "cmd-1", threadId: "thread-1", messageId: "msg-1", text: "hello", runtimeMode: "full-access", modelSelection: { instanceId: "codex", model: "gpt-6-sol", options: [] } });
  const steps = await translateCommand(command);
  assert.deepEqual(steps.map((step) => [step.method, step.payload.type, step.payload.commandId]), [
    ["orchestration.dispatchCommand", "thread.runtime-mode.set", "cmd-1:runtime-mode"],
    ["orchestration.dispatchMessageWithMode", "message.dispatch", "cmd-1"],
  ]);
  const message = steps[1].payload;
  assert.equal(message.messageId, "msg-1");
  assert.equal(message.text, "hello");
  assert.equal(message.runtimeMode, "full-access");
  assert.equal(message.deliveryIntent, "auto");
  assert.deepEqual(message.dispatchMode, { type: "start_immediately" });
  assert.equal(message.createdAt, undefined);
  assert.equal(steps[0].payload.runtimeMode, "full-access");
});

test("unknown commands and unknown fields fail closed before any dispatch", async () => {
  await assert.rejects(translateCommand({ ...threadArchive({ threadId: "t" }), surprise: 1 }), T3V2UnsupportedError);
  await assert.rejects(translateCommand({ type: "thread.checkpoint.revert", commandId: "c", threadId: "t", turnCount: 0 }), /does not support/);
  const turn = threadTurnStart({ threadId: "t", text: "x", runtimeMode: "full-access" });
  await assert.rejects(translateCommand({ ...turn, message: { ...turn.message, extra: true } }), /unknown turn message field: extra/);
});

test("interrupt targets the active V2 run, and is a no-op without one", async () => {
  const runs = [{ id: "run-1", status: "completed" }, { id: "run-2", status: "running" }];
  const [step] = await translateCommand(threadTurnInterrupt({ commandId: "c", threadId: "t" }), { readProjection: async () => ({ runs }) });
  assert.deepEqual(step.payload, { type: "run.interrupt", commandId: "c", threadId: "t", runId: "run-2" });
  assert.deepEqual(await translateCommand(threadTurnInterrupt({ commandId: "c", threadId: "t" }), { readProjection: async () => ({ runs: runs.slice(0, 1) }) }), []);
});

test("V2 reads map to the V1 thread shape the report and waits use", () => {
  const thread = { id: "t", projectId: "p", title: "Neutral", modelSelection: { instanceId: "codex", model: "gpt-6-sol" }, providerInstanceId: "codex", runtimeMode: "full-access", settledAt: null };
  const detail = threadDetailToV1({ snapshotSequence: 3, projection: {
    thread,
    runs: [{ id: "run-1", ordinal: 1, status: "failed" }],
    turnItems: [{ runId: "run-1", type: "error", failure: { message: "limit" } }],
    runtimeRequests: [],
    messages: [{ id: "m1", role: "user", text: "hi", runId: "run-1", streaming: false }, { id: "m2", role: "assistant", text: "", runId: "run-1", streaming: false }],
    updatedAt: "2026-10-20T00:00:00.000Z",
  } }, "t");
  assert.equal(detail.thread.session.status, "error");
  assert.equal(detail.thread.session.lastError, "limit");
  assert.deepEqual(detail.thread.messages.map((message) => message.id), ["m1", "m2"]);
  assert.throws(() => threadDetailToV1({ projection: { thread } }, "other"), /identity mismatch/);
  const shell = shellToV1({ schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [{ ...thread, status: "waiting", activeRunId: "run-2", pendingRuntimeRequest: { kind: "user_input" } }] });
  assert.equal(shell.threads[0].session.status, "running");
  assert.equal(shell.threads[0].hasPendingUserInput, true);
  assert.throws(() => shellToV1({ schemaVersion: 3, threads: [] }), /schemaVersion 3/);
  assert.throws(() => shellToV1({ schemaVersion: 2, threads: [{ ...thread, status: "brand-new" }] }), /does not know thread status/);
});

test("protocol detection: descriptor v2, missing descriptor v1, unknown version refused", async () => {
  const client = (response) => new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", fetchImpl: async () => response() });
  assert.equal(await client(() => json({ orchestrationProtocolVersion: 2 })).protocol(), 2);
  assert.equal(await client(() => json({ label: "older" })).protocol(), 1);
  assert.equal(await client(() => new Response("", { status: 404 })).protocol(), 1);
  await assert.rejects(client(() => json({ orchestrationProtocolVersion: 3 })).protocol(), /protocol 3 is not supported/);
  assert.throws(() => new T3Client({ token: "synthetic", orchestrationProtocol: "7" }), /must be auto, 1 or 2/);
});

test("V2 dispatch sends each translated step over RPC and sends the protocol header on reads", async () => {
  const seen = [];
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", orchestrationProtocol: 2, fetchImpl: async (url, init) => {
    seen.push([new URL(url).pathname, init.headers["x-t3-orchestration-protocol"]]);
    return json(new URL(url).pathname.includes("/threads/") ? {projection:{thread:{id:"t",runtimeMode:"full-access"}}} : { schemaVersion: 2, snapshotSequence: 0, projects: [], threads: [] });
  } });
  const rpcs = [];
  client.rpc = async (method, payload, { beforeSend } = {}) => { if (beforeSend) await beforeSend(); rpcs.push([method, payload.type]); return { sequence: rpcs.length }; };
  const result = await client.dispatch(threadTurnStart({ commandId: "c", threadId: "t", text: "x", runtimeMode: "full-access" }));
  assert.deepEqual(rpcs, [["orchestration.dispatchCommand", "thread.runtime-mode.set"], ["orchestration.dispatchMessageWithMode", "message.dispatch"]]);
  assert.deepEqual(result, { sequence: 2, protocol: 2 });
  await client.snapshot();
  assert.deepEqual(seen, [["/api/orchestration/threads/t", "2"], ["/api/orchestration/shell", "2"]]);
});

test("session stop interrupts the active run and holds the queue; idle threads read as stopped", async () => {
  const [step] = await translateCommand({ type: "thread.session.stop", commandId: "c", threadId: "t", createdAt: "x" }, { readProjection: async () => ({ runs: [{ id: "run-1", status: "waiting" }] }) });
  assert.deepEqual(step.payload, { type: "thread.stop", commandId: "c", threadId: "t" });
  const shell = shellToV1({ schemaVersion: 2, threads: [{ id: "t", status: "completed" }, { id: "u", status: "idle" }] });
  assert.deepEqual(shell.threads.map((thread) => thread.session.status), ["stopped", "stopped"]);
});

test("on protocol 2 an intent with an unknown field is rejected before any dispatch", async () => {
  const { applyIntent, IntentDispatchError } = await import("../src/orchestrate.mjs");
  let dispatched = 0;
  const client = { protocol: async () => 2, dispatch: async () => { dispatched++; return { sequence: 1 }; } };
  await assert.rejects(applyIntent(client, { action: "thread.pin", threadId: "t", bogus: 1 }, { wait: false }), /unknown field\(s\): bogus/);
  assert.equal(dispatched, 0);
  await assert.rejects(applyIntent({ ...client, dispatch: async () => { throw new T3V2UnsupportedError("T3 V2 adapter does not support thread.checkpoint.revert"); } }, { action: "thread.checkpoint.revert", threadId: "t", turnCount: 0 }, { wait: false }), (error) => error instanceof IntentDispatchError && error.receipt.status === "rejected" && /does not support/.test(error.message));
});
