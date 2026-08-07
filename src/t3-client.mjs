import { randomUUID } from "node:crypto";
import { DEFAULT_T3_URL, readToken, requireLoopbackUrl } from "./config.mjs";

function safeErrorBody(body) {
  if (typeof body === "string") return body.slice(0, 500);
  return JSON.stringify(body).slice(0, 500);
}

async function readBoundedResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`T3 response exceeds ${maxBytes} bytes`);
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
      throw new Error(`T3 response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readBoundedWebSocketData(data, maxBytes) {
  if (typeof data === "string") {
    if (Buffer.byteLength(data, "utf8") > maxBytes) throw new Error("T3 websocket frame is too large");
    return data;
  }
  if (data instanceof Blob) {
    if (data.size > maxBytes) throw new Error("T3 websocket frame is too large");
    return await data.text();
  }
  const buffer = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null;
  if (!buffer) throw new Error("Unsupported T3 websocket frame type");
  if (buffer.byteLength > maxBytes) throw new Error("T3 websocket frame is too large");
  return buffer.toString("utf8");
}

export class T3Client {
  constructor({
    baseUrl = process.env.T3_URL || DEFAULT_T3_URL,
    token = readToken(),
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = 15_000,
    responseMaxBytes = 32 * 1024 * 1024,
  } = {}) {
    this.baseUrl = requireLoopbackUrl(baseUrl, "T3_URL");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.responseMaxBytes = responseMaxBytes;
  }

  async request(pathname, { method = "GET", body } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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

  shell() {
    return this.request("/api/orchestration/shell");
  }

  snapshot() {
    return this.request("/api/orchestration/snapshot");
  }

  thread(threadId) {
    return this.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
  }

  dispatch(command) {
    return this.request("/api/orchestration/dispatch", { method: "POST", body: command });
  }

  async rpc(tag, payload = {}, { timeoutMs = 15_000 } = {}) {
    const ticket = await this.request("/api/auth/websocket-ticket", { method: "POST" });
    const wsUrl = new URL(this.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws";
    wsUrl.search = "";
    wsUrl.searchParams.set("wsTicket", ticket.ticket);

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

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      });
      socket.addEventListener("message", async (event) => {
        let raw;
        try {
          raw = await readBoundedWebSocketData(event.data, this.responseMaxBytes);
        } catch (error) {
          finish(reject, error);
          return;
        }
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (message?._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }));
          return;
        }
        if (message?._tag !== "Exit" || message.requestId !== id) return;
        if (message.exit?._tag === "Success") {
          finish(resolve, message.exit.value);
        } else {
          finish(reject, new Error(`T3 RPC ${tag} failed: ${safeErrorBody(message.exit)}`));
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

export class T3HttpError extends Error {
  constructor({ method, pathname, status, body }) {
    super(`T3 ${method} ${pathname} failed (${status}): ${safeErrorBody(body)}`);
    this.name = "T3HttpError";
    this.status = status;
    this.pathname = pathname;
  }
}
