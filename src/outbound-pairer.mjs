import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { continueThread, doctor, originate } from "./bridge.mjs";
import { observe } from "./orchestrate.mjs";
import { readBoundedWebSocketData } from "./t3-client.mjs";
import {
  acquirePairStateLock,
  DEFAULT_PAIR_STATE_FILE,
  writePairPresence,
} from "./pair-state.mjs";

export const PAIR_PROTOCOL_VERSION = 1;
export const SPHERE_PRODUCT_ID = "agentjack-desktop";
export const SPHERE_ABILITY = "desktop.use";
export const REMOTE_RPC_METHODS = Object.freeze(["seats", "originate", "continue", "doctor-status"]);

const offerSecrets = new WeakMap();
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TIMER_MS = 2_147_483_647;
const ORIGINATE_PARAM_KEYS = new Set([
  "workspace", "title", "message", "instanceId", "model", "options", "budget", "runtimeMode", "idempotencyKey",
]);
const CONTINUE_PARAM_KEYS = new Set([
  "threadId", "message", "instanceId", "model", "options", "budget", "runtimeMode", "turnCommandId", "messageId",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
  return value;
}

function requireMachineId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new Error("--machine-id must be a 1-256 character Sphere machine_id");
  }
  return value;
}

function requireRelayEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "wss:") throw new Error("Pair relay endpoint must use wss");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Pair relay endpoint must not contain credentials, query, or fragment");
  }
  return endpoint.toString();
}

function readOwnerOnlyFile(file, maxBytes) {
  const linkStat = fs.lstatSync(file);
  if (linkStat.isSymbolicLink()) throw new Error("Pair offer must not be a symlink");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Pair offer must be a regular file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Pair offer must be owned by the current user");
    }
    if ((stat.mode & 0o077) !== 0) throw new Error("Pair offer must have mode 0600");
    if (stat.size < 1 || stat.size > maxBytes) throw new Error(`Pair offer must be between 1 and ${maxBytes} bytes`);
    return {
      text: fs.readFileSync(descriptor, "utf8"),
      identity: { dev: stat.dev, ino: stat.ino },
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPairOffer(file, { now = Date.now() } = {}) {
  const { text, identity } = readOwnerOnlyFile(file, 64 * 1024);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Pair offer is not valid JSON"); }
  requireRecord(parsed, "Pair offer");
  if (parsed.version !== PAIR_PROTOCOL_VERSION) throw new Error("Unsupported pair offer version");
  const endpoint = requireRelayEndpoint(parsed.endpoint);
  if (typeof parsed.pairToken !== "string" || !/^[^\s\u0000-\u001f\u007f]{16,16384}$/.test(parsed.pairToken)) {
    throw new Error("Pair offer contains an invalid pair token");
  }
  const expiresAtMs = Date.parse(parsed.expiresAt);
  if (typeof parsed.expiresAt !== "string" || !Number.isFinite(expiresAtMs)
    || new Date(expiresAtMs).toISOString() !== parsed.expiresAt) {
    throw new Error("Pair offer expiresAt must be a canonical ISO timestamp");
  }
  const offer = Object.freeze({
    version: PAIR_PROTOCOL_VERSION,
    endpoint,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expired: expiresAtMs <= now,
    sourceFile: file,
    sourceIdentity: identity,
  });
  offerSecrets.set(offer, parsed.pairToken);
  return offer;
}

function consumePairOffer(offer) {
  const current = fs.lstatSync(offer.sourceFile);
  if (current.isSymbolicLink() || !current.isFile()
    || current.dev !== offer.sourceIdentity.dev || current.ino !== offer.sourceIdentity.ino) {
    throw new Error("Pair offer changed before one-shot consumption");
  }
  fs.unlinkSync(offer.sourceFile);
}

function fullAccessParams(params, label, allowedKeys) {
  const input = requireRecord(params ?? {}, `${label} params`);
  const unknown = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`${label} does not accept remote parameter ${unknown}`);
  if (input.runtimeMode !== undefined && input.runtimeMode !== "full-access") {
    throw new Error(`${label} requires runtimeMode full-access`);
  }
  return { ...input, runtimeMode: "full-access" };
}

