import net from "node:net";
import { randomUUID } from "node:crypto";
import { readBoundedWebSocketData } from "./t3-client.mjs";
import { holdWarm, reconnectDelayMs } from "./outbound-pairer.mjs";

// KRA-6945 contract v1 (C1, C4, C5) with amendments A1 (connector line protocol)
// and A2 (parentPort transport). The connector owns the key and builds the signed
// message from fields; Tentacles owns the one device WebSocket.
export const DEVICE_PROTOCOL_VERSION = 1;
export const DEVICE_SIGN_PREFIX = "agentjack-device-v1";
// interrupt stays off this 0.4.1 line. 0.4.2 advertised it and the relay rejected the bind.
// mac methods come from the connector's host.hello, never from this binary.
export const DEVICE_CHANNELS = Object.freeze({
  labs: Object.freeze(["doctor-status"]),
  turns: Object.freeze(["seats", "originate", "continue", "turn-result", "thread-events", "thread-artifact"]),
});
export const HOST_LINE_MAX_BYTES = 64 * 1024;

const RUNTIME_METHODS = Object.freeze({
  "doctor-status": "doctorStatus",
  seats: "seats",
  originate: "originate",
  continue: "continue",
  "turn-result": "turnResult",
  "thread-events": "threadEvents",
  "thread-artifact": "threadArtifact",
});
const RPC_ERROR_MESSAGES = Object.freeze({
  "computer.unavailable": "Computer unavailable",
  "computer.warming": "Computer is warming up",
  method_unsupported: "Method unsupported",
  lab_error: "Lab error",
});
const PURPOSES = new Set(["enroll", "connect"]);
const SIGN_RESULT_KEYS = new Set(["version", "type", "id", "algorithm", "keyFingerprint", "signature"]);
const KEY_FIELDS = new Set([
  "privatekey", "private_key", "priv", "d", "pkcs8", "pkcs1", "pem", "seed", "rawkey", "keybytes",
]);
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DER_SIGNATURE = /^[A-Za-z0-9_-]{8,128}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const METHOD_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const APP_TOKEN = /^[A-Za-z0-9._+-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

// C1: exactly 7 lines joined by \n, no trailing newline. Exported so the connector
// (PR6) and tests build the same bytes; Tentacles itself never signs.
export function buildDeviceMessage({ purpose, audience, deviceId, keyFingerprint, nonce, issuedAt }) {
  if (!PURPOSES.has(purpose)) throw new Error("purpose must be enroll or connect");
  if (typeof audience !== "string" || audience.length < 1 || audience.length > 512 || CONTROL.test(audience)) {
    throw new Error("audience is not a single-line string");
  }
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) throw new Error("deviceId is not a lowercase device UUID");
  if (typeof keyFingerprint !== "string" || !FINGERPRINT.test(keyFingerprint)) {
    throw new Error("keyFingerprint is not a sha256 fingerprint");
  }
  if (typeof nonce !== "string" || !NONCE.test(nonce)) throw new Error("nonce is not base64url");
  if (typeof issuedAt !== "string" || !ISSUED_AT.test(issuedAt) || Number.isNaN(Date.parse(issuedAt))) {
    throw new Error("issuedAt is not an RFC 3339 UTC second");
  }
  return [DEVICE_SIGN_PREFIX, purpose, audience, deviceId, keyFingerprint, nonce, issuedAt].join("\n");
}

// C4 close-code table, client side.
export function deviceClosePolicy(code, { attempt = 0, random = Math.random } = {}) {
  if (code === 4401 || code === 4403) return { kind: "closed", code };
  if (code === 4402) return { kind: "suspended", delayMs: 3_600_000 };
  if (code === 4404) return { kind: "suspended", delayMs: 3_600_000, wakeOnSignIn: true };
  if (code === 4100) {
    const sample = random();
    return { kind: "superseded", delayMs: Math.round(60_000 * (0.8 + 0.4 * sample)) };
  }
  return {
    kind: "transient",
    delayMs: reconnectDelayMs(Math.min(attempt, 30), { baseMs: 1_000, capMs: 60_000, random }),
  };
}

