import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { continueThread } from "../src/bridge.mjs";
import { ensureLocalTalkWorkspace } from "../src/local-talk-workspace.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { T3Client } from "../src/t3-client.mjs";
import { GUARD_FILE, instructionExcludes } from "../src/talk-instruction-guard.mjs";
import { freshCapability } from "./helpers/fresh-context-wire.mjs";

// KRA-9781: a continued turn guards a Talk workspace created before the guard existed.
const threadId = "11111111-2222-4333-8444-555555555555";
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "continue-guard-")));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const talk = path.join(home, ".jack-local-scratch", "jack-talk", "a".repeat(32), "b".repeat(32));
  // A 0.5.0-jack.1..5 workspace: the private directories exist, the guard does not.
  fs.mkdirSync(talk, { recursive: true, mode: 0o700 });
  return { home, talk };
}

function fakeT3(workspaceRoot, onDispatch, { snapshot, thread = {}, messages = [] } = {}) {
  const commands = [];
  const reads = [];
  return {
    commands,
    reads,
    async request(pathname) { reads.push(pathname); return freshCapability; },
    async thread() {
      return { thread: { id: threadId, projectId: "project", messages, modelSelection: { instanceId: "codex", model: "gpt-5.5" }, ...thread } };
    },
    async snapshot() {
      reads.push("snapshot");
      return snapshot ? snapshot() : { projects: [{ id: "other", workspaceRoot: "/elsewhere" }, { id: "project", workspaceRoot }] };
    },
    async dispatch(command) {
      onDispatch?.(command);
      commands.push(command);
      if (command.type === "thread.turn.start") messages.push({ id: command.message.messageId, text: command.message.text });
      return {};
    },
  };
}

function adapter(client, home) {
  return new LoopbackRuntimeAdapter({ client, continueImpl: continueThread,
    prepareTalkWorkspaceImpl: (workspace) => ensureLocalTalkWorkspace(workspace, { home }) });
}

const input = { threadId, message: "again", runtimeMode: "full-access" };
const guardOf = (workspace) => path.join(workspace, GUARD_FILE);

test("continue guards a pre-existing unguarded Talk workspace before the T3 turn", async (t) => {
  const { home, talk } = fixture(t);
  assert.equal(fs.existsSync(guardOf(talk)), false);
  let guardedAtDispatch = null;
  const client = fakeT3(talk, () => { guardedAtDispatch = JSON.parse(fs.readFileSync(guardOf(talk), "utf8")); });
  await adapter(client, home).continue(input);
  assert.equal(client.commands.length, 1);
  assert.equal(guardedAtDispatch.autoMemoryEnabled, false);
  assert.deepEqual(guardedAtDispatch.claudeMdExcludes, instructionExcludes(talk));
});

test("continue leaves an already guarded Talk workspace byte-stable", async (t) => {
  const { home, talk } = fixture(t);
  ensureLocalTalkWorkspace(talk, { home });
  const before = fs.readFileSync(guardOf(talk));
  const inode = fs.lstatSync(guardOf(talk)).ino;
  const client = fakeT3(talk);
  await adapter(client, home).continue(input);
  assert.equal(client.commands.length, 1);
  assert.deepEqual(fs.readFileSync(guardOf(talk)), before);
  assert.equal(fs.lstatSync(guardOf(talk)).ino, inode);
});

