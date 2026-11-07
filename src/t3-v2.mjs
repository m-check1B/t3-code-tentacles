import { createHash } from "node:crypto";
import { validateNestedRecords } from "./t3-v2-validation.mjs";

// T3 Orchestrator V2 (T3 >= v0.1.0, orchestrationProtocolVersion 2) adapter (KRA-6436).
// Tentacles keeps building its V1 command shapes; this module translates them
// into V2 commands and maps V2 projections back into the V1 thread shape the
// rest of Tentacles reads. Every translation is closed: a field or command this
// adapter does not know is refused before anything is dispatched.

export const V2_PROTOCOL = 2;
export const V2_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

// A definitive T3 RPC failure reply: the command was refused, never applied.
export class T3RpcRejectedError extends Error {
  constructor(tag, detail, { unknownTag = false } = {}) {
    super(`T3 RPC ${tag} failed: ${detail}`);
    this.name = "T3RpcRejectedError";
    this.tag = tag;
    // KRA-10175/10176: the server does not know this RPC at all, so it never
    // decoded or applied the request. Only this exact defect sets the flag.
    this.unknownTag = unknownTag === true;
  }
}

/** True when an RPC failure exit is upstream's "Unknown request tag: <tag>" defect. */
export function isUnknownTagExit(exit, tag) {
  if (exit?._tag !== "Failure") return false;
  const causes = Array.isArray(exit.cause) ? exit.cause : [exit.cause];
  const expected = `Unknown request tag: ${tag}`;
  return causes.length > 0 && causes.every((cause) => cause?._tag === "Die" && cause.defect === expected);
}

export const isUnknownTagError = (error, tag) => error instanceof T3RpcRejectedError && error.unknownTag === true && error.tag === tag;

// Patched T3 v2 (jack/upstream-0.1.0) carries runtime mode atomically on its
// own message RPC. Upstream T3 >= 0.1.8 removed that tag; it takes
// message.dispatch through orchestration.dispatchCommand.
export const PATCHED_MESSAGE_METHOD = "orchestration.dispatchMessageWithMode";
export const UPSTREAM_MESSAGE_METHOD = "orchestration.dispatchCommand";

/**
 * Patched message step -> upstream message.dispatch step. Upstream has no
 * atomic runtimeMode on the message (the preceding thread.runtime-mode.set step
 * and the client's pre-send projection check stay), and names the fresh flag
 * `freshContext`. A fresh turn is refused unless the server advertises
 * `environment.capabilities.freshContext`: older servers ignore the field.
 */
export function upstreamMessageStep(step, { freshContext = false } = {}) {
  if (step?.method !== PATCHED_MESSAGE_METHOD || step.payload?.type !== "message.dispatch")
    throw new T3V2UnsupportedError("T3 V2 adapter can convert only its message step");
  const { runtimeMode, freshProviderContext, ...rest } = step.payload;
  void runtimeMode;
  if (freshProviderContext === true && freshContext !== true)
    throw new T3V2UnsupportedError("This T3 server does not advertise freshContext; refusing a fresh-context turn");
  return { method: UPSTREAM_MESSAGE_METHOD, payload: { ...rest, ...(freshProviderContext === true ? { freshContext: true } : {}) } };
}

export class T3V2UnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = "T3V2UnsupportedError";
    this.code = "t3_v2_unsupported";
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireKnownFields(command, allowed, label = command.type) {
  for (const key of Object.keys(command)) {
    if (!allowed.has(key)) throw new T3V2UnsupportedError(`T3 V2 adapter refuses unknown ${label} field: ${key}`);
  }
}

