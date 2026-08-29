import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { continueThread, originate, startThread } from "../src/bridge.mjs";
import { usage } from "../src/cli.mjs";
import {
  buildCommandFromIntent,
  threadCreate,
  threadTurnStart,
} from "../src/orchestrate.mjs";
import { requireExplicitRuntimeMode } from "../src/model-selection.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

const CLI_PATH = path.resolve("src/cli.mjs");

// T3 session-start binds `session.runtimeMode` from the thread row at
// `thread.turn.start` (the decider copies `targetThread.runtimeMode`, not a
// silent fallback). A thread row alone is not the session.
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

test("session-init builders refuse an omitted runtime mode and accept only explicit values", () => {
  assert.throws(
    () => threadCreate({ commandId: "c1", threadId: "t1", projectId: "p1", title: "T", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } }),
    /runtimeMode is required .*POL-036\/POL-GB-016.*full-access.*not a compliant operation/,
  );
  assert.throws(
    () => threadTurnStart({ commandId: "c2", threadId: "t1", text: "hi" }),
    /runtimeMode is required .*full-access.*not a compliant operation/,
  );
  assert.equal(
    threadCreate({
      commandId: "c3",
      threadId: "t2",
      projectId: "p1",
      title: "T",
      modelSelection: { instanceId: "grok", model: "grok-4.6" },
      runtimeMode: "full-access",
    }).runtimeMode,
    "full-access",
  );
  assert.equal(
    threadTurnStart({ commandId: "c4", threadId: "t2", text: "hi", runtimeMode: "full-access" }).runtimeMode,
    "full-access",
  );
  assert.equal(
    threadCreate({
      commandId: "c5",
      threadId: "t3",
      projectId: "p1",
      title: "T",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "auto-accept-edits",
    }).runtimeMode,
    "auto-accept-edits",
  );
  assert.throws(
    () => threadCreate({ commandId: "c6", threadId: "t4", projectId: "p1", title: "T", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" }, runtimeMode: "banana" }),
    /runtimeMode must be one of/,
  );
});

test("thread.create and thread.continue intents fail closed without an explicit runtime mode", () => {
  assert.throws(
    () => buildCommandFromIntent({ action: "thread.create", projectId: "p1", title: "T", instanceId: "codex", model: "gpt-5.6-sol" }, { commandId: "cc" }),
    /runtimeMode is required .*full-access/,
  );
  assert.throws(
    () => buildCommandFromIntent({ action: "thread.continue", threadId: "t1", text: "go" }, { commandId: "cd" }),
    /runtimeMode is required .*full-access/,
  );
  assert.throws(
    () => buildCommandFromIntent({ action: "thread.restart", threadId: "t1", text: "resume" }, { commandId: "restart" }),
    /runtimeMode is required .*full-access/,
  );

  const continued = buildCommandFromIntent({ action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access" }, { commandId: "ce" });
  assert.equal(continued.type, "thread.turn.start");
  assert.equal(continued.runtimeMode, "full-access");

  const created = buildCommandFromIntent({ action: "thread.create", projectId: "p1", title: "T", instanceId: "codex", model: "gpt-5.6-sol", runtimeMode: "full-access" }, { commandId: "cf" });
  assert.equal(created.type, "thread.create");
  assert.equal(created.runtimeMode, "full-access");
});

test("requireExplicitRuntimeMode rejects empty strings, not just absent values", () => {
  assert.throws(() => requireExplicitRuntimeMode(undefined), /runtimeMode is required/);
  assert.throws(() => requireExplicitRuntimeMode(null, "--runtime-mode"), /--runtime-mode is required/);
  assert.throws(() => requireExplicitRuntimeMode("   ", "--runtime-mode"), /--runtime-mode is required/);
  assert.equal(requireExplicitRuntimeMode("full-access"), "full-access");
});

test("originate refuses to run without --runtime-mode and propagates full-access to session start", async () => {
  const client = sessionBindingClient();
  await assert.rejects(
    () => originate(client, {
      workspace: "/tmp/originate-omitted",
      title: "Omitted mode",
      message: "start",
      instanceId: "codex",
      model: "gpt-5.6-sol",
    }),
    /--?runtime-mode|runtimeMode is required .*full-access/,
  );
  assert.deepEqual(client.commands, []);

  const result = await originate(client, {
    workspace: "/tmp/originate-full-access",
    title: "Codex high review lane",
    message: "start",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
    runtimeMode: "full-access",
  });
  const { threadCreate: created, turnStart } = sessionStartCommands(client.commands);
  assert.equal(created.type, "thread.create");
  assert.equal(turnStart.type, "thread.turn.start");
  assert.equal(created.runtimeMode, "full-access");
  assert.equal(turnStart.runtimeMode, "full-access");
  assert.notEqual(created.runtimeMode, "approval-required");
  assert.notEqual(turnStart.runtimeMode, "approval-required");

  // Fresh readback: effective mode recorded at BOTH the thread row and the live session binding.
  const projected = await client.thread(result.threadId);
  assert.equal(projected.thread.runtimeMode, "full-access");
  assert.equal(projected.thread.session?.runtimeMode, "full-access");
  assert.notEqual(projected.thread.session?.runtimeMode, "approval-required");
});

test("continueThread refuses an omitted mode and full-access continues bind at thread and session level", async () => {
  const client = sessionBindingClient();
  const started = await originate(client, {
    workspace: "/tmp/continue-full-access",
    title: "Grok Code lane",
    message: "first task",
    instanceId: "grok",
    model: "grok-4.6",
    runtimeMode: "full-access",
  });

  await assert.rejects(
    () => continueThread(client, { threadId: started.threadId, message: "non-empty continue without a mode", messageId: "m-missing-mode" }),
    /runtimeMode is required .*full-access/,
  );
  assert.equal(client.commands.some((command) => command.type === "thread.turn.start" && command.message.text === "non-empty continue without a mode"), false);

  await continueThread(client, { threadId: started.threadId, message: "second task", messageId: "m-second", runtimeMode: "full-access" });
  const turns = client.commands.filter((command) => command.type === "thread.turn.start");
  assert.deepEqual(turns.map((turn) => turn.runtimeMode), ["full-access", "full-access"]);

  const projected = await client.thread(started.threadId);
  assert.equal(projected.thread.runtimeMode, "full-access");
  assert.equal(projected.thread.session?.runtimeMode, "full-access");
});

test("idempotent originate retries keep full-access without duplicate session-init commands", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-runtime-mode-"));
  const stateFile = path.join(directory, "state.json");
  const client = sessionBindingClient();
  const options = {
    workspace: "/tmp/originate-idempotent-mode",
    title: "Idempotent mode",
    message: "hello",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "xhigh" }],
    runtimeMode: "full-access",
    idempotencyKey: "origin-mode-1",
    stateFile,
  };
  const first = await originate(client, options);
  const second = await originate(client, options);
  assert.equal(first.threadId, second.threadId);
  assert.deepEqual(
    client.commands.filter((command) => command.type === "thread.create").map((command) => command.runtimeMode),
    ["full-access"],
  );
  assert.deepEqual(
    client.commands.filter((command) => command.type === "thread.turn.start").map((command) => command.runtimeMode),
    ["full-access"],
  );
  const projected = await client.thread(first.threadId);
  assert.equal(projected.thread.session.runtimeMode, "full-access");
});

