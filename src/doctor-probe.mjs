// Opt-in doctor "responds" probe (KRA-9857). Doctor readiness never proves a
// model answers: on 30 Oct a ready codex lab accepted every turn and never sent
// a model event. This runs one bounded no-tools turn per selected lab through
// the normal originate path and reports only whether and when a model answered.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ensureProject, originate } from "./bridge.mjs";
import { DEFAULT_STATE_DIR } from "./config.mjs";
import { classifyFailure } from "./failure-codes.mjs";
import { createThreadLock, TurnInterrupter } from "./turn-interrupt.mjs";

export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_PROBE_WORKSPACE = path.join(DEFAULT_STATE_DIR, "doctor-probe");
const PROBE_MESSAGE = "Reply with the single word OK. Do not use any tools.";
const NO_RESPONSE_ACTION = "model accepts requests but never answers; check the CLI's sign-in and quota, or pass --model with a model that answers";

async function probeLab(client, lab, { workspace, timeoutMs, intervalMs, interrupter }) {
  const started = Date.now();
  const row = { instanceId: lab.instanceId, model: lab.defaultModel ?? null };
  if (!lab.ready) return { ...row, status: "error", firstEventMs: null, code: "lab_not_ready" };
  if (!lab.defaultModel) return { ...row, status: "error", firstEventMs: null, code: "model_required" };
  let turn;
  try {
    turn = await originate(client, {
      workspace,
      title: `Tentacles doctor probe: ${lab.instanceId}`,
      message: PROBE_MESSAGE,
      instanceId: lab.instanceId,
      model: lab.defaultModel,
      runtimeMode: "full-access",
    });
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const thread = (await client.thread(turn.threadId))?.thread;
      const messages = Array.isArray(thread?.messages) ? thread.messages : [];
      const index = messages.findIndex((message) => message?.id === turn.messageId);
      // Only the role is read; message text never leaves T3.
      if (index >= 0 && messages.slice(index + 1).some((message) => message?.role === "assistant")) {
        return { ...row, threadId: turn.threadId, status: "responds", firstEventMs: Date.now() - started };
      }
      if (thread?.session?.status === "error") {
        const { code } = classifyFailure({ sessionStatus: "error", error: typeof thread.session.lastError === "string" ? thread.session.lastError : null });
        return { ...row, threadId: turn.threadId, status: "error", firstEventMs: null, code };
      }
      await delay(intervalMs);
    }
  } catch (error) {
    return { ...row, ...(turn ? { threadId: turn.threadId } : {}), status: "error", firstEventMs: null, code: classifyFailure({ error }).code };
  }
  const { status: interrupt } = await interrupter.interrupt({
    requestId: `doctor-probe:${randomUUID()}`,
    threadId: turn.threadId,
    messageId: turn.messageId,
    turnCommandId: turn.turnCommandId,
    reason: "user_stop",
  });
  return { ...row, threadId: turn.threadId, status: "no_response", firstEventMs: null, interrupt, action: NO_RESPONSE_ACTION };
}

export async function probeResponds(client, labs, {
  select = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  intervalMs = 500,
  workspace = DEFAULT_PROBE_WORKSPACE,
  interruptOptions = {},
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Responds probe timeout must be a positive integer");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
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
  if (selected.some((lab) => lab.ready && lab.defaultModel)) await ensureProject(client, { workspace, title: "Tentacles doctor probe" });
  return {
    timeoutMs,
    labs: await Promise.all(selected.map((lab) => probeLab(client, lab, { workspace, timeoutMs, intervalMs, interrupter }))),
  };
}
