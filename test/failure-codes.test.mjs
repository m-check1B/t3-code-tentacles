// KRA-8958: typed, redacted failure codes on report, turn-result and receipts.
// Synthetic fixtures only; no T3, provider or relay is contacted.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, failure, FAILURE_CODES, FAILURE_MESSAGES } from "../src/failure-codes.mjs";
import { applyIntent, projectThreadReport } from "../src/orchestrate.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

const THREAD_ID = "12345678-1111-4111-8111-111111111111";
// Secret-shaped, synthetic. It must never reach any `message` or output.
const FAKE_SECRET = "sk-FAKE0kra8958redactionCanary0000";
const providerBody = (text) => `{"error":{"message":"${text}","request":{"headers":{"authorization":"Bearer ${FAKE_SECRET}"}}}}`;

const blockedReport = (session, extra = {}) =>
  projectThreadReport({ id: THREAD_ID, modelSelection: { model: "gpt-5.6-sol" }, session, ...extra }, THREAD_ID);

function turnResultAdapter(upstream) {
  const input = { threadId: "thread", messageId: "message", turnCommandId: "command" };
  const adapter = new LoopbackRuntimeAdapter({ client: { request: async () => ({ ...input, turnId: "turn", assistantMessageId: null,
    instanceId: "codex", model: "gpt-5.6-sol", effort: "high", outputText: null, ...upstream }) } });
  return () => adapter.turnResult(input);
}

test("every code has one static message and unknown codes fall back to provider_error", () => {
  assert.deepEqual([...FAILURE_CODES].sort(), ["approval_required", "cancelled", "lab_not_ready", "provider_error",
    "session_busy", "timeout", "usage_limit"]);
  for (const code of FAILURE_CODES) {
    assert.deepEqual(failure(code), { code, message: FAILURE_MESSAGES[code] });
    assert.equal(typeof FAILURE_MESSAGES[code], "string");
  }
  assert.deepEqual(failure("not-a-code"), failure("provider_error"));
  assert.deepEqual(classifyFailure(), failure("provider_error"));
  assert.deepEqual(classifyFailure({ error: "segfault in an unfamiliar provider" }), failure("provider_error"));
});

test("report maps each code from existing state, status and error signals", () => {
  const cases = [
    ["approval_required", { status: "ready", lastError: null }, { hasPendingApprovals: true }],
    ["approval_required", { status: "ready", lastError: null }, { hasPendingUserInput: true }],
    ["usage_limit", { status: "error", lastError: providerBody("You've hit your usage limit. Try again at 9pm.") }],
    ["usage_limit", { status: "idle", lastError: "429 Too Many Requests" }],
    ["timeout", { status: "error", lastError: "provider request timed out after 600s" }],
    ["session_busy", { status: "error", lastError: "Another turn is already running on this session" }],
    ["lab_not_ready", { status: "error", lastError: "Provider instance 'grok' is not ready" }],
    ["cancelled", { status: "error", lastError: "Turn was interrupted by the user" }],
    ["provider_error", { status: "error", lastError: providerBody("internal server error") }],
    ["provider_error", { status: "error", lastError: null }],
  ];
  for (const [code, session, extra] of cases) {
    const document = blockedReport(session, extra);
    assert.equal(document.status, "blocked", code);
    assert.equal(document.code, code, JSON.stringify(session));
    assert.equal(document.message, FAILURE_MESSAGES[code]);
    assert.ok(document.lastError === null || document.lastError === "provider-error", "existing marker kept");
  }
  // Non-failed statuses stay exactly as before: no code, no message.
  for (const session of [{ status: "running", lastError: "old" }, { status: "ready", lastError: null }]) {
    const document = blockedReport(session);
    assert.equal(Object.hasOwn(document, "code"), false);
    assert.equal(Object.hasOwn(document, "message"), false);
  }
  assert.equal(Object.hasOwn(blockedReport({ status: "error" }, { settledAt: "2026-10-25T00:00:00.000Z" }), "code"), false);
});

test("the relay seats report carries the same code for blocked threads", async () => {
  const adapter = new LoopbackRuntimeAdapter({
    client: {},
    observeImpl: async () => ({ activeTurns: [], projects: [], threads: [
      { id: "t1", projectId: "p1", session: { status: "error", lastError: providerBody("usage limit reached") } },
      { id: "t2", projectId: "p1", session: { status: "ready", lastError: null } },
    ] }),
  });
  const seats = await adapter.seats();
  assert.equal(seats.threads[0].report.code, "usage_limit");
  assert.equal(seats.threads[0].report.message, FAILURE_MESSAGES.usage_limit);
  assert.equal(Object.hasOwn(seats.threads[1].report, "code"), false);
  assert.equal(JSON.stringify(seats).includes(FAKE_SECRET), false);
});