test("usage documents the required flag, every-lab coverage, and non-compliance of omission", () => {
  const help = usage();
  assert.match(help, /originate --workspace PATH --title TITLE --message TEXT --runtime-mode approval-required\|auto-accept-edits\|auto\|full-access/);
  assert.match(help, /Runtime mode invariant \(POL-036 \/ POL-GB-016\)/);
  assert.match(help, /Every originate and every non-empty continue runs full-access/);
  assert.match(help, /T3-native selections and every Tentacles-additive adapter/);
  assert.match(help, /--runtime-mode full-access on originate and "runtimeMode":"full-access" on/);
  assert.match(help, /thread\.continue intents\. Omitting the runtime mode fails closed; it is never/);
  assert.doesNotMatch(help, /\[--runtime-mode /);
});

test("CLI originate without --runtime-mode exits non-zero with the compliance error before any dispatch", () => {
  const tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-cli-token-"));
  const tokenFile = path.join(tokenDirectory, "t3.token");
  fs.writeFileSync(tokenFile, "0".repeat(32) + "\n", { mode: 0o600 });
  const spawned = spawnSync(process.execPath, [
    CLI_PATH,
    "originate",
    "--workspace", "/tmp/cli-no-runtime-mode",
    "--title", "Missing mode",
    "--message", "must fail closed",
  ], {
    encoding: "utf8",
    env: { ...process.env, T3_HERMES_TOKEN_FILE: tokenFile, T3_URL: "http://127.0.0.1:9" },
  });
  assert.equal(spawned.status, 1);
  assert.match(`${spawned.stderr}`, /--runtime-mode is required .*POL-036\/POL-GB-016.*full-access/);

  const helpSpawned = spawnSync(process.execPath, [CLI_PATH, "help"], { encoding: "utf8" });
  assert.equal(helpSpawned.status, 0);
  assert.match(helpSpawned.stdout, /Every originate and every non-empty continue runs full-access/);
  assert.match(helpSpawned.stdout, /T3-native selections and every Tentacles-additive adapter/);
});
