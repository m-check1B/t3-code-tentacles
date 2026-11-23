// KRA-10939 (write-side remote workspace isolation),
// KRA-10940 (read-side remote thread isolation),
// KRA-10941 (content-addressed artifact store, no-op poll skip, oversized recovery).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { continueThread, originate } from "../src/bridge.mjs";
import { parseAllowedWorkspaces, parseArgs } from "../src/cli.mjs";
import {
  ensureLocalTalkWorkspace,
  isAllowedRemoteWorkspace,
  isBotWorkspacePath,
} from "../src/local-talk-workspace.mjs";
import {
  LoopbackRuntimeAdapter,
  RemoteRpcShim,
  resolveThreadWorkspace,
} from "../src/outbound-pairer.mjs";
import { acquirePairStateLock } from "../src/pair-state.mjs";
import { REFUSALS } from "../src/refusal-codes.mjs";
import { GUARD_FILE } from "../src/talk-instruction-guard.mjs";
import { T3HttpError } from "../src/t3-client.mjs";
import { recordThreadEvents, threadArtifact, threadEvents } from "../src/thread-events.mjs";

const BOT_THREAD = "11111111-2222-4333-8444-555555555555";
const PRIVATE_THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SEAT_THREAD = "22222222-3333-4444-8555-666666666666";
const WHEN = "2026-11-21T10:00:00.000Z";

function makeTempHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tentacles-isolation-")));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const talkWorkspace = path.join(home, ".jack-local-scratch", "jack-talk", "a".repeat(32), "b".repeat(32));
  const seatWorkspace = path.join(
    home,
    ".jack-local-scratch",
    "seats",
    "c".repeat(64),
    "agents",
    "11111111-1111-4111-8111-111111111111",
  );
  const privateRepo = path.join(home, "private-repo");
  fs.mkdirSync(privateRepo, { recursive: true });
  return { home, talkWorkspace, seatWorkspace, privateRepo };
}

function makeFakeT3({ botWorkspace, seatWorkspace, privateRepo }) {
  const dispatched = [];
  const turnResultCalls = [];
  const projects = [
    { id: "proj-bot", workspaceRoot: botWorkspace },
    { id: "proj-seat", workspaceRoot: seatWorkspace },
    { id: "proj-private", workspaceRoot: privateRepo },
  ];
  const threads = new Map([
    [BOT_THREAD, {
      id: BOT_THREAD,
      projectId: "proj-bot",
      messages: [{ id: "m-bot", role: "user", text: "Hello Bot", createdAt: WHEN }],
      session: { status: "running", activeTurnId: "turn-bot" },
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      activities: [],
      checkpoints: [],
    }],
    [SEAT_THREAD, {
      id: SEAT_THREAD,
      projectId: "proj-seat",
      messages: [{ id: "m-seat", role: "user", text: "Hello Seat", createdAt: WHEN }],
      session: { status: "ready", activeTurnId: null },
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      activities: [],
      checkpoints: [],
    }],
    [PRIVATE_THREAD, {
      id: PRIVATE_THREAD,
      projectId: "proj-private",
      title: "owner-secret-repo",
      messages: [{ id: "m-priv", role: "user", text: "secret private session", createdAt: WHEN }],
      session: { status: "running", activeTurnId: "turn-priv" },
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      activities: [],
      checkpoints: [],
    }],
  ]);
  const client = {
    dispatched,
    turnResultCalls,
    snapshot: async () => ({ projects, threads: [...threads.values()] }),
    shell: async () => ({ projects, threads: [...threads.values()] }),
    archivedShell: async () => ({ threads: [] }),
    thread: async (id) => {
      const found = threads.get(id);
      if (!found) throw new T3HttpError({ method: "GET", pathname: `/api/orchestration/threads/${id}`, status: 404, body: null });
      return { thread: found };
    },
    dispatch: async (command) => {
      dispatched.push(command);
      if (command.type === "project.create") {
        projects.push({ id: command.projectId, workspaceRoot: command.workspaceRoot });
      }
      if (command.type === "thread.create") {
        threads.set(command.threadId, {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          messages: [],
          session: { status: "ready", activeTurnId: null },
          activities: [],
          checkpoints: [],
        });
      }
      if (command.type === "thread.turn.start") {
        threads.get(command.threadId)?.messages.push({ id: command.message.messageId, role: "user", text: command.message.text, createdAt: WHEN });
      }
      return { sequence: dispatched.length };
    },
    request: async (pathname, options) => {
      if (pathname === "/api/orchestration/turn-result" && options?.method === "POST") {
        turnResultCalls.push(options.body);
        return {
          ...options.body,
          turnId: "turn-1",
          assistantMessageId: "a-1",
          instanceId: "codex",
          model: "gpt-5.6-sol",
          effort: "high",
          state: "succeeded",
          outputText: "leaked output",
        };
      }
      return { talkTurnResult: "v1" };
    },
  };
  return { client, projects, threads };
}

