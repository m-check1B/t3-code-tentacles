import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startThread, continueThread, originate } from "../src/bridge.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";
import { captureWire, freshCapability } from "./helpers/fresh-context-wire.mjs";
import { translateCommand } from "../src/t3-v2.mjs";
const capability = { talkTurnResult: "v1", talkFreshProviderContext: "v1", talkFreshProviderContextProviders: ["codex"] };
const selection = { instanceId: "codex", model: "gpt-5.6-sol", runtimeMode: "full-access" };
function fake(caps = capability) {
  const commands = [], projects = [], threads = new Map();
  return { commands, threads, request: async () => caps, shell: async () => ({ projects }),
    thread: async (id) => { if (!threads.has(id)) throw new T3HttpError({ method: "GET", pathname: id, status: 404, body: null }); return { thread: threads.get(id) }; },
    dispatch: async (cmd) => {
      commands.push(cmd);
      if (cmd.type === "project.create") projects.push({ id: cmd.projectId, workspaceRoot: cmd.workspaceRoot });
      if (cmd.type === "thread.create") threads.set(cmd.threadId, { id: cmd.threadId, projectId: cmd.projectId, title: cmd.title, modelSelection: cmd.modelSelection, messages: [] });
      if (cmd.type === "thread.turn.start") threads.get(cmd.threadId).messages.push({ id: cmd.message.messageId, text: cmd.message.text });
      return { sequence: commands.length };
    } };
}
test("fresh originate keeps the explicit Jack title; continue uses the same visible thread", async () => {
  const client = fake();
  const first = await startThread(client, { ...selection, projectId: "project", title: "Jack · Test Bot", message: "first memory", freshProviderContext: true, fixedTitle: true });
  const next = await continueThread(client, { ...selection, threadId: first.threadId, message: "current memory", freshProviderContext: true });
  assert.equal(next.threadId, first.threadId);
  assert.equal(client.threads.size, 1);
  const turns = client.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.ok(turns.every(c => c.freshProviderContext === true && !Object.hasOwn(c, "titleSeed")));
  assert.notEqual(turns[0].commandId, turns[1].commandId);
  assert.equal(client.threads.get(first.threadId).title, "Jack · Test Bot");
});
test("legacy originate keeps titleSeed and does not serialize fresh mode", async () => {
  const client = fake({});
  await startThread(client, { ...selection, projectId: "project", title: "old", message: "old memory" });
  const turn = client.commands.at(-1);
  assert.equal(turn.titleSeed, "old");
  assert.equal(Object.hasOwn(turn, "freshProviderContext"), false);
});
test("unsupported, malformed, or withdrawn capabilities fail before workspace effects", async () => {
  for (const caps of [{}, { ...capability, talkFreshProviderContext: "v2" }, { ...capability, talkFreshProviderContextProviders: ["grok"] }, { ...capability, talkFreshProviderContextProviders: ["codex", "codex"] }, { ...capability, talkFreshProviderContextProviders: "codex" }]) {
    let effects = 0;
    const runtime = new LoopbackRuntimeAdapter({ client: fake(caps), prepareTalkWorkspaceImpl: () => effects++, originateImpl: () => effects++, continueImpl: () => effects++ });
    await assert.rejects(runtime.originate({ ...selection, workspace: "/synthetic", title: "Jack · Test", message: "memory", freshProviderContext: true, fixedTitle: true }), /unavailable/);
    await assert.rejects(runtime.continue({ ...selection, threadId: "thread", message: "memory", freshProviderContext: true }), /unavailable/);
    assert.equal(effects, 0);
  }
});
test("invalid optional flags are refused synchronously before callbacks", () => {
  let effects = 0;
  const runtime = new LoopbackRuntimeAdapter({ client: fake(), prepareTalkWorkspaceImpl: () => effects++, originateImpl: () => effects++ });
  for (const flags of [{ freshProviderContext: "true" }, { fixedTitle: 1 }]) assert.throws(() => runtime.originate({ ...selection, workspace: "/synthetic", message: "memory", ...flags }), /boolean/);
  assert.equal(effects, 0);
});
test("idempotent fresh originate replays the same identifiers but refuses semantic mode changes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-fresh-proof-"));
  try {
    const client = fake();
    const input = { ...selection, workspace: "/synthetic", title: "Jack · Test", message: "memory", freshProviderContext: true, fixedTitle: true, idempotencyKey: "owned-proof", stateFile: path.join(directory, "state.json") };
    const first = await originate(client, input);
    const second = await originate(client, input);
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.turnCommandId, first.turnCommandId);
    assert.equal(client.commands.filter(c => c.type === "thread.turn.start").length, 1);
    await assert.rejects(originate(client, { ...input, freshProviderContext: false }), /different input/);
    await assert.rejects(originate(client, { ...input, fixedTitle: false }), /different input/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("doctor advertises only the exact agreed capability envelope", async () => {
  const exact = { talkTurnResult: "v1" };
  for (const caps of [{}, capability, exact]) {
    const runtime = new LoopbackRuntimeAdapter({ client: fake(caps), doctorImpl: async () => ({ ready: true }) });
    const result = await runtime.doctorStatus();
    assert.deepEqual(result.capabilities, caps === exact ? { ...exact, turnInterrupt: "turn-interrupt-v1" } : { talkTurnResult: null, turnInterrupt: null });
  }
});
test("exact result forwards only actual applied context receipt and rejects the wrong generation", async () => {
  const input = { threadId: "thread", messageId: "message", turnCommandId: "command" };
  const result = { ...input, turnId: "turn", assistantMessageId: null, instanceId: "codex", model: "gpt-5.6-sol", effort: "high", state: "failed", outputText: null };
  for (const receipt of [{}, { freshProviderContext: true, nativeContextGeneration: "command" }]) {
    const runtime = new LoopbackRuntimeAdapter({ client: { request: async (_path, options) => options ? ({ ...result, ...receipt, secretInternal: "not forwarded" }) : capability } });
    assert.deepEqual(await runtime.turnResult(input), { ...result, ...receipt });
  }
  for (const receipt of [{ freshProviderContext: true, nativeContextGeneration: "other" }, { freshProviderContext: true }, { nativeContextGeneration: "command" }, { freshProviderContext: false, nativeContextGeneration: "command" }]) {
    const runtime = new LoopbackRuntimeAdapter({ client: { request: async () => ({ ...result, ...receipt }) } });
    await assert.rejects(runtime.turnResult(input), /Invalid applied/);
  }
});

test("pending results never attest a fresh applied context", async () => {
  const input = { threadId: "thread", messageId: "message", turnCommandId: "command" };
  const result = { ...input, turnId: null, assistantMessageId: null, instanceId: null, model: null, effort: null, state: "pending", outputText: null };
  const legacy = new LoopbackRuntimeAdapter({ client: { request: async () => result } });
  assert.deepEqual(await legacy.turnResult(input), result);
  const premature = new LoopbackRuntimeAdapter({ client: { request: async () => ({ ...result, freshProviderContext: true, nativeContextGeneration: "command" }) } });
  await assert.rejects(premature.turnResult(input), /Invalid applied/);
});

test("owner ledger refuses malformed persisted flags and accepts absent legacy flags", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-fresh-ledger-proof-"));
  try {
    const client = fake();
    const input = { ...selection, workspace: "/synthetic", title: "Legacy", message: "memory", idempotencyKey: "ledger-proof", stateFile: path.join(directory, "state.json") };
    const first = await originate(client, input);
    const state = JSON.parse(fs.readFileSync(input.stateFile, "utf8"));
    delete state.originations["ledger-proof"].freshProviderContext;
    delete state.originations["ledger-proof"].fixedTitle;
    fs.writeFileSync(input.stateFile, JSON.stringify(state));
    assert.equal((await originate(client, input)).threadId, first.threadId);
    state.originations["ledger-proof"].freshProviderContext = "true";
    fs.writeFileSync(input.stateFile, JSON.stringify(state));
    const count = client.commands.length;
    await assert.rejects(originate(client, input), /boolean/);
    assert.equal(client.commands.length, count);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("G1: capability-zero default wire is byte-identical to main for legacy and V2", async () => {
  const baseline = JSON.parse(fs.readFileSync(new URL("./fixtures/fresh-context-default-wire.json", import.meta.url), "utf8"));
  for (const protocol of [1, 2]) {
    const actual = await captureWire(protocol);
    assert.equal(JSON.stringify(actual), JSON.stringify(baseline.protocols[protocol]));
    assert.equal(actual.wire.filter((entry) => entry.pathname === "/api/orchestration/turn-result" && entry.method === "GET").length, 1, "only doctor probes capabilities");
  }
});

test("fresh context reaches the legacy and V2 transports without a title seed", async () => {
  for (const protocol of [1, 2]) {
    const actual = await captureWire(protocol, { fresh: true, capabilities: freshCapability });
    const messages = actual.wire.map((entry) => entry.payload ?? entry.body).filter((command) => ["thread.turn.start", "message.dispatch"].includes(command?.type));
    assert.equal(messages.length, 2);
    assert.ok(messages.every((command) => command.freshProviderContext === true && !Object.hasOwn(command, "titleSeed")));
    assert.deepEqual(messages.map((command) => command.commandId), ["first-command", "next-command"]);
    assert.equal(actual.receipt.nativeContextGeneration, "next-command");
    assert.equal(Object.hasOwn(actual.doctor.capabilities, "talkFreshProviderContext"), false);
    assert.equal(actual.doctor.capabilities.talkTurnResult, null);
    assert.equal(actual.doctor.capabilities.turnInterrupt, null);
  }
});

test("V2 validates fresh-context values before building any prerequisite", async () => {
  const command = { type: "thread.turn.start", commandId: "command", threadId: "thread", runtimeMode: "full-access", message: { messageId: "message", role: "user", text: "synthetic" }, freshProviderContext: true };
  assert.equal((await translateCommand(command)).at(-1).payload.freshProviderContext, true);
  for (const value of [false, null, 1, "true"]) await assert.rejects(translateCommand({ ...command, freshProviderContext: value }), /freshProviderContext/);
});

test("G1: unsupported direct client dispatch refuses both protocols before mutation", async () => {
  for (const protocol of [1, 2]) {
    for (const capabilities of [{}, { talkTurnResult: "v1", talkFreshProviderContext: 0 }, { ...capability, talkFreshProviderContextProviders: ["other"] }]) {
      let mutations = 0;
      const client = new T3Client({ token: "synthetic", orchestrationProtocol: protocol, fetchImpl: async (_url, init) => {
        if (init.method !== "GET") mutations++;
        return new Response(JSON.stringify(capabilities));
      } });
      client.rpc = async () => { mutations++; };
      await assert.rejects(client.dispatch({ type: "thread.turn.start", commandId: "command", threadId: "thread", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" }, message: { messageId: "message", role: "user", text: "synthetic" }, runtimeMode: "full-access", freshProviderContext: true }), /unavailable/);
      assert.equal(mutations, 0);
    }
  }
});

test("G1: fixed title alone is capability-gated before workspace or ledger creation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-fixed-title-proof-"));
  try {
    for (const flags of [{ fixedTitle: true }, { freshProviderContext: true }, { fixedTitle: true, freshProviderContext: true }]) {
      const client = fake({ talkTurnResult: "v1", talkFreshProviderContext: 0 });
      let effects = 0;
      const adapter = new LoopbackRuntimeAdapter({ client, prepareTalkWorkspaceImpl: () => effects++, originateImpl: () => effects++ });
      const input = { ...selection, workspace: "/synthetic", title: "Synthetic", message: "memory", ...flags };
      await assert.rejects(adapter.originate(input), /unavailable/);
      const stateFile = path.join(directory, "state.json");
      await assert.rejects(originate(client, { ...input, stateFile, idempotencyKey: "unsupported" }), /unavailable/);
      assert.equal(fs.existsSync(stateFile), false);
      assert.equal(effects, 0);
      assert.equal(client.commands.length, 0);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("fresh hints require an explicit instance on all entry points", async () => {
  for (const hints of [{ freshProviderContext: true }, { fixedTitle: true }]) {
    const client = fake({ ...capability, talkFreshProviderContextProviders: ["hermes", "codex"] });
    const input = { runtimeMode: "full-access", projectId: "project", workspace: "/synthetic", title: "Synthetic", message: "memory", ...hints };
    await assert.rejects(startThread(client, input), /explicit provider/);
    await assert.rejects(originate(client, input), /explicit provider/);
    assert.equal(client.commands.length, 0);
  }
  await assert.rejects(continueThread(fake(), { threadId: "thread", message: "memory", runtimeMode: "full-access", freshProviderContext: true }), /explicit provider/);
});

test("doctor drops malformed capabilities and preserves interruption and inventory", async () => {
  const malformed = [null, {}, { ...capability, talkTurnResult: null }, { ...capability, talkFreshProviderContext: 0 }, { ...capability, talkFreshProviderContext: "v2" }, ...[[], ["codex", "codex"], ["bad/id"], [""], [null], Array.from({ length: 33 }, (_, i) => `provider-${i}`), "codex"].map((providers) => ({ ...capability, talkFreshProviderContextProviders: providers }))];
  for (const caps of malformed) {
    const runtime = new LoopbackRuntimeAdapter({ client: fake(caps), doctorImpl: async () => ({ ready: true }), capabilityCache: { current: null, refreshIfStale: async () => null } });
    const report = await runtime.doctorStatus();
    assert.equal(Object.hasOwn(report.capabilities, "talkFreshProviderContext"), false);
    assert.equal(Object.hasOwn(report.capabilities, "talkFreshProviderContextProviders"), false);
    assert.equal(report.capabilities.talkTurnResult, null);
    assert.equal(report.capabilities.turnInterrupt, null);
    assert.equal(report.capabilityInventory, null);
  }
});

test("unadvertised applied receipts are refused instead of escaping the G1 gate", async () => {
  const input = { threadId: "thread", messageId: "message", turnCommandId: "command" };
  const receipt = { ...input, turnId: "turn", assistantMessageId: null, instanceId: "codex", model: "gpt-5.6-sol", effort: "high", state: "failed", outputText: null, freshProviderContext: true, nativeContextGeneration: "command" };
  const runtime = new LoopbackRuntimeAdapter({ client: { request: async (_path, options) => options ? receipt : { talkTurnResult: "v1", talkFreshProviderContext: 0 } } });
  await assert.rejects(runtime.turnResult(input), /unavailable/);
});

test("origination reconciles an accepted ambiguous fresh turn without repeating it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-fresh-replay-"));
  try {
    const client = fake();
    const dispatch = client.dispatch;
    client.dispatch = async (command) => {
      const result = await dispatch(command);
      if (command.type === "thread.turn.start") throw new Error("synthetic accepted disconnect");
      return result;
    };
    const input = { ...selection, workspace: "/synthetic", title: "Synthetic", message: "memory", freshProviderContext: true, fixedTitle: true, stateFile: path.join(directory, "state.json"), idempotencyKey: "ambiguous" };
    await assert.rejects(originate(client, input), /accepted disconnect/);
    const result = await originate(client, input);
    assert.deepEqual(await originate(client, input), result);
    assert.equal(client.commands.filter((command) => command.type === "thread.turn.start").length, 1);
    await assert.rejects(originate(client, { ...input, freshProviderContext: undefined }), /different input/);
    await assert.rejects(originate(client, { ...input, fixedTitle: undefined }), /different input/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("capability withdrawal is rechecked by the client instead of caching admission", async () => {
  let supported = true, dispatches = 0;
  const client = new T3Client({ token: "synthetic", orchestrationProtocol: 1, fetchImpl: async (url) => {
    if (new URL(url).pathname === "/api/orchestration/turn-result") return new Response(JSON.stringify(supported ? capability : { talkTurnResult: "v1", talkFreshProviderContext: 0 }));
    dispatches++;
    return new Response("{}");
  } });
  const command = { type: "thread.turn.start", commandId: "command", threadId: "thread", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" }, message: { messageId: "message", role: "user", text: "synthetic" }, runtimeMode: "full-access", freshProviderContext: true };
  await client.dispatch(command);
  supported = false;
  await assert.rejects(client.dispatch({ ...command, commandId: "second-command" }), /unavailable/);
  assert.equal(dispatches, 1);
});

test("fresh terminal receipts require an applied turn for every terminal state", async () => {
  const input = { threadId: "thread", messageId: "message", turnCommandId: "command" };
  for (const state of ["succeeded", "failed", "cancelled"]) {
    const receipt = { ...input, turnId: "turn", assistantMessageId: state === "succeeded" ? "assistant" : null, instanceId: "codex", model: "gpt-5.6-sol", effort: "high", state, outputText: state === "succeeded" ? "synthetic" : null, freshProviderContext: true, nativeContextGeneration: "command" };
    const adapter = new LoopbackRuntimeAdapter({ client: { request: async (_path, options) => options ? receipt : capability } });
    assert.deepEqual(await adapter.turnResult(input), receipt);
    if (state !== "succeeded") {
      receipt.turnId = null;
      await assert.rejects(adapter.turnResult(input), /Invalid applied/);
    }
  }
});