test("turn-result failed/cancelled carry codes; success and pending do not", async () => {
  assert.deepEqual(await turnResultAdapter({ state: "cancelled" })(), { threadId: "thread", messageId: "message",
    turnCommandId: "command", turnId: "turn", assistantMessageId: null, instanceId: "codex", model: "gpt-5.6-sol",
    effort: "high", state: "cancelled", outputText: null, ...failure("cancelled") });
  for (const [code, error] of [
    ["usage_limit", providerBody("Claude usage limit reached")],
    ["usage_limit", { message: "insufficient_quota" }],
    ["timeout", "deadline exceeded"],
    ["session_busy", "session busy"],
    ["lab_not_ready", "harness_not_found"],
    ["provider_error", providerBody("upstream exploded")],
    ["provider_error", undefined],
  ]) {
    const result = await turnResultAdapter({ state: "failed", ...(error === undefined ? {} : { error }) })();
    assert.equal(result.code, code, JSON.stringify(error));
    assert.equal(result.message, FAILURE_MESSAGES[code]);
    assert.equal(Object.hasOwn(result, "error"), false, "upstream error is never projected");
  }
  const succeeded = await turnResultAdapter({ state: "succeeded", assistantMessageId: "assistant", outputText: "ok" })();
  assert.equal(Object.hasOwn(succeeded, "code"), false);
  const pending = await turnResultAdapter({ state: "pending", turnId: null })();
  assert.equal(Object.hasOwn(pending, "code"), false);
});

test("orchestrate receipts carry timeout, session_busy and provider codes", async () => {
  const busy = { dispatch: async () => { throw new T3HttpError({ method: "POST", pathname: "/dispatch", status: 409 }); } };
  await assert.rejects(applyIntent(busy, { action: "thread.pin", threadId: "t" }, { wait: false, commandId: "busy" }),
    (error) => { assert.equal(error.receipt.code, "session_busy"); assert.equal(error.receipt.status, "rejected"); return true; });

  const limited = { dispatch: async () => { throw new T3HttpError({ method: "POST", pathname: "/dispatch", status: 429 }); } };
  await assert.rejects(applyIntent(limited, { action: "thread.pin", threadId: "t" }, { wait: false, commandId: "limit" }),
    (error) => { assert.equal(error.receipt.code, "usage_limit"); return true; });

  const thread = { id: "t1", modelSelection: { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }] },
    messages: [], session: { status: "ready", activeTurnId: null, updatedAt: "before", lastError: null } };
  const silent = { thread: async () => ({ thread }), dispatch: async () => ({ sequence: 1 }) };
  await assert.rejects(applyIntent(silent, { action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access" },
    { commandId: "slow", intervalMs: 0, timeoutMs: 20 }), (error) => {
    assert.match(error.message, /Timed out waiting for T3 turn outcome/);
    assert.equal(error.receipt.code, "timeout");
    assert.equal(error.receipt.message, FAILURE_MESSAGES.timeout);
    return true;
  });

  const failing = {
    thread: async () => ({ thread }),
    dispatch: async (command) => {
      thread.messages.push({ id: command.message.messageId, role: "user" });
      thread.session = { status: "error", activeTurnId: null, updatedAt: "after", lastError: providerBody("You have reached your usage limit") };
      return { sequence: 2 };
    },
  };
  await assert.rejects(applyIntent(failing, { action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access" },
    { commandId: "limited", intervalMs: 0, timeoutMs: 1_000 }), (error) => {
    assert.equal(error.receipt.code, "usage_limit");
    assert.equal(JSON.stringify(error.receipt).includes(FAKE_SECRET), false);
    return true;
  });
});

test("redaction: a provider body with a secret-shaped token never reaches message or output", async () => {
  const bodies = [providerBody("usage limit reached"), providerBody("timed out"), providerBody("boom"),
    `Bearer ${FAKE_SECRET}`, `${FAKE_SECRET} ${"x".repeat(100_000)}`];
  for (const body of bodies) {
    const outputs = [
      blockedReport({ status: "error", lastError: body }),
      await turnResultAdapter({ state: "failed", error: body })(),
      await turnResultAdapter({ state: "failed", error: { message: body } })(),
      classifyFailure({ error: new Error(body) }),
    ];
    for (const output of outputs) {
      assert.ok(FAILURE_CODES.includes(output.code));
      assert.equal(output.message, FAILURE_MESSAGES[output.code]);
      assert.equal(output.message.includes(FAKE_SECRET), false);
      assert.equal(JSON.stringify(output).includes(FAKE_SECRET), false);
    }
  }
});

test("context and token overflow are provider errors; key-value timeouts are not timeouts", () => {
  for (const [code, text] of [
    ["usage_limit", "usage limit reached"],
    ["usage_limit", "Rate limit reached for requests"],
    ["usage_limit", "monthly spend limit exceeded"],
    ["usage_limit", "Rate limit reached on tokens per min (TPM)"],
    ["provider_error", "maximum context length limit exceeded"],
    ["provider_error", "prompt token limit exceeded"],
    ["provider_error", "This model's maximum context length is 8192 tokens (context_length_exceeded)"],
    ["provider_error", "prompt is too long: 210000 tokens > 200000 maximum"],
    ["provider_error", "context window limit reached"],
    ["timeout", "timeout"],
    ["timeout", "provider request timed out after 600s"],
    ["timeout", "request timeout"],
    ["timeout", "Timeout exceeded while waiting for the model"],
    ["timeout", "ETIMEDOUT"],
    ["provider_error", "invalid api key (timeout=30)"],
    ["provider_error", "bad config: timeout: 30, retries: 2"],
    ["provider_error", "unsupported option timeout"],
  ]) assert.equal(classifyFailure({ state: "failed", error: text }).code, code, text);
});
