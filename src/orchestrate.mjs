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

import { validateNestedRecords } from "./t3-v2-validation.mjs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  requireExplicitRuntimeMode,
  requireRuntimeMode,
  resolveModelSelection,
  requireContinueSelection,
  retainedSelectionPin,
} from "./model-selection.mjs";
import { readOrchestrationSnapshot, requireFullThreadId, T3HttpError, T3AuthError } from "./t3-client.mjs";
import { T3RpcRejectedError, T3V2UnsupportedError, V2_PROTOCOL } from "./t3-v2.mjs";
import { classifyFailure } from "./failure-codes.mjs";

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
  return resolveModelSelection({
    instanceId,
    model,
    options: intent.options ?? intent.modelSelection?.options,
    budget: intent.budget,
  });
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
    runtimeMode: requireExplicitRuntimeMode(input.runtimeMode),
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
  const runtimeMode = requireRuntimeMode(requireString(input.runtimeMode, "runtimeMode"));
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
    runtimeMode: requireExplicitRuntimeMode(input.runtimeMode),
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

export const INTENT_ACTIONS = new Set([
  "project.create",
  "project.rename",
  "project.set-model",
  "project.delete",
  "thread.create",
  "thread.continue",
  "thread.restart",
  "thread.interrupt",
  "thread.stop",
  "thread.session.stop",
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

// Intent fields each action reads. On T3 orchestration protocol 2 any other
// field is refused (KRA-6436: fail closed), never silently dropped.
const SELECTION_FIELDS = ["instanceId", "model", "options", "budget", "modelSelection"];
const THREAD_ONLY = ["threadId"];
const INTENT_FIELDS = {
  "project.create": ["projectId", "title", "workspaceRoot", ...SELECTION_FIELDS],
  "project.rename": ["projectId", "title"],
  "project.set-model": ["projectId", ...SELECTION_FIELDS],
  "project.delete": ["projectId", "force"],
  "thread.create": ["threadId", "projectId", "title", "runtimeMode", ...SELECTION_FIELDS],
  "thread.continue": ["threadId", "text", "runtimeMode", "titleSeed", ...SELECTION_FIELDS],
  "thread.restart": ["threadId", "text", "runtimeMode", "titleSeed", ...SELECTION_FIELDS],
  "thread.interrupt": ["threadId", "turnId"],
  "thread.stop": THREAD_ONLY,
  "thread.session.stop": THREAD_ONLY,
  "thread.approval.respond": ["threadId", "requestId", "decision"],
  "thread.user-input.respond": ["threadId", "requestId", "answers"],
  "thread.checkpoint.revert": ["threadId", "turnCount"],
  "thread.set-runtime-mode": ["threadId", "runtimeMode"],
  "thread.set-model": ["threadId", ...SELECTION_FIELDS],
  "thread.rename": ["threadId", "title"],
  "thread.snooze": ["threadId", "snoozedUntil"],
  "thread.external-message": ["threadId", "text"],
};

export function requireKnownIntentFields(intent) {
  const allowed = new Set(["action", "commandId", ...(INTENT_FIELDS[intent?.action] ?? THREAD_ONLY)]);
  const unknown = Object.keys(intent ?? {}).filter((key) => !allowed.has(key));
  if (unknown.length) throw new T3V2UnsupportedError(`Intent ${intent.action} has unknown field(s): ${unknown.join(", ")}`);
  validateNestedRecords(intent, (message) => { throw new T3V2UnsupportedError(message); });
}

export function buildCommandFromIntent(intent, { commandId, createdAt } = {}) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new Error("Intent must be an object");
  const action = requireString(intent.action, "action");
  if (!INTENT_ACTIONS.has(action)) throw new Error(`Unknown intent action: ${action}`);
  const retryId = commandId ?? intent.commandId;
  const base = { ...(retryId !== undefined ? { commandId: requireString(retryId, "commandId") } : {}), ...(createdAt !== undefined ? { createdAt } : {}) };

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
      return threadCreate({ ...base, threadId: intent.threadId ?? randomUUID(), projectId: intent.projectId, title: intent.title, modelSelection: modelSelection(intent), runtimeMode: intent.runtimeMode });
    case "thread.continue":
    case "thread.restart": {
      // Refuse partial selection input here, before applyIntent can dispatch
      // anything (including a restart stop).
      const explicit = requireContinueSelection({ instanceId: intent.instanceId, model: intent.model, options: intent.options, budget: intent.budget, modelSelection: intent.modelSelection });
      return threadTurnStart({ ...base, threadId: intent.threadId, text: intent.text ?? "", runtimeMode: intent.runtimeMode, ...(explicit ? { modelSelection: modelSelection(intent) } : {}), ...(intent.titleSeed !== undefined ? { titleSeed: intent.titleSeed } : {}) });
    }
    case "thread.interrupt":
      return threadTurnInterrupt({ ...base, threadId: intent.threadId, ...(intent.turnId !== undefined ? { turnId: intent.turnId } : {}) });
    case "thread.stop":
    case "thread.session.stop":
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordArray(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function hasOpenRequest(activities, requestedKind, resolvedKind) {
  const open = new Set();
  for (const activity of recordArray(activities)) {
    const payload = isRecord(activity.payload) ? activity.payload : {};
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;
    if (activity.kind === requestedKind) open.add(requestId);
    if (activity.kind === resolvedKind) open.delete(requestId);
  }
  return open.size > 0;
}

function projectSession(session) {
  if (!isRecord(session)) return null;
  return {
    status: session.status ?? null,
    activeTurnId: session.activeTurnId ?? null,
    providerName: session.providerName ?? null,
    providerInstanceId: session.providerInstanceId ?? null,
    runtimeMode: session.runtimeMode ?? null,
    lastError: session.lastError ?? null,
  };
}

function canonicalActivityStamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? value : null;
}

function sanitizedLastActivity(thread) {
  const stamps = [];
  for (const value of [thread.lastActivity, thread.updatedAt]) {
    const stamp = canonicalActivityStamp(value);
    if (stamp) stamps.push(stamp);
  }
  for (const activity of recordArray(thread.activities)) {
    const created = canonicalActivityStamp(activity.createdAt);
    if (created) stamps.push(created);
  }
  stamps.sort();
  return stamps.at(-1) ?? null;
}

function threadPendingFlags(thread) {
  const hasPendingApprovals = typeof thread.hasPendingApprovals === "boolean"
    ? thread.hasPendingApprovals
    : hasOpenRequest(thread.activities, "approval.requested", "approval.resolved");
  const hasPendingUserInput = typeof thread.hasPendingUserInput === "boolean"
    ? thread.hasPendingUserInput
    : hasOpenRequest(thread.activities, "user-input.requested", "user-input.resolved");
  return { hasPendingApprovals, hasPendingUserInput };
}

function projectThreadSummary(thread) {
  const { hasPendingApprovals, hasPendingUserInput } = threadPendingFlags(thread);
  return {
    id: thread.id ?? null,
    projectId: thread.projectId ?? null,
    title: thread.title ?? null,
    modelSelection: thread.modelSelection ?? null,
    runtimeMode: thread.runtimeMode ?? null,
    archivedAt: thread.archivedAt ?? null,
    settledAt: thread.settledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    lastActivity: sanitizedLastActivity(thread),
    session: projectSession(thread.session),
    hasPendingApprovals,
    hasPendingUserInput,
  };
}

// Compact parent-check document. One per-thread HTTP read; never the observe snapshot.
// "stalled" is CLI-only (KRA-9494): it needs a clock, so the relay keeps "generating".
export const THREAD_REPORT_STATUSES = Object.freeze(["Done", "generating", "ready/idle", "blocked", "stalled"]);

// KRA-9494: Codex can exhaust its stream reconnects (e.g. after HTTP 429) and
// leave the turn "running" with no further events. Idle window before "stalled".
export const STREAM_STALL_IDLE_MS = 10 * 60 * 1000;
const RECONNECT_ATTEMPT = /^Reconnecting\.\.\.\s*(\d{1,3})\/(\d{1,3})(?!\d)/;

/**
 * Pure: stall evidence when the newest activity is a stream disconnect or
 * reconnect warning and nothing at all has happened for over `idleMs`, else
 * null. Only parsed numbers leave this function, never provider text.
 */
export function threadStreamStall(thread, { now = Date.now(), idleMs = STREAM_STALL_IDLE_MS } = {}) {
  if (!isRecord(thread)) return null;
  let last = null;
  for (const activity of recordArray(thread.activities)) {
    const at = canonicalActivityStamp(activity.createdAt);
    if (at && (!last || at >= last.at)) last = { activity, at };
  }
  if (!last || !["runtime.warning", "runtime.error"].includes(last.activity.kind)) return null;
  const payload = isRecord(last.activity.payload) ? last.activity.payload : {};
  // T3 keeps the Codex notification params as `detail`; accept the raw params too.
  const error = [payload.detail?.error, payload.error].find(isRecord) ?? {};
  const disconnect = isRecord(error.codexErrorInfo) && isRecord(error.codexErrorInfo.responseStreamDisconnected)
    ? error.codexErrorInfo.responseStreamDisconnected : null;
  const attempt = [payload.message, error.message].map((text) => typeof text === "string" ? RECONNECT_ATTEMPT.exec(text) : null).find(Boolean);
  const retryLimitExceeded = typeof error.additionalDetails === "string" && /exceeded retry limit/i.test(error.additionalDetails);
  if (!disconnect && !attempt && !retryLimitExceeded) return null;
  const lastActivity = sanitizedLastActivity(thread);
  const idleForMs = lastActivity ? now - Date.parse(lastActivity) : NaN;
  if (!(idleForMs > idleMs)) return null;
  const httpStatusCode = Number.isSafeInteger(disconnect?.httpStatusCode) ? disconnect.httpStatusCode : null;
  const reconnectAttempt = attempt ? `${Number(attempt[1])}/${Number(attempt[2])}` : null;
  const summary = [disconnect ? "stream disconnected" : "stream reconnecting",
    httpStatusCode !== null ? `HTTP ${httpStatusCode}` : null,
    reconnectAttempt ? `reconnect ${reconnectAttempt}` : null,
    retryLimitExceeded ? "retry limit exceeded" : null].filter(Boolean).join(", ");
  return { reason: "stream-disconnected", idleSince: lastActivity, idleForMs,
    lastError: { kind: last.activity.kind, httpStatusCode, reconnectAttempt, retryLimitExceeded, summary } };
}

/** CLI stall window: TENTACLES_STALL_IDLE_MINUTES when a positive number, else 10 min. */
export function streamStallIdleMs(env = process.env) {
  const minutes = Number(env.TENTACLES_STALL_IDLE_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : STREAM_STALL_IDLE_MS;
}

// Model labels leave this process only when they are short, printable IDs.
export const REPORT_MODEL_LABEL = /^[A-Za-z0-9._:+-]{1,80}$/;
// Provider error payloads can carry prompt/auth material, so the compact
// report states only that an error exists, never its text or object.
export const REPORT_ERROR_MARKER = "provider-error";

function reportModel(modelSelection) {
  if (!isRecord(modelSelection)) return null;
  return typeof modelSelection.model === "string" && REPORT_MODEL_LABEL.test(modelSelection.model)
    ? modelSelection.model
    : null;
}

function reportError(session) {
  const lastError = session.lastError;
  const present = typeof lastError === "string" ? lastError.length > 0 : lastError != null;
  return present || session.status === "error" ? REPORT_ERROR_MARKER : null;
}

export function mapThreadReportStatus({
  sessionStatus = null,
  hasPendingApprovals = false,
  hasPendingUserInput = false,
  settledAt = null,
  lastError = null,
} = {}) {
  if (typeof settledAt === "string" && settledAt.length > 0) return "Done";
  if (hasPendingApprovals === true || hasPendingUserInput === true) return "blocked";
  if (sessionStatus === "starting" || sessionStatus === "running") return "generating";
  if (sessionStatus === "error" || (typeof lastError === "string" && lastError.length > 0)) return "blocked";
  if (lastError != null && typeof lastError !== "string") return null;
  if (sessionStatus === "ready" || sessionStatus === "idle" || sessionStatus === "stopped") {
    return "ready/idle";
  }
  // Unproven is not a fifth public status: the relay omits it and the CLI fails.
  return null;
}

export function threadReportStatus(thread) {
  if (!isRecord(thread)) return null;
  const { hasPendingApprovals, hasPendingUserInput } = threadPendingFlags(thread);
  const session = isRecord(thread.session) ? thread.session : {};
  return mapThreadReportStatus({
    sessionStatus: session.status ?? null,
    hasPendingApprovals,
    hasPendingUserInput,
    settledAt: thread.settledAt ?? null,
    lastError: session.lastError ?? null,
  });
}

/**
 * KRA-8958: a `blocked` report gains a typed `{code, message}`. The code is
 * derived from pending flags and session state; provider text is only
 * pattern-matched (usage limit, timeout, ...) and never copied.
 */
export function threadReportFailure(thread) {
  if (!isRecord(thread) || threadReportStatus(thread) !== "blocked") return null;
  const session = isRecord(thread.session) ? thread.session : {};
  return classifyFailure({
    ...threadPendingFlags(thread),
    sessionStatus: session.status ?? null,
    error: typeof session.lastError === "string" ? session.lastError : null,
  });
}

export function projectThreadReport(thread, threadId, { now = Date.now(), stallIdleMs = STREAM_STALL_IDLE_MS } = {}) {
  if (!isRecord(thread)) throw new Error(`T3 thread ${threadId} is not projected`);
  if (thread.id !== threadId) throw new Error(`T3 thread ${threadId} projection identity mismatch`);
  let status = threadReportStatus(thread);
  const stall = status === "generating" ? threadStreamStall(thread, { now, idleMs: stallIdleMs }) : null;
  if (stall) status = "stalled";
  if (status === null) throw new Error(`T3 thread ${threadId} report is unproven`);
  if (!THREAD_REPORT_STATUSES.includes(status)) {
    throw new Error(`Thread report produced an unknown status: ${status}`);
  }
  return {
    threadId,
    status,
    lastError: reportError(isRecord(thread.session) ? thread.session : {}),
    model: reportModel(thread.modelSelection),
    ...(threadReportFailure(thread) ?? {}),
    ...(stall ? { stall } : {}),
  };
}

function looksLikeThread(value) {
  if (!isRecord(value)) return false;
  return value.id != null
    || isRecord(value.session)
    || typeof value.settledAt === "string"
    || isRecord(value.modelSelection)
    || typeof value.hasPendingApprovals === "boolean"
    || typeof value.hasPendingUserInput === "boolean"
    || Array.isArray(value.activities);
}

function unwrapThreadDetail(detail) {
  if (isRecord(detail?.thread)) return detail.thread;
  if (looksLikeThread(detail) && detail.thread === undefined) return detail;
  return null;
}

export async function report(client, threadId, options = {}) {
  const id = requireFullThreadId(threadId);
  if (typeof client?.thread !== "function") {
    throw new Error("T3 client does not expose a per-thread read");
  }
  const detail = await client.thread(id);
  const thread = unwrapThreadDetail(detail);
  if (!thread) throw new Error(`T3 thread ${id} is not projected`);
  return projectThreadReport(thread, id, options);
}

// An in-progress turn with no activity for this long is listed as stale (KRA-8952).
export const STALE_TURN_MS = 6 * 60 * 60 * 1000;

export async function observe(client, { now = Date.now(), staleTurnMs = STALE_TURN_MS, stallIdleMs = STREAM_STALL_IDLE_MS } = {}) {
  const [snapshot, archived] = await Promise.all([readOrchestrationSnapshot(client), client.archivedShell()]);
  const readModel = isRecord(snapshot) ? snapshot : {};
  const projects = recordArray(readModel.projects).filter((project) => project.deletedAt == null);
  const liveThreads = recordArray(readModel.threads)
    .filter((thread) => thread.deletedAt == null && thread.archivedAt == null);
  const threads = liveThreads.map(projectThreadSummary);
  const archivedThreads = recordArray(isRecord(archived) ? archived.threads : []).map(projectThreadSummary);
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
  const inProgress = threads
    .filter((thread) => thread.session && (thread.session.activeTurnId != null || ["starting", "running"].includes(thread.session.status)));
  const inProgressSet = new Set(inProgress);
  // Stale turns stay in activeTurns (the seat cap is unchanged); they are only listed separately.
  const staleTurnThreadIds = inProgress
    .filter((thread) => thread.lastActivity != null && now - Date.parse(thread.lastActivity) > staleTurnMs)
    .map((thread) => thread.id);
  // KRA-9494: like stale turns, stalled ones stay in activeTurns; raw threads keep activities.
  const stalledTurns = liveThreads.flatMap((thread, index) => {
    const stall = inProgressSet.has(threads[index]) ? threadStreamStall(thread, { now, idleMs: stallIdleMs }) : null;
    return stall ? [{ threadId: threads[index].id, status: "stalled", ...stall }] : [];
  });
  const activeTurns = inProgress
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
    snapshotSequence: readModel.snapshotSequence ?? null,
    updatedAt: readModel.updatedAt ?? null,
    projects,
    threads,
    archivedThreads,
    pendingWork,
    activeTurns,
    staleTurnThreadIds,
    stalledTurns,
    counts: {
      projects: projects.length,
      threads: threads.length,
      archivedThreads: archivedThreads.length,
      pendingApprovals: pendingWork.filter((entry) => entry.approvals).length,
      pendingUserInput: pendingWork.filter((entry) => entry.userInput).length,
      activeTurns: activeTurns.length,
      staleTurns: staleTurnThreadIds.length,
      stalledTurns: stalledTurns.length,
      // A ready status with an explicit turn id is an active turn, not a free session.
      readySessions: liveThreads.filter((thread, index) => !inProgressSet.has(threads[index]) && (thread.orchestrationProtocol === V2_PROTOCOL
        ? thread.session?.sourceStatus === "idle" : thread.session?.status === "ready")).length,
      interruptedSessions: liveThreads.filter((thread) => thread.orchestrationProtocol === V2_PROTOCOL
        ? thread.session?.sourceStatus === "interrupted" : thread.session?.status === "interrupted").length,
    },
  };
}

// ── Dispatch + verify ───────────────────────────────────────────────────────

async function getThreadIfProjected(client, threadId) {
  try { return await client.thread(threadId); }
  catch (error) { if (error instanceof T3HttpError && error.status === 404) return null; throw error; }
}

// Archived threads are absent from T3's active detail endpoint. Read their
// exact shell identity instead of treating a 404 as proof of termination.
async function readLifecycleThread(client, threadId) {
  const detail = await getThreadIfProjected(client, threadId);
  const active = unwrapThreadDetail(detail);
  if (active) {
    if (active.id !== threadId) throw new Error("T3 lifecycle projection identity mismatch");
    return active;
  }
  const archived = await client.archivedShell();
  const thread = recordArray(archived?.threads).find((entry) => entry.id === threadId);
  if (!thread) throw new Error(`T3 lifecycle thread ${threadId} is not projected`);
  return thread;
}

async function waitForLifecycle(client, threadId, predicate, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const thread = await readLifecycleThread(client, threadId);
    if (predicate(thread)) return thread;
    if (Date.now() >= deadline) break;
    await delay(intervalMs);
  } while (true);
  throw new Error(`T3 did not verify session termination for thread ${threadId}`);
}

const sessionEnded = (thread) => thread.orchestrationProtocol === V2_PROTOCOL
  ? thread.lifecycleWorkPending === false && thread.session?.activeTurnId == null
  : thread.session == null || (thread.session.status === "stopped" && thread.session.activeTurnId == null);

// Older T3 releases acknowledge stops for archived threads without acting.
// Temporarily expose only this thread to the supported session-stop command,
// then restore its archive state. Never terminate a process by PID or pattern.
async function stopLifecycleSession(client, command, options) {
  const before = await readBeforeDispatch(command, () => readLifecycleThread(client, command.threadId));
  const archived = before.archivedAt != null;
  if (sessionEnded(before)) return before;
  let unarchived = false;
  let primaryError = null;
  try {
    if (archived) {
      await client.dispatch(threadUnarchive({ threadId: command.threadId, commandId: `unarchive-for-stop:${command.commandId}` }));
      unarchived = true;
      await waitForLifecycle(client, command.threadId, (thread) => thread.archivedAt == null, options);
    }
    await client.dispatch(threadSessionStop({ threadId: command.threadId, commandId: `verified-stop:${command.commandId}` }));
    await waitForLifecycle(client, command.threadId, sessionEnded, options);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (unarchived) {
      try {
        if ((await readLifecycleThread(client, command.threadId)).archivedAt == null) {
          await client.dispatch(threadArchive({ threadId: command.threadId, commandId: `restore-archive:${command.commandId}` }));
          await waitForLifecycle(client, command.threadId, (thread) => thread.archivedAt != null, options);
        }
      } catch (error) {
        // Cleanup has its own evidence and must never replace the Stop receipt.
        // Only static identifiers are exposed, never projection/error bodies.
        const failure = { phase: "restore-archive", commandId: `restore-archive:${command.commandId}`, status: error.receipt?.status ?? "unconfirmed" };
        if (primaryError) primaryError.restorationFailures = [...(primaryError.restorationFailures ?? []), failure];
        else {
          const uncertain = new IntentDispatchError(command.commandId, "unconfirmed");
          uncertain.restorationFailures = [failure];
          throw uncertain;
        }
      }
    }
  }
  return await readLifecycleThread(client, command.threadId);
}

export async function inspectLeakedSessions(client) {
  try {
    if (typeof client.archivedShell !== "function") return { status: "unavailable", count: null, threads: [] };
    const archived = await client.archivedShell();
    if (!Array.isArray(archived?.threads)) return { status: "unavailable", count: null, threads: [] };
    const threads = archived.threads.filter((thread) => thread.deletedAt == null && !sessionEnded(thread))
      .map((thread) => ({ threadId: thread.id, sessionStatus: thread.session?.status ?? null }));
    return { status: threads.length ? "leaked" : "clear", count: threads.length, threads };
  } catch {
    return { status: "unavailable", count: null, threads: [] };
  }
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

async function waitForRestartableSession(client, threadId, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await getThreadIfProjected(client, threadId);
    const status = detail?.thread?.session?.status ?? null;
    // T3 may retain a failed provider session as `error` after acknowledging
    // thread.session.stop. That state has no active turn and is safe to replace
    // with the next turn; requiring a synthetic `stopped` projection makes a
    // fail-closed thread impossible to continue.
    if (detail && (status === null || status === "stopped" || status === "error")) return detail;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for T3 projection: restartable session in thread ${threadId}`);
}

export async function waitForTurnOutcome(client, threadId, messageId, {
  baselineSession,
  timeoutMs = 15_000,
  intervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await getThreadIfProjected(client, threadId);
    const thread = detail?.thread;
    const messages = recordArray(thread?.messages);
    const messageIndex = messages.findIndex((message) => message.id === messageId);
    if (messageIndex >= 0) {
      const session = isRecord(thread?.session) ? thread.session : null;
      if (session?.status === "error") {
        const error = new Error(`T3 thread ${threadId} entered error: ${session.lastError ?? "Unknown provider session error"}`);
        // Typed before the text leaves: receipts carry the code, never this message.
        error.failure = classifyFailure({ sessionStatus: "error", error: typeof session.lastError === "string" ? session.lastError : null });
        throw error;
      }
      const assistantProjected = messages
        .slice(messageIndex + 1)
        .some((message) => message.role === "assistant");
      const activeSessionAdvanced = session !== null
        && session.status === "running"
        && (
          baselineSession == null
          || session.status !== baselineSession.status
          || session.activeTurnId !== baselineSession.activeTurnId
          || session.updatedAt !== baselineSession.updatedAt
        );
      if (assistantProjected || activeSessionAdvanced) return detail;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for T3 turn outcome: message ${messageId} in thread ${threadId} never reached a live session or assistant response`);
}

export async function waitForProjectProjection(client, projectId, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readOrchestrationSnapshot(client);
    const project = recordArray(isRecord(snapshot) ? snapshot.projects : []).find((entry) => entry.id === projectId);
    if (project) return project;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for T3 projection: project ${projectId}`);
}

export class IntentDispatchError extends Error {
  constructor(commandId, status, authError) {
    super(status === "rejected" ? "T3 rejected the command" : "T3 command acceptance is unconfirmed; retry with the same commandId");
    this.name = "IntentDispatchError";
    if (authError instanceof T3AuthError) this.message = authError.message;
    // The adapter's own refusal is safe to show; T3 reply bodies are not.
    if (authError instanceof T3V2UnsupportedError) this.message = authError.message;
    // KRA-8958: non-auth receipts carry a typed code; the auth code is kept as is.
    this.receipt = { accepted: false, commandId, status, projected: false, ...(authError instanceof T3AuthError ? { code: authError.code, action: authError.action } : classifyFailure({ error: authError })) };
  }
}

async function readBeforeDispatch(command, read) {
  try { return await read(); }
  catch (error) {
    if (error instanceof T3V2UnsupportedError) throw new IntentDispatchError(command.commandId, "rejected", error);
    throw error;
  }
}

async function dispatchWithReceipt(client, command) {
  let result;
  try { result = await client.dispatch(command); }
  catch (error) {
    const refused = (error instanceof T3HttpError && error.status >= 400 && error.status < 500)
      || error instanceof T3RpcRejectedError || error instanceof T3V2UnsupportedError;
    throw new IntentDispatchError(command.commandId, refused ? "rejected" : "unconfirmed", error);
  }
  if (result?.accepted === false) throw new IntentDispatchError(command.commandId, "rejected");
  return result;
}

// Apply one intent: build the command, dispatch it, project it back, and
// return evidence an orchestrator can record. `wait` toggles projection
// verification (off for fire-and-forget lifecycle commands).
async function applyIntentWithReceipt(client, intent, { wait = true, commandId, createdAt, timeoutMs, intervalMs, receiptState } = {}) {
  const dispatchClient = client;
  client = Object.create(client);
  client.dispatch = async (command) => {
    receiptState.lastCommandId = command.commandId;
    receiptState.attempted = true;
    const result = await dispatchWithReceipt(dispatchClient, command);
    receiptState.accepted.add(command.commandId);
    return result;
  };
  let command;
  const receiptId = commandId ?? intent?.commandId ?? randomUUID();
  let protocol;
  try { protocol = typeof dispatchClient.protocol === "function" ? await dispatchClient.protocol() : null; }
  catch (error) { throw new IntentDispatchError(receiptId, "rejected", error); }
  if (protocol === V2_PROTOCOL) {
    try {
      requireKnownIntentFields(intent);
      command = buildCommandFromIntent(intent, { commandId: receiptId, createdAt });
    } catch (error) {
      throw new IntentDispatchError(receiptId, "rejected", error);
    }
  } else command = buildCommandFromIntent(intent, { commandId, createdAt });
  let baseline = null;
  let restartCommand = null;
  let restartDispatchResult = null;
  if (command.type === "thread.turn.start") {
    baseline = await readBeforeDispatch(command, () => getThreadIfProjected(client, command.threadId));
    const sessionStatus = baseline?.thread?.session?.status ?? null;
    const shouldRestart = intent.action === "thread.restart"
      || (intent.action === "thread.continue" && sessionStatus === "error");
    // An omitted selection continues on the retained lab/model; validate and
    // pin its effort before anything (including a restart stop) dispatches.
    if (command.modelSelection === undefined) {
      try {
        if (!baseline) {
          // Almost always a routing miss: the thread lives on another computer's T3.
          const target = typeof client.baseUrl === "string" ? ` on ${client.baseUrl}` : "";
          throw new Error(`T3 thread ${command.threadId} is not projected${target}; its retained model selection is unproven. Wrong computer? Pass --computer <name> for a thread on another host; thread ids must be full UUIDs`);
        }
        const pinned = retainedSelectionPin(baseline.thread?.modelSelection);
        if (pinned !== undefined) command.modelSelection = pinned;
      } catch (error) {
        if (protocol === V2_PROTOCOL) throw new IntentDispatchError(command.commandId, "rejected", error);
        throw error;
      }
    }
    if (shouldRestart && sessionStatus !== null && sessionStatus !== "stopped") {
      restartCommand = threadSessionStop({
        threadId: command.threadId,
        commandId: `restart:${command.commandId}`,
        createdAt: command.createdAt,
      });
      restartDispatchResult = await client.dispatch(restartCommand);
      baseline = await waitForRestartableSession(client, command.threadId, { timeoutMs, intervalMs });
    }
  }
  const baselineSession = isRecord(baseline?.thread?.session)
    ? { ...baseline.thread.session }
    : null;
  const lifecycle = command.type === "thread.session.stop" || command.type === "thread.archive";
  let lifecycleBefore = null;
  if (lifecycle) {
    // Stop before archive so T3's active-only stop lookup can still find it.
    lifecycleBefore = await stopLifecycleSession(client, command, { timeoutMs, intervalMs });
  }
  const dispatchResult = command.type === "thread.archive" && lifecycleBefore?.archivedAt != null
    ? { alreadyArchived: true }
    : await client.dispatch(command);
  const waitOptions = { timeoutMs, intervalMs };
  let projection = null;
  if (lifecycle) {
    let thread = await waitForLifecycle(client, command.threadId,
      (entry) => command.type !== "thread.archive" || entry.archivedAt != null, waitOptions);
    if (!sessionEnded(thread)) {
      await stopLifecycleSession(client, { ...command, commandId: `recovery:${command.commandId}` }, waitOptions);
      thread = await waitForLifecycle(client, command.threadId, sessionEnded, waitOptions);
    }
    projection = { thread };
  } else if (wait && command.type === "thread.turn.start") {
    projection = await waitForTurnOutcome(client, command.threadId, command.message.messageId, {
      ...waitOptions,
      baselineSession,
    });
  } else if (wait && command.type === "thread.create") {
    projection = await waitForThreadProjection(client, command.threadId, waitOptions);
  } else if (wait && command.type === "project.create") {
    // Projects live in the shell snapshot; a projectId is not a thread-detail id.
    projection = await waitForProjectProjection(client, command.projectId, waitOptions);
  }
  return {
    action: intent.action,
    commandId: command.commandId,
    dispatchResult,
    accepted: true,
    status: "accepted",
    executionStatus: projection !== null ? "verified" : "unverified",
    ...(restartCommand !== null ? {
      restartCommandId: restartCommand.commandId,
      restartDispatchResult,
    } : {}),
    threadId: command.threadId ?? intent.threadId ?? null,
    projectId: command.projectId ?? intent.projectId ?? null,
    projected: projection !== null,
    ...(projection?.thread?.session ? {
      sessionStatus: projection.thread.session.status ?? null,
      activeTurnId: projection.thread.session.activeTurnId ?? null,
      lastError: projection.thread.session.lastError ?? null,
    } : {}),
  };
}

export async function applyIntent(client, intent, options = {}) {
  const callerCommandId = options.commandId ?? intent?.commandId ?? randomUUID();
  const receiptState = { attempted: false, accepted: new Set(), lastCommandId: null };
  try {
    return await applyIntentWithReceipt(client, intent, { ...options, commandId: callerCommandId, receiptState });
  } catch (error) {
    // Preserve existing diagnostics/classes as well as adding correlation to
    // validation, projection and verification errors outside dispatch itself.
    const receiptError = error instanceof Error ? error : new Error("T3 operation failed");
    if (!receiptError.receipt) {
      receiptError.receipt = {
        accepted: false, commandId: receiptState.lastCommandId ?? callerCommandId,
        status: receiptState.attempted ? "unconfirmed" : "rejected", projected: false,
        ...classifyFailure({ error: receiptError }),
      };
    }
    if (receiptError.receipt.status === "rejected" && receiptState.accepted.has(callerCommandId)) {
      // A recovery/prerequisite refusal cannot undo the caller's acceptance.
      receiptError.receipt = { ...receiptError.receipt, status: "unconfirmed", internalStatus: "rejected" };
    }
    if (receiptError.receipt.commandId !== callerCommandId) {
      receiptError.receipt = { ...receiptError.receipt, internalCommandId: receiptError.receipt.commandId, commandId: callerCommandId };
    }
    if (receiptError.receipt.status === "unconfirmed" && receiptState.accepted.size > 0) {
      receiptError.receipt = { ...receiptError.receipt,
        accepted: receiptState.accepted.has(callerCommandId) ? true : null,
        executionStatus: "unverified" };
    }
    throw receiptError;
  }
}

// Apply a bounded list of intents in order, stopping at the first failure.
export async function applyIntents(client, intents, { wait = true, maxIntents = 100 } = {}) {
  if (!Array.isArray(intents)) throw new Error("Intents must be an array");
  if (intents.length > maxIntents) throw new Error(`Refusing to apply more than ${maxIntents} intents`);
  const results = [];
  for (const intent of intents) {
    try { results.push(await applyIntent(client, intent, { wait })); }
    catch (error) {
      if (error?.receipt) error.results = results;
      throw error;
    }
  }
  return results;
}
