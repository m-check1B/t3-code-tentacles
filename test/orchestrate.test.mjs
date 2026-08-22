import assert from "node:assert/strict";
import test from "node:test";
import {
  applyIntent,
  applyIntents,
  buildCommandFromIntent,
  observe,
  projectCreate,
  threadApprovalRespond,
  threadCheckpointRevert,
  threadCreate,
  threadExternalMessageAppend,
  threadRuntimeModeSet,
  threadSnooze,
  threadTurnStart,
} from "../src/orchestrate.mjs";

const SAMPLE_MODEL = { instanceId: "codex", model: "gpt-5.6-sol" };

test("command builders produce the wire shape T3 expects", () => {
  const project = projectCreate({ commandId: "c1", createdAt: "2026-08-13T00:00:00.000Z", projectId: "p1", title: "P", workspaceRoot: "/w" });
  assert.deepEqual(project, {
    type: "project.create", commandId: "c1", projectId: "p1", title: "P", workspaceRoot: "/w", createdAt: "2026-08-13T00:00:00.000Z",
  });

  const thread = threadCreate({ commandId: "c2", threadId: "t1", projectId: "p1", title: "T", modelSelection: SAMPLE_MODEL });
  assert.equal(thread.type, "thread.create");
  assert.equal(thread.modelSelection.instanceId, "codex");
  assert.equal(thread.runtimeMode, "approval-required");
  assert.equal(thread.interactionMode, "default");
  assert.equal(thread.branch, null);
  assert.equal(thread.worktreePath, null);

  const turn = threadTurnStart({ commandId: "c3", threadId: "t1", text: "hi" });
  assert.equal(turn.type, "thread.turn.start");
  assert.equal(turn.runtimeMode, "approval-required");
  assert.equal(turn.message.role, "user");
  assert.equal(turn.message.text, "hi");
  assert.deepEqual(turn.message.attachments, []);

  const approval = threadApprovalRespond({ commandId: "c4", threadId: "t1", requestId: "r1", decision: "accept" });
  assert.deepEqual(approval, {
    type: "thread.approval.respond", commandId: "c4", threadId: "t1", requestId: "r1", decision: "accept",
    createdAt: approval.createdAt,
  });

  const snooze = threadSnooze({ threadId: "t1", snoozedUntil: "2026-08-14T00:00:00.000Z" });
  assert.equal(snooze.type, "thread.snooze");
  assert.equal(snooze.snoozedUntil, "2026-08-14T00:00:00.000Z");
});

test("command builders validate enums and bounds", () => {
  assert.throws(() => threadRuntimeModeSet({ threadId: "t1", runtimeMode: "banana" }), /runtimeMode/);
  assert.throws(() => threadApprovalRespond({ threadId: "t1", requestId: "r1", decision: "maybe" }), /decision/);
  assert.throws(() => threadCheckpointRevert({ threadId: "t1", turnCount: -1 }), /non-negative/);
  assert.throws(() => threadSnooze({ threadId: "t1", snoozedUntil: "not-a-date" }), /ISO timestamp/);
  assert.throws(() => threadExternalMessageAppend({ threadId: "t1", text: "x".repeat(32_001) }), /bound/);
});

test("buildCommandFromIntent maps the full intent vocabulary", () => {
  const cases = [
    [{ action: "project.create", projectId: "p1", title: "P", workspaceRoot: "/w", instanceId: "codex", model: "gpt-5.6-sol" }, "project.create"],
    [{ action: "project.rename", projectId: "p1", title: "P2" }, "project.meta.update"],
    [{ action: "project.delete", projectId: "p1" }, "project.delete"],
    [{ action: "thread.create", projectId: "p1", title: "T", instanceId: "codex", model: "gpt-5.6-sol" }, "thread.create"],
    [{ action: "thread.continue", threadId: "t1", text: "go" }, "thread.turn.start"],
    [{ action: "thread.interrupt", threadId: "t1" }, "thread.turn.interrupt"],
    [{ action: "thread.stop", threadId: "t1" }, "thread.session.stop"],
    [{ action: "thread.approval.respond", threadId: "t1", requestId: "r1", decision: "decline" }, "thread.approval.respond"],
    [{ action: "thread.user-input.respond", threadId: "t1", requestId: "r1", answers: { a: 1 } }, "thread.user-input.respond"],
    [{ action: "thread.checkpoint.revert", threadId: "t1", turnCount: 2 }, "thread.checkpoint.revert"],
    [{ action: "thread.set-runtime-mode", threadId: "t1", runtimeMode: "approval-required" }, "thread.runtime-mode.set"],
    [{ action: "thread.set-model", threadId: "t1", instanceId: "codex", model: "gpt-5.6-sol" }, "thread.meta.update"],
    [{ action: "thread.rename", threadId: "t1", title: "New" }, "thread.meta.update"],
    [{ action: "thread.archive", threadId: "t1" }, "thread.archive"],
    [{ action: "thread.settle", threadId: "t1" }, "thread.settle"],
    [{ action: "thread.snooze", threadId: "t1", snoozedUntil: "2026-08-14T00:00:00.000Z" }, "thread.snooze"],
    [{ action: "thread.pin", threadId: "t1" }, "thread.pin"],
    [{ action: "thread.delete", threadId: "t1" }, "thread.delete"],
    [{ action: "thread.external-message", threadId: "t1", text: "attributed note" }, "thread.external-message.append"],
  ];
  for (const [intent, expectedType] of cases) {
    const command = buildCommandFromIntent(intent, { commandId: "cc" });
    assert.equal(command.type, expectedType, `action ${intent.action}`);
    assert.equal(command.commandId, "cc");
  }
});

