// KRA-10175 / KRA-10176: one build drives both the patched T3 v2
// (jack/upstream-0.1.0: server.getSettings, orchestration.dispatchMessageWithMode,
// patched turn-result route) and upstream T3 Code Nightly 0.1.8 (server.getConfig
// settings, message.dispatch via orchestration.dispatchCommand, no turn-result
// route). The upstream half replays a recorded, allow-listed contract fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";
import { doctor, probeTalkCapabilities } from "../src/bridge.mjs";
import { isUnknownTagExit, nativeTurnResult, safeResultId, T3RpcRejectedError, T3V2UnsupportedError, upstreamMessageStep } from "../src/t3-v2.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";

const NIGHTLY = JSON.parse(fs.readFileSync(new URL("./fixtures/t3-nightly-0.1.8-contract.json", import.meta.url), "utf8"));
const THREAD_ID = NIGHTLY.threadDetail.projection.thread.id;
const RUN_1 = NIGHTLY.threadDetail.projection.runs.find((run) => run.ordinal === 1);

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
const clone = (value) => JSON.parse(JSON.stringify(value));

const PATCHED_SETTINGS = { providerInstances: { grok: { driver: "grok", enabled: true } } };
const PATCHED_TALK = { talkTurnResult: "v1" };

/**
 * A real T3Client whose transport replays one server shape. `rpc` keeps the
 * client's own error classification: an unknown tag is replayed as the exact
 * recorded upstream exit, so the client must classify it itself.
 */
function server(shape, { threadDetail = NIGHTLY.threadDetail, patchedTurnResult } = {}) {
  const rpcs = [];
  const reads = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    reads.push([init.method ?? "GET", pathname]);
    if (pathname === "/.well-known/t3/environment") return json({ orchestrationProtocolVersion: 2 });
    if (pathname === "/api/orchestration/shell") return json({ schemaVersion: 2, snapshotSequence: 1, projects: [], threads: [] });
    if (pathname.startsWith("/api/orchestration/threads/")) return json(threadDetail);
    if (pathname === "/api/orchestration/turn-result") {
      if (shape === "upstream") return html();
      if (init.method === "POST") return json(patchedTurnResult(JSON.parse(init.body)));
      return json(PATCHED_TALK);
    }
    return new Response("", { status: 404 });
  };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", fetchImpl });
  const removed = new Set(shape === "upstream" ? ["server.getSettings", "orchestration.dispatchMessageWithMode"] : []);
  client.rpc = async (tag, payload, { beforeSend } = {}) => {
    rpcs.push([tag, payload?.type ?? null, clone(payload ?? {})]);
    if (removed.has(tag)) {
      const exit = NIGHTLY.unknownTagExits[tag];
      throw new T3RpcRejectedError(tag, "[redacted error body]", { unknownTag: isUnknownTagExit(exit, tag) });
    }
    if (beforeSend) await beforeSend();
    if (tag === "server.getSettings") return clone(PATCHED_SETTINGS);
    if (tag === "server.getConfig") return shape === "upstream" ? clone(NIGHTLY.config) : { environment: { orchestrationProtocolVersion: 2, capabilities: {} }, providers: clone(NIGHTLY.config.providers) };
    return { sequence: rpcs.length };
  };
  return { client, rpcs, reads };
}

const turnStart = (overrides = {}) => ({
  type: "thread.turn.start",
  commandId: "cmd-1",
  threadId: THREAD_ID,
  message: { messageId: "msg-1", role: "user", text: "PONG?", attachments: [] },
  modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-11-07T00:00:00.000Z",
  ...overrides,
});

test("recorded upstream exits are exact unknown-tag defects; other failures are not", () => {
  for (const [tag, exit] of Object.entries(NIGHTLY.unknownTagExits)) {
    assert.equal(isUnknownTagExit(exit, tag), true, tag);
    assert.equal(isUnknownTagExit(exit, "server.getConfig"), false, "a different tag never matches");
  }
  assert.equal(isUnknownTagExit({ _tag: "Failure", cause: [{ _tag: "Fail", error: "Unknown request tag: server.getSettings" }] }, "server.getSettings"), false);
  assert.equal(isUnknownTagExit({ _tag: "Failure", cause: [] }, "server.getSettings"), false);
  assert.equal(isUnknownTagExit({ _tag: "Success", value: null }, "server.getSettings"), false);
  assert.equal(isUnknownTagExit({ _tag: "Failure", cause: { _tag: "Die", defect: "Unknown request tag: x" } }, "x"), true, "a single cause object is accepted");
});

