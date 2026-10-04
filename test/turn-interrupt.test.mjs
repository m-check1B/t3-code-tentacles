import assert from "node:assert/strict";
import test from "node:test";
import { LoopbackRuntimeAdapter, RemoteRpcShim, REMOTE_RPC_METHODS } from "../src/outbound-pairer.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

const FAST = { startWaitMs: 60, terminalWaitMs: 200, intervalMs: 5 };

// Synthetic T3: exact turn-result rows keyed by the receipt tuple, one
// session per thread, and thread.turn.interrupt that interrupts by session
// exactly like T3 does (it ignores turnId).
class FakeT3 {
  constructor() {
    this.turns = new Map();
    this.sessions = new Map();
    this.dispatched = [];
    this.onInterrupt = (turn) => { turn.state = "cancelled"; };
  }

  key({ threadId, messageId, turnCommandId }) { return `${threadId}|${messageId}|${turnCommandId}`; }

  start(tuple, { turnId = `turn-${tuple.messageId}`, state = "pending" } = {}) {
    const turn = { ...tuple, turnId, state };
    this.turns.set(this.key(tuple), turn);
    if (state === "pending" && turnId) this.sessions.set(tuple.threadId, { status: "running", activeTurnId: turnId });
    return turn;
  }

  finish(tuple, state) {
    const turn = this.turns.get(this.key(tuple));
    turn.state = state;
    const session = this.sessions.get(tuple.threadId);
    if (session?.activeTurnId === turn.turnId) this.sessions.set(tuple.threadId, { status: "ready", activeTurnId: null });
  }

  client() {
    return {
      request: async (url, options) => {
        assert.equal(url, "/api/orchestration/turn-result");
        if (!options) return { talkTurnResult: "v1" };
        const turn = this.turns.get(this.key(options.body));
        if (!turn) throw new T3HttpError({ method: "POST", pathname: url, status: 404, body: null });
        const succeeded = turn.state === "succeeded";
        return {
          threadId: turn.threadId, messageId: turn.messageId, turnCommandId: turn.turnCommandId,
          turnId: turn.turnId, assistantMessageId: succeeded ? "assistant" : null,
          instanceId: "codex", model: "synthetic", effort: "high",
          state: turn.state, outputText: succeeded ? "partial reply" : null,
        };
      },
      thread: async (threadId) => ({ thread: { id: threadId, session: this.sessions.get(threadId) ?? null } }),
      dispatch: async (command) => {
        this.dispatched.push(command);
        if (command.type === "thread.turn.interrupt") {
          const session = this.sessions.get(command.threadId);
          const active = [...this.turns.values()].find((turn) => turn.threadId === command.threadId && turn.turnId === session?.activeTurnId);
          if (active) {
            setTimeout(() => {
              this.onInterrupt(active);
              this.sessions.set(command.threadId, { status: "ready", activeTurnId: null });
            }, 10);
          }
        }
        return { accepted: true };
      },
    };
  }
}

function stopFor(tuple, requestId = `stop-${tuple.messageId}`) {
  return { requestId, ...tuple, reason: "user_stop" };
}

const A = { threadId: "thread-1", messageId: "message-a", turnCommandId: "command-a" };
const B = { threadId: "thread-1", messageId: "message-b", turnCommandId: "command-b" };

function adapterFor(t3, extra = {}) {
  return new LoopbackRuntimeAdapter({ client: t3.client(), interruptOptions: FAST, ...extra });
}

test("interrupt is allowlisted and advertised only with exact turn results", async () => {
  assert.equal(REMOTE_RPC_METHODS.includes("interrupt"), true);
  const t3 = new FakeT3();
  const adapter = adapterFor(t3, { doctorImpl: async () => ({ ready: true }) });
  assert.equal((await adapter.doctorStatus()).capabilities.turnInterrupt, "turn-interrupt-v1");
  const old = new LoopbackRuntimeAdapter({
    client: { request: async () => { throw new T3HttpError({ method: "GET", pathname: "/", status: 404, body: null }); } },
    doctorImpl: async () => ({ ready: true }),
  });
  assert.deepEqual((await old.doctorStatus()).capabilities, { talkTurnResult: null, turnInterrupt: null });
});

test("active exact turn is cancelled and acknowledged only at terminal state", async () => {
  const t3 = new FakeT3();
  t3.start(A);
  const result = await adapterFor(t3).interrupt(stopFor(A));
  assert.deepEqual(result, {
    contract: "turn-interrupt-v1", requestId: "stop-message-a", ...A, status: "cancelled", outcome: null,
  });
  const [command] = t3.dispatched;
  assert.equal(command.type, "thread.turn.interrupt");
  assert.equal(command.commandId, "jack-stop:stop-message-a");
  assert.equal(command.turnId, "turn-message-a");
});

