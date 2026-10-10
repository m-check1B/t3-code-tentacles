import fs from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readBoundedWebSocketData } from "./t3-client.mjs";
import {
  PAIR_PROTOCOL_VERSION,
  REMOTE_RPC_METHODS,
  RemoteRpcShim,
  reconnectDelayMs,
} from "./outbound-pairer.mjs";

export const DEVICE_CONTRACT = "agentjack-device/v1";
export const T3_CONTRACT = "talkTurnResult/v1";
export const DEVICE_SIGN_PREFIX = "agentjack-device-v1";
// mac stays empty: Device Bridge actions belong to the connector (PR6), not this binary.
// interrupt stays off this 0.4.1 line. 0.4.2 advertised it and the relay rejected the bind.
export const DEVICE_CHANNELS = Object.freeze({
  labs: Object.freeze(["doctor-status"]),
  turns: Object.freeze(["originate", "continue", "turn-result", "thread-events", "thread-artifact"]),
  mac: Object.freeze([]),
});

const KEY_FIELDS = new Set([
  "privatekey", "private_key", "priv", "d", "pkcs8", "pkcs1", "pem", "seed", "rawkey", "keybytes",
]);
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/_-]{16,512}={0,2}$/;

function assertNoKeyMaterial(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, entry] of entries) {
    if (typeof key === "string" && KEY_FIELDS.has(key.toLowerCase())) {
      throw new Error("Signer response included key material");
    }
    if (entry && typeof entry === "object") assertNoKeyMaterial(entry, depth + 1);
  }
}

function requireSignToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) throw new Error(`${label} is not a signable token`);
  return value;
}

export function canonicalSignPayload({ nonce, deviceId, origin, serverTime }) {
  requireSignToken(nonce, "nonce");
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) throw new Error("deviceId is not a device UUID");
  if (typeof origin !== "string" || origin.length > 256) throw new Error("origin is not a signable token");
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error("origin is not a signable token"); }
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("origin is not a signable token");
  }
  if (typeof serverTime !== "string" || !SERVER_TIME.test(serverTime) || Number.isNaN(Date.parse(serverTime))) {
    throw new Error("serverTime is not a signable token");
  }
  return `${DEVICE_SIGN_PREFIX}|${nonce}|${deviceId}|${origin}|${serverTime}`;
}

export function openSignerFd(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("--signer-fd must be an inherited descriptor >= 3");
  const fd = Number(value);
  if (!Number.isInteger(fd) || fd < 3 || fd > 0x7fffffff) {
    throw new Error("--signer-fd must be an inherited descriptor >= 3");
  }
  return fd;
}

export function requestSignature(fd, payload, { timeoutMs = 5_000 } = {}) {
  const descriptor = openSignerFd(fd);
  if (typeof payload !== "string" || payload.length < 1 || payload.length > 1024) {
    throw new Error("Sign payload must be a bounded string");
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(null, { fd: descriptor, autoClose: false });
    const lines = createInterface({ input });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      input.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Signer timed out")), timeoutMs);
    lines.once("line", (line) => {
      try {
        const message = JSON.parse(line);
        assertNoKeyMaterial(message);
        if (message.version !== 1 || message.type !== "sign.result" || message.id !== id) {
          throw new Error("Signer response does not match the request");
        }
        if (message.algorithm !== "ECDSA-P256-SHA256") throw new Error("Signer algorithm is not ECDSA-P256-SHA256");
        if (typeof message.keyFingerprint !== "string" || !FINGERPRINT.test(message.keyFingerprint)) {
          throw new Error("Signer fingerprint is not a SHA-256 hex");
        }
        if (typeof message.signature !== "string" || !SIGNATURE.test(message.signature)) {
          throw new Error("Signer signature is not bounded base64");
        }
        finish(null, {
          keyFingerprint: message.keyFingerprint,
          signature: message.signature,
          algorithm: message.algorithm,
        });
      } catch (error) {
        finish(error);
      }
    });
    fs.writeSync(descriptor, `${JSON.stringify({ version: 1, type: "sign.request", id, payload })}\n`);
  });
}

