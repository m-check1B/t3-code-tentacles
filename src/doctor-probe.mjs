// Opt-in doctor "responds" probe (KRA-9857). Doctor readiness never proves a
// model answers: on 30 Oct a ready codex lab accepted every turn and never sent
// a model event. This runs one bounded no-tools turn per selected lab through
// the normal originate path and reports only whether and when a model answered.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ensureProject, originate } from "./bridge.mjs";
import { DEFAULT_STATE_DIR, ensurePrivateDirectory } from "./config.mjs";
import { classifyFailure } from "./failure-codes.mjs";
import { T3HttpError } from "./t3-client.mjs";
import { createThreadLock, TurnInterrupter } from "./turn-interrupt.mjs";

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_PROBE_WORKSPACE = path.join(DEFAULT_STATE_DIR, "doctor-probe");
const PROBE_MESSAGE = "Reply with the single word OK. Do not use any tools.";
const NO_RESPONSE_ACTION = "model accepts requests but never answers; check the CLI's sign-in and quota, or pass --model with a model that answers";
const NO_MODEL_ACTION = "the lab reports no default model to probe; set one in T3";

/** CLI flags -> probe request, or null when --responds is absent. Runs before doctor. */
export function respondsRequest(options, computerName) {
  if (options.responds === undefined) {
    if (options["responds-timeout"] !== undefined) throw new Error("--responds-timeout needs --responds");
    return null;
  }
  // The probe workspace is a local path; it does not exist on another computer.
  if (computerName) throw new Error("--responds runs against the local T3 only");
  const select = options.responds === "all" ? null : options.responds.split(",").map((id) => id.trim()).filter(Boolean);
  if (select?.length === 0) throw new Error("--responds needs all or a lab list");
  const seconds = Number(options["responds-timeout"] ?? 60);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error("--responds-timeout must be an integer between 1 and 600 seconds");
  return { select, timeoutMs: seconds * 1000 };
}

// A T3 fault is not a provider outcome: report T3's HTTP status, never its body.
function failureFields(error) {
  if (error instanceof T3HttpError) return { t3HttpStatus: error.status, action: `T3 answered HTTP ${error.status}; check T3 and rerun doctor --responds` };
  return { code: classifyFailure({ error }).code };
}

function privateProbeWorkspace(workspace) {
  const refuseLink = () => {
    let info;
    try { info = fs.lstatSync(workspace); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Doctor probe workspace must be a real directory, not a symlink");
  };
  refuseLink();
  ensurePrivateDirectory(workspace);
  refuseLink();
}

async function probeLab(client, lab, { workspace, timeoutMs, intervalMs, interrupter }) {
  const started = Date.now();
  const row = { instanceId: lab.instanceId, model: lab.defaultModel ?? null };
  if (!lab.ready) return { ...row, status: "error", firstEventMs: null, code: "lab_not_ready" };
  // lab_not_ready, not a new code: a lab with no model cannot take a turn, and the code set is a shared contract.
  if (!lab.defaultModel) return { ...row, status: "error", firstEventMs: null, code: "lab_not_ready", action: NO_MODEL_ACTION };
  let turn;
  let outcome;
  try {
    turn = await originate(client, {
      workspace,
      title: `Tentacles doctor probe: ${lab.instanceId}`,
      message: PROBE_MESSAGE,
      instanceId: lab.instanceId,
      model: lab.defaultModel,
      // Same mode as real turns, so the probe proves what they will see; "no tools"
      // rests on the fixed prompt in an empty private workspace (B3 PR 69 P3-8).
      runtimeMode: "full-access",
    });
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const thread = (await client.thread(turn.threadId))?.thread;
      const messages = Array.isArray(thread?.messages) ? thread.messages : [];
      const index = messages.findIndex((message) => message?.id === turn.messageId);
      // Only message roles and session status are read; message text never leaves T3.
      if (index >= 0 && messages.slice(index + 1).some((message) => message?.role === "assistant")) {
        return { ...row, threadId: turn.threadId, status: "responds", firstEventMs: Date.now() - started };
      }
      if (thread?.session?.status === "error") {
        const { code } = classifyFailure({ sessionStatus: "error", error: typeof thread.session.lastError === "string" ? thread.session.lastError : null });
        return { ...row, threadId: turn.threadId, status: "error", firstEventMs: null, code };
      }
      await delay(intervalMs);
    }
    outcome = { status: "no_response", firstEventMs: null, action: NO_RESPONSE_ACTION };
  } catch (error) {
    outcome = { status: "error", firstEventMs: null, ...failureFields(error) };
    if (!turn) return { ...row, ...outcome };
  }
  const { status: interrupt } = await interrupter.interrupt({
    requestId: `doctor-probe:${randomUUID()}`,
    threadId: turn.threadId,
    messageId: turn.messageId,
    turnCommandId: turn.turnCommandId,
    reason: "user_stop",
  });
  // Without the turn-result route (or on any other refusal) nothing was interrupted.
  const action = interrupt === "cancelled" || interrupt === "already_terminal"
    ? outcome.action
    : [outcome.action, `probe turn may still be running; stop thread ${turn.threadId} in T3`].filter(Boolean).join("; ");
  return { ...row, threadId: turn.threadId, ...outcome, interrupt, ...(action ? { action } : {}) };
}

export async function probeResponds(client, labs, {
  select = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  intervalMs = 500,
  workspace = DEFAULT_PROBE_WORKSPACE,
  interruptOptions = {},
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Responds probe timeout must be a positive integer");
  privateProbeWorkspace(workspace);
  const interrupter = new TurnInterrupter({
    readTurnResult: (tuple) => client.request("/api/orchestration/turn-result", { method: "POST", body: tuple }),
    readThread: (threadId) => client.thread(threadId),
    dispatch: (command) => client.dispatch(command),
    withThreadLock: createThreadLock(),
    ...interruptOptions,
  });
  const selected = select
    ? select.map((id) => labs.find((lab) => lab.instanceId === id) ?? { instanceId: id, ready: false })
    : labs.filter((lab) => lab.ready);
  // One project up front: parallel originates into a new workspace would each create one.
  const first = selected.find((lab) => lab.ready && lab.defaultModel);
  if (first) {
    try {
      await ensureProject(client, { workspace, title: "Tentacles doctor probe", instanceId: first.instanceId, model: first.defaultModel });
    } catch (error) {
      const failed = failureFields(error);
      return {
        timeoutMs,
        labs: await Promise.all(selected.map((lab) => (lab.ready && lab.defaultModel
          ? { instanceId: lab.instanceId, model: lab.defaultModel, status: "error", firstEventMs: null, ...failed }
          : probeLab(client, lab, { workspace, timeoutMs, intervalMs, interrupter })))),
      };
    }
  }
  return {
    timeoutMs,
    labs: await Promise.all(selected.map((lab) => probeLab(client, lab, { workspace, timeoutMs, intervalMs, interrupter }))),
  };
}