test("KRA-10176 patched T3 v2: settings come from server.getSettings and getConfig is not needed", async () => {
  const { client, rpcs } = server("patched");
  assert.deepEqual(await client.getSettings(), PATCHED_SETTINGS);
  assert.deepEqual(rpcs.map(([tag]) => tag), ["server.getSettings"]);
});

test("KRA-10176 upstream Nightly: unknown server.getSettings switches once to server.getConfig().settings", async () => {
  const { client, rpcs } = server("upstream");
  assert.deepEqual(await client.getSettings(), NIGHTLY.config.settings);
  assert.deepEqual(await client.getSettings(), NIGHTLY.config.settings);
  assert.deepEqual(rpcs.map(([tag]) => tag), ["server.getSettings", "server.getConfig", "server.getConfig"]);
});

test("KRA-10176 a generic settings refusal is never mistaken for a removed RPC", async () => {
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", orchestrationProtocol: 2 });
  const tags = [];
  client.rpc = async (tag) => { tags.push(tag); throw new T3RpcRejectedError(tag, "[redacted error body]"); };
  await assert.rejects(client.getSettings(), T3RpcRejectedError);
  assert.deepEqual(tags, ["server.getSettings"]);
  const empty = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", orchestrationProtocol: 2 });
  empty.rpc = async (tag) => {
    if (tag === "server.getSettings") throw new T3RpcRejectedError(tag, "x", { unknownTag: true });
    return { environment: {} };
  };
  await assert.rejects(empty.getSettings(), T3V2UnsupportedError);
});

test("KRA-10175 patched T3 v2 keeps the atomic message RPC", async () => {
  const { client, rpcs } = server("patched");
  await client.dispatch(turnStart());
  assert.deepEqual(rpcs.map(([tag, type]) => [tag, type]), [
    ["orchestration.dispatchCommand", "thread.runtime-mode.set"],
    ["orchestration.dispatchMessageWithMode", "message.dispatch"],
  ]);
  assert.equal(rpcs[1][2].runtimeMode, "full-access");
});

test("KRA-10175 upstream Nightly: the same message goes once through dispatchCommand, then directly", async () => {
  const { client, rpcs } = server("upstream");
  await client.dispatch(turnStart());
  await client.dispatch(turnStart({ commandId: "cmd-2", message: { messageId: "msg-2", role: "user", text: "again", attachments: [] } }));
  assert.deepEqual(rpcs.map(([tag, type]) => [tag, type]), [
    ["orchestration.dispatchCommand", "thread.runtime-mode.set"],
    ["orchestration.dispatchMessageWithMode", "message.dispatch"],
    ["orchestration.dispatchCommand", "message.dispatch"],
    ["orchestration.dispatchCommand", "thread.runtime-mode.set"],
    ["orchestration.dispatchCommand", "message.dispatch"],
  ]);
  const sent = rpcs[2][2];
  // Same ids as the refused attempt (never applied), upstream schema fields only.
  assert.equal(sent.commandId, "cmd-1");
  assert.equal(sent.messageId, "msg-1");
  assert.equal(Object.hasOwn(sent, "runtimeMode"), false);
  assert.equal(Object.hasOwn(sent, "freshProviderContext"), false);
  assert.deepEqual(sent.dispatchMode, { type: "start_immediately" });
  assert.equal(sent.deliveryIntent, "auto");
});

test("KRA-10175 a generic refusal of the atomic message RPC still has no fallback", async () => {
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", orchestrationProtocol: 2, fetchImpl: async () => json(NIGHTLY.threadDetail) });
  const tags = [];
  client.rpc = async (tag, payload, { beforeSend } = {}) => {
    tags.push(tag);
    if (beforeSend) await beforeSend();
    if (tag === "orchestration.dispatchMessageWithMode") throw new T3RpcRejectedError(tag, "refused");
    return { sequence: 1 };
  };
  await assert.rejects(client.dispatch(turnStart()), T3RpcRejectedError);
  assert.deepEqual(tags, ["orchestration.dispatchCommand", "orchestration.dispatchMessageWithMode"]);
});

test("KRA-10175 freshProviderContext maps to upstream freshContext only when the server advertises it", () => {
  const step = { method: "orchestration.dispatchMessageWithMode", payload: { type: "message.dispatch", commandId: "c", threadId: "t", messageId: "m", text: "x", attachments: [], runtimeMode: "full-access", freshProviderContext: true, dispatchMode: { type: "start_immediately" } } };
  const upstream = upstreamMessageStep(step, { freshContext: true });
  assert.equal(upstream.method, "orchestration.dispatchCommand");
  assert.equal(upstream.payload.freshContext, true);
  assert.equal(Object.hasOwn(upstream.payload, "freshProviderContext"), false);
  assert.equal(Object.hasOwn(upstream.payload, "runtimeMode"), false);
  assert.throws(() => upstreamMessageStep(step, { freshContext: false }), /does not advertise freshContext/);
  assert.throws(() => upstreamMessageStep({ method: "orchestration.dispatchCommand", payload: step.payload }), T3V2UnsupportedError);
});