// ── KRA-10939: Write-side remote workspace isolation ─────────────────────────

test("KRA-10939: remote originate in owner's home or arbitrary folder is refused before T3 with typed code", async (t) => {
  const { home, talkWorkspace, seatWorkspace, privateRepo } = makeTempHome(t);
  const originated = [];
  const { client } = makeFakeT3({ botWorkspace: talkWorkspace, seatWorkspace, privateRepo });
  const adapter = new LoopbackRuntimeAdapter({
    client,
    workspaceHome: home,
    prepareTalkWorkspaceImpl: (ws) => ensureLocalTalkWorkspace(ws, { home }),
    originateImpl: async (_c, params) => { originated.push(params.workspace); return { threadId: BOT_THREAD }; },
  });
  const logged = [];
  const shim = new RemoteRpcShim(adapter, { onRefusal: (entry) => logged.push(entry) });

  // Home folder without refusalCodes -> plain computer.unavailable, logged with typed code.
  const homeReply = await shim.handle({
    version: 1, type: "rpc.request", id: "orig-home", method: "originate",
    params: { workspace: home, title: "Home", message: "read ~/.ssh" },
  });
  assert.equal(homeReply.type, "rpc.error");
  assert.deepEqual(homeReply.error, { code: "computer.unavailable", message: "Computer unavailable", data: null });
  assert.equal(logged.at(-1).code, "talk.workspace_outside_bot_root");

  // Private repo with refusalCodes: "v1" -> returns typed code and plain fix.
  const repoReply = await shim.handle({
    version: 1, type: "rpc.request", id: "orig-repo", method: "originate",
    params: { workspace: privateRepo, title: "Repo", message: "exfil", refusalCodes: "v1" },
  });
  assert.equal(repoReply.type, "rpc.error");
  assert.deepEqual(repoReply.error.data, {
    refusal: {
      code: "talk.workspace_outside_bot_root",
      text: REFUSALS["talk.workspace_outside_bot_root"],
    },
  });
  assert.deepEqual(originated, []);
  assert.deepEqual(client.dispatched, []);

  // Prepared Bot workspaces (both jack-talk and seats/agents) are admitted.
  const talkOk = await shim.handle({
    version: 1, type: "rpc.request", id: "orig-talk", method: "originate",
    params: { workspace: talkWorkspace, title: "Bot Talk", message: "hi" },
  });
  assert.equal(talkOk.type, "rpc.result");
  const seatOk = await shim.handle({
    version: 1, type: "rpc.request", id: "orig-seat", method: "originate",
    params: { workspace: seatWorkspace, title: "Bot Seat", message: "hi" },
  });
  assert.equal(seatOk.type, "rpc.result");
  assert.deepEqual(originated, [talkWorkspace, seatWorkspace]);
});