export function openSignerFd(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("--signer-fd must be an inherited descriptor >= 3");
  const fd = Number(value);
  if (!Number.isInteger(fd) || fd < 3 || fd > 0x7fffffff) {
    throw new Error("--signer-fd must be an inherited descriptor >= 3");
  }
  return fd;
}

function encodeHostMessage(message) {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") > HOST_LINE_MAX_BYTES) throw new Error("Host message exceeds 64 KiB");
  return encoded;
}

// A1 over an inherited descriptor: one JSON object per line, each <= 64 KiB.
export function fdHostChannel(fd) {
  const socket = new net.Socket({ fd: openSignerFd(fd), readable: true, writable: true });
  const messageListeners = new Set();
  const closeListeners = new Set();
  let buffer = "";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (closed) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > HOST_LINE_MAX_BYTES) {
        socket.destroy();
        close();
        return;
      }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      for (const listener of messageListeners) listener(message);
      if (closed) return;
    }
    if (Buffer.byteLength(buffer, "utf8") > HOST_LINE_MAX_BYTES) {
      socket.destroy();
      close();
    }
  });
  socket.on("end", close);
  socket.on("close", close);
  socket.on("error", close);
  return {
    send(message) { if (!closed) socket.write(`${encodeHostMessage(message)}\n`); },
    onMessage(listener) { messageListeners.add(listener); },
    onClose(listener) { closeListeners.add(listener); },
    close() { socket.destroySoon(); close(); },
  };
}

// A2: Electron utilityProcess parentPort, one JSON object per message.
export function portHostChannel(port) {
  if (!port || typeof port.postMessage !== "function" || typeof port.on !== "function") {
    throw new Error("--host-port needs an Electron utilityProcess parentPort");
  }
  const messageListeners = new Set();
  const closeListeners = new Set();
  const onPortMessage = (event) => {
    const message = event?.data;
    try { encodeHostMessage(message); } catch { return; }
    for (const listener of messageListeners) listener(message);
  };
  const onPortClose = () => { for (const listener of closeListeners) listener(); };
  port.on("message", onPortMessage);
  port.on("close", onPortClose);
  let closed = false;
  return {
    send(message) { if (!closed) { encodeHostMessage(message); port.postMessage(message); } },
    onMessage(listener) { messageListeners.add(listener); },
    onClose(listener) { closeListeners.add(listener); },
    // A listening parentPort keeps a utilityProcess alive, so close drops our listeners.
    close() {
      if (closed) return;
      closed = true;
      const off = (typeof port.off === "function" ? port.off : port.removeListener)?.bind(port);
      off?.("message", onPortMessage);
      off?.("close", onPortClose);
    },
  };
}

function rpcFailure(code) {
  return Object.assign(new Error(RPC_ERROR_MESSAGES[code]), { code });
}

export class HostLink {
  #resolveHello;
  #rejectHello;
  #resolveClosed;
  #pendingSigns = new Map();
  #pendingRpcs = new Map();
  #signInListeners = new Set();

