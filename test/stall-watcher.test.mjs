import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexConcurrency, NUDGE_TEXT, runPass, stalledTail, WAKE_EXIT } from "../scripts/stall-watcher.mjs";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "stall-watcher");
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const MIN = 60_000;
const T0 = Date.parse("2026-10-27T10:00:00.000Z");

// Fake clock and fake tentacles CLI; real files in a private temp dir.
function harness(threads, turn = (threadId) => ({ threadId, title: "t" })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stall-"));
  const logDir = path.join(root, "logs"); const stateDir = path.join(root, "state");
  fs.mkdirSync(logDir);
  const clock = { t: T0 };
  const calls = []; const out = [];
  const sendCode = { value: 0 };
  const setLog = (id, fixture, mtime) => {
    const file = path.join(logDir, `events.${id}.log`);
    fs.copyFileSync(path.join(FIXTURES, fixture), file);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  const appendLog = (id, mtime, line) => {
    const file = path.join(logDir, `events.${id}.log`);
    fs.appendFileSync(file, `${line}\n`);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  };
  const cli = async (args) => {
    calls.push(args);
    if (args[0] === "observe") return { code: 0, stdout: JSON.stringify({ activeTurns: threads.map(turn) }) };
    return { code: sendCode.value, stdout: "{}" };
  };
  const pass = (extra = {}) => runPass({ logDir, stateDir, now: () => clock.t, cli, out: (line) => out.push(line), ...extra });
  const sends = () => calls.filter((args) => args[0] === "act").map((args) => JSON.parse(args.at(-1)));
  const allActions = () => fs.readFileSync(path.join(stateDir, "stall-watcher.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const actions = () => allActions().filter((entry) => entry.action !== "concurrency");
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  const stateFile = path.join(stateDir, "stall-watcher.state.json");
  return { clock, calls, out, sendCode, setLog, appendLog, pass, sends, actions, allActions, stateDir, stateFile, cleanup };
}

test("fixture tails: 429 reconnect is a stall tail, a recovered turn is not", () => {
  assert.equal(stalledTail(fs.readFileSync(path.join(FIXTURES, "stalled-429.log"), "utf8")), true);
  assert.equal(stalledTail(fs.readFileSync(path.join(FIXTURES, "healthy.log"), "utf8")), false);
});

test("429 or reconnect text inside a command, its output or assistant text is never a stall tail", () => {
  for (const fixture of ["healthy-429-command.log", "healthy-429-output.log", "healthy-429-agent-message.log"]) {
    assert.equal(stalledTail(fs.readFileSync(path.join(FIXTURES, fixture), "utf8")), false, fixture);
  }
});

test("only parsed NTIVE error or CANON runtime warning/error events count; unparseable lines never do", () => {
  const line = (tag, event) => `[2026-10-27T09:42:00.000Z] ${tag}: ${JSON.stringify(event)}`;
  assert.equal(stalledTail(line("NTIVE", { method: "error", params: { error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } } } })), true);
  assert.equal(stalledTail(line("NTIVE", { method: "error", payload: { error: { additionalDetails: "exceeded retry limit, last status: 429 Too Many Requests" } } })), true);
  assert.equal(stalledTail(line("CANON", { type: "runtime.error", payload: { message: "Reconnecting... 5/5" } })), true);
  assert.equal(stalledTail(line("CANON", { type: "runtime.warning", payload: { detail: { error: { codexErrorInfo: { responseStreamDisconnected: {} } } } } })), true);
  assert.equal(stalledTail(line("NTIVE", { method: "error", message: "model not found" })), false, "an unrelated error is not a stall");
  assert.equal(stalledTail(line("CANON", { type: "content.delta", payload: { message: "Reconnecting... 5/5" } })), false);
  assert.equal(stalledTail(line("NTIVE", { method: "item/completed", payload: { error: { message: "429 Too Many Requests" } } })), false);
  assert.equal(stalledTail('[2026-10-27T09:42:00.000Z] NTIVE: {"method":"error","message":"Reconnecting... 5/5"'), false, "truncated JSON");
  assert.equal(stalledTail("Reconnecting... 5/5 429 Too Many Requests"), false, "no event prefix");
});

test("a long silent command after grepping for 429 text is never nudged", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "healthy-429-command.log", T0 - 80 * MIN);
  assert.equal(await h.pass(), 0);
  assert.deepEqual(h.sends(), []);
});

test("the newest stall error or turn activity line decides the tail (KRA-9525)", () => {
  const tail = (fixture) => stalledTail(fs.readFileSync(path.join(FIXTURES, fixture), "utf8"));
  assert.equal(tail("recovered-long-command.log"), false, "reconnect, recovery, then a command started");
  assert.equal(tail("stalled-reconnect-newest.log"), true, "reconnect error is the newest line");
  assert.equal(tail("stalled-reconnect-then-warning.log"), true, "only a plain runtime.warning after the reconnect");
});