test("KRA-10939: remote continue on a non-Bot thread is refused before T3; local CLI remains unchanged", async (t) => {
  const { home, talkWorkspace, seatWorkspace, privateRepo } = makeTempHome(t);
  const { client } = makeFakeT3({ botWorkspace: talkWorkspace, seatWorkspace, privateRepo });
  const adapter = new LoopbackRuntimeAdapter({
    client,
    workspaceHome: home,
    prepareTalkWorkspaceImpl: (ws) => ensureLocalTalkWorkspace(ws, { home }),
    continueImpl: continueThread,
  });
  const shim = new RemoteRpcShim(adapter);

  const refused = await shim.handle({
    version: 1, type: "rpc.request", id: "cont-priv", method: "continue",
    params: { threadId: PRIVATE_THREAD, message: "run full-access here", refusalCodes: "v1" },
  });
  assert.equal(refused.type, "rpc.error");
  assert.equal(refused.error.data.refusal.code, "talk.workspace_outside_bot_root");
  assert.equal(client.dispatched.length, 0);

  // Bot thread continues normally.
  const ok = await shim.handle({
    version: 1, type: "rpc.request", id: "cont-bot", method: "continue",
    params: { threadId: BOT_THREAD, message: "hello bot" },
  });
  assert.equal(ok.type, "rpc.result");
  assert.equal(client.dispatched.length, 1);

  // Local CLI functions (originate / continueThread directly) are unchanged on arbitrary folders.
  await continueThread(client, {
    threadId: PRIVATE_THREAD,
    message: "local cli continue",
    runtimeMode: "approval-required",
  });
  assert.equal(client.dispatched.length, 2);
  const localOrig = await originate(client, {
    workspace: privateRepo,
    title: "Local CLI",
    message: "local originate",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    runtimeMode: "approval-required",
  });
  assert.ok(localOrig.threadId);
});

