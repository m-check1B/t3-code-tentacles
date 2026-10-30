import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatDoctor } from "../src/bridge.mjs";
import { probeResponds, respondsRequest } from "../src/doctor-probe.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./helpers/fake-t3-client.mjs", import.meta.url));

// KRA-9857: a synthetic T3 whose labs answer, stay silent, or fail. No real providers.
function fakeT3(t, behaviour, { failProject = false, noTurnResult = false } = {}) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctor-responds-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const projects = new Map();
  const threads = new Map();
  const commands = [];
  const turns = new Map();
  const failedReads = new Map();
  const brokenThreads = new Set();
  const recoverOnce = new Set();
  const client = {
    snapshot: async () => ({ projects: [...projects.values()], threads: [...threads.values()] }),
    thread: async (threadId) => {
      // readfail: originate's own read succeeds, the first probe poll gets a 503.
      const reads = failedReads.get(threadId);
      if (reads !== undefined) failedReads.set(threadId, reads + 1);
      if (recoverOnce.delete(threadId)) throw new T3HttpError({ method: "GET", pathname: threadId, status: 503, body: "START-CANARY" });
      if (brokenThreads.has(threadId)) throw new T3HttpError({ method: "GET", pathname: threadId, status: 503, body: "START-CANARY" });
      if (reads === 1) throw new T3HttpError({ method: "GET", pathname: threadId, status: 503, body: "READ-CANARY" });
      if (!threads.has(threadId)) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread: structuredClone(threads.get(threadId)) };
    },
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "project.create" && failProject) throw new T3HttpError({ method: "POST", pathname: "/api/orchestration/dispatch", status: 500, body: "PROJECT-CANARY" });
      if (command.type === "project.create") projects.set(command.projectId, { id: command.projectId, workspaceRoot: command.workspaceRoot });
      if (command.type === "thread.create") threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, title: command.title, modelSelection: command.modelSelection, messages: [], session: null });
      if (command.type === "thread.turn.start") {
        const thread = threads.get(command.threadId);
        const mode = behaviour[command.modelSelection.instanceId];
        thread.messages.push({ id: command.message.messageId, role: "user", text: command.message.text });
        turns.set(command.threadId, { state: "pending", turnId: "turn-1", messageId: command.message.messageId, turnCommandId: command.commandId });
        if (mode === "readfail") failedReads.set(command.threadId, 0);
        // startfail: every read after the turn start gets a 503, so originate's own wait fails.
        if (mode === "startfail") brokenThreads.add(command.threadId);
        // startfail-recover: only the first read after the turn start gets a 503.
        if (mode === "startfail-recover") recoverOnce.add(command.threadId);
        if (mode === "answer") thread.messages.push({ id: "assistant-1", role: "assistant", text: "OK" });
        thread.session = mode === "error"
          ? { status: "error", activeTurnId: null, lastError: "rate limit exceeded SECRET-CANARY" }
          : { status: "running", activeTurnId: "turn-1" };
      }
      if (command.type === "thread.turn.interrupt") {
        turns.get(command.threadId).state = "cancelled";
        threads.get(command.threadId).session = { status: "ready", activeTurnId: null };
      }
      return { sequence: commands.length };
    },
    request: async (route, { body } = {}) => {
      assert.equal(route, "/api/orchestration/turn-result");
      if (noTurnResult) throw new T3HttpError({ method: "POST", pathname: route, status: 404, body: null });
      if (!body) return { talkTurnResult: "v1" };
      // Like T3, only the exact (threadId, messageId, turnCommandId) tuple names a turn.
      const { messageId, turnCommandId, ...turn } = turns.get(body.threadId) ?? {};
      if (messageId !== body.messageId || turnCommandId !== body.turnCommandId) throw new T3HttpError({ method: "POST", pathname: route, status: 404, body: null });
      return { ...body, ...turn };
    },
  };
  return { client, commands, workspace };
}

const labs = [
  { instanceId: "codex", ready: true, defaultModel: "gpt-synthetic" },
  { instanceId: "grok", ready: true, defaultModel: "grok-synthetic" },
  { instanceId: "claudeAgent", ready: true, defaultModel: "claude-synthetic" },
  { instanceId: "pi", ready: false, defaultModel: "pi-synthetic" },
];
const options = (workspace) => ({ workspace, timeoutMs: 400, intervalMs: 10, interruptOptions: { intervalMs: 10, startWaitMs: 200, terminalWaitMs: 200 } });

