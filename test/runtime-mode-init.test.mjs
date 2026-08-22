import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { originate, startThread } from "../src/bridge.mjs";
import {
  buildCommandFromIntent,
  threadCreate,
  threadTurnStart,
} from "../src/orchestrate.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

const SAMPLE_MODEL = { instanceId: "codex", model: "gpt-5.6-sol" };

// T3 session-start binds `session.runtimeMode` from the thread row at
// `thread.turn.start` (the decider copies `targetThread.runtimeMode`, not a
// silent full-access fallback). A thread row alone is not the session.
function sessionBindingClient({ projectWorkspace } = {}) {
  const commands = [];
  const projects = new Map();
  const threads = new Map();
  return {
    commands,
    projects,
    threads,
    shell: async () => ({ projects: [...projects.values()] }),
    thread: async (threadId) => {
      const thread = threads.get(threadId);
      if (!thread) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread };
    },
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "project.create") {
        projects.set(command.projectId, {
          id: command.projectId,
          workspaceRoot: command.workspaceRoot || projectWorkspace,
        });
      } else if (command.type === "thread.create") {
        threads.set(command.threadId, {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          messages: [],
          session: null,
        });
      } else if (command.type === "thread.turn.start") {
        const thread = threads.get(command.threadId);
        thread.messages.push({
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
        });
        thread.session = {
          status: "starting",
          runtimeMode: thread.runtimeMode,
        };
      } else if (command.type === "thread.runtime-mode.set") {
        const thread = threads.get(command.threadId);
        thread.runtimeMode = command.runtimeMode;
        if (thread.session) thread.session.runtimeMode = command.runtimeMode;
      }
      return { sequence: commands.length };
    },
  };
}

function sessionStartCommands(commands) {
  return {
    threadCreate: commands.find((command) => command.type === "thread.create"),
    turnStart: commands.find((command) => command.type === "thread.turn.start"),
  };
}

test("thread.create and thread.turn.start default to approval-required, never silent full-access", () => {
  const created = threadCreate({
    commandId: "c1",
    threadId: "t1",
    projectId: "p1",
    title: "T",
    modelSelection: SAMPLE_MODEL,
  });
  assert.equal(created.runtimeMode, "approval-required");
  assert.notEqual(created.runtimeMode, "full-access");

  const turn = threadTurnStart({ commandId: "c2", threadId: "t1", text: "hi" });
  assert.equal(turn.runtimeMode, "approval-required");
  assert.notEqual(turn.runtimeMode, "full-access");

  assert.equal(
    threadCreate({
      commandId: "c3",
      threadId: "t2",
      projectId: "p1",
      title: "T",
      modelSelection: SAMPLE_MODEL,
      runtimeMode: "auto-accept-edits",
    }).runtimeMode,
    "auto-accept-edits",
  );
  assert.equal(
    threadTurnStart({ commandId: "c4", threadId: "t2", text: "hi", runtimeMode: "auto-accept-edits" }).runtimeMode,
    "auto-accept-edits",
  );
  assert.throws(
    () => threadCreate({
      commandId: "c5",
      threadId: "t3",
      projectId: "p1",
      title: "T",
      modelSelection: SAMPLE_MODEL,
      runtimeMode: "banana",
    }),
    /runtimeMode/,
  );
  assert.throws(
    () => threadTurnStart({ commandId: "c6", threadId: "t3", text: "hi", runtimeMode: "banana" }),
    /runtimeMode/,
  );
});

test("thread.create and thread.continue intents default to approval-required", () => {
  const created = buildCommandFromIntent({
    action: "thread.create",
    projectId: "p1",
    title: "T",
    instanceId: "codex",
    model: "gpt-5.6-sol",
  }, { commandId: "cc" });
  assert.equal(created.type, "thread.create");
  assert.equal(created.runtimeMode, "approval-required");

  const continued = buildCommandFromIntent({
    action: "thread.continue",
    threadId: "t1",
    text: "go",
  }, { commandId: "cd" });
  assert.equal(continued.type, "thread.turn.start");
  assert.equal(continued.runtimeMode, "approval-required");

  const requested = buildCommandFromIntent({
    action: "thread.create",
    projectId: "p1",
    title: "T",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    runtimeMode: "auto-accept-edits",
  }, { commandId: "ce" });
  assert.equal(requested.runtimeMode, "auto-accept-edits");

  const continuedRequested = buildCommandFromIntent({
    action: "thread.continue",
    threadId: "t1",
    text: "go",
    runtimeMode: "auto-accept-edits",
  }, { commandId: "cf" });
  assert.equal(continuedRequested.runtimeMode, "auto-accept-edits");
});