test("KRA-10939: owner-configured allowlist admits only exact non-symlink folders", (t) => {
  const { home, talkWorkspace, privateRepo } = makeTempHome(t);
  const symlinkAlias = path.join(home, "symlink-alias");
  fs.symlinkSync(privateRepo, symlinkAlias);
  assert.equal(isBotWorkspacePath(talkWorkspace, { home }), true);
  assert.equal(isBotWorkspacePath(privateRepo, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(privateRepo, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(privateRepo, { home, allowedWorkspaces: [privateRepo] }), true);
  assert.equal(isAllowedRemoteWorkspace(symlinkAlias, { home, allowedWorkspaces: [symlinkAlias] }), false);
});

// ── KRA-10940: Read-side remote thread isolation ─────────────────────────────

test("KRA-10940: shared resolver prefers worktreePath over project root and fails closed when unknown", async () => {
  const projects = new Map([["p1", "/proj/root"]]);
  assert.equal(await resolveThreadWorkspace(null, { worktreePath: "/wt/path", projectId: "p1" }, projects), "/wt/path");
  assert.equal(await resolveThreadWorkspace(null, { worktreePath: "", projectId: "p1" }, projects), "/proj/root");
  assert.equal(await resolveThreadWorkspace(null, { projectId: "missing" }, projects), null);
  assert.equal(await resolveThreadWorkspace(null, {}, projects), null);
});

test("KRA-10940: seats omits non-Bot threads; thread-events, thread-artifact, turn-result and interrupt refuse them", async (t) => {
  const { home, talkWorkspace, seatWorkspace, privateRepo } = makeTempHome(t);
  const { client } = makeFakeT3({ botWorkspace: talkWorkspace, seatWorkspace, privateRepo });
  const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-iso-events-"));
  t.after(() => fs.rmSync(eventsDir, { recursive: true, force: true }));

  // Pre-seed a journal entry for the private thread to prove thread-artifact still refuses it.
  const secretBytes = Buffer.from("top-secret-file-contents");
  recordThreadEvents(PRIVATE_THREAD, [{
    eventId: "file:secret-1",
    kind: "artifact",
    occurredAt: WHEN,
    payload: {
      name: "secrets.yml",
      mediaType: "application/octet-stream",
      contentBase64: secretBytes.toString("base64"),
      sha256: createHash("sha256").update(secretBytes).digest("hex"),
    },
  }], { directory: eventsDir, state: "ready" });

  const adapter = new LoopbackRuntimeAdapter({
    client,
    workspaceHome: home,
    prepareTalkWorkspaceImpl: (ws) => ensureLocalTalkWorkspace(ws, { home }),
    threadEventsDirectory: eventsDir,
    interruptOptions: { startWaitMs: 50, terminalWaitMs: 100, totalBudgetMs: 500, intervalMs: 5 },
  });
  const shim = new RemoteRpcShim(adapter, { enableInterrupt: true });

  // 1. seats: lists only Bot threads and their activeTurns; private thread is completely absent.
  const seatsReply = await shim.handle({ version: 1, type: "rpc.request", id: "s1", method: "seats", params: {} });
  assert.equal(seatsReply.type, "rpc.result");
  assert.deepEqual(seatsReply.result.threads.map((entry) => entry.id).sort(), [BOT_THREAD, SEAT_THREAD].sort());
  assert.deepEqual(seatsReply.result.activeTurns.map((entry) => entry.threadId), [BOT_THREAD]);
  assert.equal(JSON.stringify(seatsReply).includes(PRIVATE_THREAD), false);

  // 2. thread-events: refuses non-Bot thread with computer.unavailable.
  const evRefused = await shim.handle({
    version: 1, type: "rpc.request", id: "te-priv", method: "thread-events",
    params: { threadId: PRIVATE_THREAD, includeTurnEnd: true },
  });
  assert.equal(evRefused.type, "rpc.error");
  assert.equal(evRefused.error.code, "computer.unavailable");

  // Bot thread succeeds.
  const evOk = await shim.handle({
    version: 1, type: "rpc.request", id: "te-bot", method: "thread-events",
    params: { threadId: BOT_THREAD },
  });
  assert.equal(evOk.type, "rpc.result");

  // 3. thread-artifact: refuses non-Bot thread with computer.unavailable.
  const artRefused = await shim.handle({
    version: 1, type: "rpc.request", id: "ta-priv", method: "thread-artifact",
    params: { threadId: PRIVATE_THREAD, eventId: "file:secret-1" },
  });
  assert.equal(artRefused.type, "rpc.error");
  assert.equal(artRefused.error.code, "computer.unavailable");

  // 4. turn-result: refuses non-Bot thread with computer.unavailable and never calls T3 turn-result.
  const trRefused = await shim.handle({
    version: 1, type: "rpc.request", id: "tr-priv", method: "turn-result",
    params: { threadId: PRIVATE_THREAD, messageId: "m-priv", turnCommandId: "cmd-priv" },
  });
  assert.equal(trRefused.type, "rpc.error");
  assert.equal(trRefused.error.code, "computer.unavailable");
  assert.equal(client.turnResultCalls.length, 0);

  // 5. interrupt: refuses non-Bot thread with computer.unavailable and never dispatches interrupt.
  const intRefused = await shim.handle({
    version: 1, type: "rpc.request", id: "int-priv", method: "interrupt",
    params: {
      requestId: "req-priv",
      threadId: PRIVATE_THREAD,
      messageId: "m-priv",
      turnCommandId: "cmd-priv",
      reason: "user_stop",
    },
  });
  assert.equal(intRefused.type, "rpc.error");
  assert.equal(intRefused.error.code, "computer.unavailable");
  assert.equal(client.dispatched.length, 0);
});

// ── KRA-10941: Content-addressed artifacts, no-op polls, oversized recovery ────

test("KRA-10941: 200 checkpoint versions of a 1 MB file keep the journal under 1 MB and serve exact bytes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-kra10941-200-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const oneMb = 1024 * 1024;
  let currentVersion = 0;
  const thread = {
    id: BOT_THREAD,
    messages: [{ id: "m1", role: "user", text: "Generate 200 versions", createdAt: WHEN }],
    session: { status: "ready" },
    activities: [],
    checkpoints: [],
  };
  const versionBuffer = (version) => {
    const buf = Buffer.alloc(oneMb, version % 251);
    buf.writeUInt32BE(version, 0);
    return buf;
  };
  const client = {
    baseUrl: "http://127.0.0.1:3773",
    requestTimeoutMs: 5_000,
    thread: async () => ({ thread }),
    rpc: async () => ({ relativeUrl: `/api/assets/v${currentVersion}` }),
    fetchImpl: async () => new Response(versionBuffer(currentVersion)),
  };

  for (let version = 1; version <= 200; version += 1) {
    currentVersion = version;
    thread.checkpoints = [{
      status: "ready",
      checkpointRef: `ref-${version}`,
      completedAt: new Date(Date.parse(WHEN) + version * 1000).toISOString(),
      files: [{ path: "build/output.bin", kind: "modified" }],
    }];
    const page = await threadEvents(client, { threadId: BOT_THREAD, afterSequence: Math.max(0, version - 1) }, { directory });
    assert.ok(page.nextSequence >= version);
  }

  const journalPath = path.join(directory, `${BOT_THREAD}.json`);
  const journalBytes = fs.statSync(journalPath).size;
  assert.ok(journalBytes < 1024 * 1024, `journal should stay under 1 MB, got ${journalBytes} bytes`);
  const rawJournal = fs.readFileSync(journalPath, "utf8");
  assert.equal(rawJournal.includes("contentBase64"), false, "journal must hold no base64");

  const journal = JSON.parse(rawJournal);
  const artifacts = journal.filter((event) => event.kind === "artifact");
  assert.equal(artifacts.length, 200);
  // Spot-check first, middle, and last version bytes through threadArtifact + 0600 blob permissions.
  for (const [idx, expectedVersion] of [[0, 1], [99, 100], [199, 200]]) {
    const entry = artifacts[idx];
    const blobPath = path.join(directory, "artifacts", `${entry.payload.sha256}.bin`);
    assert.equal(fs.statSync(blobPath).mode & 0o777, 0o600);
    const chunks = [];
    let offset = 0;
    while (offset < oneMb) {
      const part = threadArtifact({ threadId: BOT_THREAD, eventId: entry.eventId, offset }, { directory });
      chunks.push(Buffer.from(part.contentBase64, "base64"));
      offset = part.nextOffset;
    }
    const assembled = Buffer.concat(chunks);
    assert.equal(assembled.length, oneMb);
    assert.equal(assembled.readUInt32BE(0), expectedVersion);
  }
});

test("KRA-10941: a no-op poll with no new events and no state change does not rewrite the journal file", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-kra10941-noop-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const thread = {
    id: BOT_THREAD,
    messages: [{ id: "m1", role: "user", text: "Hello", createdAt: WHEN }],
    session: { status: "ready" },
    activities: [],
    checkpoints: [],
  };
  const client = { thread: async () => ({ thread }) };
  const first = await threadEvents(client, { threadId: BOT_THREAD }, { directory });
  const journalPath = path.join(directory, `${BOT_THREAD}.json`);
  const before = fs.statSync(journalPath);

  const second = await threadEvents(client, { threadId: BOT_THREAD, afterSequence: first.nextSequence }, { directory });
  const after = fs.statSync(journalPath);
  assert.deepEqual(second.events, []);
  assert.equal(after.ino, before.ino, "no temp-file rename on no-op poll");
  assert.equal(after.mtimeMs, before.mtimeMs, "no rewrite on no-op poll");
});