test("a recovered reconnect followed by a long silent command is never nudged (KRA-9525)", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  for (const idle of [11, 30, 120]) {
    h.setLog(A, "recovered-long-command.log", T0 - idle * MIN);
    assert.equal(await h.pass(), 0);
    h.clock.t += 20 * MIN;
  }
  assert.deepEqual(h.sends(), []);
  assert.deepEqual(h.out, []);
});

test("a reconnect error as the newest line, or followed only by a runtime.warning, is nudged", async (t) => {
  for (const fixture of ["stalled-reconnect-newest.log", "stalled-reconnect-then-warning.log"]) {
    const h = harness([A]); t.after(h.cleanup);
    h.setLog(A, fixture, T0 - 11 * MIN);
    assert.equal(await h.pass(), 0);
    assert.deepEqual(h.sends().map((intent) => intent.threadId), [A], fixture);
  }
});

test("a stalled thread gets exactly one full-access continue with the fixed text", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  assert.equal(await h.pass(), 0);
  assert.deepEqual(h.sends(), [{ action: "thread.continue", threadId: A, text: NUDGE_TEXT, runtimeMode: "full-access" }]);
  assert.deepEqual(h.calls.find((args) => args[0] === "act").slice(0, 3), ["act", "--no-wait", "--intent"]);
  assert.deepEqual(h.actions().map((entry) => entry.action), ["nudge"]);
  assert.deepEqual(h.out, []);
});

test("healthy threads are untouched", async (t) => {
  const h = harness([A, B]); t.after(h.cleanup);
  h.setLog(A, "healthy.log", T0 - 60 * MIN); // idle but its tail is a completed turn
  h.setLog(B, "stalled-429.log", T0 - 5 * MIN); // disconnect tail but still inside the window
  assert.equal(await h.pass(), 0);
  assert.deepEqual(h.sends(), []);
  assert.deepEqual(h.allActions().map((entry) => entry.action), ["concurrency"], "nothing to act on, only the concurrency line");
});

test("nudges are staggered at least 60 s apart across threads", async (t) => {
  const h = harness([A, B]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 20 * MIN);
  h.setLog(B, "stalled-429.log", T0 - 20 * MIN);
  await h.pass();
  assert.deepEqual(h.sends().map((intent) => intent.threadId), [A]);
  h.clock.t += 59_000; await h.pass();
  assert.deepEqual(h.sends().map((intent) => intent.threadId), [A]);
  h.clock.t += 1_000; await h.pass();
  assert.deepEqual(h.sends().map((intent) => intent.threadId), [A, B]);
});

test("after a 429 the second nudge waits 10 min, then at most two nudges, then WAKE", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  await h.pass();
  h.clock.t = T0 + 9 * MIN; await h.pass();
  assert.equal(h.sends().length, 1, "429 backoff holds the second nudge");
  h.clock.t = T0 + 10 * MIN; assert.equal(await h.pass(), 0);
  assert.equal(h.sends().length, 2);
  h.clock.t = T0 + 19 * MIN; assert.equal(await h.pass(), 0, "not yet 10 min after the second nudge");
  assert.deepEqual(h.out, []);
  h.clock.t = T0 + 20 * MIN; assert.equal(await h.pass(), WAKE_EXIT);
  assert.deepEqual(h.out, [`WAKE ${A}`]);
  h.clock.t = T0 + 60 * MIN; assert.equal(await h.pass(), 0, "WAKE fires once");
  assert.equal(h.sends().length, 2, "never a third nudge");
});

test("WAKE once when the second nudge's turn disconnects again and then idles past the window", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  await h.pass();
  h.clock.t = T0 + 10 * MIN; await h.pass();
  // The second nudge started a turn that disconnected again: the log moved.
  h.appendLog(A, T0 + 11 * MIN, '[2026-10-27T10:11:00.000Z] NTIVE: {"method":"error","message":"Reconnecting... 5/5"}');
  h.clock.t = T0 + 21 * MIN; assert.equal(await h.pass(), 0, "tail idle exactly 10 min, not more");
  h.clock.t = T0 + 22 * MIN; assert.equal(await h.pass(), WAKE_EXIT);
  assert.deepEqual(h.out, [`WAKE ${A}`]);
  h.clock.t = T0 + 60 * MIN; assert.equal(await h.pass(), 0, "WAKE fires once per thread");
  assert.equal(h.sends().length, 2, "never a third nudge");
});