test("KRA-10175 upstream fresh-context turn: capability from getConfig, freshContext on the wire", async () => {
  const { client, rpcs } = server("upstream");
  await client.dispatch(turnStart({ freshProviderContext: true }));
  const message = rpcs.find(([tag, type]) => tag === "orchestration.dispatchCommand" && type === "message.dispatch")[2];
  assert.equal(message.freshContext, true);
  assert.equal(Object.hasOwn(message, "freshProviderContext"), false);
});

test("talkTurnResult/v1 capabilities: patched record kept, upstream derived from getConfig, protocol 1 404 unchanged", async () => {
  const patched = server("patched").client;
  assert.deepEqual(await patched.talkCapabilities(), PATCHED_TALK);
  assert.equal(patched.turnResultSource, "patched");

  const upstream = server("upstream").client;
  const derived = await upstream.talkCapabilities();
  assert.equal(upstream.turnResultSource, "native-v2");
  assert.equal(derived.talkTurnResult, "v1");
  assert.equal(derived.talkFreshProviderContext, "v1");
  const ready = NIGHTLY.config.providers.filter((entry) => entry.enabled && entry.installed).map((entry) => entry.instanceId);
  assert.deepEqual(derived.talkFreshProviderContextProviders, ready);
  assert.ok(derived.talkFreshProviderContextProviders.includes("codex"));

  const v1 = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", orchestrationProtocol: 1, fetchImpl: async () => new Response("", { status: 404 }) });
  await assert.rejects(v1.talkCapabilities(), (error) => error instanceof T3HttpError && error.status === 404);
});

test("doctor talk probe reports Local Talk present on both shapes", async () => {
  for (const shape of ["patched", "upstream"]) {
    const { client } = server(shape);
    const probe = await probeTalkCapabilities(client);
    assert.equal(probe.capabilities.talkTurnResult, "v1", shape);
    assert.equal(probe.finding.status, "present", shape);
  }
});

test("native turn result: the recorded Nightly PONG run joins exactly by messageId", () => {
  const tuple = { threadId: THREAD_ID, messageId: RUN_1.userMessageId, turnCommandId: "receipt-command" };
  const result = nativeTurnResult(NIGHTLY.threadDetail, tuple);
  assert.equal(result.state, "succeeded");
  assert.equal(result.outputText, "PONG");
  assert.equal(result.turnId, RUN_1.id);
  assert.equal(result.instanceId, "codex");
  assert.equal(result.model, "gpt-5.6-luna");
  assert.equal(result.effort, "low");
  assert.equal(result.turnCommandId, "receipt-command");
  const assistant = NIGHTLY.threadDetail.projection.messages.filter((message) => message.role === "assistant" && message.runId === RUN_1.id).at(-1);
  assert.equal(result.assistantMessageId, assistant.id);
  assert.equal(Object.hasOwn(result, "freshProviderContext"), false);
});

test("native turn result never falls back to the latest run", () => {
  const unknown = nativeTurnResult(NIGHTLY.threadDetail, { threadId: THREAD_ID, messageId: "not-a-sent-message", turnCommandId: "c" });
  assert.equal(unknown.state, "pending");
  assert.equal(unknown.turnId, null);
  assert.equal(unknown.outputText, null);
  assert.throws(() => nativeTurnResult(NIGHTLY.threadDetail, { threadId: "00000000-0000-4000-8000-000000000000", messageId: RUN_1.userMessageId, turnCommandId: "c" }), /identity mismatch/);
  const doubled = clone(NIGHTLY.threadDetail);
  doubled.projection.runs.push({ ...RUN_1, id: "run:other", ordinal: 99 });
  assert.throws(() => nativeTurnResult(doubled, { threadId: THREAD_ID, messageId: RUN_1.userMessageId, turnCommandId: "c" }), /more than one run/);
});