test("duplicate and concurrent Stop replay one exact result with one dispatch", async () => {
  const t3 = new FakeT3();
  t3.start(A);
  const adapter = adapterFor(t3);
  const [first, concurrent] = await Promise.all([adapter.interrupt(stopFor(A)), adapter.interrupt(stopFor(A))]);
  const replay = await adapter.interrupt(stopFor(A));
  assert.deepEqual(concurrent, first);
  assert.deepEqual(replay, first);
  assert.equal(t3.dispatched.length, 1);
  // A fresh request for the same finished turn reports its original outcome.
  const later = await adapter.interrupt(stopFor(A, "stop-again"));
  assert.equal(later.status, "already_terminal");
  assert.equal(later.outcome, "cancelled");
  assert.equal(t3.dispatched.length, 1);
});

test("a reused idempotency key cannot retarget another turn", async () => {
  const t3 = new FakeT3();
  t3.start(A);
  const adapter = adapterFor(t3);
  await adapter.interrupt(stopFor(A, "same-key"));
  t3.start(B);
  const result = await adapter.interrupt(stopFor(B, "same-key"));
  assert.equal(result.status, "target_mismatch");
  assert.equal(result.messageId, "message-b");
  assert.equal(t3.dispatched.length, 1);
});

test("delayed Stop for completed A never interrupts newer B on the reused thread", async () => {
  const t3 = new FakeT3();
  t3.start(A);
  t3.finish(A, "succeeded");
  t3.start(B);
  const result = await adapterFor(t3).interrupt(stopFor(A));
  assert.equal(result.status, "already_terminal");
  assert.equal(result.outcome, "succeeded");
  assert.equal(t3.dispatched.length, 0);
  assert.deepEqual(t3.sessions.get("thread-1"), { status: "running", activeTurnId: "turn-message-b" });
});

test("pending A while another turn owns the session is a target mismatch", async () => {
  const t3 = new FakeT3();
  t3.start(A, { turnId: "turn-a" });
  t3.sessions.set("thread-1", { status: "running", activeTurnId: "turn-other" });
  const result = await adapterFor(t3).interrupt(stopFor(A));
  assert.equal(result.status, "target_mismatch");
  assert.equal(t3.dispatched.length, 0);
});

test("natural completion racing Stop preserves the completed outcome", async () => {
  const t3 = new FakeT3();
  t3.onInterrupt = (turn) => { turn.state = "succeeded"; };
  t3.start(A);
  const result = await adapterFor(t3).interrupt(stopFor(A));
  assert.equal(result.status, "already_terminal");
  assert.equal(result.outcome, "succeeded");
});

test("forged or foreign receipt tuples are refused without dispatch", async () => {
  const t3 = new FakeT3();
  t3.start(A);
  const adapter = adapterFor(t3);
  for (const forged of [{ ...A, messageId: "message-x" }, { ...A, turnCommandId: "command-x" }, { ...A, threadId: "thread-x" }]) {
    assert.equal((await adapter.interrupt(stopFor(forged))).status, "target_mismatch");
  }
  assert.equal(t3.dispatched.length, 0);
});

test("accepted but unstarted turn is unavailable and retryable, never guessed", async () => {
  const t3 = new FakeT3();
  t3.start(A, { turnId: null });
  const adapter = adapterFor(t3);
  assert.equal((await adapter.interrupt(stopFor(A))).status, "unavailable");
  assert.equal(t3.dispatched.length, 0);
  t3.start(A);
  assert.equal((await adapter.interrupt(stopFor(A))).status, "cancelled");
});

test("an unreachable T3 is unavailable, not a successful Stop", async () => {
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => { throw new Error("connect ECONNREFUSED"); } },
    interruptOptions: FAST,
  });
  assert.equal((await adapter.interrupt(stopFor(A))).status, "unavailable");
});

test("continue on the same thread waits for an in-flight interrupt", async () => {
  const t3 = new FakeT3();
  t3.start(A);
  let stateAtContinue = null;
  const adapter = adapterFor(t3, {
    continueImpl: async (_client, input) => { stateAtContinue = t3.turns.get(t3.key(A)).state; return input; },
  });
  const stopping = adapter.interrupt(stopFor(A));
  const continuing = adapter.continue({ threadId: "thread-1", message: "next", messageId: "message-b", turnCommandId: "command-b" });
  assert.equal((await stopping).status, "cancelled");
  await continuing;
  assert.equal(stateAtContinue, "cancelled");
});

test("the shim refuses malformed interrupt requests generically", async () => {
  const t3 = new FakeT3();
  t3.start(A);
  const shim = new RemoteRpcShim(adapterFor(t3));
  for (const params of [
    { ...stopFor(A), reason: "other" },
    { ...stopFor(A), extra: true },
    { requestId: "r", ...A },
    { ...stopFor(A), threadId: "../x" },
  ]) {
    const response = await shim.handle({ version: 1, type: "rpc.request", id: "rpc-1", method: "interrupt", params });
    assert.equal(response.type, "rpc.error");
  }
  const ok = await shim.handle({ version: 1, type: "rpc.request", id: "rpc-2", method: "interrupt", params: stopFor(A) });
  assert.equal(ok.type, "rpc.result");
  assert.equal(ok.result.status, "cancelled");
  assert.equal(t3.dispatched.length, 1);
});