test("KRA-10941: an already-oversized legacy base64 journal migrates and recovers automatically", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-kra10941-recover-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payloadBytes = Buffer.alloc(64 * 1024, 0x42);
  const sha = createHash("sha256").update(payloadBytes).digest("hex");
  const legacyJournal = [
    {
      threadId: BOT_THREAD,
      eventId: "message:m1",
      sequence: 1,
      occurredAt: WHEN,
      kind: "message",
      payload: { role: "user", text: "Legacy", messageId: "m1" },
    },
    {
      threadId: BOT_THREAD,
      eventId: "file:legacy-1",
      sequence: 2,
      occurredAt: WHEN,
      kind: "artifact",
      payload: {
        name: "legacy.bin",
        mediaType: "application/octet-stream",
        contentBase64: payloadBytes.toString("base64"),
        sha256: sha,
      },
    },
    {
      threadId: BOT_THREAD,
      eventId: "state:3",
      sequence: 3,
      occurredAt: WHEN,
      kind: "state",
      payload: { status: "ready" },
    },
  ];
  const journalPath = path.join(directory, `${BOT_THREAD}.json`);
  fs.writeFileSync(journalPath, JSON.stringify(legacyJournal), { mode: 0o600 });
  // Simulate being over the cap using a small maxJournalBytes bound (32 KB < ~88 KB legacy file).
  const cap = 32 * 1024;
  assert.ok(fs.statSync(journalPath).size > cap, "legacy journal starts over the cap");

  const thread = {
    id: BOT_THREAD,
    messages: [{ id: "m1", role: "user", text: "Legacy", createdAt: WHEN }],
    session: { status: "ready" },
    activities: [],
    checkpoints: [],
  };
  const client = { thread: async () => ({ thread }) };
  const page = await threadEvents(client, { threadId: BOT_THREAD }, { directory, maxJournalBytes: cap });
  assert.equal(page.events.length, 3);
  assert.equal(page.events[1].payload.sizeBytes, payloadBytes.length);
  assert.ok(fs.statSync(journalPath).size < 2048, "migrated journal shrunk below 2 KB");
  assert.equal(fs.readFileSync(journalPath, "utf8").includes("contentBase64"), false);

  const served = threadArtifact({ threadId: BOT_THREAD, eventId: "file:legacy-1" }, { directory, maxJournalBytes: cap });
  assert.deepEqual(Buffer.from(served.contentBase64, "base64"), payloadBytes);
});