test("a symlinked .claude aborts the continue before T3 and writes nothing outside", async (t) => {
  const { home, talk } = fixture(t);
  const outside = path.join(home, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(talk, ".claude"));
  const client = fakeT3(talk);
  await assert.rejects(adapter(client, home).continue(input), /real directory/);
  assert.equal(client.commands.length, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a malformed path under the private root is refused before T3", async (t) => {
  const { home, talk } = fixture(t);
  const client = fakeT3(path.join(path.dirname(talk), "not-an-agent"));
  await assert.rejects(adapter(client, home).continue(input), /custody or scope refused/);
  assert.equal(client.commands.length, 0);
});

test("a hire workspace gets no guard on continue", async (t) => {
  const { home } = fixture(t);
  const hire = path.join(home, "github", "current", "products", "repo");
  fs.mkdirSync(hire, { recursive: true });
  const client = fakeT3(hire);
  await adapter(client, home).continue(input);
  assert.equal(client.commands.length, 1);
  assert.equal(fs.existsSync(path.join(hire, ".claude")), false);
});

// PR 45 B3: every path that cannot resolve the thread's workspace fails closed before T3.
const unresolved = /could not be resolved/;
for (const [name, snapshot, refusal] of [
  // The read's own error surfaces, so a swallowed read is visible.
  ["a failed snapshot read", async () => { throw new Error("synthetic snapshot failure"); }, /synthetic snapshot failure/],
  ["a snapshot without a projects array", async () => ({}), unresolved],
  ["a snapshot without the thread's project", async () => ({ projects: [{ id: "other", workspaceRoot: "/elsewhere" }] }), unresolved],
  ["a project without a string workspaceRoot", async () => ({ projects: [{ id: "project", workspaceRoot: null }] }), unresolved],
]) {
  test(`${name} refuses the continue before T3`, async (t) => {
    const { home, talk } = fixture(t);
    const client = fakeT3(talk, undefined, { snapshot });
    await assert.rejects(adapter(client, home).continue(input), refusal);
    assert.equal(client.commands.length, 0);
    assert.equal(fs.existsSync(guardOf(talk)), false);
  });
}

test("a fresh-context continue guards the Talk workspace before the T3 turn", async (t) => {
  const { home, talk } = fixture(t);
  let guardedAtDispatch = false;
  const client = fakeT3(talk, () => { guardedAtDispatch = fs.existsSync(guardOf(talk)); });
  await adapter(client, home).continue({ ...input, instanceId: "codex", model: "gpt-5.6-sol", freshProviderContext: true });
  assert.equal(client.commands.length, 1);
  assert.equal(client.commands[0].freshProviderContext, true);
  assert.equal(guardedAtDispatch, true);
});

test("a thread worktreePath under the Talk root is guarded instead of the project root", async (t) => {
  const { home, talk } = fixture(t);
  const hire = path.join(home, "github", "current", "products", "repo");
  fs.mkdirSync(hire, { recursive: true });
  const client = fakeT3(hire, undefined, { thread: { worktreePath: talk } });
  await adapter(client, home).continue(input);
  assert.equal(client.commands.length, 1);
  assert.equal(fs.existsSync(guardOf(talk)), true);
  assert.equal(fs.existsSync(path.join(hire, ".claude")), false);
});

// PR 46 B3 P3-A: protocol 2 maps worktreePath through threadDetailToV1, so the guard sees it.
test("a protocol 2 thread worktreePath under the Talk root is guarded instead of the project root", async (t) => {
  const { home, talk } = fixture(t);
  const hire = path.join(home, "github", "current", "products", "repo");
  fs.mkdirSync(hire, { recursive: true });
  const messages = [];
  const commands = [];
  const thread = { id: threadId, projectId: "project", runtimeMode: "full-access", worktreePath: talk, modelSelection: { instanceId: "codex", model: "gpt-5.5" } };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", orchestrationProtocol: 2, fetchImpl: async (url) => Response.json(
    new URL(url).pathname === "/api/orchestration/shell"
      ? { schemaVersion: 2, projects: [{ id: "project", workspaceRoot: hire }], threads: [] }
      : { projection: { thread, runs: [], messages } }) });
  client.rpc = async (method, payload, { beforeSend } = {}) => {
    await beforeSend?.();
    commands.push(payload);
    if (payload.type === "message.dispatch") messages.push({ id: payload.messageId, role: "user", text: payload.text });
    return { sequence: commands.length };
  };
  await adapter(client, home).continue(input);
  assert.equal(commands.at(-1).type, "message.dispatch");
  assert.equal(fs.existsSync(guardOf(talk)), true);
  assert.equal(fs.existsSync(path.join(hire, ".claude")), false);
});

// PR 46 B3 P3-B: an async hook that rejects aborts the continue before T3.
test("a rejecting async workspace hook rejects the continue and dispatches nothing", async (t) => {
  const { talk } = fixture(t);
  const client = fakeT3(talk);
  await assert.rejects(continueThread(client, input, { prepareTalkWorkspace: async () => { throw new Error("synthetic async guard failure"); } }), /synthetic async guard failure/);
  assert.equal(client.commands.length, 0);
});

test("an idempotent replay reads no snapshot, writes no guard and dispatches nothing", async (t) => {
  const { home, talk } = fixture(t);
  const client = fakeT3(talk, undefined, { messages: [{ id: "replayed", text: "again" }] });
  await adapter(client, home).continue({ ...input, messageId: "replayed" });
  assert.deepEqual(client.reads, []);
  assert.equal(client.commands.length, 0);
  assert.equal(fs.existsSync(guardOf(talk)), false);
});