test("native turn result maps run states and keeps output only for success", () => {
  const tuple = { threadId: THREAD_ID, messageId: RUN_1.userMessageId, turnCommandId: "c" };
  const withStatus = (status, extra = {}) => {
    const detail = clone(NIGHTLY.threadDetail);
    Object.assign(detail.projection.runs.find((run) => run.id === RUN_1.id), { status, ...extra });
    return detail;
  };
  for (const [status, state] of [["running", "pending"], ["queued", "pending"], ["failed", "failed"], ["interrupted", "cancelled"], ["cancelled", "cancelled"]]) {
    const result = nativeTurnResult(withStatus(status), tuple);
    assert.equal(result.state, state, status);
    assert.equal(result.outputText, null, status);
    assert.equal(result.assistantMessageId, null, status);
  }
  const fresh = nativeTurnResult(withStatus("completed", { freshContext: true }), tuple);
  assert.equal(fresh.freshProviderContext, true);
  assert.equal(fresh.nativeContextGeneration, "c");
  const silent = clone(NIGHTLY.threadDetail);
  silent.projection.messages = silent.projection.messages.filter((message) => !(message.role === "assistant" && message.runId === RUN_1.id));
  assert.equal(nativeTurnResult(silent, tuple).state, "failed", "a completed run without assistant output is not a success");
});

test("pairer turn-result accepts the native upstream record through its closed validator", async () => {
  const { client } = server("upstream");
  const adapter = new LoopbackRuntimeAdapter({ client, doctorImpl: async () => ({ labs: [] }) });
  const tuple = { threadId: THREAD_ID, messageId: RUN_1.userMessageId, turnCommandId: "receipt-command" };
  const result = await adapter.turnResult(tuple);
  assert.equal(result.state, "succeeded");
  assert.equal(result.outputText, "PONG");
  assert.equal(result.turnCommandId, "receipt-command");
});

test("pairer turn-result on patched T3 still posts to the patched route", async () => {
  const tuple = { threadId: THREAD_ID, messageId: "msg-1", turnCommandId: "cmd-1" };
  const { client, reads } = server("patched", {
    patchedTurnResult: (body) => ({ ...body, turnId: "turn-1", assistantMessageId: "a-1", instanceId: "codex", model: "gpt-5.6-luna", effort: "low", state: "succeeded", outputText: "PONG" }),
  });
  const adapter = new LoopbackRuntimeAdapter({ client, doctorImpl: async () => ({ labs: [] }) });
  assert.equal((await adapter.turnResult(tuple)).outputText, "PONG");
  assert.ok(reads.some(([method, pathname]) => method === "POST" && pathname === "/api/orchestration/turn-result"));
});

test("doctor on the recorded upstream Nightly prints every lab row with ready, signedIn and models", async () => {
  const { client } = server("upstream");
  client.refreshProvider = async () => { throw new Error("doctor must not need a refresh to answer"); };
  const report = await doctor(client, { hermesUrl: "http://127.0.0.1:9", fetchImpl: async () => { throw new Error("offline"); }, refreshDirectory: fs.mkdtempSync("/tmp/tentacles-nightly-doctor-") });
  assert.equal(report.t3.talk.status, "present");
  assert.equal(report.capabilities.talkTurnResult, "v1");
  const row = (id) => report.labs.find((lab) => lab.instanceId === id);
  for (const id of ["codex", "claudeAgent", "grok", "opencode", "antigravity"]) {
    assert.equal(row(id).ready, true, id);
    assert.equal(row(id).signedIn, true, id);
    assert.ok(row(id).modelCount > 0, id);
  }
  assert.equal(row("cursor").ready, false);
  assert.equal(row("cursor").signedIn, false);
  assert.equal(row("hermes").signedIn, null);
});

test("unsafe upstream assistant ids (Antigravity) become a stable safe digest; safe ids stay verbatim", async () => {
  // Shape seen live on Nightly 0.1.8: percent-escaped, 138 characters.
  const unsafe = `message:provider:antigravity:native-item:provider-instance%3Aantigravity%3A${"0".repeat(64)}`;
  assert.ok(unsafe.length > 128);
  const mapped = safeResultId(unsafe);
  assert.match(mapped, /^t3v2-sha256:[0-9a-f]{64}$/);
  assert.equal(safeResultId(unsafe), mapped, "deterministic");
  assert.equal(safeResultId("message:provider:codex:native-item:msg_1"), "message:provider:codex:native-item:msg_1");
  const detail = clone(NIGHTLY.threadDetail);
  const assistant = detail.projection.messages.filter((message) => message.role === "assistant" && message.runId === RUN_1.id).at(-1);
  assistant.id = unsafe;
  const { client } = server("upstream", { threadDetail: detail });
  const adapter = new LoopbackRuntimeAdapter({ client, doctorImpl: async () => ({ labs: [] }) });
  const result = await adapter.turnResult({ threadId: THREAD_ID, messageId: RUN_1.userMessageId, turnCommandId: "c" });
  assert.equal(result.assistantMessageId, mapped);
  assert.equal(result.outputText, "PONG");
});