function pairedThreadReportStatus(thread) {
  const session = isRecord(thread.session) ? thread.session : {};
  const settled = typeof thread.settledAt === "string" && thread.settledAt.length > 0;
  if (settled) return "Done";
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) return "blocked";
  if (session.status === "starting" || session.status === "running") return "generating";
  if (session.status === "error"
    || (session.lastError !== null && session.lastError !== undefined && session.lastError !== "")) return "blocked";
  if ([undefined, null, "ready", "idle", "stopped"].includes(session.status)) return "ready/idle";
  return "blocked";
}

function remoteSeatsProjection(observed) {
  requireRecord(observed, "Observed Tentacles state");
  const activeTurns = Array.isArray(observed.activeTurns)
    ? observed.activeTurns
      .filter(isRecord)
      .map((turn) => ({
        ...(typeof turn.threadId === "string" ? { threadId: turn.threadId } : {}),
        ...(typeof turn.providerInstanceId === "string" ? { providerInstanceId: turn.providerInstanceId } : {}),
      }))
    : [];
  const threads = Array.isArray(observed.threads)
    ? observed.threads
      .filter(isRecord)
      .map((thread) => ({
        ...(typeof thread.id === "string" ? { id: thread.id } : {}),
        ...(typeof thread.projectId === "string" ? { projectId: thread.projectId } : {}),
        report: { status: pairedThreadReportStatus(thread) },
      }))
    : [];
  return { activeTurns, threads };
}

export class LoopbackRuntimeAdapter {
  constructor({
    client,
    pairStateFile = DEFAULT_PAIR_STATE_FILE,
    observeImpl = observe,
    originateImpl = originate,
    continueImpl = continueThread,
    doctorImpl = doctor,
  }) {
    if (!client) throw new Error("Loopback runtime requires a T3 client");
    this.client = client;
    this.pairStateFile = pairStateFile;
    this.observeImpl = observeImpl;
    this.originateImpl = originateImpl;
    this.continueImpl = continueImpl;
    this.doctorImpl = doctorImpl;
  }

  async seats() {
    return remoteSeatsProjection(await this.observeImpl(this.client));
  }

  originate(params) {
    return this.originateImpl(this.client, fullAccessParams(params, "originate", ORIGINATE_PARAM_KEYS));
  }

  continue(params) {
    return this.continueImpl(this.client, fullAccessParams(params, "continue", CONTINUE_PARAM_KEYS));
  }

  doctorStatus() {
    return this.doctorImpl(this.client, { pairStateFile: this.pairStateFile });
  }
}

function unavailable(id) {
  return {
    version: PAIR_PROTOCOL_VERSION,
    type: "rpc.error",
    id,
    error: { code: "computer.unavailable", message: "Computer unavailable", data: null },
  };
}

export class RemoteRpcShim {
  constructor(runtime) {
    if (!runtime) throw new Error("Remote RPC shim requires a runtime");
    this.runtime = runtime;
  }

  async handle(message) {
    let id = null;
    try {
      requireRecord(message, "RPC request");
      if (message.version !== PAIR_PROTOCOL_VERSION || message.type !== "rpc.request") throw new Error("Invalid RPC envelope");
      id = requireSafeId(message.id, "RPC request id");
      if (!REMOTE_RPC_METHODS.includes(message.method)) throw new Error("Unsupported RPC method");
      const params = message.params === undefined ? {} : requireRecord(message.params, "RPC params");
      const method = message.method === "doctor-status" ? "doctorStatus" : message.method;
      if (typeof this.runtime[method] !== "function") throw new Error("Runtime method is unavailable");
      const result = await this.runtime[method](params);
      return { version: PAIR_PROTOCOL_VERSION, type: "rpc.result", id, result: result ?? null };
    } catch {
      return unavailable(id);
    }
  }
}

function encodeBounded(message, maxBytes) {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("Pair relay response exceeds the frame bound");
  return encoded;
}