  constructor({ channel, signTimeoutMs = 5_000 }) {
    if (!channel) throw new Error("Host link requires a channel");
    this.channel = channel;
    this.signTimeoutMs = signTimeoutMs;
    this.hello = null;
    this.isClosed = false;
    this.helloPromise = new Promise((resolve, reject) => {
      this.#resolveHello = resolve;
      this.#rejectHello = reject;
    });
    this.helloPromise.catch(() => {});
    this.closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
    channel.onMessage((message) => this.#receive(message));
    channel.onClose(() => this.#close());
  }

  ready() { return this.helloPromise; }

  send(message) { this.channel.send(message); }

  close() {
    this.channel.close();
    this.#close();
  }

  onSignedIn(listener) {
    this.#signInListeners.add(listener);
    return () => this.#signInListeners.delete(listener);
  }

  #close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.#rejectHello(new Error("Connector closed before host.hello"));
    for (const { reject, timer } of [...this.#pendingSigns.values(), ...this.#pendingRpcs.values()]) {
      clearTimeout(timer);
      reject(rpcFailure("computer.unavailable"));
    }
    this.#pendingSigns.clear();
    this.#pendingRpcs.clear();
    this.#resolveClosed();
  }

  #receive(message) {
    if (!isRecord(message) || message.version !== DEVICE_PROTOCOL_VERSION || typeof message.type !== "string") return;
    if (!this.hello) {
      try {
        if (message.type !== "host.hello") throw new Error("host.hello is required first");
        if (typeof message.deviceId !== "string" || !DEVICE_ID.test(message.deviceId)) {
          throw new Error("host.hello deviceId is not a lowercase device UUID");
        }
        if (typeof message.keyFingerprint !== "string" || !FINGERPRINT.test(message.keyFingerprint)) {
          throw new Error("host.hello keyFingerprint is not a sha256 fingerprint");
        }
        if (!Array.isArray(message.mac) || message.mac.length > 64
          || !message.mac.every((method) => typeof method === "string" && METHOD_NAME.test(method))) {
          throw new Error("host.hello mac must list method names");
        }
        this.hello = Object.freeze({
          deviceId: message.deviceId,
          keyFingerprint: message.keyFingerprint,
          mac: Object.freeze([...new Set(message.mac)]),
        });
        this.#resolveHello(this.hello);
      } catch (error) {
        this.#rejectHello(error);
      }
      return;
    }
    if (message.type === "host.signed-in") {
      for (const listener of this.#signInListeners) listener();
      return;
    }
    if (message.type === "sign.result" || message.type === "sign.error") {
      const pending = this.#pendingSigns.get(message.id);
      if (!pending) return;
      this.#pendingSigns.delete(message.id);
      clearTimeout(pending.timer);
      try {
        if (message.type === "sign.error") throw new Error("Connector refused to sign");
        assertNoKeyMaterial(message);
        if (!Object.keys(message).every((key) => SIGN_RESULT_KEYS.has(key))) throw new Error("Signer reply has unexpected fields");
        if (message.algorithm !== "ECDSA-P256-SHA256") throw new Error("Signer algorithm is not ECDSA-P256-SHA256");
        if (message.keyFingerprint !== this.hello.keyFingerprint) throw new Error("Signer key fingerprint does not match host.hello");
        if (typeof message.signature !== "string" || !DER_SIGNATURE.test(message.signature)
          || Buffer.from(message.signature, "base64url")[0] !== 0x30) {
          throw new Error("Signer signature is not base64url DER");
        }
        pending.resolve({ keyFingerprint: message.keyFingerprint, signature: message.signature });
      } catch (error) {
        pending.reject(error);
      }
      return;
    }
    if (message.type === "host.rpc.result" || message.type === "host.rpc.error") {
      const pending = this.#pendingRpcs.get(message.id);
      if (!pending) return;
      this.#pendingRpcs.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === "host.rpc.result") pending.resolve(message.result ?? null);
      else {
        const code = Object.hasOwn(RPC_ERROR_MESSAGES, message.code) ? message.code : "computer.unavailable";
        pending.reject(rpcFailure(code));
      }
    }
    // Anything else from the connector is ignored, like unknown relay frames.
  }

  // A1: send only the fields. The connector rebuilds the exact C1 message itself.
  sign({ purpose, audience, nonce, issuedAt }) {
    if (!this.hello) return Promise.reject(new Error("host.hello is required before signing"));
    if (this.isClosed) return Promise.reject(new Error("Connector is closed"));
    buildDeviceMessage({ purpose, audience, nonce, issuedAt, ...this.hello });
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingSigns.delete(id);
        reject(new Error("Signer timed out"));
      }, this.signTimeoutMs);
      this.#pendingSigns.set(id, { resolve, reject, timer });
      this.channel.send({ version: DEVICE_PROTOCOL_VERSION, type: "sign.request", id, purpose, audience, nonce, issuedAt });
    });
  }

  rpc({ method, params, deadline, timeoutMs }) {
    if (this.isClosed) return Promise.reject(rpcFailure("computer.unavailable"));
    // Connector correlation belongs to this operation, never to a reusable relay ID.
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRpcs.delete(id);
        reject(rpcFailure("computer.unavailable"));
      }, Math.max(0, timeoutMs));
      this.#pendingRpcs.set(id, { resolve, reject, timer });
      try {
        this.channel.send({ version: DEVICE_PROTOCOL_VERSION, type: "host.rpc", id, method, params, deadline });
      } catch {
        clearTimeout(timer);
        this.#pendingRpcs.delete(id);
        reject(rpcFailure("computer.unavailable"));
      }
    });
  }
}

