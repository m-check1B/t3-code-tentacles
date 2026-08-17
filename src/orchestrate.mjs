// Orchestration control plane over T3 Code's local orchestration API.
//
// The bridge's existing surface lets Hermes appear as a provider and originate
// threads. This module turns the bridge into a top-level orchestrator: it
// exposes the full project/thread/turn/approval command vocabulary as pure
// command builders plus a small intent interpreter, and an `observe` read that
// surfaces everything an orchestrator needs to decide the next action.
//
// Every command carries an immutable `commandId` and `createdAt`; callers can
// supply their own for idempotent retry. Commands are dispatched through the
// bridge's existing loopback-authenticated HTTP client and projected back with
// the same exact-ID wait used by `originate`.

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { T3HttpError } from "./t3-client.mjs";

const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const INTERACTION_MODES = new Set(["default", "plan"]);
const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

function now() {
  return new Date().toISOString();
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Intent requires a non-empty ${label}`);
  return value;
}

function modelSelection(intent, label = "model selection") {
  const instanceId = requireString(intent.instanceId, `${label} instanceId`);
  const model = requireString(intent.model, `${label} model`);
  return { instanceId, model };
}

// ── Command builders ────────────────────────────────────────────────────────
// Pure constructors for every dispatchable T3 orchestration command. Each
// accepts an explicit commandId/createdAt so an orchestrator can retry the
// same intent idempotently.

export function projectCreate(input) {
  return {
    type: "project.create",
    commandId: input.commandId ?? randomUUID(),
    projectId: requireString(input.projectId, "projectId"),
    title: requireString(input.title, "title"),
    workspaceRoot: requireString(input.workspaceRoot, "workspaceRoot"),
    ...(input.defaultModelSelection !== undefined ? { defaultModelSelection: input.defaultModelSelection } : {}),
    ...(input.createWorkspaceRootIfMissing !== undefined ? { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing } : {}),
    createdAt: input.createdAt ?? now(),
  };
}

export function projectMetaUpdate(input) {
  return {
    type: "project.meta.update",
    commandId: input.commandId ?? randomUUID(),
    projectId: requireString(input.projectId, "projectId"),
    ...(input.title !== undefined ? { title: requireString(input.title, "title") } : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: requireString(input.workspaceRoot, "workspaceRoot") } : {}),
    ...(input.defaultModelSelection !== undefined ? { defaultModelSelection: input.defaultModelSelection } : {}),
    ...(input.scripts !== undefined ? { scripts: input.scripts } : {}),
  };
}

export function projectDelete(input) {
  return {
    type: "project.delete",
    commandId: input.commandId ?? randomUUID(),
    projectId: requireString(input.projectId, "projectId"),
    ...(input.force !== undefined ? { force: input.force } : {}),
  };
}

export function threadCreate(input) {
  return {
    type: "thread.create",
    commandId: input.commandId ?? randomUUID(),
    threadId: requireString(input.threadId, "threadId"),
    projectId: requireString(input.projectId, "projectId"),
    title: requireString(input.title, "title"),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    createdAt: input.createdAt ?? now(),
  };
}

export function threadDelete(input) {
  return { type: "thread.delete", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId") };
}

export function threadArchive(input) {
  return { type: "thread.archive", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId") };
}

export function threadUnarchive(input) {
  return { type: "thread.unarchive", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId") };
}

export function threadSettle(input) {
  return { type: "thread.settle", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId") };
}

export function threadUnsettle(input) {
  return { type: "thread.unsettle", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId"), reason: "user" };
}

export function threadSnooze(input) {
  const snoozedUntil = requireString(input.snoozedUntil, "snoozedUntil");
  if (!Number.isFinite(Date.parse(snoozedUntil))) throw new Error("Intent snoozedUntil must be an ISO timestamp");
  return { type: "thread.snooze", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId"), snoozedUntil };
}

export function threadUnsnooze(input) {
  return { type: "thread.unsnooze", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId"), reason: "user" };
}

export function threadPin(input) {
  return { type: "thread.pin", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId") };
}

export function threadUnpin(input) {
  return { type: "thread.unpin", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId") };
}

export function threadMetaUpdate(input) {
  const command = {
    type: "thread.meta.update",
    commandId: input.commandId ?? randomUUID(),
    threadId: requireString(input.threadId, "threadId"),
  };
  if (input.title !== undefined) command.title = requireString(input.title, "title");
  if (input.regenerateTitle !== undefined) command.regenerateTitle = input.regenerateTitle;
  if (input.modelSelection !== undefined) command.modelSelection = input.modelSelection;
  if (input.branch !== undefined) command.branch = input.branch;
  if (input.expectedBranch !== undefined) command.expectedBranch = input.expectedBranch;
  if (input.worktreePath !== undefined) command.worktreePath = input.worktreePath;
  return command;
}

export function threadRuntimeModeSet(input) {
  const runtimeMode = requireString(input.runtimeMode, "runtimeMode");
  if (!RUNTIME_MODES.has(runtimeMode)) throw new Error(`Intent runtimeMode must be one of ${[...RUNTIME_MODES].join(", ")}`);
  return { type: "thread.runtime-mode.set", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId"), runtimeMode, createdAt: input.createdAt ?? now() };
}

export function threadInteractionModeSet(input) {
  const interactionMode = requireString(input.interactionMode, "interactionMode");
  if (!INTERACTION_MODES.has(interactionMode)) throw new Error("Intent interactionMode must be one of default, plan");
  return { type: "thread.interaction-mode.set", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId"), interactionMode, createdAt: input.createdAt ?? now() };
}

export function threadTurnStart(input) {
  const command = {
    type: "thread.turn.start",
    commandId: input.commandId ?? randomUUID(),
    threadId: requireString(input.threadId, "threadId"),
    message: {
      messageId: input.messageId ?? randomUUID(),
      role: "user",
      text: input.text ?? "",
      attachments: input.attachments ?? [],
    },
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    createdAt: input.createdAt ?? now(),
  };
  if (input.modelSelection !== undefined) command.modelSelection = input.modelSelection;
  if (input.titleSeed !== undefined) command.titleSeed = input.titleSeed;
  return command;
}

export function threadTurnInterrupt(input) {
  const command = {
    type: "thread.turn.interrupt",
    commandId: input.commandId ?? randomUUID(),
    threadId: requireString(input.threadId, "threadId"),
    createdAt: input.createdAt ?? now(),
  };
  if (input.turnId !== undefined) command.turnId = input.turnId;
  return command;
}

export function threadApprovalRespond(input) {
  const decision = requireString(input.decision, "decision");
  if (!APPROVAL_DECISIONS.has(decision)) throw new Error(`Intent decision must be one of ${[...APPROVAL_DECISIONS].join(", ")}`);
  return {
    type: "thread.approval.respond",
    commandId: input.commandId ?? randomUUID(),
    threadId: requireString(input.threadId, "threadId"),
    requestId: requireString(input.requestId, "requestId"),
    decision,
    createdAt: input.createdAt ?? now(),
  };
}

export function threadUserInputRespond(input) {
  return {
    type: "thread.user-input.respond",
    commandId: input.commandId ?? randomUUID(),
    threadId: requireString(input.threadId, "threadId"),
    requestId: requireString(input.requestId, "requestId"),
    answers: input.answers ?? {},
    createdAt: input.createdAt ?? now(),
  };
}

export function threadCheckpointRevert(input) {
  const turnCount = input.turnCount;
  if (!Number.isInteger(turnCount) || turnCount < 0) throw new Error("Intent turnCount must be a non-negative integer");
  return { type: "thread.checkpoint.revert", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId"), turnCount, createdAt: input.createdAt ?? now() };
}

export function threadSessionStop(input) {
  return { type: "thread.session.stop", commandId: input.commandId ?? randomUUID(), threadId: requireString(input.threadId, "threadId"), createdAt: input.createdAt ?? now() };
}

export function threadExternalMessageAppend(input) {
  const text = requireString(input.text, "text");
  if (text.length > 32_000) throw new Error("Intent text exceeds the 32000 character external-message bound");
  return {
    type: "thread.external-message.append",
    commandId: input.commandId ?? randomUUID(),
    threadId: requireString(input.threadId, "threadId"),
    text,
    createdAt: input.createdAt ?? now(),
  };
}

// ── Intent interpreter ──────────────────────────────────────────────────────
// A high-level action vocabulary an orchestrator (Hermes, a cron job, another
// agent) can drive without knowing T3's wire command shapes.

const INTENT_ACTIONS = new Set([
  "project.create",
  "project.rename",
  "project.set-model",
  "project.delete",
  "thread.create",
  "thread.continue",
  "thread.interrupt",
  "thread.stop",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.checkpoint.revert",
  "thread.set-runtime-mode",
  "thread.set-model",
  "thread.rename",
  "thread.archive",
  "thread.unarchive",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.delete",
  "thread.external-message",
]);

export function buildCommandFromIntent(intent, { commandId, createdAt } = {}) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new Error("Intent must be an object");
  const action = requireString(intent.action, "action");
  if (!INTENT_ACTIONS.has(action)) throw new Error(`Unknown intent action: ${action}`);
  const base = { ...(commandId !== undefined ? { commandId } : {}), ...(createdAt !== undefined ? { createdAt } : {}) };

  switch (action) {
    case "project.create":
      return projectCreate({ ...base, projectId: intent.projectId ?? randomUUID(), title: intent.title, workspaceRoot: intent.workspaceRoot, ...(intent.instanceId && intent.model ? { defaultModelSelection: modelSelection(intent) } : {}) });
    case "project.rename":
      return projectMetaUpdate({ ...base, projectId: intent.projectId, title: intent.title });
    case "project.set-model":
      return projectMetaUpdate({ ...base, projectId: intent.projectId, defaultModelSelection: modelSelection(intent) });
    case "project.delete":
      return projectDelete({ ...base, projectId: intent.projectId, ...(intent.force !== undefined ? { force: intent.force } : {}) });
    case "thread.create":
      return threadCreate({ ...base, threadId: intent.threadId ?? randomUUID(), projectId: intent.projectId, title: intent.title, modelSelection: modelSelection(intent), ...(intent.runtimeMode !== undefined ? { runtimeMode: intent.runtimeMode } : {}) });
    case "thread.continue":
      return threadTurnStart({ ...base, threadId: intent.threadId, text: intent.text ?? "", ...(intent.instanceId && intent.model ? { modelSelection: modelSelection(intent) } : {}), ...(intent.titleSeed !== undefined ? { titleSeed: intent.titleSeed } : {}) });
    case "thread.interrupt":
      return threadTurnInterrupt({ ...base, threadId: intent.threadId, ...(intent.turnId !== undefined ? { turnId: intent.turnId } : {}) });
    case "thread.stop":
      return threadSessionStop({ ...base, threadId: intent.threadId });
    case "thread.approval.respond":
      return threadApprovalRespond({ ...base, threadId: intent.threadId, requestId: intent.requestId, decision: intent.decision });
    case "thread.user-input.respond":
      return threadUserInputRespond({ ...base, threadId: intent.threadId, requestId: intent.requestId, answers: intent.answers ?? {} });
    case "thread.checkpoint.revert":
      return threadCheckpointRevert({ ...base, threadId: intent.threadId, turnCount: intent.turnCount });
    case "thread.set-runtime-mode":
      return threadRuntimeModeSet({ ...base, threadId: intent.threadId, runtimeMode: intent.runtimeMode });
    case "thread.set-model":
      return threadMetaUpdate({ ...base, threadId: intent.threadId, modelSelection: modelSelection(intent) });
    case "thread.rename":
      return threadMetaUpdate({ ...base, threadId: intent.threadId, title: intent.title });
    case "thread.archive": return threadArchive({ ...base, threadId: intent.threadId });
    case "thread.unarchive": return threadUnarchive({ ...base, threadId: intent.threadId });
    case "thread.settle": return threadSettle({ ...base, threadId: intent.threadId });
    case "thread.unsettle": return threadUnsettle({ ...base, threadId: intent.threadId });
    case "thread.snooze": return threadSnooze({ ...base, threadId: intent.threadId, snoozedUntil: intent.snoozedUntil });
    case "thread.unsnooze": return threadUnsnooze({ ...base, threadId: intent.threadId });
    case "thread.pin": return threadPin({ ...base, threadId: intent.threadId });
    case "thread.unpin": return threadUnpin({ ...base, threadId: intent.threadId });
    case "thread.delete": return threadDelete({ ...base, threadId: intent.threadId });
    case "thread.external-message":
      return threadExternalMessageAppend({ ...base, threadId: intent.threadId, text: intent.text });
    default:
      throw new Error(`Unknown intent action: ${action}`);
  }
}

// ── Read: observe ───────────────────────────────────────────────────────────
// Snapshot everything an orchestrator needs to choose the next action: active
// and archived projects/threads, plus a compact pending-work index.

export async function observe(client) {
  const [shell, archived] = await Promise.all([client.shell(), client.archivedShell()]);
  const threads = shell.threads ?? [];
  const archivedThreads = archived?.threads ?? [];
  const pendingWork = [];
  for (const thread of threads) {
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      pendingWork.push({
        threadId: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        approvals: Boolean(thread.hasPendingApprovals),
        userInput: Boolean(thread.hasPendingUserInput),
        activeTurnId: thread.session?.activeTurnId ?? null,
        sessionStatus: thread.session?.status ?? null,
        modelSelection: thread.modelSelection ?? null,
      });
    }
  }
  const activeTurns = threads
    .filter((thread) => thread.session && ["starting", "running", "ready", "interrupted"].includes(thread.session.status))
    .map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      projectId: thread.projectId,
      activeTurnId: thread.session.activeTurnId,
      sessionStatus: thread.session.status,
      providerName: thread.session.providerName,
      providerInstanceId: thread.session.providerInstanceId ?? null,
      runtimeMode: thread.session.runtimeMode,
    }));
  return {
    snapshotSequence: shell.snapshotSequence,
    updatedAt: shell.updatedAt,
    projects: shell.projects ?? [],
    threads,
    archivedThreads,
    pendingWork,
    activeTurns,
    counts: {
      projects: (shell.projects ?? []).length,
      threads: threads.length,
      archivedThreads: archivedThreads.length,
      pendingApprovals: pendingWork.filter((entry) => entry.approvals).length,
      pendingUserInput: pendingWork.filter((entry) => entry.userInput).length,
      activeTurns: activeTurns.length,
    },
  };
}

// ── Dispatch + verify ───────────────────────────────────────────────────────

async function getThreadIfProjected(client, threadId) {
  try { return await client.thread(threadId); }
  catch (error) { if (error instanceof T3HttpError && error.status === 404) return null; throw error; }
}

export async function waitForThreadProjection(client, threadId, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await getThreadIfProjected(client, threadId);
    if (detail) return detail;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for T3 projection: thread ${threadId}`);
}

