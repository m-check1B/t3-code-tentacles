import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { continueThread } from "../src/bridge.mjs";
import { ensureLocalTalkWorkspace } from "../src/local-talk-workspace.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { GUARD_FILE, instructionExcludes } from "../src/talk-instruction-guard.mjs";

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

function fakeT3(workspaceRoot, onDispatch) {
  const messages = [];
  const commands = [];
  return {
    commands,
    async thread() {
      return { thread: { id: threadId, projectId: "project", messages, modelSelection: { instanceId: "codex", model: "gpt-5.5" } } };
    },
    async snapshot() { return { projects: [{ id: "other", workspaceRoot: "/elsewhere" }, { id: "project", workspaceRoot }] }; },
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