function requireDeviceRelay(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "wss:") throw new Error("Device relay endpoint must use wss");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Device relay endpoint must not contain credentials, query, or fragment");
  }
  return endpoint;
}

// The hello audience must name the relay this process dialed, so a challenge from
// another server is never signed. The signed bytes stay exactly what the server sent.
function audienceMatches(audience, endpoint) {
  if (typeof audience !== "string" || audience.length > 512 || CONTROL.test(audience)) return false;
  let parsed;
  try { parsed = new URL(audience); } catch { return false; }
  const trim = (pathname) => (pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname);
  return parsed.protocol === "wss:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && parsed.host === endpoint.host && trim(parsed.pathname) === trim(endpoint.pathname);
}

export function devicePlatform(platform = process.platform) {
  return ({ darwin: "macos", win32: "windows", linux: "linux" })[platform] ?? platform;
}

function defaultSleep(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function encodeBounded(message, maxBytes) {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("Device relay frame exceeds the frame bound");
  return encoded;
}

async function waitForHostHello(host, signal, timeoutMs) {
  if (signal.aborted) return null;
  let timer;
  let abort;
  try {
    return await Promise.race([
      host.ready(),
      new Promise((resolve, reject) => {
        abort = () => resolve(null);
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("Connector host.hello timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export class DeviceConnector {
  constructor({
    runtime,
    host,
    WebSocketImpl = globalThis.WebSocket,
    appVersion,
    platform = devicePlatform(),
    arch = process.arch,
    handshakeTimeoutMs = 15_000,
    idleTimeoutMs = 45_000,
    maxFrameBytes = 1024 * 1024,
    maxInFlight = 16,
    random = Math.random,
    now = Date.now,
    sleep = defaultSleep,
    onEvent = () => {},
  }) {
    if (!runtime) throw new Error("Device connector requires a runtime");
    if (!(host instanceof HostLink)) throw new Error("Device connector requires a host link");
    if (typeof WebSocketImpl !== "function") throw new Error("This Node.js runtime does not provide WebSocket support");
    for (const [label, value] of [["app version", appVersion], ["platform", platform], ["arch", arch]]) {
      if (typeof value !== "string" || !APP_TOKEN.test(value)) throw new Error(`Device ${label} must be a safe token`);
    }
    this.runtime = runtime;
    this.host = host;
    this.WebSocketImpl = WebSocketImpl;
    this.app = Object.freeze({ version: appVersion, platform, arch });
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.maxInFlight = maxInFlight;
    this.random = random;
    this.now = now;
    this.sleep = sleep;
    this.onEvent = onEvent;
  }

  emit(event) {
    try { this.onEvent(event); } catch { /* diagnostics never break the connection */ }
  }

  async run({ relay, signal } = {}) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    void this.host.closed.then(stop);
    try {
      const endpoint = requireDeviceRelay(relay);
      const hello = await waitForHostHello(this.host, controller.signal, this.handshakeTimeoutMs);
      if (!hello) return { status: "stopped" };
      const operations = { seenRpcIds: new Set(), rpcIdWindow: [], inFlight: new Set() };
      let attempt = 0;
      while (!controller.signal.aborted) {
        const outcome = await this.connectOnce({ endpoint, hello, signal: controller.signal, operations });
        if (controller.signal.aborted) break;
        if (outcome.bound) attempt = 0;
        // A superseded connection waits like 4100 whatever close code follows, unless that code is terminal or suspends.
        const code = outcome.superseded && ![4401, 4402, 4403, 4404].includes(outcome.code) ? 4100 : outcome.code;
        const policy = deviceClosePolicy(code, { attempt, random: this.random });
        if (policy.kind === "closed") {
          this.emit({ event: "device.closed", code: policy.code });
          try { this.host.send({ version: DEVICE_PROTOCOL_VERSION, type: "device.closed", code: policy.code }); } catch { /* connector gone */ }
          return { status: "closed", code: policy.code };
        }
        if (policy.kind === "transient") attempt += 1;
        this.emit({
          event: "device.reconnecting",
          attempt,
          delayMs: policy.delayMs,
          code: outcome.code ?? null,
          reason: outcome.code === 4400 ? "relay_protocol_error" : outcome.reason ?? policy.kind,
        });
        let unsubscribe = () => {};
        const waits = [this.sleep(policy.delayMs, controller.signal)];
        if (policy.wakeOnSignIn) waits.push(new Promise((resolve) => { unsubscribe = this.host.onSignedIn(() => resolve(true)); }));
        await Promise.race(waits);
        unsubscribe();
      }
      return { status: "stopped" };
    } catch (error) {
      if (controller.signal.aborted) return { status: "stopped" };
      throw error;
    } finally {
      stop();
      signal?.removeEventListener("abort", stop);
      this.host.close();
    }
  }

  connectOnce({ endpoint, hello, signal,
    operations = { seenRpcIds: new Set(), rpcIdWindow: [], inFlight: new Set() },
  }) {
    let socket;
    try { socket = new this.WebSocketImpl(endpoint.toString()); }
    catch { return Promise.resolve({ bound: false, reason: "relay_connection_error" }); }
    let settled = false;
    let superseded = false;
    let releaseWarm = () => {};
    let phase = "hello";
    let handshakeTimer;
    let idleTimer;
    let queue = Promise.resolve();
    // Socket teardown cannot forget or release an unfinished local operation.
    const { seenRpcIds, rpcIdWindow, inFlight } = operations;
    return new Promise((resolve) => {
      const finish = ({ code, reason }) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        clearTimeout(idleTimer);
        releaseWarm();
        signal.removeEventListener("abort", abort);
        try { socket.close(); } catch { /* already closed */ }
        resolve({ code, reason, superseded, bound: phase === "bound" });
      };
      const abort = () => finish({ reason: "stopped" });
      const send = (message) => { if (!settled) socket.send(encodeBounded(message, this.maxFrameBytes)); };
      const armIdle = () => {
        clearTimeout(idleTimer);
        if (settled) return;
        idleTimer = setTimeout(() => finish({ reason: "relay_idle_timeout" }), this.idleTimeoutMs);
      };
      const answer = (rpcId, work) => {
        inFlight.add(rpcId);
        void Promise.resolve().then(work).then(
          (result) => {
            try { send({ type: "rpc.result", rpcId, result: result ?? null }); }
            catch { send({ type: "rpc.error", rpcId, code: "lab_error", message: "Result exceeds the frame bound" }); }
          },
          (error) => {
            const code = Object.hasOwn(RPC_ERROR_MESSAGES, error?.code) ? error.code : "lab_error";
            send({ type: "rpc.error", rpcId, code, message: RPC_ERROR_MESSAGES[code] });
          },
        ).catch(() => finish({ reason: "relay_send_failed" })).finally(() => inFlight.delete(rpcId));
      };
      const handleRpc = (message) => {
        const { rpcId, channel, method } = message;
        if (typeof rpcId !== "string" || !SAFE_ID.test(rpcId) || seenRpcIds.has(rpcId) || inFlight.has(rpcId)) return;
        if (inFlight.size >= this.maxInFlight) {
          send({ type: "rpc.error", rpcId, code: "computer.unavailable", message: RPC_ERROR_MESSAGES["computer.unavailable"] });
          return;
        }
        seenRpcIds.add(rpcId);
        rpcIdWindow.push(rpcId);
        if (rpcIdWindow.length > 1_000) seenRpcIds.delete(rpcIdWindow.shift());
        const params = message.params === undefined ? {} : message.params;
        if (!isRecord(params)) {
          answer(rpcId, () => { throw rpcFailure("lab_error"); });
          return;
        }
        // Jack has already given up on a request past its deadline; never start it.
        const deadlineMs = Date.parse(message.deadline);
        if (!Number.isNaN(deadlineMs) && deadlineMs <= this.now()) {
          answer(rpcId, () => { throw rpcFailure("computer.unavailable"); });
          return;
        }
        if (channel === "mac") {
          if (!hello.mac.includes(method)) {
            answer(rpcId, () => { throw rpcFailure("method_unsupported"); });
            return;
          }
          const timeoutMs = Number.isNaN(deadlineMs) ? 30_000 : Math.min(30_000, Math.max(0, deadlineMs - this.now()));
          answer(rpcId, () => this.host.rpc({ method, params, deadline: message.deadline, timeoutMs }));
          return;
        }
        const runtimeMethod = Object.hasOwn(DEVICE_CHANNELS, channel) && DEVICE_CHANNELS[channel].includes(method)
          ? RUNTIME_METHODS[method]
          : null;
        if (!runtimeMethod || typeof this.runtime[runtimeMethod] !== "function") {
          answer(rpcId, () => { throw rpcFailure("method_unsupported"); });
          return;
        }
        answer(rpcId, () => this.runtime[runtimeMethod](params));
      };
      const receive = async (data) => {
        if (settled) return;
        const raw = await readBoundedWebSocketData(data, this.maxFrameBytes, "Device relay frame");
        if (settled) return;
        let message;
        try { message = JSON.parse(raw); } catch { throw new Error("Invalid device relay JSON"); }
        if (!isRecord(message) || typeof message.type !== "string") throw new Error("Invalid device relay message");
        if (Object.hasOwn(message, "version") && message.version !== DEVICE_PROTOCOL_VERSION) {
          throw new Error("Unsupported device relay version");
        }
        if (phase === "bound") armIdle();
        if (message.type === "device.hello" && phase === "hello") {
          if (typeof message.nonce !== "string" || !NONCE.test(message.nonce)) throw new Error("Device hello nonce is invalid");
          if (!audienceMatches(message.audience, endpoint)) {
            finish({ reason: "relay_audience_mismatch" });
            return;
          }
          phase = "auth";
          let signed;
          try {
            signed = await this.host.sign({
              purpose: "connect",
              audience: message.audience,
              nonce: message.nonce,
              issuedAt: message.issuedAt,
            });
          } catch {
            finish({ reason: "signer_refused" });
            return;
          }
          if (settled) return;
          send({
            type: "device.auth",
            version: DEVICE_PROTOCOL_VERSION,
            deviceId: hello.deviceId,
            keyFingerprint: signed.keyFingerprint,
            signature: signed.signature,
            app: { ...this.app },
            channels: ["labs", "turns", "mac"],
            rpc: { labs: [...DEVICE_CHANNELS.labs], turns: [...DEVICE_CHANNELS.turns], mac: [...hello.mac] },
          });
          return;
        }
        if (message.type === "device.bound" && phase === "auth") {
          if (typeof message.connectionId !== "string" || !SAFE_ID.test(message.connectionId)) {
            throw new Error("Invalid device bind acknowledgement");
          }
          phase = "bound";
          clearTimeout(handshakeTimer);
          armIdle();
          this.emit({
            event: "device.bound",
            connectionId: message.connectionId,
            licence: isRecord(message.licence) && typeof message.licence.state === "string" ? message.licence.state : null,
          });
          releaseWarm = holdWarm(this.runtime);
          return;
        }
        if (message.type === "ping") {
          send(Number.isSafeInteger(message.seq) && message.seq >= 0 ? { type: "pong", seq: message.seq } : { type: "pong" });
          return;
        }
        if (message.type === "device.superseded") {
          superseded = true;
          this.emit({ event: "device.superseded" });
          return;
        }
        if (message.type === "rpc.request" && phase === "bound") {
          handleRpc(message);
        }
        // Unknown or out-of-phase frames are ignored: drift must not close the socket (C4.2).
      };
      handshakeTimer = setTimeout(() => finish({ reason: "relay_handshake_timeout" }), this.handshakeTimeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      socket.addEventListener("message", (event) => {
        queue = queue.then(() => receive(event.data)).catch(() => finish({ reason: "relay_protocol_error" }));
      });
      socket.addEventListener("close", (event) => {
        const code = Number(event?.code);
        finish({ code: Number.isInteger(code) && code > 0 ? code : undefined, reason: "relay_connection_closed" });
      });
      socket.addEventListener("error", () => finish({ reason: "relay_connection_error" }));
    });
  }
}