test("answering, silent and failing labs map to responds, no_response and error", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { codex: "silent", grok: "answer", claudeAgent: "error" });
  const result = await probeResponds(client, labs, options(workspace));
  const row = (id) => result.labs.find((lab) => lab.instanceId === id);
  assert.deepEqual(result.labs.map((lab) => lab.instanceId), ["codex", "grok", "claudeAgent"], "only ready labs by default");

  assert.equal(row("grok").status, "responds");
  assert.equal(typeof row("grok").firstEventMs, "number");
  assert.equal(row("grok").action, undefined);

  assert.equal(row("codex").status, "no_response");
  assert.equal(row("codex").firstEventMs, null);
  assert.match(row("codex").action, /never answers/);
  assert.match(row("codex").action, /--model/);
  assert.equal(row("codex").interrupt, "cancelled");
  const interrupts = commands.filter((command) => command.type === "thread.turn.interrupt");
  assert.equal(interrupts.length, 1, "only the silent probe is interrupted");
  assert.equal(interrupts[0].threadId, row("codex").threadId);
  assert.equal(interrupts[0].turnId, "turn-1");

  assert.equal(row("claudeAgent").status, "error");
  assert.equal(row("claudeAgent").code, "usage_limit");
  assert.doesNotMatch(JSON.stringify(result), /SECRET-CANARY|"OK"/, "no provider or model text leaves the probe");

  const created = commands.filter((command) => command.type === "thread.create");
  assert.ok(created.every((command) => /^Tentacles doctor probe: /.test(command.title)));
  const projectCreates = commands.filter((command) => command.type === "project.create");
  assert.equal(projectCreates.length, 1, "parallel probes share one probe project");
  assert.equal(projectCreates[0].workspaceRoot, workspace);
  assert.ok(commands.filter((command) => command.type === "thread.turn.start").every((command) => command.runtimeMode === "full-access"));
  assert.match(formatDoctor({ labs: [], responds: result }), /Responds probe/);
});

test("a lab list selects exactly those labs; a listed lab that is not ready is an error without a model call", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { grok: "answer" });
  const result = await probeResponds(client, labs, { ...options(workspace), select: ["grok", "pi"] });
  assert.deepEqual(result.labs.map((lab) => [lab.instanceId, lab.status, lab.code ?? null]), [["grok", "responds", null], ["pi", "error", "lab_not_ready"]]);
  assert.equal(commands.filter((command) => command.type === "thread.turn.start").length, 1);
});

test("default doctor text is unchanged without the responds block", () => {
  assert.doesNotMatch(formatDoctor({ labs: [] }), /Responds probe/);
});

// B3 PR 69 R2 below.

test("respondsRequest is null without the flag and validates the flags before doctor runs (P2-1, P3-5)", () => {
  assert.equal(respondsRequest({ _: [] }, null), null);
  assert.equal(respondsRequest({ _: [], json: true, models: "full" }, null), null);
  assert.deepEqual(respondsRequest({ responds: "all" }, null), { select: null, timeoutMs: 60_000 });
  assert.deepEqual(respondsRequest({ responds: "codex, grok", "responds-timeout": "5" }, null), { select: ["codex", "grok"], timeoutMs: 5_000 });
  assert.throws(() => respondsRequest({ "responds-timeout": "5" }, null), /--responds-timeout needs --responds/);
  for (const responds of ["", ",", " , "]) assert.throws(() => respondsRequest({ responds }, null), /--responds needs all or a lab list/);
  for (const seconds of ["0", "601", "1.5", "x"]) assert.throws(() => respondsRequest({ responds: "all", "responds-timeout": seconds }, null), /between 1 and 600/);
  assert.throws(() => respondsRequest({ responds: "all" }, "mini"), /local T3 only/);
});

test("CLI doctor --json without --responds sends no probe against a T3 with a ready lab (P2-1)", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-responds-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  fs.writeFileSync(tokenFile, "synthetic-fixture-only-token", { mode: 0o600 });
  const commandsFile = path.join(directory, "commands.jsonl");
  const env = {
    ...process.env, HOME: directory, T3_URL: "http://127.0.0.1:9", T3_HERMES_TOKEN_FILE: tokenFile, TENTACLES_T3_AUTO_REAUTH: "0",
    FAKE_T3_COMMANDS: commandsFile,
    FAKE_T3_SETTINGS: JSON.stringify({ providerInstances: { codex: { driver: "codex", enabled: true } } }),
    FAKE_T3_CONFIG: JSON.stringify({ providers: [{ instanceId: "codex", status: "ready", installed: true, models: [{ slug: "gpt-synthetic", isDefault: true }] }] }),
  };
  delete env.TENTACLES_COMPUTER;
  const spawned = spawnSync(process.execPath, ["--import", PRELOAD, CLI, "doctor", "--json"], { encoding: "utf8", env });
  assert.equal(spawned.status, 0, spawned.stderr);
  const report = JSON.parse(spawned.stdout);
  assert.equal(report.labs.find((lab) => lab.instanceId === "codex")?.ready, true, "the fake T3 has a ready lab");
  assert.equal(Object.hasOwn(report, "responds"), false);
  assert.equal(fs.existsSync(commandsFile), false, "no dispatch was sent");
  assert.equal(fs.existsSync(path.join(directory, ".local", "state", "t3-hermes-bridge", "doctor-probe")), false);
});