test("originate default runtime mode reaches session-start binding as approval-required", async () => {
  const client = sessionBindingClient();
  const result = await originate(client, {
    workspace: "/tmp/originate-approval",
    title: "Approval default",
    message: "start",
    instanceId: "codex",
    model: "gpt-5.6-sol",
  });
  const { threadCreate: created, turnStart } = sessionStartCommands(client.commands);
  assert.equal(created.type, "thread.create");
  assert.equal(turnStart.type, "thread.turn.start");
  assert.equal(created.runtimeMode, "approval-required");
  assert.equal(turnStart.runtimeMode, "approval-required");
  const projected = await client.thread(result.threadId);
  assert.equal(projected.thread.runtimeMode, "approval-required");
  assert.equal(projected.thread.session?.runtimeMode, "approval-required");
  assert.notEqual(projected.thread.session?.runtimeMode, "full-access");
});

test("originate requested auto-accept-edits survives thread.create, turn.start, and session binding", async () => {
  const client = sessionBindingClient();
  const result = await originate(client, {
    workspace: "/tmp/originate-auto-edits",
    title: "Auto edits",
    message: "start",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    runtimeMode: "auto-accept-edits",
  });
  const { threadCreate: created, turnStart } = sessionStartCommands(client.commands);
  assert.equal(created.runtimeMode, "auto-accept-edits");
  assert.equal(turnStart.runtimeMode, "auto-accept-edits");
  const projected = await client.thread(result.threadId);
  assert.equal(projected.thread.runtimeMode, "auto-accept-edits");
  assert.equal(projected.thread.session?.runtimeMode, "auto-accept-edits");
});

test("startThread puts the requested mode on both session-init commands", async () => {
  const client = sessionBindingClient();
  await startThread(client, {
    projectId: "p1",
    threadId: "t-init",
    title: "Init",
    message: "hello",
    messageId: "m-init",
    instanceId: "hermes",
    model: "openai-codex:gpt-5.6-sol",
    runtimeMode: "auto-accept-edits",
  });
  assert.equal(client.commands[0].type, "thread.create");
  assert.equal(client.commands[1].type, "thread.turn.start");
  assert.equal(client.commands[0].runtimeMode, "auto-accept-edits");
  assert.equal(client.commands[1].runtimeMode, "auto-accept-edits");
  const projected = await client.thread("t-init");
  assert.equal(projected.thread.session.runtimeMode, "auto-accept-edits");
});

test("idempotent originate retries keep the requested runtime mode without duplicate session-init commands", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-runtime-mode-"));
  const stateFile = path.join(directory, "state.json");
  const client = sessionBindingClient();
  const options = {
    workspace: "/tmp/originate-idempotent-mode",
    title: "Idempotent mode",
    message: "hello",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    runtimeMode: "auto-accept-edits",
    idempotencyKey: "origin-mode-1",
    stateFile,
  };
  const first = await originate(client, options);
  const second = await originate(client, options);
  assert.equal(first.threadId, second.threadId);
  assert.deepEqual(
    client.commands.filter((command) => command.type === "thread.create").map((command) => command.runtimeMode),
    ["auto-accept-edits"],
  );
  assert.deepEqual(
    client.commands.filter((command) => command.type === "thread.turn.start").map((command) => command.runtimeMode),
    ["auto-accept-edits"],
  );
  const projected = await client.thread(first.threadId);
  assert.equal(projected.thread.session.runtimeMode, "auto-accept-edits");
});