// V1 field sets Tentacles emits per command type; `createdAt` is V1-only and dropped.
const SIMPLE = ["type", "commandId", "threadId", "createdAt"];
const FIELDS = {
  "project.create": ["type", "commandId", "projectId", "title", "workspaceRoot", "defaultModelSelection", "createWorkspaceRootIfMissing", "createdAt"],
  "project.meta.update": ["type", "commandId", "projectId", "title", "workspaceRoot", "defaultModelSelection", "scripts"],
  "project.delete": ["type", "commandId", "projectId", "force"],
  "thread.create": ["type", "commandId", "threadId", "projectId", "title", "modelSelection", "runtimeMode", "interactionMode", "branch", "worktreePath", "createdAt"],
  "thread.turn.start": ["type", "commandId", "threadId", "message", "modelSelection", "titleSeed", "freshProviderContext", "runtimeMode", "interactionMode", "createdAt"],
  "thread.turn.interrupt": [...SIMPLE, "turnId"],
  "thread.approval.respond": [...SIMPLE, "requestId", "decision"],
  "thread.user-input.respond": [...SIMPLE, "requestId", "answers"],
  "thread.session.stop": SIMPLE,
  "thread.meta.update": ["type", "commandId", "threadId", "title", "modelSelection"],
  "thread.runtime-mode.set": [...SIMPLE, "runtimeMode"],
  "thread.interaction-mode.set": [...SIMPLE, "interactionMode"],
  "thread.archive": SIMPLE,
  "thread.unarchive": SIMPLE,
  "thread.delete": SIMPLE,
  "thread.pin": SIMPLE,
  "thread.unpin": SIMPLE,
  "thread.settle": SIMPLE,
  "thread.unsettle": [...SIMPLE, "reason"],
  "thread.snooze": [...SIMPLE, "snoozedUntil"],
  "thread.unsnooze": [...SIMPLE, "reason"],
};
const ALLOWED = Object.fromEntries(Object.entries(FIELDS).map(([type, keys]) => [type, new Set(keys)]));
const MESSAGE_FIELDS = new Set(["messageId", "role", "text", "attachments"]);
// T3 records Tentacles-originated work as user work from a non-UI client.
const CREATION = { createdBy: "user", creationSource: "mcp" };
const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const dispatchStep = (payload) => ({ method: "orchestration.dispatchCommand", payload });
const projectStep = (payload) => ({ method: "projects.mutate", payload });
const pick = (source, keys) => Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));

/**
 * Translate one V1 command into ordered V2 steps ({ method, payload }).
 * `readProjection(threadId)` is used only when V2 needs an id V1 did not carry
 * (the active run for an interrupt). Returns [] for a proven no-op.
 */