test("an interrupt that does not stop the probe turn tells the user to stop the thread (P3-1)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { codex: "silent" }, { noTurnResult: true });
  const [row] = (await probeResponds(client, labs, { ...options(workspace), select: ["codex"] })).labs;
  assert.equal(row.status, "no_response");
  assert.equal(row.interrupt, "unsupported", "a T3 that 404s every tuple is not read as no turn accepted");
  assert.equal(commands.some((command) => command.type === "thread.turn.interrupt"), false);
  assert.ok(row.action.includes(`probe turn may still be running; stop thread ${row.threadId} in T3`), row.action);
});

test("a T3 read failure while polling still interrupts and reports the T3 HTTP status, not a provider error (P3-2)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { codex: "readfail" });
  const [row] = (await probeResponds(client, labs, { ...options(workspace), select: ["codex"] })).labs;
  assert.equal(row.status, "error");
  assert.equal(row.t3HttpStatus, 503);
  assert.equal(Object.hasOwn(row, "code"), false);
  assert.equal(row.interrupt, "cancelled");
  assert.equal(commands.filter((command) => command.type === "thread.turn.interrupt").length, 1);
  assert.doesNotMatch(JSON.stringify(row), /READ-CANARY/);
  assert.match(formatDoctor({ labs: [], responds: { timeoutMs: 400, labs: [row] } }), /t3 http=503/);
});

test("the probe workspace is tightened to 0700 and a symlinked one is refused (P3-3)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { grok: "answer" });
  fs.chmodSync(workspace, 0o755);
  await probeResponds(client, labs, { ...options(workspace), select: ["grok"] });
  assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);

  const link = `${workspace}-link`;
  fs.symlinkSync(workspace, link);
  t.after(() => fs.rmSync(link, { force: true }));
  const before = commands.length;
  await assert.rejects(probeResponds(client, labs, { ...options(link), select: ["grok"] }), /probe workspace/);
  assert.equal(commands.length, before, "no dispatch into a symlinked workspace");
});

test("a failed probe project create keeps the report and marks each probed lab an error (P3-4)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { grok: "answer" }, { failProject: true });
  const result = await probeResponds(client, labs, { ...options(workspace), select: ["grok", "pi"] });
  assert.deepEqual(result.labs.map((lab) => [lab.instanceId, lab.status, lab.code ?? null, lab.t3HttpStatus ?? null]),
    [["grok", "error", null, 500], ["pi", "error", "lab_not_ready", null]]);
  assert.equal(commands.some((command) => command.type === "thread.turn.start"), false);
  assert.doesNotMatch(JSON.stringify(result), /PROJECT-CANARY/);
});

test("a ready lab without a default model is lab_not_ready without a model call (P3-6)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, {});
  const result = await probeResponds(client, [{ instanceId: "codex", ready: true, defaultModel: null }], options(workspace));
  assert.deepEqual(result.labs.map((lab) => [lab.status, lab.code]), [["error", "lab_not_ready"]]);
  assert.match(result.labs[0].action, /no default model/);
  assert.equal(commands.length, 0);
});

test("the probe project uses the first selected ready lab's model selection (P3-7)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { grok: "answer", claudeAgent: "answer" });
  await probeResponds(client, labs, { ...options(workspace), select: ["pi", "grok", "claudeAgent"] });
  const [project] = commands.filter((command) => command.type === "project.create");
  assert.equal(project.defaultModelSelection.instanceId, "grok");
  assert.equal(project.defaultModelSelection.model, "grok-synthetic");
});

// KRA-9874: B3 PR 69 follow-ups N1-N3.

test("a T3 read fault after the probe turn starts still reports the thread and tries to interrupt it (N1)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { codex: "startfail" });
  const [row] = (await probeResponds(client, labs, { ...options(workspace), select: ["codex"] })).labs;
  const [start] = commands.filter((command) => command.type === "thread.turn.start");
  assert.ok(start, "the probe turn was started");
  assert.equal(row.status, "error");
  assert.equal(row.t3HttpStatus, 503);
  assert.equal(row.threadId, start.threadId);
  // T3 still cannot read the thread, so the interrupter refuses to guess and the row names the thread to stop.
  assert.equal(row.interrupt, "unavailable");
  assert.ok(row.action.includes(`probe turn may still be running; stop thread ${start.threadId} in T3`), row.action);
  assert.doesNotMatch(JSON.stringify(row), /START-CANARY/);
});