// ── B3 Review Regressions (P2-1, P2-2, P2-3, P3-1, P3-3) ─────────────────────

test("B3 P2-1: continue rejects private thread idempotent replay and fresh message upfront without leaking projectId or model errors", async (t) => {
  const { home, talkWorkspace, seatWorkspace, privateRepo } = makeTempHome(t);
  const { client, threads } = makeFakeT3({ botWorkspace: talkWorkspace, seatWorkspace, privateRepo });
  // Give the private thread a prohibited modelSelection that retainedSelectionPin would reject.
  threads.get(PRIVATE_THREAD).modelSelection = {
    instanceId: "grok",
    model: "grok-4.7",
    options: [{ id: "reasoningEffort", value: "xhigh" }],
  };
  let continueCalls = 0;
  const adapter = new LoopbackRuntimeAdapter({
    client,
    workspaceHome: home,
    prepareTalkWorkspaceImpl: (ws) => ensureLocalTalkWorkspace(ws, { home }),
    continueImpl: (...args) => { continueCalls += 1; return continueThread(...args); },
  });
  const shim = new RemoteRpcShim(adapter);

  // 1. Idempotent replay on private thread (matching existing messageId "m-priv") MUST fail closed upfront.
  const replayRefused = await shim.handle({
    version: 1, type: "rpc.request", id: "cont-priv-replay", method: "continue",
    params: {
      threadId: PRIVATE_THREAD,
      messageId: "m-priv",
      message: "secret private session",
      refusalCodes: "v1",
    },
  });
  assert.equal(replayRefused.type, "rpc.error");
  assert.equal(replayRefused.error.data.refusal.code, "talk.workspace_outside_bot_root");
  assert.equal(JSON.stringify(replayRefused).includes("proj-private"), false);
  assert.equal(continueCalls, 0);

  // 2. Fresh message on private thread MUST fail with workspace_outside_bot_root before retainedSelectionPin.
  const freshRefused = await shim.handle({
    version: 1, type: "rpc.request", id: "cont-priv-fresh", method: "continue",
    params: {
      threadId: PRIVATE_THREAD,
      messageId: "m-priv-new",
      message: "probe model selection",
      refusalCodes: "v1",
    },
  });
  assert.equal(freshRefused.type, "rpc.error");
  assert.equal(freshRefused.error.data.refusal.code, "talk.workspace_outside_bot_root");
  assert.equal(continueCalls, 0);
  assert.equal(client.dispatched.length, 0);

  // 3. Valid in-scope Bot thread idempotent replay succeeds, writes NO guard, and dispatches nothing.
  fs.mkdirSync(talkWorkspace, { recursive: true, mode: 0o700 });
  const guardPath = path.join(talkWorkspace, GUARD_FILE);
  assert.equal(fs.existsSync(guardPath), false);
  const botReplay = await shim.handle({
    version: 1, type: "rpc.request", id: "cont-bot-replay", method: "continue",
    params: {
      threadId: BOT_THREAD,
      messageId: "m-bot",
      message: "Hello Bot",
    },
  });
  assert.equal(botReplay.type, "rpc.result");
  assert.equal(botReplay.result.threadId, BOT_THREAD);
  assert.equal(botReplay.result.projectId, "proj-bot");
  assert.equal(fs.existsSync(guardPath), false, "valid in-scope idempotent replay must not write guard");
  assert.equal(client.dispatched.length, 0);
});

