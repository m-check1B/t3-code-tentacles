import { randomUUID } from "node:crypto";
import { requireFreshProviderContext } from "./fresh-provider-context.mjs";
import { DEFAULT_T3_URL, DEFAULT_TOKEN_FILE, readToken, requireLoopbackUrl } from "./config.mjs";
import { archivedShellToV1, shellToV1, T3RpcRejectedError, threadDetailToV1, translateCommand, T3V2UnsupportedError, V2_PROTOCOL, V2_PROTOCOL_HEADER } from "./t3-v2.mjs";

const isPlainRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function requireFullThreadId(threadId) {
  if (typeof threadId !== "string" || threadId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error("A full thread UUID is required; short IDs are display-only. Use threadId from tentacles originate or threads[].id from tentacles observe.");
  }
  return threadId;
}

function safeErrorBody(body) {
  // T3 error payloads are not a trusted logging surface: they can echo bearer
  // material or the prompt that caused a rejected command. Keep diagnostics to
  // the status/path and never reflect a server-controlled body.
  void body;
  return "[redacted error body]";
}

export async function readBoundedResponseText(response, maxBytes, label = "T3 response") {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function readBoundedWebSocketData(data, maxBytes, label = "T3 websocket frame") {
  if (typeof data === "string") {
    if (Buffer.byteLength(data, "utf8") > maxBytes) throw new Error(`${label} is too large`);
    return data;
  }
  if (data instanceof Blob) {
    if (data.size > maxBytes) throw new Error(`${label} is too large`);
    return await data.text();
  }
  const buffer = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null;
  if (!buffer) throw new Error(`Unsupported ${label} type`);
  if (buffer.byteLength > maxBytes) throw new Error(`${label} is too large`);
  return buffer.toString("utf8");
}

export class T3Client {
  constructor({
    baseUrl = process.env.T3_URL || DEFAULT_T3_URL,
    token,
    tokenFile = process.env.T3_HERMES_TOKEN_FILE || DEFAULT_TOKEN_FILE,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = 15_000,
    responseMaxBytes = 32 * 1024 * 1024,
    // 1 | 2 pins the T3 orchestration protocol; auto reads the environment descriptor.
    orchestrationProtocol = process.env.T3_ORCHESTRATION_PROTOCOL || "auto",
    // Optional 401 recovery hook (t3-auth.mjs createAutoReauth); runs at most once per client.
    reauth = null,
  } = {}) {
    this.baseUrl = requireLoopbackUrl(baseUrl, "T3_URL");
    this.tokenFile = token === undefined ? tokenFile : null;
    this.token = token === undefined ? readToken(tokenFile) : token;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.responseMaxBytes = responseMaxBytes;
    this.reauth = reauth;
    this.reauthAttempt = null;
    if (!["auto", "1", "2", 1, 2].includes(orchestrationProtocol)) {
      throw new Error("T3_ORCHESTRATION_PROTOCOL must be auto, 1 or 2");
    }
    this.protocolVersion = orchestrationProtocol === "auto" ? null : Number(orchestrationProtocol);
  }

  // KRA-6436: T3 >= v0.1.0 speaks orchestration protocol 2. Older T3 has no
  // version field (or no descriptor) and is protocol 1. Anything else fails closed.
  async protocol({ signal } = {}) {
    if (this.protocolVersion !== null) return this.protocolVersion;
    const response = await this.fetchImpl(`${this.baseUrl}/.well-known/t3/environment`, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs),
    });
    let version = 1;
    if (response.ok) {
      const text = await readBoundedResponseText(response, 1024 * 1024, "T3 environment descriptor");
      let descriptor;
      try { descriptor = JSON.parse(text); } catch { throw new Error("T3 environment descriptor is not JSON"); }
      if (!isPlainRecord(descriptor)) throw new Error("T3 environment descriptor must be an object");
      version = Object.hasOwn(descriptor, "orchestrationProtocolVersion") ? descriptor.orchestrationProtocolVersion : 1;
    } else {
      try { await response.body?.cancel(); } catch { /* status alone decides */ }
      if (response.status !== 404) throw new T3HttpError({ method: "GET", pathname: "/.well-known/t3/environment", status: response.status });
    }
    if (version !== 1 && version !== V2_PROTOCOL) {
      const label = typeof version === "number" ? version : `type ${typeof version}`;
      throw new Error(`T3 orchestration protocol ${label} is not supported by this Tentacles release`);
    }
    this.protocolVersion = version;
    return version;
  }

  async request(pathname, { method = "GET", body, signal } = {}, retried = false) {
    const usedToken = this.token;
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        authorization: `Bearer ${usedToken}`,
        ...(this.protocolVersion === V2_PROTOCOL ? { [V2_PROTOCOL_HEADER]: "2" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      // An unauthenticated request has not executed. Retry the same command only
      // when the owner-controlled token file was replaced (by an operator or reauth).
      try { await response.body?.cancel(); } catch { /* 401 diagnostics never reflect a body error */ }
      const rotated = () => {
        let current;
        try { current = readToken(this.tokenFile); } catch { /* fail closed below */ }
        if (current && current !== usedToken) this.token = current;
        return current && current !== usedToken;
      };
      if (!retried && this.tokenFile && rotated()) return this.request(pathname, { method, body, signal }, true);
      if (this.reauth && this.tokenFile && (!retried || this.reauthAttempt)) {
        // Concurrent 401s share one issuance; a failed or exhausted attempt is never repeated.
        this.reauthAttempt ??= Promise.resolve().then(() => this.reauth({ tokenFile: this.tokenFile }))
          .then(result => ({ action: result?.action }), error => ({ action: error.action, reason: error.message }));
        const { action, reason } = await this.reauthAttempt;
        // Safe to retry once even for dispatches: a 401 means T3 rejected the request before acting.
        if (!retried && !reason && rotated()) return this.request(pathname, { method, body, signal }, true);
        throw new T3AuthError({ method, pathname, action, reason: reason ?? (retried ? "a newly issued session was also rejected" : undefined) });
      }
      throw new T3AuthError({ method, pathname });
    }
    const text = await readBoundedResponseText(response, this.responseMaxBytes);
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new T3HttpError({ method, pathname, status: response.status, body: parsed });
    }
    return parsed;
  }

  async shell(options) {
    if (await this.protocol(options) === V2_PROTOCOL) return shellToV1(await this.request("/api/orchestration/shell", options));
    return this.request("/api/orchestration/shell", options);
  }

  // Shell snapshot of archived threads. Unlike the active shell, this lives
  // behind the WebSocket RPC surface (orchestration.getArchivedShellSnapshot).
  async archivedShell(options) {
    const archived = await this.rpc("orchestration.getArchivedShellSnapshot", {}, { timeoutMs: 30_000, ...options });
    return this.protocolVersion === V2_PROTOCOL ? archivedShellToV1(archived) : archived;
  }

  // V2 has no full snapshot; its shell is the bounded equivalent.
  async snapshot(options) {
    if (await this.protocol(options) === V2_PROTOCOL) return this.shell(options);
    return this.request("/api/orchestration/snapshot", options);
  }

  async thread(threadId) {
    requireFullThreadId(threadId);
    const pathname = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
    if (await this.protocol() === V2_PROTOCOL) return threadDetailToV1(await this.request(pathname), threadId);
    return this.request(pathname);
  }

  // Windowed thread read. `turnLimit` bounds returned turns and `beforeCursor`
  // pages backwards through older history.
  threadDetail(threadId, { turnLimit, beforeCursor } = {}) {
    const query = new URLSearchParams();
    if (turnLimit !== undefined) query.set("turnLimit", String(turnLimit));
    if (beforeCursor !== undefined) query.set("beforeCursor", beforeCursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}${suffix}`);
  }

  async dispatch(command) {
    if (command?.type === "thread.turn.start" && Object.hasOwn(command, "freshProviderContext")) {
      if (command.freshProviderContext !== true) throw new T3V2UnsupportedError("freshProviderContext must be true when dispatched");
      await requireFreshProviderContext(this, { freshProviderContext: true, instanceId: command.modelSelection?.instanceId });
    }
    if (await this.protocol() !== V2_PROTOCOL) {
      return this.request("/api/orchestration/dispatch", { method: "POST", body: command });
    }
    const steps = await translateCommand(command, {
      readProjection: async (threadId) => (await this.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}`)).projection,
    });
    let result = { sequence: 0, protocol: V2_PROTOCOL, noop: steps.length === 0 };
    for (const step of steps) {
      const beforeSend = step.payload.type === "message.dispatch" && command.runtimeMode !== undefined
        ? async () => {
          const detail = await this.request(`/api/orchestration/threads/${encodeURIComponent(command.threadId)}`);
          if (detail?.projection?.thread?.id !== command.threadId
            || detail.projection.thread.runtimeMode !== command.runtimeMode) {
            throw new T3V2UnsupportedError("T3 V2 message refused: runtime mode prerequisite changed or is unproven");
          }
        }
        : undefined;
      const value = await this.rpc(step.method, step.payload, { beforeSend });
      result = { ...(isPlainRecord(value) && typeof value.sequence === "number" ? { sequence: value.sequence } : { sequence: result.sequence }), protocol: V2_PROTOCOL };
    }
    return result;
  }

  async rpc(tag, payload = {}, { timeoutMs = 15_000, beforeSend, signal } = {}) {
    const ticket = await this.request("/api/auth/websocket-ticket", { method: "POST", signal });
    const wsUrl = new URL(this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws";
    wsUrl.search = "";
    wsUrl.searchParams.set("wsTicket", ticket.ticket);
    if (await this.protocol({ signal }) === V2_PROTOCOL) wsUrl.searchParams.set("orchestrationProtocol", "2");

    signal?.throwIfAborted();
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(wsUrl.toString());
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          socket.close();
        } catch {}
        callback(value);
      };
      const onAbort = () => finish(reject, signal.reason);
      const timer = setTimeout(
        () => finish(reject, new Error(`T3 RPC ${tag} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      signal?.addEventListener("abort", onAbort, { once: true });

      // KRA-6576: once settled the socket is closed. Any later open, message or
      // Ping must not write to it: a throwing send would reject unhandled and
      // exit the pairer process.
      const send = (frame) => {
        if (settled) return;
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          finish(reject, new Error(`T3 RPC ${tag} websocket send failed`));
        }
      };
      socket.addEventListener("open", async () => {
        try {
          // Early refusal after handshake. Atomic message mode enforcement at
          // the server remains required even when this snapshot was full-access.
          if (beforeSend) await beforeSend();
          send({ _tag: "Request", id, tag, payload, headers: [] });
        } catch (error) {
          finish(reject, error);
        }
      });
      socket.addEventListener("message", async (event) => {
        if (settled) return;
        let raw;
        try {
          raw = await readBoundedWebSocketData(event.data, this.responseMaxBytes);
        } catch (error) {
          finish(reject, error);
          return;
        }
        if (settled) return;
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (message?._tag === "Ping") {
          send({ _tag: "Pong" });
          return;
        }
        if (message?._tag !== "Exit" || message.requestId !== id) return;
        if (message.exit?._tag === "Success") {
          finish(resolve, message.exit.value);
        } else {
          finish(reject, new T3RpcRejectedError(tag, safeErrorBody(message.exit)));
        }
      });
      socket.addEventListener("error", () => finish(reject, new Error(`T3 RPC ${tag} websocket failed`)));
      socket.addEventListener("close", () => {
        if (!settled) finish(reject, new Error(`T3 RPC ${tag} websocket closed before a response`));
      });
    });
  }

  getSettings(options) {
    return this.rpc("server.getSettings", {}, options);
  }

  updateSettings(patch) {
    return this.rpc("server.updateSettings", { patch });
  }

  refreshProvider(instanceId, { timeoutMs = 30_000, signal } = {}) {
    return this.rpc("server.refreshProviders", { instanceId }, { timeoutMs, signal });
  }
}

// T3 0.0.34 can leave the compact shell query blocked while the full
// orchestration snapshot and per-thread reads remain healthy. Standard
// T3Client instances always expose snapshot(); the shell fallback preserves
// compatibility with narrow embedders and existing synthetic clients.
export function readOrchestrationSnapshot(client, options) {
  if (typeof client?.snapshot === "function") return client.snapshot(options);
  if (typeof client?.shell === "function") return client.shell(options);
  throw new Error("T3 client does not expose an orchestration snapshot read");
}

export class T3HttpError extends Error {
  constructor({ method, pathname, status, body }) {
    super(`T3 ${method} ${pathname} failed (${status}): ${safeErrorBody(body)}`);
    this.name = "T3HttpError";
    this.status = status;
    this.pathname = pathname;
  }
}

export const T3_REAUTH_ACTION = 'tentacles reauth --t3-bin "$(command -v t3)" --t3-home "$HOME/.t3"';

export class T3AuthError extends T3HttpError {
  constructor({ method, pathname, action = T3_REAUTH_ACTION, reason }) {
    super({ method, pathname, status: 401 });
    this.name = "T3AuthError";
    this.code = "t3_reauth_required";
    this.action = action;
    this.message = `T3 authentication rejected (401); the bearer expired, was revoked, or belongs to another T3 home.${reason ? ` ${reason[0].toUpperCase()}${reason.slice(1)}.` : ""} Re-authenticate using the colocated T3 CLI: ${this.action}`;
  }
}