test("no WAKE when the second nudge's turn recovered", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  await h.pass();
  h.clock.t = T0 + 10 * MIN; await h.pass();
  for (const line of ['NTIVE: {"method":"turn/started","payload":{"turn":{"status":"inProgress"}}}',
    'NTIVE: {"method":"item/agentMessage/delta","payload":{"delta":"resumed"}}',
    'CANON: {"type":"turn.completed","payload":{"state":"completed"}}']) h.appendLog(A, T0 + 11 * MIN, `[2026-10-27T10:11:00.000Z] ${line}`);
  h.clock.t = T0 + 40 * MIN; assert.equal(await h.pass(), 0);
  assert.deepEqual(h.out, []);
  assert.equal(h.sends().length, 2);
});

test("a corrupt state file is moved aside and logged, and the pass still runs and exits 0", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  fs.mkdirSync(h.stateDir, { recursive: true });
  fs.writeFileSync(h.stateFile, "{\"threads\": {");
  assert.equal(await h.pass(), 0);
  const aside = `stall-watcher.state.json.corrupt-${T0 / 1000}`;
  assert.equal(fs.readFileSync(path.join(h.stateDir, aside), "utf8"), "{\"threads\": {");
  assert.deepEqual(h.actions().map((entry) => [entry.action, entry.movedTo]), [["state-corrupt", aside], ["nudge", undefined]]);
  assert.equal(h.sends().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(h.stateFile, "utf8")).threads[A].nudges.length, 1, "fresh state written");
  h.clock.t = T0 + 10 * MIN; assert.equal(await h.pass(), 0);
  assert.equal(h.sends().length, 2, "the next pass reads the fresh state");
});

test("valid JSON without the state shape is treated as corrupt too", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  fs.mkdirSync(h.stateDir, { recursive: true });
  fs.writeFileSync(h.stateFile, "null");
  assert.equal(await h.pass(), 0);
  assert.equal(h.actions().some((entry) => entry.action === "state-corrupt"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.stateFile, "utf8")), { lastNudgeAt: null, threads: {} });
});

test("a thread entry without valid nudges is corrupt: moved aside, state empty, pass exits 0", async (t) => {
  const bad = [{ lastNudgeAt: null, threads: { [A]: { wokeAt: null } } },
    { lastNudgeAt: null, threads: { [A]: { nudges: [T0] } } },
    { lastNudgeAt: null, threads: { [A]: { nudges: [{ at: "x", size: 1, mtimeMs: 1, ok: true }] } } },
    { lastNudgeAt: null, threads: { [A]: { nudges: [], wokeAt: "soon" } } },
    { lastNudgeAt: "now", threads: {} }];
  for (const state of bad) {
    const h = harness([A]); t.after(h.cleanup);
    h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
    fs.mkdirSync(h.stateDir, { recursive: true });
    fs.writeFileSync(h.stateFile, JSON.stringify(state));
    assert.equal(await h.pass(), 0, JSON.stringify(state));
    const aside = `stall-watcher.state.json.corrupt-${T0 / 1000}`;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.stateDir, aside), "utf8")), state);
    assert.deepEqual(h.actions().map((entry) => [entry.action, entry.movedTo]), [["state-corrupt", aside], ["nudge", undefined]]);
    assert.equal(JSON.parse(fs.readFileSync(h.stateFile, "utf8")).threads[A].nudges.length, 1, "fresh state written");
  }
});

test("a state file the watcher wrote itself is valid on the next pass", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  await h.pass(); h.clock.t = T0 + 10 * MIN; await h.pass(); h.clock.t = T0 + 21 * MIN; await h.pass();
  assert.equal(h.actions().some((entry) => entry.action === "state-corrupt"), false);
  assert.equal(h.out.length, 1, "WAKE read back wokeAt-free state and then wrote wokeAt");
});