test("thread.create and thread.set-model accept modelSelection options", () => {
  const options = [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "default" }];
  const created = buildCommandFromIntent({
    action: "thread.create",
    projectId: "p1",
    title: "T",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options,
  }, { commandId: "cc" });
  assert.equal(created.type, "thread.create");
  assert.deepEqual(created.modelSelection, { instanceId: "codex", model: "gpt-5.6-sol", options });

  const nested = buildCommandFromIntent({
    action: "thread.set-model",
    threadId: "t1",
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    modelSelection: { options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "1m" }] },
  }, { commandId: "cm" });
  assert.equal(nested.type, "thread.meta.update");
  assert.deepEqual(nested.modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "1m" }],
  });

  const budgeted = buildCommandFromIntent({
    action: "thread.create",
    projectId: "p1",
    title: "T",
    instanceId: "hermes",
    model: "openai-codex:gpt-5.6-sol",
    budget: "low",
  });
  assert.deepEqual(budgeted.modelSelection.options, [{ id: "reasoningEffort", value: "low" }]);
});

test("buildCommandFromIntent rejects unknown actions and missing fields", () => {
  assert.throws(() => buildCommandFromIntent({ action: "thread.explode", threadId: "t1" }), /Unknown intent action/);
  assert.throws(() => buildCommandFromIntent({ action: "thread.continue" }), /threadId/);
  assert.throws(() => buildCommandFromIntent({ action: "thread.set-model", threadId: "t1" }), /instanceId/);
  assert.throws(() => buildCommandFromIntent({ action: "thread.approval.respond", threadId: "t1", decision: "accept" }), /requestId/);
});

test("applyIntent dispatches, projects, and returns evidence", async () => {
  const commands = [];
  const client = {
    dispatch: async (command) => { commands.push(command); return { sequence: commands.length }; },
    thread: async () => ({ thread: { id: "t1", messages: [{ id: commands[0].message.messageId }] } }),
  };
  const result = await applyIntent(client, { action: "thread.continue", threadId: "t1", text: "go" }, { commandId: "cc" });
  assert.equal(result.action, "thread.continue");
  assert.equal(result.commandId, "cc");
  assert.equal(result.projected, true);
  assert.equal(commands[0].type, "thread.turn.start");
  assert.equal(commands[0].message.text, "go");
});

test("applyIntent skips projection when wait is false", async () => {
  const commands = [];
  const client = { dispatch: async (command) => { commands.push(command); return { sequence: 1 }; } };
  const result = await applyIntent(client, { action: "thread.stop", threadId: "t1" }, { wait: false });
  assert.equal(result.projected, false);
  assert.equal(commands[0].type, "thread.session.stop");
});

test("applyIntent waits for exact project id in the shell projection", async () => {
  const commands = [];
  const threadLookups = [];
  let shellCalls = 0;
  const project = { id: "p1", title: "P", workspaceRoot: "/w" };
  const client = {
    dispatch: async (command) => { commands.push(command); return { sequence: 1 }; },
    thread: async (threadId) => { threadLookups.push(threadId); throw new Error(`unexpected thread lookup for ${threadId}`); },
    shell: async () => {
      shellCalls += 1;
      return { projects: shellCalls === 1 ? [] : [project] };
    },
  };
  const result = await applyIntent(client, {
    action: "project.create",
    projectId: "p1",
    title: "P",
    workspaceRoot: "/w",
  }, { commandId: "cc", intervalMs: 0, timeoutMs: 1_000 });
  assert.equal(result.action, "project.create");
  assert.equal(result.commandId, "cc");
  assert.equal(result.projectId, "p1");
  assert.equal(result.projected, true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "project.create");
  assert.equal(commands[0].commandId, "cc");
  assert.equal(commands[0].projectId, "p1");
  assert.equal(shellCalls, 2);
  assert.deepEqual(threadLookups, []);
});

test("applyIntents stops at the first failure and bounds the list", async () => {
  const client = { dispatch: async () => ({ sequence: 1 }), thread: async () => ({ thread: { id: "x", messages: [] } }) };
  await assert.rejects(
    applyIntents(client, new Array(101).fill({ action: "thread.pin", threadId: "t1" })),
    /Refusing to apply more than 100 intents/,
  );
  await assert.rejects(
    applyIntents(client, [{ action: "thread.pin", threadId: "t1" }, { action: "nope", threadId: "t1" }]),
    /Unknown intent action/,
  );
});

test("observe surfaces pending work, active turns, and archived threads", async () => {
  const client = {
    shell: async () => ({
      snapshotSequence: 7,
      updatedAt: "2026-08-13T00:00:00.000Z",
      projects: [{ id: "p1", title: "P", workspaceRoot: "/w" }],
      threads: [
        { id: "t1", projectId: "p1", title: "Approval", hasPendingApprovals: true, hasPendingUserInput: false, modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" }, session: { status: "ready", activeTurnId: "turn1", providerName: "Codex" } },
        { id: "t2", projectId: "p1", title: "Idle", hasPendingApprovals: false, hasPendingUserInput: false, session: { status: "idle", activeTurnId: null } },
      ],
    }),
    archivedShell: async () => ({ snapshotSequence: 7, updatedAt: "2026-08-13T00:00:00.000Z", projects: [], threads: [{ id: "t3", projectId: "p1", title: "Archived" }] }),
  };
  const state = await observe(client);
  assert.equal(state.counts.projects, 1);
  assert.equal(state.counts.threads, 2);
  assert.equal(state.counts.archivedThreads, 1);
  assert.equal(state.counts.pendingApprovals, 1);
  assert.equal(state.counts.activeTurns, 1);
  assert.equal(state.pendingWork[0].threadId, "t1");
  assert.equal(state.pendingWork[0].approvals, true);
  assert.equal(state.activeTurns[0].activeTurnId, "turn1");
});
