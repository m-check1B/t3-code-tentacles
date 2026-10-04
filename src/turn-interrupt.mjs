// Exact paired Local turn interruption (KRA-6245, turn-interrupt-v1).
//
// T3 interrupts by provider session, not by orchestration turn id, so this
// module owns the exact-turn fence: the persisted originate/continue receipt
// tuple must resolve, through T3's exact turn-result query, to the turn that is
// active on the thread right now. The caller serializes interrupt with continue
// per thread, so a newer turn B cannot start between the check and dispatch.
import { threadTurnInterrupt } from "./orchestrate.mjs";
import { T3HttpError } from "./t3-client.mjs";

export const TURN_INTERRUPT_CONTRACT = "turn-interrupt-v1";
export const TURN_INTERRUPT_STATUSES = Object.freeze(["cancelled", "already_terminal", "target_mismatch", "unsupported", "unavailable"]);

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PARAM_KEYS = ["requestId", "threadId", "messageId", "turnCommandId", "reason"];
const TUPLE_KEYS = ["threadId", "messageId", "turnCommandId"];
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const ACTIVE_SESSION_STATES = new Set(["starting", "running"]);
const MAX_REMEMBERED_REQUESTS = 256;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function requireInterruptParams(params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("interrupt params must be an object");
  const keys = Object.keys(params);
  if (keys.length !== PARAM_KEYS.length || PARAM_KEYS.some((key) => !Object.hasOwn(params, key))) {
    throw new Error("interrupt requires exactly requestId, threadId, messageId, turnCommandId and reason");
  }
  for (const key of PARAM_KEYS.slice(0, 4)) {
    if (typeof params[key] !== "string" || !SAFE_ID.test(params[key])) throw new Error(`${key} must be a safe identifier`);
  }
  if (params.reason !== "user_stop") throw new Error("interrupt reason must be user_stop");
  return Object.fromEntries(PARAM_KEYS.map((key) => [key, params[key]]));
}

export function interruptEnvelope(input, status, outcome = null) {
  if (!TURN_INTERRUPT_STATUSES.includes(status)) throw new Error("Unknown interrupt status");
  return {
    contract: TURN_INTERRUPT_CONTRACT,
    requestId: input.requestId,
    threadId: input.threadId,
    messageId: input.messageId,
    turnCommandId: input.turnCommandId,
    status,
    // Only already_terminal carries the original outcome; completed work is
    // never relabelled as cancelled.
    outcome: status === "already_terminal" ? outcome : null,
  };
}

function tupleKey(input) {
  return TUPLE_KEYS.map((key) => input[key]).join("\u0000");
}

export class TurnInterrupter {
  constructor({
    readTurnResult,
    readThread,
    dispatch,
    withThreadLock,
    startWaitMs = 10_000,
    terminalWaitMs = 20_000,
    intervalMs = 200,
  }) {
    this.readTurnResult = readTurnResult;
    this.readThread = readThread;
    this.dispatch = dispatch;
    this.withThreadLock = withThreadLock;
    this.startWaitMs = startWaitMs;
    this.terminalWaitMs = terminalWaitMs;
    this.intervalMs = intervalMs;
    // requestId -> { tuple, promise, result }. Final results replay exactly;
    // unavailable is not final and re-runs (dispatch is commandId-idempotent).
    this.requests = new Map();
  }

  interrupt(params) {
    const input = requireInterruptParams(params);
    const remembered = this.requests.get(input.requestId);
    if (remembered) {
      // A reused idempotency key can never retarget another turn.
      if (remembered.tuple !== tupleKey(input)) return Promise.resolve(interruptEnvelope(input, "target_mismatch"));
      if (remembered.result) return Promise.resolve(remembered.result);
      if (remembered.promise) return remembered.promise;
    }
    const entry = { tuple: tupleKey(input), promise: null, result: null };
    entry.promise = this.withThreadLock(input.threadId, () => this.interruptExact(input))
      .catch(() => interruptEnvelope(input, "unavailable"))
      .then((result) => {
        entry.promise = null;
        if (result.status === "unavailable") this.requests.delete(input.requestId);
        else entry.result = result;
        return result;
      });
    this.requests.set(input.requestId, entry);
    while (this.requests.size > MAX_REMEMBERED_REQUESTS) this.requests.delete(this.requests.keys().next().value);
    return entry.promise;
  }

  async exactResult(input) {
    try {
      return await this.readTurnResult(Object.fromEntries(TUPLE_KEYS.map((key) => [key, input[key]])));
    } catch (error) {
      // T3 answers 404 when the tuple does not identify one accepted turn.
      if (error instanceof T3HttpError && error.status === 404) return null;
      throw error;
    }
  }

  async pollUntil(input, deadlineMs, done) {
    while (true) {
      const result = await this.exactResult(input);
      if (!result || done(result) || Date.now() >= deadlineMs) return result;
      await delay(this.intervalMs);
    }
  }

  async interruptExact(input) {
    let result = await this.pollUntil(input, Date.now() + this.startWaitMs,
      (current) => TERMINAL_STATES.has(current.state) || current.turnId !== null);
    if (!result) return interruptEnvelope(input, "target_mismatch");
    if (TERMINAL_STATES.has(result.state)) return interruptEnvelope(input, "already_terminal", result.state);
    // Accepted but not started within the bound: never guess a provider turn.
    if (result.turnId === null) return interruptEnvelope(input, "unavailable");

    const detail = await this.readThread(input.threadId);
    const thread = detail?.thread ?? null;
    const session = thread?.session ?? null;
    if (!thread || thread.id !== input.threadId) return interruptEnvelope(input, "target_mismatch");
    if (!session || !ACTIVE_SESSION_STATES.has(session.status) || session.activeTurnId !== result.turnId) {
      // Natural completion may be settling; prefer its exact outcome.
      const settled = await this.pollUntil(input, Date.now() + this.terminalWaitMs, (current) => TERMINAL_STATES.has(current.state));
      if (settled && TERMINAL_STATES.has(settled.state)) return interruptEnvelope(input, "already_terminal", settled.state);
      // Another turn owns the session: a delayed Stop for A never interrupts B.
      if (session?.activeTurnId && session.activeTurnId !== result.turnId) return interruptEnvelope(input, "target_mismatch");
      return interruptEnvelope(input, "unavailable");
    }

    await this.dispatch(threadTurnInterrupt({
      commandId: `jack-stop:${input.requestId}`,
      threadId: input.threadId,
      turnId: result.turnId,
    }));
    // Transport acceptance is not a Stop acknowledgement; wait for the exact
    // turn to reach terminal provider state.
    result = await this.pollUntil(input, Date.now() + this.terminalWaitMs, (current) => TERMINAL_STATES.has(current.state));
    if (!result) return interruptEnvelope(input, "unavailable");
    if (result.state === "cancelled") return interruptEnvelope(input, "cancelled");
    if (TERMINAL_STATES.has(result.state)) return interruptEnvelope(input, "already_terminal", result.state);
    return interruptEnvelope(input, "unavailable");
  }
}

// Per-thread FIFO serialization shared by interrupt and continue.
export function createThreadLock() {
  const tails = new Map();
  return (threadId, task) => {
    const previous = tails.get(threadId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    tails.set(threadId, tail);
    void tail.then(() => { if (tails.get(threadId) === tail) tails.delete(threadId); });
    return run;
  };
}
