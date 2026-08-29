import { randomUUID } from "node:crypto";
import { readPrivateToken } from "./config.mjs";
import { readBoundedResponseText } from "./t3-client.mjs";

export const TOOL_AUDIT_SCHEMA = "com.verduona.tentacles.tool_action.v1";
export const TOOL_AUDIT_EVENT_TYPE = "com.verduona.tentacles.tool_action";

const CONFIG_KEYS = [
  "TENTACLES_AUDIT_MATRIX_URL",
  "TENTACLES_AUDIT_MATRIX_ROOM_ID",
  "TENTACLES_AUDIT_MATRIX_TOKEN_FILE",
  "TENTACLES_AUDIT_ACTOR_ID",
];

function requireIdentifier(value, label, { maxBytes = 256 } = {}) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes
    || !/^[A-Za-z0-9._:@/-]+$/.test(value)) {
    throw new Error(`${label} must be a non-empty, bounded identifier`);
  }
  return value;
}

function requireToken(value) {
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f\u007f]{16,16384}$/.test(value)) {
    throw new Error("Matrix audit token has an invalid format");
  }
  return value;
}

function requireMatrixOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("TENTACLES_AUDIT_MATRIX_URL must use https");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TENTACLES_AUDIT_MATRIX_URL must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function requireRoomId(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 512 || !/^![^:\s/]+:[^\s/]+$/.test(value)) {
    throw new Error("TENTACLES_AUDIT_MATRIX_ROOM_ID must be a bounded Matrix room id");
  }
  return value;
}

function auditRecord({ actorId, correlationId, toolName, phase, outcome, recordedAt }) {
  return Object.freeze({
    schema: TOOL_AUDIT_SCHEMA,
    correlation_id: requireIdentifier(correlationId, "commandId"),
    actor_id: requireIdentifier(actorId, "audit actor id"),
    service_name: "Tentacles",
    tool_name: requireIdentifier(toolName, "command type"),
    phase,
    outcome,
    recorded_at: recordedAt,
  });
}

export class MatrixToolAuditEmitter {
  constructor({ matrixUrl, roomId, token, actorId, fetchImpl = globalThis.fetch, now = () => new Date().toISOString(), requestTimeoutMs = 10_000 } = {}) {
    this.matrixUrl = requireMatrixOrigin(matrixUrl);
    this.roomId = requireRoomId(roomId);
    this.token = requireToken(token);
    this.actorId = requireIdentifier(actorId, "audit actor id");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async before(command) {
    return await this.#emit(command, "before", "attempted");
  }

  async after(command, outcome) {
    if (outcome !== "succeeded" && outcome !== "failed") throw new Error("Audit outcome must be succeeded or failed");
    return await this.#emit(command, "after", outcome);
  }

  async #emit(command, phase, outcome) {
    const content = auditRecord({
      actorId: this.actorId,
      correlationId: command?.commandId,
      toolName: command?.type,
      phase,
      outcome,
      recordedAt: this.now(),
    });
    const transactionId = randomUUID();
    const pathname = `/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/send/${encodeURIComponent(TOOL_AUDIT_EVENT_TYPE)}/${transactionId}`;
    const response = await this.fetchImpl(`${this.matrixUrl}${pathname}`, {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(content),
    });
    const responseText = await readBoundedResponseText(response, 64 * 1024, "Matrix audit response");
    if (!response.ok) throw new Error(`Matrix audit write failed (${response.status})`);
    let result;
    try { result = JSON.parse(responseText); }
    catch { throw new Error("Matrix audit write returned an invalid response"); }
    if (typeof result?.event_id !== "string" || result.event_id.length === 0) {
      throw new Error("Matrix audit write returned no event id");
    }
    return { eventId: result.event_id, content };
  }
}

export function matrixToolAuditEmitterFromEnv(env = process.env, overrides = {}) {
  const present = CONFIG_KEYS.filter((key) => typeof env[key] === "string" && env[key].length > 0);
  if (present.length === 0) return null;
  if (present.length !== CONFIG_KEYS.length) {
    throw new Error(`Tentacles tool audit configuration is incomplete; require ${CONFIG_KEYS.join(", ")}`);
  }
  return new MatrixToolAuditEmitter({
    matrixUrl: env.TENTACLES_AUDIT_MATRIX_URL,
    roomId: env.TENTACLES_AUDIT_MATRIX_ROOM_ID,
    token: readPrivateToken(env.TENTACLES_AUDIT_MATRIX_TOKEN_FILE, "Matrix audit token"),
    actorId: env.TENTACLES_AUDIT_ACTOR_ID,
    ...overrides,
  });
}