export async function translateCommand(command, { readProjection } = {}) {
  if (!isRecord(command) || typeof command.type !== "string") throw new T3V2UnsupportedError("T3 V2 adapter requires a typed command");
  const allowed = Object.hasOwn(ALLOWED, command.type) ? ALLOWED[command.type] : undefined;
  if (!allowed) throw new T3V2UnsupportedError(`T3 V2 adapter does not support ${command.type}`);
  requireKnownFields(command, allowed);
  validateNestedRecords(command, (message) => { throw new T3V2UnsupportedError(message); });
  const { commandId, threadId } = command;
  switch (command.type) {
    case "project.create":
      return [projectStep({ ...pick(command, ["type", "commandId", "projectId", "title", "workspaceRoot", "createWorkspaceRootIfMissing"]), defaultModelSelection: command.defaultModelSelection ?? null })];
    case "project.meta.update":
      return [projectStep({ type: "project.update", ...pick(command, ["commandId", "projectId", "title", "workspaceRoot", "defaultModelSelection", "scripts"]) })];
    case "project.delete":
      return [projectStep(pick(command, ["type", "commandId", "projectId", "force"]))];
    case "thread.create":
      return [dispatchStep({ ...pick(command, ["type", "commandId", "threadId", "projectId", "title", "modelSelection", "runtimeMode"]), ...CREATION, interactionMode: command.interactionMode ?? "default", branch: command.branch ?? null, worktreePath: command.worktreePath ?? null })];
    case "thread.turn.start": {
      if (Object.hasOwn(command, "freshProviderContext") && command.freshProviderContext !== true)
        throw new T3V2UnsupportedError("freshProviderContext must be true when dispatched");
      if (!isEnum(command.runtimeMode, RUNTIME_MODES))
        throw new T3V2UnsupportedError("T3 V2 turn requires a supported runtime mode prerequisite");
      const message = command.message;
      if (!isRecord(message)) throw new T3V2UnsupportedError("T3 V2 adapter requires a turn message");
      requireKnownFields(message, MESSAGE_FIELDS, "turn message");
      if (message.role !== "user") throw new T3V2UnsupportedError("T3 V2 adapter dispatches only user messages");
      const steps = [];
      // Preserve prerequisite IDs for retries. The message's own atomic mode
      // field is authoritative; this historical receipt is never mode proof.
      if (command.runtimeMode !== undefined) {
        steps.push(dispatchStep({ type: "thread.runtime-mode.set", commandId: `${commandId}:runtime-mode`, threadId, runtimeMode: command.runtimeMode }));
      }
      if (command.interactionMode !== undefined && command.interactionMode !== "default") {
        steps.push(dispatchStep({ type: "thread.interaction-mode.set", commandId: `${commandId}:interaction-mode`, threadId, interactionMode: command.interactionMode }));
      }
      steps.push(dispatchStep({
        type: "message.dispatch",
        runtimeMode: command.runtimeMode,
        commandId,
        ...CREATION,
        threadId,
        messageId: message.messageId,
        text: message.text ?? "",
        attachments: message.attachments ?? [],
        ...pick(command, ["modelSelection", "titleSeed", "freshProviderContext"]),
        // The server resolves steer/queue against its own serialized thread state.
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
      }));
      steps.at(-1).method = PATCHED_MESSAGE_METHOD;
      return steps;
    }
    case "thread.session.stop": {
      if (typeof readProjection !== "function") throw new T3V2UnsupportedError("T3 V2 stop needs a projection read");
      const projection = await readProjection(threadId);
      validatedRuns(projection);
      validateBackgroundWork(projection);
      // Native V2 Stop covers terminal-run background work, queue holds,
      // delegated wakes and PR monitors; run.interrupt alone cannot do that.
      return [dispatchStep({ type: "thread.stop", commandId, threadId })];
    }
    case "thread.turn.interrupt": {
      let runId = command.turnId;
      if (runId === undefined) {
        if (typeof readProjection !== "function") throw new T3V2UnsupportedError("T3 V2 interrupt needs a projection read");
        runId = validatedRuns(await readProjection(threadId)).filter((run) => ACTIVE_RUN.has(run.status) && run.status !== "queued").at(-1)?.id;
        if (runId === undefined) return [];
      }
      return [dispatchStep({ type: "run.interrupt", commandId, threadId, runId })];
    }
    case "thread.approval.respond":
      return [dispatchStep({ type: "runtime-request.respond", commandId, threadId, requestId: command.requestId, decision: command.decision })];
    case "thread.user-input.respond":
      return [dispatchStep({ type: "runtime-request.respond", commandId, threadId, requestId: command.requestId, answers: command.answers ?? {} })];
    case "thread.meta.update": {
      const steps = [];
      if (command.title !== undefined) steps.push(dispatchStep({ type: "thread.metadata.update", commandId, threadId, title: command.title }));
      if (command.modelSelection !== undefined) {
        steps.push(dispatchStep({ type: "thread.model-selection.set", commandId: steps.length ? `${commandId}:model-selection` : commandId, threadId, modelSelection: command.modelSelection }));
      }
      if (!steps.length) throw new T3V2UnsupportedError("T3 V2 adapter refuses an empty thread.meta.update");
      return steps;
    }
    default:
      // Same name and fields in V2, minus V1's createdAt.
      return [dispatchStep(pick(command, [...allowed].filter((key) => key !== "createdAt")))];
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

// Preserve the last run outcome. Lifecycle termination is separately proved
// from active runs, queue holds and pending background work.
const SESSION_STATUS = {
  idle: "stopped",
  preparing: "starting",
  queued: "starting",
  starting: "starting",
  running: "running",
  waiting: "running",
  completed: "stopped",
  interrupted: "stopped",
  cancelled: "stopped",
  rolled_back: "stopped",
  failed: "error",
};
const RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const SHELL_STATUSES = new Set(["idle", ...RUN_STATUSES]);

function validatedRuns(projection) {
  if (!isRecord(projection) || (projection.runs !== undefined && !Array.isArray(projection.runs)))
    throw new T3V2UnsupportedError("T3 V2 runs projection is not supported");
  const runs = [...(projection.runs ?? [])];
  for (const run of runs) {
    if (!isRecord(run) || !isEnum(run.status, RUN_STATUSES))
      throw new T3V2UnsupportedError("T3 V2 adapter does not know run status");
  }
  return runs.sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
}

// Contract enum boundary (T3 stable v0.1.0 orchestrationV2/providerPolicy/
// threadPullRequest). Unknown discriminants must not hide work either.
const TURN_ITEM_TYPES = new Set(["notification", "user_message", "assistant_message", "reasoning", "proposed_plan", "todo_list", "user_input_request", "file_change", "command_execution", "file_search", "web_search", "approval_request", "checkpoint", "run_interrupt_request", "run_interrupt_result", "system_notice", "error", "compaction", "handoff", "fork", "thread_created", "subagent", "dynamic_tool", "secret_request"]);
const REQUEST_KINDS = new Set(["command", "file-read", "file-change", "mcp-elicitation", "permission", "dynamic_tool_call", "user_input", "auth_refresh"]);
const PR_SOURCES = new Set(["manual", "created", "agent", "stack", "stack-dismissed"]);
const REQUEST_STATUSES = new Set(["pending", "resolved", "expired", "cancelled"]);
const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const INTERACTION_MODES = new Set(["default", "plan"]);
const MESSAGE_ROLES = new Set(["user", "assistant", "system"]);

function isEnum(value, known) {
  return typeof value === "string" && known.has(value);
}

function requireEnum(value, known, label) {
  if (!isEnum(value, known)) throw new T3V2UnsupportedError(`T3 V2 adapter does not know ${label}`);
}

function validateThreadEnums(thread) {
  // Missing optional summary metadata is preserved as null, never stop proof.
  if (thread.runtimeMode != null) requireEnum(thread.runtimeMode, RUNTIME_MODES, "runtime mode");
  if (thread.interactionMode != null) requireEnum(thread.interactionMode, INTERACTION_MODES, "interaction mode");
  if (thread.pullRequests !== undefined && !Array.isArray(thread.pullRequests))
    throw new T3V2UnsupportedError("T3 V2 pull-request projection is not supported");
  for (const pr of thread.pullRequests ?? []) requireEnum(pr?.source, PR_SOURCES, "pull-request source");
}

function validateBackgroundWork(projection) {
  if (projection.thread) validateThreadEnums(projection.thread);
  const knownWorkStatuses = new Set(["idle", "pending", "running", "waiting", "completed", "failed", "cancelled", "interrupted"]);
  const workTypes = new Set(["command_execution", "dynamic_tool", "subagent"]);
  for (const key of ["turnItems", "subagents", "providerThreads", "runtimeRequests"]) {
    if (projection[key] !== undefined && !Array.isArray(projection[key]))
      throw new T3V2UnsupportedError("T3 V2 background-work projection is not supported");
  }
  // Validate before any short circuit or persistent/rollback exemption can
  // turn an unknown state into evidence that the thread has stopped.
  for (const item of projection.turnItems ?? []) {
    requireEnum(item?.type, TURN_ITEM_TYPES, "turn-item type");
    if (!isRecord(item) || (workTypes.has(item.type) && !isEnum(item.status, knownWorkStatuses)))
      throw new T3V2UnsupportedError("T3 V2 adapter does not know background-work status");
  }
  for (const agent of projection.subagents ?? []) {
    if (!isRecord(agent) || !isEnum(agent.status, knownWorkStatuses))
      throw new T3V2UnsupportedError("T3 V2 adapter does not know subagent status");
  }
  const providerStatuses = new Set(["not_loaded", "idle", "active", "archived", "closed", "error"]);
  for (const provider of projection.providerThreads ?? []) {
    if (!isRecord(provider) || !isEnum(provider.status, providerStatuses))
      throw new T3V2UnsupportedError("T3 V2 adapter does not know provider-thread status");
    if (!isRecord(provider) || (provider.pendingBackgroundTasks !== undefined && !Array.isArray(provider.pendingBackgroundTasks)))
      throw new T3V2UnsupportedError("T3 V2 background-task projection is not supported");
  }
  for (const request of projection.runtimeRequests ?? []) {
    requireEnum(request?.kind, REQUEST_KINDS, "runtime-request kind");
    if (!isRecord(request) || !isEnum(request.status, REQUEST_STATUSES))
      throw new T3V2UnsupportedError("T3 V2 adapter does not know runtime-request status");
  }
  if (projection.thread?.pendingBackgroundTasks !== undefined && !Array.isArray(projection.thread.pendingBackgroundTasks))
    throw new T3V2UnsupportedError("T3 V2 background-task projection is not supported");
}

function hasPendingWork(projection, runs) {
  const workActive = (status) => ["pending", "running", "waiting"].includes(status);
  const rolledBack = new Set(runs.filter((run) => run.status === "rolled_back").map((run) => run.id));
  return runs.some((run) => ACTIVE_RUN.has(run.status) && !(run.status === "queued" && run.queueHeld === true))
    || (projection.turnItems ?? []).some((item) =>
      ["command_execution", "dynamic_tool", "subagent"].includes(item.type) && workActive(item.status)
      && !(item.type === "dynamic_tool" && item.input?.persistent === true) && !rolledBack.has(item.runId))
    || (projection.providerThreads ?? []).some((provider) => (provider.pendingBackgroundTasks ?? []).length > 0)
    || (projection.thread?.pendingBackgroundTasks ?? []).length > 0
    || (projection.subagents ?? []).some((agent) => workActive(agent.status))
    || (projection.runtimeRequests ?? []).some((request) => request.status === "pending")
    || (projection.thread?.pullRequests ?? []).some((pr) => pr.watch !== undefined && pr.source !== "stack-dismissed");
}

function sessionStatus(status) {
  requireEnum(status, SHELL_STATUSES, "thread status");
  return SESSION_STATUS[status];
}

function v1Thread(thread, { status, activeRunId, lastError, pendingKinds, updatedAt }) {
  return {
    orchestrationProtocol: V2_PROTOCOL,
    lifecycleWorkPending: ACTIVE_RUN.has(status) || (thread.pendingBackgroundTasks ?? []).length > 0,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection ?? null,
    runtimeMode: thread.runtimeMode ?? null,
    interactionMode: thread.interactionMode ?? null,
    // KRA-9781: the continue guard targets worktreePath when set, as on protocol 1.
    branch: typeof thread.branch === "string" && thread.branch !== "" ? thread.branch : null,
    worktreePath: typeof thread.worktreePath === "string" && thread.worktreePath !== "" ? thread.worktreePath : null,
    archivedAt: thread.archivedAt ?? null,
    settledAt: thread.settledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    deletedAt: thread.deletedAt ?? null,
    updatedAt: updatedAt ?? thread.updatedAt ?? null,
    session: {
      status: sessionStatus(status),
      // Retain the validated native status for observation counters: V1 maps
      // both V2 idle and interrupted to stopped for lifecycle compatibility.
      sourceStatus: status,
      activeTurnId: activeRunId ?? null,
      providerName: thread.providerInstanceId ?? thread.modelSelection?.instanceId ?? null,
      providerInstanceId: thread.providerInstanceId ?? thread.modelSelection?.instanceId ?? null,
      runtimeMode: thread.runtimeMode ?? null,
      lastError: lastError ?? null,
      updatedAt: updatedAt ?? thread.updatedAt ?? null,
    },
    hasPendingApprovals: pendingKinds.some((kind) => kind !== "user_input"),
    hasPendingUserInput: pendingKinds.includes("user_input"),
  };
}

/** V2 shell thread -> V1 thread summary. */
export function shellThreadToV1(thread) {
  if (!isRecord(thread) || typeof thread.id !== "string") throw new T3V2UnsupportedError("T3 V2 shell thread has no id");
  validateThreadEnums(thread);
  if (thread.pendingRuntimeRequest != null) requireEnum(thread.pendingRuntimeRequest.kind, REQUEST_KINDS, "runtime-request kind");
  return v1Thread(thread, {
    status: thread.status,
    activeRunId: thread.activeRunId,
    lastError: thread.lastError,
    pendingKinds: thread.pendingRuntimeRequest ? [thread.pendingRuntimeRequest.kind] : [],
  });
}

/** V2 shell snapshot -> V1 read model ({ projects, threads, snapshotSequence }). */
export function shellToV1(shell) {
  if (!isRecord(shell) || shell.schemaVersion !== 2) throw new T3V2UnsupportedError(`T3 V2 shell schemaVersion ${shell?.schemaVersion} is not supported`);
  return {
    snapshotSequence: shell.snapshotSequence ?? null,
    updatedAt: null,
    projects: Array.isArray(shell.projects) ? shell.projects : [],
    threads: (shell.threads ?? []).map(shellThreadToV1),
  };
}

/** V2 archived shell -> V1 archived shell; V2 omits archivedAt on some rows, so mark them. */
export function archivedShellToV1(shell) {
  if (!isRecord(shell) || shell.schemaVersion !== 2) throw new T3V2UnsupportedError(`T3 V2 archived shell schemaVersion ${shell?.schemaVersion} is not supported`);
  const threads = (Array.isArray(shell?.threads) ? shell.threads : []).map((thread) => {
    const mapped = shellThreadToV1(thread);
    return { ...mapped, archivedAt: mapped.archivedAt ?? mapped.updatedAt ?? "archived" };
  });
  return { ...shell, threads };
}

/** V2 thread detail ({ snapshotSequence, projection }) -> V1 detail ({ thread }). */
export function threadDetailToV1(detail, threadId) {
  const projection = detail?.projection;
  const thread = projection?.thread;
  if (!isRecord(thread) || thread.id !== threadId) throw new T3V2UnsupportedError(`T3 V2 thread ${threadId} projection identity mismatch`);
  const runs = validatedRuns(projection);
  validateBackgroundWork(projection);
  const latest = runs.at(-1);
  const active = runs.filter((run) => ACTIVE_RUN.has(run.status) && !(run.status === "queued" && run.queueHeld === true)).at(-1);
  const failure = latest?.status === "failed"
    ? (projection.turnItems ?? []).filter((item) => item.runId === latest.id && item.type === "error").at(-1)
    : undefined;
  const pendingKinds = (projection.runtimeRequests ?? []).filter((request) => request.status === "pending").map((request) => request.kind);
  const summary = v1Thread(thread, {
    status: active?.status ?? latest?.status ?? "idle",
    activeRunId: active?.id,
    lastError: latest?.status === "failed" ? (failure?.failure?.message || "provider-error") : null,
    pendingKinds,
    updatedAt: projection.updatedAt,
  });
  for (const message of projection.messages ?? []) requireEnum(message?.role, MESSAGE_ROLES, "message role");
  const messages = (projection.messages ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      streaming: message.streaming,
      turnId: message.runId ?? null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    }));
  return {
    snapshotSequence: detail.snapshotSequence ?? null,
    thread: {
      ...summary,
      orchestrationProtocol: V2_PROTOCOL,
      lifecycleWorkPending: hasPendingWork(projection, runs),
      messages,
      activities: [],
      latestTurn: latest ? { turnId: latest.id, state: latest.status, requestedAt: latest.requestedAt, completedAt: latest.completedAt ?? null } : null,
    },
  };
}

