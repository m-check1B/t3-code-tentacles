import { randomUUID } from "node:crypto";
import { DEFAULT_T3_URL, DEFAULT_TOKEN_FILE, readToken, requireLoopbackUrl } from "./config.mjs";
import { archivedShellToV1, shellToV1, T3RpcRejectedError, threadDetailToV1, translateCommand, T3V2UnsupportedError, V2_PROTOCOL, V2_PROTOCOL_HEADER } from "./t3-v2.mjs";

const isPlainRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

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
  } = {}) {
    this.baseUrl = requireLoopbackUrl(baseUrl, "T3_URL");
    this.tokenFile = token === undefined ? tokenFile : null;
    this.token = token === undefined ? readToken(tokenFile) : token;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.responseMaxBytes = responseMaxBytes;
    if (!["auto", "1", "2", 1, 2].includes(orchestrationProtocol)) {
      throw new Error("T3_ORCHESTRATION_PROTOCOL must be auto, 1 or 2");
    }
    this.protocolVersion = orchestrationProtocol === "auto" ? null : Number(orchestrationProtocol);
  }

  // KRA-6436: T3 >= v0.1.0 speaks orchestration protocol 2. Older T3 has no
  // version field (or no descriptor) and is protocol 1. Anything else fails closed.
  async protocol() {
    if (this.protocolVersion !== null) return this.protocolVersion;
    const response = await this.fetchImpl(`${this.baseUrl}/.well-known/t3/environment`, {
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
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

  async request(pathname, { method = "GET", body } = {}, retried = false) {
    const usedToken = this.token;
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        authorization: `Bearer ${usedToken}`,
        ...(this.protocolVersion === V2_PROTOCOL ? { [V2_PROTOCOL_HEADER]: "2" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      // An unauthenticated request has not executed. Retry the same command only
      // when an operator has replaced the owner-controlled token file.
      try { await response.body?.cancel(); } catch { /* 401 diagnostics never reflect a body error */ }
      if (!retried && this.tokenFile) {
        let current;
        try { current = readToken(this.tokenFile); } catch { /* fail closed below */ }
        if (current && current !== usedToken) {
          this.token = current;
          return this.request(pathname, { method, body }, true);
        }
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

  async shell() {
    if (await this.protocol() === V2_PROTOCOL) return shellToV1(await this.request("/api/orchestration/shell"));
    return this.request("/api/orchestration/shell");
  }

  // Shell snapshot of archived threads. Unlike the active shell, this lives
  // behind the WebSocket RPC surface (orchestration.getArchivedShellSnapshot).
  async archivedShell() {
    const archived = await this.rpc("orchestration.getArchivedShellSnapshot", {}, { timeoutMs: 30_000 });
    return this.protocolVersion === V2_PROTOCOL ? archivedShellToV1(archived) : archived;
  }

  // V2 has no full snapshot; its shell is the bounded equivalent.
  async snapshot() {
    if (await this.protocol() === V2_PROTOCOL) return this.shell();
    return this.request("/api/orchestration/snapshot");
  }

  async thread(threadId) {
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

  async rpc(tag, payload = {}, { timeoutMs = 15_000, beforeSend } = {}) {
    const ticket = await this.request("/api/auth/websocket-ticket", { method: "POST" });
    const wsUrl = new URL(this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws";
    wsUrl.search = "";
    wsUrl.searchParams.set("wsTicket", ticket.ticket);
    if (await this.protocol() === V2_PROTOCOL) wsUrl.searchParams.set("orchestrationProtocol", "2");

    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(wsUrl.toString());
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {}
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error(`T3 RPC ${tag} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

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
          // Read after the ticket/connection handshake, immediately before the
          // message frame. A deduplicated old mode receipt is never current proof.
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

  getSettings() {
    return this.rpc("server.getSettings", {});
  }

  updateSettings(patch) {
    return this.rpc("server.updateSettings", { patch });
  }

  refreshProvider(instanceId) {
    return this.rpc("server.refreshProviders", { instanceId }, { timeoutMs: 30_000 });
  }
}

// T3 0.0.34 can leave the compact shell query blocked while the full
// orchestration snapshot and per-thread reads remain healthy. Standard
// T3Client instances always expose snapshot(); the shell fallback preserves
// compatibility with narrow embedders and existing synthetic clients.
export function readOrchestrationSnapshot(client) {
  if (typeof client?.snapshot === "function") return client.snapshot();
  if (typeof client?.shell === "function") return client.shell();
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
  constructor({ method, pathname }) {
    super({ method, pathname, status: 401 });
    this.name = "T3AuthError";
    this.code = "t3_reauth_required";
    this.action = T3_REAUTH_ACTION;
    this.message = `T3 authentication rejected (401); the bearer expired, was revoked, or belongs to another T3 home. Re-authenticate using the colocated T3 CLI: ${this.action}`;
  }
}