test("the probe workspace must resolve to itself, and T3 gets the resolved path (N2)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { grok: "answer" });
  const parentLink = `${workspace}-parent`;
  fs.symlinkSync(workspace, parentLink);
  t.after(() => fs.rmSync(parentLink, { force: true }));
  fs.mkdirSync(path.join(workspace, "probe"), { mode: 0o700 });
  await assert.rejects(probeResponds(client, labs, { ...options(path.join(parentLink, "probe")), select: ["grok"] }), /probe workspace/);
  assert.equal(commands.length, 0, "no dispatch through a symlinked parent");

  const cwd = process.cwd();
  process.chdir(workspace);
  t.after(() => process.chdir(cwd));
  await probeResponds(client, labs, { ...options("probe"), select: ["grok"] });
  const real = path.join(workspace, "probe");
  assert.equal(commands.find((command) => command.type === "project.create").workspaceRoot, real);
});

test("CLI doctor --responds-timeout without --responds fails before any T3 call (N3)", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-responds-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  fs.writeFileSync(tokenFile, "synthetic-fixture-only-token", { mode: 0o600 });
  const callsFile = path.join(directory, "calls.log");
  const env = {
    ...process.env, HOME: directory, T3_URL: "http://127.0.0.1:9", T3_HERMES_TOKEN_FILE: tokenFile, TENTACLES_T3_AUTO_REAUTH: "0",
    FAKE_T3_CALLS: callsFile,
    FAKE_T3_COMMANDS: path.join(directory, "commands.jsonl"),
    FAKE_T3_SETTINGS: JSON.stringify({ providerInstances: { codex: { driver: "codex", enabled: true } } }),
    FAKE_T3_CONFIG: JSON.stringify({ providers: [{ instanceId: "codex", status: "ready", installed: true, models: [{ slug: "gpt-synthetic", isDefault: true }] }] }),
  };
  delete env.TENTACLES_COMPUTER;
  // Positive control: the same env records T3 calls when doctor does run (B3 PR 70 F2).
  const control = spawnSync(process.execPath, ["--import", PRELOAD, CLI, "doctor", "--json"], { encoding: "utf8", env });
  assert.equal(control.status, 0, control.stderr);
  assert.match(fs.readFileSync(callsFile, "utf8"), /^getSettings$/m);
  fs.rmSync(callsFile);
  const spawned = spawnSync(process.execPath, ["--import", PRELOAD, CLI, "doctor", "--responds-timeout", "5"], { encoding: "utf8", env });
  assert.equal(spawned.status, 1, spawned.stdout);
  assert.match(spawned.stderr, /--responds-timeout needs --responds/);
  assert.equal(fs.existsSync(callsFile), false, "no T3 client call was made");
});

// KRA-9876: B3 PR 70 follow-ups F1 and F3.

test("a T3 fault inside the start that then clears interrupts exactly the started turn (F1)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { codex: "startfail-recover", grok: "answer" });
  const result = await probeResponds(client, labs, { ...options(workspace), select: ["codex", "grok"] });
  const row = result.labs.find((lab) => lab.instanceId === "codex");
  const start = commands.find((command) => command.type === "thread.turn.start" && command.modelSelection.instanceId === "codex");
  assert.equal(row.status, "error");
  assert.equal(row.t3HttpStatus, 503);
  assert.equal(row.threadId, start.threadId);
  assert.equal(row.interrupt, "cancelled");
  const interrupts = commands.filter((command) => command.type === "thread.turn.interrupt");
  assert.equal(interrupts.length, 1, "only the faulted probe is interrupted");
  assert.equal(interrupts[0].threadId, start.threadId);
  assert.equal(Object.hasOwn(row, "action") && row.action.includes("may still be running"), false);
  assert.equal(result.labs.find((lab) => lab.instanceId === "grok").status, "responds");
});

test("a thread create fault reports that no probe turn was accepted, not a turn to stop (F3)", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { codex: "silent" });
  const dispatch = client.dispatch;
  client.dispatch = async (command) => {
    if (command.type === "thread.create") { commands.push(command); throw new T3HttpError({ method: "POST", pathname: "/api/orchestration/dispatch", status: 500, body: "CREATE-CANARY" }); }
    return dispatch(command);
  };
  const [row] = (await probeResponds(client, labs, { ...options(workspace), select: ["codex"] })).labs;
  assert.equal(row.status, "error");
  assert.equal(row.t3HttpStatus, 500);
  assert.equal(row.interrupt, "target_mismatch");
  assert.ok(row.action.includes(`no probe turn was accepted on thread ${row.threadId}`), row.action);
  assert.doesNotMatch(row.action, /may still be running/);
  assert.equal(commands.some((command) => command.type === "thread.turn.start" || command.type === "thread.turn.interrupt"), false);
  assert.doesNotMatch(JSON.stringify(row), /CREATE-CANARY/);
});