test("B3 P2-2: CLI --allow-workspace and TENTACLES_ALLOWED_WORKSPACES parse, canonicalize, and fail closed", async (t) => {
  const { home, talkWorkspace, seatWorkspace, privateRepo } = makeTempHome(t);
  const secondRepo = path.join(home, "second-repo");
  fs.mkdirSync(secondRepo, { recursive: true });
  const symlinkAlias = path.join(home, "allow-symlink");
  fs.symlinkSync(privateRepo, symlinkAlias);
  const regularFile = path.join(home, "not-a-dir.txt");
  fs.writeFileSync(regularFile, "x", { mode: 0o600 });

  const parsed = parseArgs([
    "pair",
    "--pair-file", "/tmp/offer.json",
    "--machine-id", "machine-1",
    "--allow-workspace", `${privateRepo}${path.sep}`,
    "--allow-workspace", secondRepo,
  ]);
  assert.deepEqual(parsed.options["allow-workspace"], [`${privateRepo}${path.sep}`, secondRepo]);

  const combined = parseAllowedWorkspaces({
    flagValues: parsed.options["allow-workspace"],
    envValue: `${privateRepo}${path.delimiter}${secondRepo}`,
  });
  assert.deepEqual(combined, [privateRepo, secondRepo]);

  // Invalid entries fail closed.
  assert.throws(() => parseAllowedWorkspaces({ flagValues: ["relative/dir"], envValue: "" }), /absolute directory paths/);
  assert.throws(() => parseAllowedWorkspaces({ flagValues: [symlinkAlias], envValue: "" }), /real non-symlink directories/);
  assert.throws(() => parseAllowedWorkspaces({ flagValues: [regularFile], envValue: "" }), /real non-symlink directories/);
  assert.throws(() => parseAllowedWorkspaces({ flagValues: [], envValue: `relative/path` }), /absolute directory paths/);

  // Wired into LoopbackRuntimeAdapter: allowlisted repo is admitted, non-allowlisted home is refused.
  const { client } = makeFakeT3({ botWorkspace: talkWorkspace, seatWorkspace, privateRepo });
  const adapter = new LoopbackRuntimeAdapter({
    client,
    workspaceHome: home,
    allowedWorkspaces: combined,
    prepareTalkWorkspaceImpl: (ws) => ensureLocalTalkWorkspace(ws, { home }),
    originateImpl: async (_c, params) => ({ threadId: PRIVATE_THREAD, workspace: params.workspace }),
  });
  const ok = await adapter.originate({ workspace: privateRepo, title: "Chair", message: "run" });
  assert.equal(ok.workspace, privateRepo);
  await assert.rejects(
    () => adapter.originate({ workspace: home, title: "Home", message: "nope" }),
    /outside the Bot workspace root/,
  );
});

test("B3 P2-3: oversized legacy journal migration runs strictly under lock and persists from both threadArtifact and threadEvents", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-p2-3-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payloadBytes = Buffer.alloc(48 * 1024, 0x5a);
  const sha = createHash("sha256").update(payloadBytes).digest("hex");
  const legacyJournal = [
    {
      threadId: BOT_THREAD,
      eventId: "file:legacy-lock-1",
      sequence: 1,
      occurredAt: WHEN,
      kind: "artifact",
      payload: {
        name: "legacy.bin",
        mediaType: "application/octet-stream",
        contentBase64: payloadBytes.toString("base64"),
        sha256: sha,
      },
    },
  ];
  const journalPath = path.join(directory, `${BOT_THREAD}.json`);
  fs.writeFileSync(journalPath, JSON.stringify(legacyJournal), { mode: 0o600 });
  const cap = 16 * 1024;
  const originalSize = fs.statSync(journalPath).size;
  assert.ok(originalSize > cap);

  const client = {
    thread: async () => ({
      thread: {
        id: BOT_THREAD,
        messages: [],
        session: { status: "ready" },
        activities: [],
        checkpoints: [],
      },
    }),
  };

  // While the file lock is held, neither threadArtifact nor threadEvents migrates unlocked.
  const release = acquirePairStateLock(journalPath);
  assert.ok(release);
  try {
    assert.throws(
      () => threadArtifact({ threadId: BOT_THREAD, eventId: "file:legacy-lock-1" }, { directory, maxJournalBytes: cap }),
      /Thread journal is busy/,
    );
    await assert.rejects(
      () => threadEvents(client, { threadId: BOT_THREAD }, { directory, maxJournalBytes: cap }),
      /Thread journal is busy/,
    );
    assert.equal(fs.existsSync(path.join(directory, "artifacts")), false, "no unlocked artifact blob writes");
    assert.equal(fs.statSync(journalPath).size, originalSize, "journal untouched while locked");
  } finally {
    release();
  }

  // Once unlocked, threadArtifact migrates once under lock AND persists the shrunk journal.
  const served = threadArtifact({ threadId: BOT_THREAD, eventId: "file:legacy-lock-1" }, { directory, maxJournalBytes: cap });
  assert.deepEqual(Buffer.from(served.contentBase64, "base64"), payloadBytes);
  const afterMigrate = fs.statSync(journalPath);
  assert.ok(afterMigrate.size < 2048, "threadArtifact persisted shrunk journal");
  assert.equal(fs.readFileSync(journalPath, "utf8").includes("contentBase64"), false);

  // Subsequent threadArtifact call does not rewrite the already-migrated journal.
  const servedAgain = threadArtifact({ threadId: BOT_THREAD, eventId: "file:legacy-lock-1" }, { directory, maxJournalBytes: cap });
  assert.deepEqual(Buffer.from(servedAgain.contentBase64, "base64"), payloadBytes);
  const afterSecond = fs.statSync(journalPath);
  assert.equal(afterSecond.ino, afterMigrate.ino);
  assert.equal(afterSecond.mtimeMs, afterMigrate.mtimeMs);
});