export function reconnectDelayMs(attempt, {
  baseMs = 500,
  capMs = 30_000,
  random = Math.random,
} = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error("Reconnect attempt must be a non-negative integer");
  if (!Number.isInteger(baseMs) || baseMs < 1 || baseMs > 60_000) throw new Error("Reconnect base must be between 1ms and 60000ms");
  if (!Number.isInteger(capMs) || capMs < baseMs || capMs > 60_000) throw new Error("Reconnect cap must be between the base and 60000ms");
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error("Reconnect jitter source must return a value in [0, 1)");
  const ceiling = Math.min(capMs, baseMs * (2 ** Math.min(attempt, 30)));
  const floor = Math.ceil(ceiling / 2);
  return Math.min(capMs, floor + Math.floor(sample * (ceiling - floor + 1)));
}

function waitForReconnect(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class OutboundPairer {
  constructor({
    runtime,
    WebSocketImpl = globalThis.WebSocket,
    pairStateFile = DEFAULT_PAIR_STATE_FILE,
    handshakeTimeoutMs = 15_000,
    maxFrameBytes = 1024 * 1024,
    leaseMs = 30_000,
    heartbeatTimeoutMs = leaseMs,
    reconnectBaseMs = 500,
    reconnectCapMs = 30_000,
    random = Math.random,
    now = Date.now,
    onEvent = () => {},
  }) {
    if (typeof WebSocketImpl !== "function") throw new Error("This Node.js runtime does not provide WebSocket support");
    if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1_000 || handshakeTimeoutMs > 60_000) {
      throw new Error("Pair handshake timeout must be between 1000ms and 60000ms");
    }
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 4 * 1024 * 1024) {
      throw new Error("Pair frame bound must be between 1024 and 4194304 bytes");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new Error("Pair lease must be between 1000ms and 300000ms");
    }
    if (!Number.isInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1_000 || heartbeatTimeoutMs > 300_000) {
      throw new Error("Pair heartbeat timeout must be between 1000ms and 300000ms");
    }
    reconnectDelayMs(0, { baseMs: reconnectBaseMs, capMs: reconnectCapMs, random: () => 0 });
    if (typeof random !== "function") throw new Error("Reconnect jitter source must be a function");
    this.shim = new RemoteRpcShim(runtime);
    this.WebSocketImpl = WebSocketImpl;
    this.pairStateFile = pairStateFile;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.leaseMs = leaseMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectCapMs = reconnectCapMs;
    this.random = random;
    this.now = now;
    this.onEvent = onEvent;
  }

  emit(event) {
    try { this.onEvent(event); return true; } catch { return false; }
  }

  async run({ pairFile, machineId, signal } = {}) {
    const offer = readPairOffer(pairFile, { now: this.now() });
    machineId = requireMachineId(machineId);
    const releasePairState = acquirePairStateLock(this.pairStateFile);
    if (!releasePairState) throw new Error("Another outbound pairer already owns this pair state");
    let pairStateReleased = false;
    const releasePairStateOnce = () => {
      if (pairStateReleased) return;
      pairStateReleased = true;
      releasePairState();
    };
    if (offer.expired) {
      try {
        writePairPresence("expired", {
          file: this.pairStateFile,
          now: this.now(),
          staleReason: "authorization_expired",
        });
        this.emit({ event: "pair.expired", status: "expired" });
      } finally {
        offerSecrets.delete(offer);
        releasePairStateOnce();
      }
      throw new Error("Pair offer has expired");
    }
    const seenRpcIds = new Set();
    const rpcIdWindow = [];
    const inFlightRpcIds = new Set();
    let offerConsumed = false;
    let everBound = false;
    let reconnectAttempt = 0;
    const consumeOfferOnce = () => {
      if (offerConsumed) return;
      consumePairOffer(offer);
      offerConsumed = true;
    };
    try {
      writePairPresence("unpaired", {
        file: this.pairStateFile,
        now: this.now(),
        staleReason: "relay_connecting",
      });
      while (true) {
        if (signal?.aborted) {
          writePairPresence("unpaired", {
            file: this.pairStateFile,
            now: this.now(),
            staleReason: "stopped",
          });
          this.emit({ event: "pair.unpaired", status: "unpaired", staleReason: "stopped" });
          return { status: "unpaired" };
        }
        if (!everBound && Date.parse(offer.expiresAt) <= this.now()) {
          writePairPresence("expired", {
            file: this.pairStateFile,
            now: this.now(),
            staleReason: "authorization_expired",
          });
          this.emit({ event: "pair.expired", status: "expired", staleReason: "authorization_expired" });
          throw new Error("Pair authorization expired");
        }
        this.emit({
          event: everBound ? "pair.reannouncing" : "pair.connecting",
          status: "unpaired",
          attempt: reconnectAttempt + 1,
        });
        const outcome = await this.connectOnce({
          offer,
          machineId,
          signal,
          seenRpcIds,
          rpcIdWindow,
          inFlightRpcIds,
          consumeOfferOnce,
          reconnected: everBound,
        });
        if (outcome.kind === "stopped") {
          writePairPresence("unpaired", {
            file: this.pairStateFile,
            now: this.now(),
            staleReason: "stopped",
          });
          this.emit({ event: "pair.unpaired", status: "unpaired", staleReason: "stopped" });
          return { status: "unpaired" };
        }
        if (outcome.kind === "fatal") throw outcome.error;
        if (outcome.kind === "authorization") {
          writePairPresence(outcome.status, {
            file: this.pairStateFile,
            now: this.now(),
            staleReason: outcome.staleReason,
          });
          this.emit({
            event: `pair.${outcome.status}`,
            status: outcome.status,
            staleReason: outcome.staleReason,
          });
          throw new Error(outcome.message);
        }
        if (outcome.bound) {
          everBound = true;
          reconnectAttempt = 0;
        }
        writePairPresence("unpaired", {
          file: this.pairStateFile,
          now: this.now(),
          staleReason: outcome.staleReason,
        });
        this.emit({ event: "pair.stale", status: "unpaired", staleReason: outcome.staleReason });
        const delayMs = reconnectDelayMs(reconnectAttempt, {
          baseMs: this.reconnectBaseMs,
          capMs: this.reconnectCapMs,
          random: this.random,
        });
        reconnectAttempt += 1;
        this.emit({
          event: "pair.reconnecting",
          status: "unpaired",
          staleReason: outcome.staleReason,
          attempt: reconnectAttempt,
          delayMs,
        });
        if (!await waitForReconnect(delayMs, signal)) continue;
      }
    } finally {
      offerSecrets.delete(offer);
      releasePairStateOnce();
    }
  }

  async connectOnce({
    offer,
    machineId,
    signal,
    seenRpcIds,
    rpcIdWindow,
    inFlightRpcIds,
    consumeOfferOnce,
    reconnected,
  }) {
    let socket;
    try {
      socket = new this.WebSocketImpl(offer.endpoint);
    } catch {
      return { kind: "transient", bound: false, staleReason: "relay_connection_error" };
    }
    const bindRequestId = randomUUID();
    let bound = false;
    let settled = false;
    let handshakeTimer;
    let heartbeatTimer;
    let offerExpiryTimer;
    let messageQueue = Promise.resolve();

    return await new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(handshakeTimer);
        clearTimeout(heartbeatTimer);
        clearTimeout(offerExpiryTimer);
        signal?.removeEventListener("abort", abort);
      };
      const closeSocket = () => { try { socket.close(); } catch {} };
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        cleanup();
        closeSocket();
        resolve({ ...outcome, bound });
      };
      const transient = (staleReason) => finish({ kind: "transient", staleReason });
      const protocolFailure = () => transient("relay_protocol_error");
      const authorizationFailure = (status, staleReason, message) => finish({
        kind: "authorization",
        status,
        staleReason,
        message,
      });
      const send = (message) => socket.send(encodeBounded(message, this.maxFrameBytes));
      const refreshPresence = () => {
        writePairPresence("paired", {
          file: this.pairStateFile,
          now: this.now(),
          leaseMs: this.leaseMs,
        });
        clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(
          () => transient("relay_heartbeat_timeout"),
          this.heartbeatTimeoutMs,
        );
      };
      const abort = () => finish({ kind: "stopped" });
      handshakeTimer = setTimeout(
        () => transient("relay_handshake_timeout"),
        this.handshakeTimeoutMs,
      );
      const offerRemainingMs = Date.parse(offer.expiresAt) - this.now();
      if (!reconnected && offerRemainingMs <= MAX_TIMER_MS) {
        offerExpiryTimer = setTimeout(
          () => authorizationFailure("expired", "authorization_expired", "Pair authorization expired"),
          Math.max(0, offerRemainingMs),
        );
      }
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }

      socket.addEventListener("open", () => {
        if (settled) return;
        const pairToken = offerSecrets.get(offer);
        if (!pairToken) {
          finish({ kind: "fatal", error: new Error("Pair credential is unavailable") });
          return;
        }
        try {
          send({
            version: PAIR_PROTOCOL_VERSION,
            type: "pair.bind",
            requestId: bindRequestId,
            pairToken,
            host: {
              machineId,
              productId: SPHERE_PRODUCT_ID,
              ability: SPHERE_ABILITY,
              runtime: "tentacles",
              rpc: [...REMOTE_RPC_METHODS],
            },
          });
        } catch {
          transient("relay_connection_error");
        }
      });

      socket.addEventListener("message", (event) => {
        messageQueue = messageQueue.then(async () => {
          if (settled) return;
          const raw = await readBoundedWebSocketData(event.data, this.maxFrameBytes, "Pair relay frame");
          if (settled) return;
          let message;
          try { message = JSON.parse(raw); } catch { throw new Error("Invalid pair relay JSON"); }
          requireRecord(message, "Pair relay message");
          if (message.version !== PAIR_PROTOCOL_VERSION) throw new Error("Unsupported pair relay version");

          if (message.type === "pair.bound") {
            if (bound || message.requestId !== bindRequestId) throw new Error("Invalid pair bind acknowledgement");
            if (!reconnected && Date.parse(offer.expiresAt) <= this.now()) {
              authorizationFailure("expired", "authorization_expired", "Pair authorization expired");
              return;
            }
            try {
              consumeOfferOnce();
              bound = true;
              clearTimeout(handshakeTimer);
              clearTimeout(offerExpiryTimer);
              refreshPresence();
            } catch {
              finish({ kind: "fatal", error: new Error("Pair presence activation failed") });
              return;
            }
            this.emit({ event: "pair.paired", status: "paired", reconnected });
            return;
          }
          if (message.type === "pair.expired") {
            authorizationFailure("expired", "authorization_expired", "Pair authorization expired");
            return;
          }
          if (message.type === "pair.revoked") {
            authorizationFailure("unpaired", "authorization_revoked", "Pair authorization was revoked");
            return;
          }
          if (message.type === "pair.unpaired") {
            authorizationFailure("unpaired", "authorization_denied", "Pair authorization was denied");
            return;
          }
          if (!bound) throw new Error("Relay message arrived before a valid pair bind");
          refreshPresence();
          if (message.type === "ping") {
            send({ version: PAIR_PROTOCOL_VERSION, type: "pong" });
            return;
          }
          if (message.type !== "rpc.request") throw new Error("Unsupported pair relay message");
          const id = requireSafeId(message.id, "RPC request id");
          if (seenRpcIds.has(id) || inFlightRpcIds.has(id)) throw new Error("RPC replay window failed closed");
          if (inFlightRpcIds.size >= 16) { send(unavailable(id)); return; }
          seenRpcIds.add(id);
          rpcIdWindow.push(id);
          if (rpcIdWindow.length > 1_000) seenRpcIds.delete(rpcIdWindow.shift());
          inFlightRpcIds.add(id);
          void this.shim.handle(message).then((result) => {
            if (settled) return;
            try {
              send(result);
            } catch {
              send(unavailable(id));
            }
          }).catch(() => protocolFailure()).finally(() => inFlightRpcIds.delete(id));
        }).catch(() => protocolFailure());
      });
      socket.addEventListener("error", () => {
        if (!settled) transient("relay_connection_error");
      });
      socket.addEventListener("close", () => {
        if (!settled) transient("relay_connection_closed");
      });
    });
  }
}
