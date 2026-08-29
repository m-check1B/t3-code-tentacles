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
  offerSecrets.delete(offer);
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

  seats() {
    return this.observeImpl(this.client);
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

export class OutboundPairer {
  constructor({
    runtime,
    WebSocketImpl = globalThis.WebSocket,
    pairStateFile = DEFAULT_PAIR_STATE_FILE,
    handshakeTimeoutMs = 15_000,
    maxFrameBytes = 1024 * 1024,
    leaseMs = 30_000,
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
    this.shim = new RemoteRpcShim(runtime);
    this.WebSocketImpl = WebSocketImpl;
    this.pairStateFile = pairStateFile;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.leaseMs = leaseMs;
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
        writePairPresence("expired", { file: this.pairStateFile, now: this.now() });
        this.emit({ event: "pair.expired", status: "expired" });
      } finally {
        releasePairStateOnce();
      }
      throw new Error("Pair offer has expired");
    }
    let socket;
    try {
      writePairPresence("unpaired", { file: this.pairStateFile, now: this.now() });
      this.emit({ event: "pair.connecting", status: "unpaired" });
      socket = new this.WebSocketImpl(offer.endpoint);
    } catch {
      releasePairStateOnce();
      throw new Error("Pair relay connection failed");
    }
    const bindRequestId = randomUUID();
    const seenRpcIds = new Set();
    const rpcIdWindow = [];
    const inFlightRpcIds = new Set();
    let bound = false;
    let settled = false;
    let stopping = false;
    let heartbeat = null;
    let offerExpiryTimer = null;
    let messageQueue = Promise.resolve();

    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(handshakeTimer);
        if (offerExpiryTimer) clearTimeout(offerExpiryTimer);
        if (heartbeat) clearInterval(heartbeat);
        signal?.removeEventListener("abort", abort);
      };
      const closeSocket = () => { try { socket.close(); } catch {} };
      const finish = (status, error = null) => {
        if (settled) return;
        settled = true;
        bound = false;
        cleanup();
        let stateError = null;
        try { writePairPresence(status, { file: this.pairStateFile, now: this.now() }); }
        catch { stateError = new Error("Pair presence state update failed"); }
        this.emit({ event: `pair.${status}`, status });
        closeSocket();
        releasePairStateOnce();
        if (error || stateError) reject(error || stateError); else resolve({ status });
      };
      const protocolFailure = () => finish("unpaired", new Error("Pair relay protocol failed closed"));
      const send = (message) => socket.send(encodeBounded(message, this.maxFrameBytes));
      const abort = () => {
        stopping = true;
        finish("unpaired");
      };
      const handshakeTimer = setTimeout(
        () => finish("unpaired", new Error("Pair relay handshake timed out")),
        this.handshakeTimeoutMs,
      );
      const offerRemainingMs = Date.parse(offer.expiresAt) - this.now();
      offerExpiryTimer = setTimeout(
        () => finish("expired", new Error("Pair offer has expired")),
        Math.max(0, Math.min(offerRemainingMs, this.handshakeTimeoutMs)),
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }

      socket.addEventListener("open", () => {
        const pairToken = offerSecrets.get(offer);
        if (!pairToken) { protocolFailure(); return; }
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
          protocolFailure();
        }
      });

      socket.addEventListener("message", (event) => {
        messageQueue = messageQueue.then(async () => {
          if (settled) return;
          const raw = await readBoundedWebSocketData(event.data, this.maxFrameBytes, "Pair relay frame");
          let message;
          try { message = JSON.parse(raw); } catch { throw new Error("Invalid pair relay JSON"); }
          requireRecord(message, "Pair relay message");
          if (message.version !== PAIR_PROTOCOL_VERSION) throw new Error("Unsupported pair relay version");

          if (message.type === "pair.bound") {
            if (bound || message.requestId !== bindRequestId) throw new Error("Invalid pair bind acknowledgement");
            if (Date.parse(offer.expiresAt) <= this.now()) { finish("expired", new Error("Pair offer has expired")); return; }
            consumePairOffer(offer);
            bound = true;
            clearTimeout(handshakeTimer);
            clearTimeout(offerExpiryTimer);
            writePairPresence("paired", { file: this.pairStateFile, now: this.now(), leaseMs: this.leaseMs });
            heartbeat = setInterval(() => {
              try {
                writePairPresence("paired", { file: this.pairStateFile, now: this.now(), leaseMs: this.leaseMs });
              } catch {
                protocolFailure();
              }
            }, Math.max(500, Math.floor(this.leaseMs / 3)));
            heartbeat.unref?.();
            this.emit({ event: "pair.paired", status: "paired" });
            return;
          }
          if (message.type === "pair.expired") { finish("expired", new Error("Pair expired")); return; }
          if (message.type === "pair.revoked" || message.type === "pair.unpaired") {
            finish("unpaired", new Error("Pair is no longer authorized"));
            return;
          }
          if (message.type === "ping") {
            if (!bound) throw new Error("Pair ping arrived before bind");
            send({ version: PAIR_PROTOCOL_VERSION, type: "pong" });
            return;
          }
          if (message.type !== "rpc.request" || !bound) throw new Error("RPC arrived before a valid pair bind");
          const id = requireSafeId(message.id, "RPC request id");
          if (seenRpcIds.has(id) || inFlightRpcIds.has(id)) throw new Error("RPC replay window failed closed");
          seenRpcIds.add(id);
          rpcIdWindow.push(id);
          if (rpcIdWindow.length > 1_000) seenRpcIds.delete(rpcIdWindow.shift());
          if (inFlightRpcIds.size >= 16) { send(unavailable(id)); return; }
          inFlightRpcIds.add(id);
          void this.shim.handle(message).then((result) => {
            if (settled) return;
            let response = result;
            try {
              send(response);
            } catch {
              response = unavailable(id);
              send(response);
            }
          }).catch(() => protocolFailure()).finally(() => inFlightRpcIds.delete(id));
        }).catch(() => protocolFailure());
      });
      socket.addEventListener("error", () => {
        if (!settled) finish("unpaired", new Error("Pair relay connection failed"));
      });
      socket.addEventListener("close", () => {
        if (!settled) finish("unpaired", stopping ? null : new Error("Pair relay connection closed"));
      });
    });
  }
}