// ── Native turn result (upstream T3 v2, no patched turn-result route) ──────

const RUN_RESULT_STATE = { completed: "succeeded", failed: "failed", cancelled: "cancelled", interrupted: "cancelled", rolled_back: "cancelled" };
const EFFORT_OPTION_IDS = new Set(["reasoningEffort", "effort"]);
const SAFE_RESULT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// Upstream provider message ids can carry percent-escapes and exceed 128
// characters (Antigravity, 7 Nov 2026). The turn-result contract allows only
// safe ids, so an unsafe one is replaced by a stable digest of itself: the same
// T3 message always yields the same id, which keeps journal linking exact.
export function safeResultId(id) {
  if (typeof id !== "string" || id === "") return null;
  return SAFE_RESULT_ID.test(id) ? id : `t3v2-sha256:${createHash("sha256").update(id).digest("hex")}`;
}

/**
 * KRA-10175: derive the talkTurnResult/v1 record from a V2 thread detail.
 * The join is exact: the client-generated messageId names the run
 * (run.userMessageId) and the output is that run's last settled assistant
 * message. There is no fallback to the latest run or thread state. Upstream
 * does not keep the command id on the run, so turnCommandId is echoed from the
 * caller's persisted receipt, never inferred.
 */
export function nativeTurnResult(detail, { threadId, messageId, turnCommandId }) {
  const projection = detail?.projection;
  if (!isRecord(projection?.thread) || projection.thread.id !== threadId) throw new T3V2UnsupportedError(`T3 V2 thread ${threadId} projection identity mismatch`);
  const runs = validatedRuns(projection);
  const messages = Array.isArray(projection.messages) ? projection.messages : [];
  const matches = runs.filter((run) => run.userMessageId === messageId);
  if (matches.length > 1) throw new T3V2UnsupportedError("T3 V2 message is joined to more than one run");
  const run = matches[0];
  const base = { threadId, messageId, turnCommandId };
  const empty = { turnId: null, assistantMessageId: null, instanceId: null, model: null, effort: null, outputText: null };
  if (!run) return { ...base, ...empty, state: "pending" };
  const userRow = messages.find((message) => message?.id === messageId);
  if (userRow && (userRow.role !== "user" || (userRow.runId != null && userRow.runId !== run.id)))
    throw new T3V2UnsupportedError("T3 V2 message and run disagree");
  const selection = isRecord(run.modelSelection) ? run.modelSelection : {};
  const effortOption = Array.isArray(selection.options) ? selection.options.find((option) => EFFORT_OPTION_IDS.has(option?.id)) : undefined;
  const effort = typeof effortOption?.value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(effortOption.value) ? effortOption.value : null;
  const identity = {
    // Run ids ("run:thread:<uuid>:ordinal:<n>") stay verbatim: interrupt matches them against the session.
    turnId: typeof run.id === "string" ? run.id : null,
    instanceId: typeof run.providerInstanceId === "string" ? run.providerInstanceId : (typeof selection.instanceId === "string" ? selection.instanceId : null),
    model: typeof selection.model === "string" ? selection.model : null,
    effort,
  };
  const fresh = run.freshContext === true ? { freshProviderContext: true, nativeContextGeneration: turnCommandId } : {};
  let state = RUN_RESULT_STATE[run.status] ?? "pending";
  const assistant = messages.filter((message) => message?.role === "assistant" && message.runId === run.id && message.streaming !== true && typeof message.text === "string").at(-1);
  if (state === "succeeded" && !assistant) {
    return { ...base, ...identity, assistantMessageId: null, outputText: null, state: "failed", error: "assistant output missing", ...fresh };
  }
  if (state === "succeeded") return { ...base, ...identity, assistantMessageId: safeResultId(assistant.id), outputText: assistant.text, state, ...fresh };
  const failure = state === "failed"
    ? (Array.isArray(projection.turnItems) ? projection.turnItems : []).filter((item) => item?.runId === run.id && item.type === "error").at(-1)
    : undefined;
  return {
    ...base, ...identity, assistantMessageId: null, outputText: null, state,
    ...(typeof failure?.failure?.message === "string" ? { error: failure.failure.message } : {}),
    ...(state === "pending" ? {} : fresh),
  };
}