test("B3 P3-1: turnResult re-reads thread for failureDetail when prefetched lastError was empty", async (t) => {
  const { home, talkWorkspace } = makeTempHome(t);
  let threadCalls = 0;
  const client = {
    thread: async (id) => {
      threadCalls += 1;
      return {
        thread: {
          id,
          worktreePath: talkWorkspace,
          session: { status: threadCalls === 1 ? "running" : "error", lastError: threadCalls === 1 ? null : "Rate limit exceeded" },
        },
      };
    },
    request: async () => ({
      threadId: BOT_THREAD,
      messageId: "m1",
      turnCommandId: "c1",
      turnId: "turn-1",
      assistantMessageId: null,
      instanceId: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      state: "failed",
      outputText: null,
    }),
  };
  const adapter = new LoopbackRuntimeAdapter({ client, workspaceHome: home });
  const result = await adapter.turnResult({ threadId: BOT_THREAD, messageId: "m1", turnCommandId: "c1" });
  assert.equal(result.failureDetail, "Rate limit exceeded");
  assert.equal(threadCalls, 2);
});

test("B3 P3-3: workspace scope rejects .. traversal, uppercase case-variant, trailing slash, and intermediate symlink", (t) => {
  const { home, talkWorkspace, privateRepo } = makeTempHome(t);

  // 1. `..` traversal
  const dotDotBot = `${home}${path.sep}.jack-local-scratch${path.sep}jack-talk${path.sep}${"a".repeat(32)}${path.sep}..${path.sep}private-repo`;
  const dotDotAllow = `${privateRepo}${path.sep}..${path.sep}private-repo`;
  assert.equal(isBotWorkspacePath(dotDotBot, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(dotDotBot, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(dotDotAllow, { home, allowedWorkspaces: [privateRepo] }), false);

  // 2. Uppercase macOS case-variant
  const upperBot = path.join(home, ".jack-local-scratch", "jack-talk", "A".repeat(32), "b".repeat(32));
  const upperRoot = path.join(home, ".JACK-LOCAL-SCRATCH", "jack-talk", "a".repeat(32), "b".repeat(32));
  const upperAllow = path.join(home, "PRIVATE-REPO");
  assert.equal(isBotWorkspacePath(upperBot, { home }), false);
  assert.equal(isBotWorkspacePath(upperRoot, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(upperAllow, { home, allowedWorkspaces: [privateRepo] }), false);

  // 3. Trailing slash
  assert.equal(isBotWorkspacePath(`${talkWorkspace}${path.sep}`, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(`${talkWorkspace}${path.sep}`, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(`${privateRepo}${path.sep}`, { home, allowedWorkspaces: [privateRepo] }), false);
  assert.equal(isAllowedRemoteWorkspace(`${privateRepo}${path.sep}`, { home, allowedWorkspaces: [`${privateRepo}${path.sep}`] }), false);

  // 4. Intermediate symlink inside Bot root
  const talkParent = path.join(home, ".jack-local-scratch", "jack-talk");
  fs.mkdirSync(talkParent, { recursive: true, mode: 0o700 });
  const tenantLink = path.join(talkParent, "d".repeat(32));
  fs.symlinkSync(privateRepo, tenantLink);
  const throughLink = path.join(tenantLink, "e".repeat(32));
  assert.equal(isBotWorkspacePath(throughLink, { home }), false);
  assert.equal(isAllowedRemoteWorkspace(throughLink, { home }), false);
});
