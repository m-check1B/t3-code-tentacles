// T3 Orchestrator V2 (T3 >= v0.1.0, orchestrationProtocolVersion 2) adapter (KRA-6436).
// Tentacles keeps building its V1 command shapes; this module translates them
// into V2 commands and maps V2 projections back into the V1 thread shape the
// rest of Tentacles reads. Every translation is closed: a field or command this
// adapter does not know is refused before anything is dispatched.

export const V2_PROTOCOL = 2;
export const V2_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

// A definitive T3 RPC failure reply: the command was refused, never applied.
export class T3RpcRejectedError extends Error {
  constructor(tag, detail) {
    super(`T3 RPC ${tag} failed: ${detail}`);
    this.name = "T3RpcRejectedError";
  }
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
  "thread.turn.start": ["type", "commandId", "threadId", "message", "modelSelection", "titleSeed", "runtimeMode", "interactionMode", "createdAt"],
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
  const allowed = ALLOWED[command.type];
  if (!allowed) throw new T3V2UnsupportedError(`T3 V2 adapter does not support ${command.type}`);
  requireKnownFields(command, allowed);
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
      const message = command.message;
      if (!isRecord(message)) throw new T3V2UnsupportedError("T3 V2 adapter requires a turn message");
      requireKnownFields(message, MESSAGE_FIELDS, "turn message");
      if (message.role !== "user") throw new T3V2UnsupportedError("T3 V2 adapter dispatches only user messages");
      const steps = [];
      // V2 message.dispatch carries no runtime mode; pin it on the thread first so
      // the full-access invariant still holds for every continue.
      if (command.runtimeMode !== undefined) {
        steps.push(dispatchStep({ type: "thread.runtime-mode.set", commandId: `${commandId}:runtime-mode`, threadId, runtimeMode: command.runtimeMode }));
      }
      if (command.interactionMode !== undefined && command.interactionMode !== "default") {
        steps.push(dispatchStep({ type: "thread.interaction-mode.set", commandId: `${commandId}:interaction-mode`, threadId, interactionMode: command.interactionMode }));
      }
      steps.push(dispatchStep({
        type: "message.dispatch",
        commandId,
        ...CREATION,
        threadId,
        messageId: message.messageId,
        text: message.text ?? "",
        attachments: message.attachments ?? [],
        ...pick(command, ["modelSelection", "titleSeed"]),
        // The server resolves steer/queue against its own serialized thread state.
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
      }));
      return steps;
    }
    case "thread.turn.interrupt":
    case "thread.session.stop": {
      // V2 has no client thread.stop; the T3 web client stops by interrupting
      // the active run and holding the queue. No active run: nothing to stop.
      const stop = command.type === "thread.session.stop";
      let runId = stop ? undefined : command.turnId;
      if (runId === undefined) {
        if (typeof readProjection !== "function") throw new T3V2UnsupportedError("T3 V2 interrupt needs a projection read");
        const projection = await readProjection(threadId);
        runId = (projection?.runs ?? []).filter((run) => ACTIVE_RUN.has(run.status)).at(-1)?.id;
        if (runId === undefined) return [];
      }
      return [dispatchStep({ type: "run.interrupt", commandId, threadId, runId, ...(stop ? { holdQueue: true } : {}) })];
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

// A V2 thread without an active run has no live provider turn to stop, which
// is what V1 callers mean by a "stopped" session.
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

function sessionStatus(status) {
  const mapped = SESSION_STATUS[status];
  if (!mapped) throw new T3V2UnsupportedError(`T3 V2 adapter does not know thread status ${status}`);
  return mapped;
}

function v1Thread(thread, { status, activeRunId, lastError, pendingKinds, updatedAt }) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection ?? null,
    runtimeMode: thread.runtimeMode ?? null,
    interactionMode: thread.interactionMode ?? null,
    archivedAt: thread.archivedAt ?? null,
    settledAt: thread.settledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    deletedAt: thread.deletedAt ?? null,
    updatedAt: updatedAt ?? thread.updatedAt ?? null,
    session: {
      status: sessionStatus(status),
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
  const runs = [...(projection.runs ?? [])].sort((left, right) => left.ordinal - right.ordinal);
  const latest = runs.at(-1);
  const active = runs.filter((run) => ACTIVE_RUN.has(run.status)).at(-1);
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
      messages,
      activities: [],
      latestTurn: latest ? { turnId: latest.id, state: latest.status, requestedAt: latest.requestedAt, completedAt: latest.completedAt ?? null } : null,
    },
  };
}