export async function waitForMessageProjection(client, threadId, messageId, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await getThreadIfProjected(client, threadId);
    if (detail?.thread?.messages?.some((message) => message.id === messageId)) return detail;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for message ${messageId} in thread ${threadId}`);
}

// Apply one intent: build the command, dispatch it, project it back, and
// return evidence an orchestrator can record. `wait` toggles projection
// verification (off for fire-and-forget lifecycle commands).
export async function applyIntent(client, intent, { wait = true, commandId, createdAt } = {}) {
  const command = buildCommandFromIntent(intent, { commandId, createdAt });
  const dispatchResult = await client.dispatch(command);
  let projection = null;
  if (wait && command.type === "thread.turn.start") {
    projection = await waitForMessageProjection(client, command.threadId, command.message.messageId);
  } else if (wait && (command.type === "thread.create" || command.type === "project.create")) {
    projection = await waitForThreadProjection(client, command.threadId ?? command.projectId);
  }
  return {
    action: intent.action,
    commandId: command.commandId,
    dispatchResult,
    threadId: command.threadId ?? intent.threadId ?? null,
    projectId: command.projectId ?? intent.projectId ?? null,
    projected: projection !== null,
  };
}

// Apply a bounded list of intents in order, stopping at the first failure.
export async function applyIntents(client, intents, { wait = true, maxIntents = 100 } = {}) {
  if (!Array.isArray(intents)) throw new Error("Intents must be an array");
  if (intents.length > maxIntents) throw new Error(`Refusing to apply more than ${maxIntents} intents`);
  const results = [];
  for (const intent of intents) {
    results.push(await applyIntent(client, intent, { wait }));
  }
  return results;
}