test("log rotation: only the current events.<uuid>.log is read, and a rotation is a change, never a stall", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  const current = path.join(h.stateDir, "..", "logs", `events.${A}.log`);
  // Old rotated files hold a stall tail; the current file holds a healthy, idle tail.
  h.setLog(A, "stalled-429.log", T0 - 60 * MIN);
  fs.renameSync(current, `${current}.2`);
  h.setLog(A, "stalled-429.log", T0 - 40 * MIN);
  fs.renameSync(current, `${current}.1`);
  h.setLog(A, "healthy.log", T0 - 30 * MIN);
  assert.equal(await h.pass(), 0);
  assert.deepEqual(h.sends(), [], "rotated .1/.2 files are never read");
  // A stalled current file draws one nudge; then it rotates to .1 and a smaller file replaces it.
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  await h.pass();
  assert.equal(h.sends().length, 1);
  fs.renameSync(current, `${current}.1`);
  fs.writeFileSync(current, '[2026-10-27T10:05:00.000Z] NTIVE: {"method":"turn/started","payload":{"turn":{"status":"inProgress"}}}\n');
  fs.utimesSync(current, (T0 + 5 * MIN) / 1000, (T0 + 5 * MIN) / 1000);
  for (const at of [10, 30, 60]) { h.clock.t = T0 + at * MIN; assert.equal(await h.pass(), 0); }
  assert.equal(h.sends().length, 1, "no nudge after the rotation");
  assert.deepEqual(h.out, [], "no WAKE after the rotation");
  // Rotated to an empty current file: still no stall.
  fs.renameSync(current, `${current}.1`); fs.writeFileSync(current, "");
  fs.utimesSync(current, (T0 + 61 * MIN) / 1000, (T0 + 61 * MIN) / 1000);
  h.clock.t = T0 + 120 * MIN; assert.equal(await h.pass(), 0);
  assert.equal(h.sends().length, 1);
});

test("each pass logs the generating Codex count per provider instance and never changes what it sends", async (t) => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
  const instanceOf = { [ids[0]]: "codex", [ids[1]]: "codex", [ids[2]]: "codex", [ids[3]]: "codex-sol-2" };
  const turn = (threadId) => ({ threadId, providerName: "codex", providerInstanceId: instanceOf[threadId] });
  for (const [threads, expected] of [[[], {}], [[ids[0]], { codex: 1 }], [ids, { codex: 3, "codex-sol-2": 1 }]]) {
    const h = harness(threads, turn); t.after(h.cleanup);
    for (const id of threads) h.setLog(id, "stalled-429.log", T0 - 20 * MIN);
    assert.equal(await h.pass(), 0);
    const [first, ...rest] = h.allActions();
    assert.deepEqual([first.action, first.codex], ["concurrency", expected]);
    assert.equal(rest.filter((entry) => entry.action === "concurrency").length, 0, "one concurrency line per run");
    assert.deepEqual(h.sends().map((intent) => intent.threadId), threads.slice(0, 1), "nudges are unchanged by the count");
  }
});

test("codexConcurrency ignores other providers and labels unsafe instance ids unknown", () => {
  assert.deepEqual(codexConcurrency([
    { providerName: "Codex", providerInstanceId: "codex" },
    { providerName: "grok", providerInstanceId: "grok" },
    { providerName: "codex", providerInstanceId: "bad id\n" },
    { providerName: "codex", providerInstanceId: null },
    null,
  ]), { codex: 1, unknown: 2 });
});

test("codexConcurrency counts prototype-named instance ids as plain ids", () => {
  const ids = ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"];
  const counts = codexConcurrency([...ids, "constructor"].map((providerInstanceId) => ({ providerName: "codex", providerInstanceId })));
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), { constructor: 2, toString: 1, valueOf: 1, ["__proto__"]: 1, hasOwnProperty: 1 });
  assert.equal(Object.getPrototypeOf(codexConcurrency([])), Object.prototype, "a plain object, so the log line is unchanged");
});

test("a failed send counts toward the two-nudge limit", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.sendCode.value = 1;
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  await h.pass(); h.clock.t = T0 + 10 * MIN; await h.pass(); h.clock.t = T0 + 30 * MIN; await h.pass();
  assert.equal(h.sends().length, 2);
  assert.deepEqual(h.actions().map((entry) => entry.action).slice(0, 2), ["nudge-failed", "nudge-failed"]);
});

test("dry run sends nothing and writes no state", async (t) => {
  const h = harness([A]); t.after(h.cleanup);
  h.setLog(A, "stalled-429.log", T0 - 11 * MIN);
  assert.equal(await h.pass({ dryRun: true }), 0);
  assert.equal(await h.pass({ dryRun: true }), 0);
  assert.deepEqual(h.sends(), []);
  assert.equal(fs.existsSync(path.join(h.stateDir, "stall-watcher.state.json")), false);
  assert.deepEqual(h.actions().map((entry) => [entry.action, entry.dryRun, entry.nudge]), [["nudge", true, 1], ["nudge", true, 1]]);
});

test("observe failure exits 1; non-UUID ids never become paths", async (t) => {
  const h = harness(["../../etc/passwd"]); t.after(h.cleanup);
  assert.equal(await h.pass(), 0);
  assert.deepEqual(h.sends(), []);
  const failing = await runPass({ logDir: h.stateDir, stateDir: h.stateDir, now: () => T0, cli: async () => ({ code: 2, stdout: "" }), out: () => {} });
  assert.equal(failing, 1);
  assert.deepEqual(h.actions().map((entry) => entry.action), ["observe-failed"]);
});