function requireDeviceRelay(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "wss:") throw new Error("Device relay endpoint must use wss");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Device relay endpoint must not contain credentials, query, or fragment");
  }
  return endpoint;
}

// Pinned for PR4. Node's URL.origin for wss is not stable across runtimes, so the
// signed origin is exactly wss://hostname with a non-443 port when one is present.
export function relayOrigin(endpoint) {
  const port = endpoint.port && endpoint.port !== "443" ? `:${endpoint.port}` : "";
  return `wss://${endpoint.hostname}${port}`;
}

function encodeBounded(message, maxBytes) {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("Device relay frame exceeds the frame bound");
  return encoded;
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

function advertisedChannels() {
  return {
    labs: [...DEVICE_CHANNELS.labs],
    turns: [...DEVICE_CHANNELS.turns],
    mac: [...DEVICE_CHANNELS.mac],
  };
}

export class DeviceConnector {
  constructor({
    runtime,
    WebSocketImpl = globalThis.WebSocket,
    signer,
    handshakeTimeoutMs = 15_000,
    maxFrameBytes = 1024 * 1024,
    heartbeatTimeoutMs = 15_000,
    reconnectBaseMs = 500,
    reconnectCapMs = 30_000,
    random = Math.random,
    now = Date.now,
    onEvent = () => {},
  }) {
    if (!runtime) throw new Error("Device connector requires a runtime");
    if (!signer || typeof signer.sign !== "function") throw new Error("Device connector requires a signer");
    if (typeof WebSocketImpl !== "function") throw new Error("This Node.js runtime does not provide WebSocket support");
    reconnectDelayMs(0, { baseMs: reconnectBaseMs, capMs: reconnectCapMs, random: () => 0 });
    this.shim = new RemoteRpcShim(runtime);
    this.runtime = runtime;
    this.WebSocketImpl = WebSocketImpl;
    this.signer = signer;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
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

  async run({ relay, deviceId, app = "agentjack-desktop", signal } = {}) {
    const endpointUrl = requireDeviceRelay(relay);
    const endpoint = endpointUrl.toString();
    const origin = relayOrigin(endpointUrl);
    if (!DEVICE_ID.test(deviceId)) throw new Error("--device-id must be a device UUID");
    if (typeof app !== "string" || !SAFE_TOKEN.test(app)) throw new Error("--app must be a safe token");
    let attempt = 0;
    while (!signal?.aborted) {
      const outcome = await this.connectOnce({ endpoint, origin, deviceId, app, signal });
      if (signal?.aborted || outcome.kind === "stopped") return { status: "stopped" };
      if (outcome.kind === "terminal") {
        this.emit({ event: "device.terminal", code: outcome.code });
        return { status: "stopped", code: outcome.code };
      }
      if (outcome.bound) attempt = 0;
      const delayMs = outcome.code === 4402
        ? 3_600_000
        : reconnectDelayMs(attempt, { baseMs: this.reconnectBaseMs, capMs: this.reconnectCapMs, random: this.random });
      if (!outcome.bound) attempt += 1;
      this.emit({ event: "device.reconnecting", attempt, delayMs, code: outcome.code ?? null });
      if (!await waitForReconnect(delayMs, signal)) return { status: "stopped" };
    }
    return { status: "stopped" };
  }

  async connectOnce({ endpoint, origin, deviceId, app, signal }) {
    let socket;
    try { socket = new this.WebSocketImpl(endpoint); }
    catch { return { kind: "transient", bound: false, staleReason: "relay_connection_error" }; }
    let settled = false;
    let bound = false;
    let authed = false;
    let handshakeTimer;
    let heartbeatTimer;
    let messageQueue = Promise.resolve();
    const seenRpcIds = new Set();
    const rpcIdWindow = [];
    const inFlightRpcIds = new Set();
    return await new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(handshakeTimer);
        clearTimeout(heartbeatTimer);
        signal?.removeEventListener("abort", abort);
      };
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { socket.close(); } catch { /* already closed */ }
        resolve({ ...outcome, bound });
      };
      const transient = (staleReason, code) => finish({ kind: "transient", staleReason, code });
      const abort = () => finish({ kind: "stopped" });
      const send = (message) => socket.send(encodeBounded(message, this.maxFrameBytes));
      const armHeartbeat = () => {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(() => transient("relay_heartbeat_timeout"), this.heartbeatTimeoutMs);
      };
      handshakeTimer = setTimeout(() => transient("relay_handshake_timeout"), this.handshakeTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      socket.addEventListener("message", (event) => {
        messageQueue = messageQueue.then(async () => {
          if (settled) return;
          const raw = await readBoundedWebSocketData(event.data, this.maxFrameBytes, "Device relay frame");
          if (settled) return;
          let message;
          try { message = JSON.parse(raw); }
          catch { throw new Error("Invalid device relay JSON"); }
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid device relay message");
          if (message.version !== PAIR_PROTOCOL_VERSION) throw new Error("Unsupported device relay version");
          if (!authed) {
            if (message.type !== "hello") throw new Error("Device relay hello is required");
            if (typeof message.nonce !== "string" || !SAFE_TOKEN.test(message.nonce)) throw new Error("Device relay nonce is invalid");
            const payload = canonicalSignPayload({
              nonce: message.nonce,
              deviceId,
              origin,
              serverTime: message.serverTime,
            });
            const signed = await this.signer.sign(payload);
            assertNoKeyMaterial(signed);
            if (signed?.algorithm !== "ECDSA-P256-SHA256"
              || typeof signed.keyFingerprint !== "string" || !FINGERPRINT.test(signed.keyFingerprint)
              || typeof signed.signature !== "string" || !SIGNATURE.test(signed.signature)) {
              throw new Error("Signer result is not an ECDSA signature");
            }
            send({
              version: PAIR_PROTOCOL_VERSION,
              type: "auth",
              deviceId,
              keyFingerprint: signed.keyFingerprint,
              sig: signed.signature,
              app,
              origin,
              channels: advertisedChannels(),
              rpc: [...REMOTE_RPC_METHODS],
              contract: DEVICE_CONTRACT,
              t3Contract: T3_CONTRACT,
            });
            authed = true;
            return;
          }
          if (message.type === "bound") {
            if (bound || typeof message.connectionId !== "string" || !SAFE_TOKEN.test(message.connectionId)) {
              throw new Error("Invalid device bind acknowledgement");
            }
            bound = true;
            clearTimeout(handshakeTimer);
            armHeartbeat();
            this.emit({ event: "device.bound", connectionId: message.connectionId });
            if (typeof this.runtime.warmDoctor === "function") {
              void Promise.resolve().then(() => this.runtime.warmDoctor()).catch(() => {});
            }
            return;
          }
          if (!bound) throw new Error("Device relay message arrived before bind");
          armHeartbeat();
          if (message.type === "ping") {
            send({ version: PAIR_PROTOCOL_VERSION, type: "pong" });
            return;
          }
          if (message.type !== "rpc.request") throw new Error("Unsupported device relay message");
          const id = typeof message.id === "string" ? message.id : null;
          if (!id || seenRpcIds.has(id) || inFlightRpcIds.has(id)) throw new Error("RPC replay window failed closed");
          if (inFlightRpcIds.size >= 16) {
            send({ version: PAIR_PROTOCOL_VERSION, type: "rpc.error", id, error: { code: "computer.unavailable", message: "Computer unavailable", data: null } });
            return;
          }
          seenRpcIds.add(id);
          rpcIdWindow.push(id);
          if (rpcIdWindow.length > 1_000) seenRpcIds.delete(rpcIdWindow.shift());
          inFlightRpcIds.add(id);
          void this.shim.handle(message).then((result) => {
            if (!settled) send(result);
          }).catch(() => transient("relay_protocol_error")).finally(() => inFlightRpcIds.delete(id));
        }).catch(() => transient("relay_protocol_error"));
      });
      socket.addEventListener("close", (event) => {
        if (settled) return;
        const code = Number(event?.code);
        if (code === 4401 || code === 4403) finish({ kind: "terminal", code, bound });
        else transient("relay_connection_closed", code || undefined);
      });
      socket.addEventListener("error", () => { if (!settled) transient("relay_connection_error"); });
    });
  }
}
