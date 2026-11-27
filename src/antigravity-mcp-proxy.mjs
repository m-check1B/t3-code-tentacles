/**
 * Zero-dependency in-process loopback Streamable-HTTP MCP proxy for Local · Antigravity.
 *
 * Antigravity discovers `.agents/plugins/jack-tools/mcp_config.json` lazily on
 * Turn 1 of an `antigravity acp` session. Pointing `mcp_config.json` at this
 * loopback proxy (`http://127.0.0.1:<port>/mcp/<routeId>` with a per-route
 * local bearer secret) keeps upstream Jack bearer tokens strictly in RAM,
 * works inside packaged Electron Desktop (`runAsNode: false`,
 * `onlyLoadAppFromAsar: true`, zero child processes), and transparently
 * rotates upstream tokens and re-handshakes stateful upstream MCP sessions
 * without restarting the warm `antigravity acp` process.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";

export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT = 16;
export const MAX_SESSIONS_PER_ROUTE = 64;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_BODY_TIMEOUT_MS = 15_000;
export const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 30_000;

const ROUTE_PATH_RE = /^\/mcp\/([A-Za-z0-9_-]{16,128})$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// RFC 9110 field-name token characters (tchar).
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Reject ASCII control characters (CR, LF, NUL, DEL) and non-ByteString chars (> 0xff)
// so `new Headers().set()` can never throw at forward time.
const HEADER_VALUE_FORBIDDEN_RE = /[\u0000-\u001f\u007f\u0100-\uffff]/;
const MAX_HEADER_BYTES = 16 * 1024;
const FORBIDDEN_UPSTREAM_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);
const DUMMY_SECRET_DIGEST = createHash("sha256").update("tentacles-antigravity-mcp-proxy-dummy").digest();

class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload Too Large");
    this.name = "PayloadTooLargeError";
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super("Request Timeout");
    this.name = "RequestTimeoutError";
  }
}

class ResponseTooLargeError extends Error {
  constructor() {
    super("Upstream MCP response exceeded size limit");
    this.name = "ResponseTooLargeError";
  }
}

class UpstreamHttpError extends Error {
  constructor(status) {
    super(`Upstream MCP HTTP ${status}`);
    this.name = "UpstreamHttpError";
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest();
}

function configFingerprint(url, headers) {
  const sortedHeaders = Object.keys(headers).sort().map((key) => [key, headers[key]]);
  return createHash("sha256").update(JSON.stringify([url, sortedHeaders])).digest("hex");
}

function hasRequestId(message) {
  return isPlainObject(message) && Object.hasOwn(message, "id") && message.id !== undefined;
}

function isAllowedServerUrl(value, { allowLoopbackHttp = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    return allowLoopbackHttp === true && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function sanitizeHeaders(raw) {
  const headers = {};
  if (raw === undefined) return headers;

  let entries;
  if (Array.isArray(raw)) {
    entries = [];
    for (const item of raw) {
      if (!isPlainObject(item)) return null;
      const keys = Object.keys(item);
      if (keys.length !== 2 || !Object.hasOwn(item, "name") || !Object.hasOwn(item, "value")) return null;
      entries.push([item.name, item.value]);
    }
  } else if (isPlainObject(raw)) {
    entries = Object.entries(raw);
  } else {
    return null;
  }

  const seenLower = new Set();
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (typeof key !== "string" || !HEADER_NAME_RE.test(key)) return null;
    const lower = key.toLowerCase();
    if (FORBIDDEN_UPSTREAM_HEADERS.has(lower) || seenLower.has(lower)) return null;
    if (typeof value !== "string" || HEADER_VALUE_FORBIDDEN_RE.test(value)) return null;
    const entryBytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    totalBytes += entryBytes;
    if (entryBytes > MAX_HEADER_BYTES || totalBytes > MAX_HEADER_BYTES) return null;
    seenLower.add(lower);
    headers[key] = value;
  }
  return headers;
}

function sanitizeContentType(raw) {
  const lower = String(raw ?? "").toLowerCase();
  if (lower.includes("text/event-stream")) return "text/event-stream";
  return "application/json";
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": String(body.byteLength),
      ...extraHeaders,
    });
    res.end(body);
  } catch {}
}

function sendBuffer(res, statusCode, contentType, body, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(statusCode, {
      "Content-Type": contentType,
      "Content-Length": String(body.byteLength),
      ...extraHeaders,
    });
    res.end(body);
  } catch {}
}

function sendEmpty(res, statusCode, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(statusCode, {
      "Content-Length": "0",
      ...extraHeaders,
    });
    res.end();
  } catch {}
}

async function readRequestBody(req, maxBytes, bodyTimeoutMs) {
  const rawLength = req.headers["content-length"];
  if (rawLength !== undefined) {
    const parsedLength = Number(rawLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      req.pause();
      throw new PayloadTooLargeError();
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        req.pause();
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total).toString("utf8"));
    };

    const onError = (error) => fail(error);
    const onAborted = () => fail(new Error("Request aborted"));
    const onClose = () => {
      if (!req.complete) fail(new Error("Request closed prematurely"));
    };

    if (Number.isFinite(bodyTimeoutMs) && bodyTimeoutMs > 0) {
      timer = setTimeout(() => {
        req.pause();
        fail(new RequestTimeoutError());
      }, bodyTimeoutMs);
      timer.unref?.();
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}

async function drainBody(response) {
  try {
    if (response?.body?.cancel) await response.body.cancel();
    else if (typeof response?.arrayBuffer === "function") await response.arrayBuffer();
    else if (typeof response?.text === "function") await response.text();
  } catch {}
}

async function readBoundedBuffer(response, maxBytes) {
  const rawLength = response?.headers?.get?.("content-length");
  if (rawLength !== null && rawLength !== undefined && rawLength !== "") {
    const parsedLength = Number(rawLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await drainBody(response);
      throw new ResponseTooLargeError();
    }
  }
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        total += buf.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new ResponseTooLargeError();
        }
        chunks.push(buf);
      }
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response?.arrayBuffer === "function") {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new ResponseTooLargeError();
    return buf;
  }
  const text = await response.text();
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength > maxBytes) throw new ResponseTooLargeError();
  return buf;
}

function snapshotRoute(route) {
  if (!route || !route.active || !route.url || !route.headers || !route.configHash) return null;
  return {
    url: route.url,
    headers: route.headers,
    configHash: route.configHash,
  };
}

function runSessionSerialized(session, task) {
  const run = session.sessionGate.catch(() => {}).then(task);
  session.sessionGate = run.catch(() => {});
  return run;
}

function clearRouteState(route) {
  route.active = false;
  route.url = null;
  route.headers = null;
  route.configHash = null;
  route.sessions.clear();
  try { route.abortController?.abort(new Error("Route revoked")); } catch {}
}

export class AntigravityMcpProxy {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
    headersTimeoutMs = DEFAULT_HEADERS_TIMEOUT_MS,
    serverRequestTimeoutMs = DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
    allowLoopbackHttp = false,
    maxRequestBytes = MAX_REQUEST_BYTES,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    maxInFlight = MAX_IN_FLIGHT,
    maxSessionsPerRoute = MAX_SESSIONS_PER_ROUTE,
  } = {}) {
    this._fetchImpl = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._bodyTimeoutMs = bodyTimeoutMs;
    this._headersTimeoutMs = headersTimeoutMs;
    this._serverRequestTimeoutMs = serverRequestTimeoutMs;
    this._allowLoopbackHttp = allowLoopbackHttp === true;
    this._maxRequestBytes = maxRequestBytes;
    this._maxResponseBytes = maxResponseBytes;
    this._maxInFlight = maxInFlight;
    this._maxSessionsPerRoute = maxSessionsPerRoute;
    this._server = null;
    this._port = null;
    this._startPromise = null;
    this._generation = 0;
    this._routesById = new Map();
    this._workspaceRoutes = new Map();
  }

  get port() {
    return this._port;
  }

  async ensureStarted() {
    if (this._server && this._port !== null) {
      return { port: this._port };
    }
    if (this._startPromise) {
      return this._startPromise;
    }
    const generation = this._generation;
    this._startPromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this._handleRequest(req, res);
      });
      server.headersTimeout = this._headersTimeoutMs;
      server.requestTimeout = this._serverRequestTimeoutMs;
      const onError = (error) => {
        server.off("listening", onListening);
        if (this._generation === generation) {
          this._startPromise = null;
        }
        if (this._server === server) {
          this._server = null;
          this._port = null;
        }
        try { server.close(); } catch {}
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        if (this._generation !== generation) {
          try { server.closeAllConnections?.(); } catch {}
          try { server.close(); } catch {}
          reject(new Error("Antigravity MCP proxy closed while starting"));
          return;
        }
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!Number.isInteger(port) || port <= 0) {
          this._startPromise = null;
          try { server.close(); } catch {}
          reject(new Error("Antigravity MCP proxy failed to bind loopback port"));
          return;
        }
        server.unref();
        this._server = server;
        this._port = port;
        this._startPromise = null;
        resolve({ port });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(0, "127.0.0.1");
      } catch (error) {
        onError(error);
      }
    });
    return this._startPromise;
  }

  async close() {
    this._generation += 1;
    for (const route of this._routesById.values()) {
      clearRouteState(route);
    }
    this._routesById.clear();
    this._workspaceRoutes.clear();

    const server = this._server;
    this._server = null;
    this._port = null;
    this._startPromise = null;
    if (!server) return;
    try { server.closeAllConnections?.(); } catch {}
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  _formatEntry(route) {
    return {
      serverUrl: `http://127.0.0.1:${this._port}/mcp/${route.routeId}`,
      headers: { Authorization: `Bearer ${route.localSecret}` },
    };
  }

  setWorkspaceServers(workspace, servers) {
    if (!this._server || this._port === null) {
      throw new Error("Antigravity MCP proxy is not started");
    }
    if (typeof workspace !== "string" || !workspace.trim()) {
      throw new Error("Invalid workspace");
    }
    if (!Array.isArray(servers)) {
      throw new Error("Invalid MCP servers list");
    }

    const validated = [];
    const seenNames = new Set();
    for (const server of servers) {
      if (!isPlainObject(server)) throw new Error("Invalid MCP server entry");
      if (typeof server.name !== "string" || !SERVER_NAME_RE.test(server.name)) {
        throw new Error("Invalid MCP server name");
      }
      if (seenNames.has(server.name)) {
        throw new Error("Duplicate MCP server name");
      }
      if (!isAllowedServerUrl(server.url, { allowLoopbackHttp: this._allowLoopbackHttp })) {
        throw new Error("Disallowed MCP server URL");
      }
      const headers = sanitizeHeaders(server.headers);
      if (headers === null) {
        throw new Error("Invalid MCP server headers");
      }
      seenNames.add(server.name);
      validated.push({
        name: server.name,
        url: server.url,
        headers,
        configHash: configFingerprint(server.url, headers),
      });
    }

    const wsKey = path.resolve(workspace);
    let wsMap = this._workspaceRoutes.get(wsKey);
    if (!wsMap) {
      wsMap = new Map();
      this._workspaceRoutes.set(wsKey, wsMap);
    }

    // Revoke any previously registered routes for this workspace that are no longer in `servers`.
    for (const [existingName, existingRoute] of [...wsMap.entries()]) {
      if (!seenNames.has(existingName)) {
        clearRouteState(existingRoute);
        this._routesById.delete(existingRoute.routeId);
        wsMap.delete(existingName);
      }
    }

    const entries = {};
    for (const item of validated) {
      let route = wsMap.get(item.name);
      if (route) {
        route.url = item.url;
        route.headers = item.headers;
        route.configHash = item.configHash;
        route.active = true;
      } else {
        const routeId = randomBytes(18).toString("base64url");
        const localSecret = randomBytes(32).toString("base64url");
        route = {
          routeId,
          localSecret,
          secretDigest: sha256Buffer(localSecret),
          url: item.url,
          headers: item.headers,
          configHash: item.configHash,
          sessions: new Map(),
          inFlight: 0,
          active: true,
          abortController: new AbortController(),
        };
        wsMap.set(item.name, route);
        this._routesById.set(routeId, route);
      }
      entries[item.name] = this._formatEntry(route);
    }

    if (wsMap.size === 0) {
      this._workspaceRoutes.delete(wsKey);
    }
    return entries;
  }

  entryFor(workspace, serverName) {
    if (!this._server || this._port === null) return null;
    if (typeof workspace !== "string" || !workspace.trim()) return null;
    if (typeof serverName !== "string" || !SERVER_NAME_RE.test(serverName)) return null;
    const route = this._workspaceRoutes.get(path.resolve(workspace))?.get(serverName);
    if (!route || !route.active) return null;
    return this._formatEntry(route);
  }

  clearWorkspace(workspace) {
    if (typeof workspace !== "string" || !workspace.trim()) return;
    const wsKey = path.resolve(workspace);
    const wsMap = this._workspaceRoutes.get(wsKey);
    if (!wsMap) return;
    for (const route of wsMap.values()) {
      clearRouteState(route);
      this._routesById.delete(route.routeId);
    }
    this._workspaceRoutes.delete(wsKey);
  }

  async _postUpstream({ route, url, headers, body, currentSessionId }) {
    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value);
    }
    // Proxy-owned headers always win case-insensitively.
    requestHeaders.set("Content-Type", "application/json");
    requestHeaders.set("Accept", "application/json, text/event-stream");
    if (currentSessionId) requestHeaders.set("Mcp-Session-Id", currentSessionId);
    else requestHeaders.delete("Mcp-Session-Id");
    const timeoutSignal = AbortSignal.timeout(this._timeoutMs);
    const signal = route?.abortController
      ? AbortSignal.any([route.abortController.signal, timeoutSignal])
      : timeoutSignal;
    return this._fetchImpl(url, {
      method: "POST",
      headers: requestHeaders,
      body,
      redirect: "error",
      signal,
    });
  }

  async _reinitializeUpstreamSession(route, session, upstream) {
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "__tentacles_proxy_reinit__",
      method: "initialize",
      params: session.initParams,
    });
    let initResponse;
    try {
      initResponse = await this._postUpstream({
        route,
        url: upstream.url,
        headers: upstream.headers,
        body: initBody,
        currentSessionId: null,
      });
    } catch (error) {
      session.upstreamSid = null;
      session.upstreamConfigHash = null;
      throw error;
    }
    const nextUpstreamSid = initResponse?.headers?.get?.("mcp-session-id")?.trim() || null;
    await drainBody(initResponse);
    if (!initResponse.ok) {
      session.upstreamSid = null;
      session.upstreamConfigHash = null;
      throw new UpstreamHttpError(initResponse.status);
    }
    if (!route.active || route.configHash !== upstream.configHash) {
      return;
    }
    if (nextUpstreamSid) {
      try {
        const notifResponse = await this._postUpstream({
          route,
          url: upstream.url,
          headers: upstream.headers,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          currentSessionId: nextUpstreamSid,
        });
        await drainBody(notifResponse);
      } catch {
        // Best-effort initialized notification; keep session usable.
      }
    }
    if (!route.active || route.configHash !== upstream.configHash) {
      return;
    }
    session.upstreamSid = nextUpstreamSid;
    session.upstreamConfigHash = upstream.configHash;
  }

  async _ensureSessionFresh(route, session, { forceForSid = null } = {}) {
    await runSessionSerialized(session, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const latest = snapshotRoute(route);
        if (!latest) return;
        const needsForce = forceForSid !== null
          && session.upstreamConfigHash === latest.configHash
          && session.upstreamSid === forceForSid;
        const needsSync = session.upstreamConfigHash !== latest.configHash;
        if (!needsForce && !needsSync) return;
        session.upstreamSid = null;
        session.upstreamConfigHash = null;
        await this._reinitializeUpstreamSession(route, session, latest);
        // If route rotated again while we were awaiting upstream initialize/initialized,
        // loop once more to re-init for the latest snapshot instead of firing with null sid.
        if (!route.active || route.configHash === latest.configHash) return;
      }
    });
  }

  async _handleRequest(req, res) {
    try {
      // 1. Strict Host header check (blocks DNS rebinding).
      const expectedHost = `127.0.0.1:${this._port}`;
      if (req.headers.host !== expectedHost) {
        return sendJson(res, 403, { error: "Forbidden" });
      }
      // 2. Reject any Origin header (blocks browser CSRF).
      if (req.headers.origin !== undefined) {
        return sendJson(res, 403, { error: "Forbidden" });
      }
      // 3. Strict path matching.
      const match = typeof req.url === "string" ? ROUTE_PATH_RE.exec(req.url) : null;
      if (!match) {
        return sendJson(res, 404, { error: "Not Found" });
      }
      const routeId = match[1];
      const route = this._routesById.get(routeId);

      // 4. Constant-time Bearer token check via SHA-256 digests.
      const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
      const hasBearer = authHeader.startsWith("Bearer ");
      const token = hasBearer ? authHeader.slice(7) : "";
      const providedDigest = sha256Buffer(token);
      const expectedDigest = route ? route.secretDigest : DUMMY_SECRET_DIGEST;
      const secretOk = timingSafeEqual(providedDigest, expectedDigest);
      if (!route || !route.active || !hasBearer || token.length === 0 || !secretOk) {
        return sendJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });
      }

      // 5. HTTP method handling.
      if (req.method === "GET") {
        return sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "POST, DELETE" });
      }
      if (req.method === "DELETE") {
        const localSid = typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"].trim()
          : "";
        if (localSid) {
          const session = route.sessions.get(localSid);
          if (session) {
            session.upstreamSid = null;
            route.sessions.delete(localSid);
          }
        }
        return sendEmpty(res, 204);
      }
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "POST, DELETE" });
      }

      // 6. Per-route concurrency cap.
      if (route.inFlight >= this._maxInFlight) {
        return sendJson(res, 429, { error: "Too Many Requests" });
      }
      route.inFlight += 1;
      try {
        await this._handlePost(req, res, route);
      } finally {
        route.inFlight -= 1;
      }
    } catch {
      sendJson(res, 500, { error: "Internal Server Error" });
    }
  }

  async _handlePost(req, res, route) {
    const sendCloseError = (statusCode, errorText) => {
      if (!res.writableEnded && !res.destroyed) {
        const body = Buffer.from(JSON.stringify({ error: errorText }), "utf8");
        try {
          res.writeHead(statusCode, {
            "Content-Type": "application/json",
            "Content-Length": String(body.byteLength),
            Connection: "close",
          });
          res.end(body, () => {
            try { req.destroy(); } catch {}
          });
        } catch {
          try { req.destroy(); } catch {}
        }
      }
    };

    let rawBody;
    try {
      rawBody = await readRequestBody(req, this._maxRequestBytes, this._bodyTimeoutMs);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendCloseError(413, "Payload Too Large");
        return;
      }
      if (error instanceof RequestTimeoutError) {
        sendCloseError(408, "Request Timeout");
        return;
      }
      return sendJson(res, 400, { error: "Bad Request" });
    }

    let message;
    try {
      message = JSON.parse(rawBody);
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (!isPlainObject(message)) {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    }

    const isRequest = hasRequestId(message);
    const errorId = isRequest ? message.id : null;
    const isInitialize = message.method === "initialize";
    const rawLocalSid = req.headers["mcp-session-id"];
    const localSid = typeof rawLocalSid === "string" && rawLocalSid.trim() ? rawLocalSid.trim() : null;

    const sendUnauthorized = () => sendJson(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" });

    const sendUpstreamFailure = (error, sessionHeader) => {
      if (!route.active) return sendUnauthorized();
      const extra = sessionHeader ? { "Mcp-Session-Id": sessionHeader } : {};
      let safeMessage = "Upstream MCP request failed";
      if (error instanceof ResponseTooLargeError) {
        safeMessage = "Upstream MCP response exceeded size limit";
      } else if (error instanceof UpstreamHttpError) {
        safeMessage = `Upstream MCP HTTP ${error.status}`;
      } else if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        safeMessage = "Upstream MCP request timed out";
      }
      return sendJson(res, 502, {
        jsonrpc: "2.0",
        id: errorId,
        error: { code: -32000, message: safeMessage },
      }, extra);
    };

    // Case 1: initialize — forward without Mcp-Session-Id and allocate opaque localSid on 2xx.
    if (isInitialize) {
      const upstream = snapshotRoute(route);
      if (!upstream) return sendUnauthorized();
      let response;
      try {
        response = await this._postUpstream({
          route,
          url: upstream.url,
          headers: upstream.headers,
          body: rawBody,
          currentSessionId: null,
        });
      } catch (error) {
        return sendUpstreamFailure(error, null);
      }

      if (!response.ok) {
        await drainBody(response);
        if (!route.active) return sendUnauthorized();
        return sendJson(res, response.status, {
          jsonrpc: "2.0",
          id: errorId,
          error: { code: -32000, message: `Upstream MCP HTTP ${response.status}` },
        });
      }

      let responseBody;
      try {
        responseBody = await readBoundedBuffer(response, this._maxResponseBytes);
      } catch (error) {
        return sendUpstreamFailure(error, null);
      }

      if (!route.active) return sendUnauthorized();

      const upstreamSid = response?.headers?.get?.("mcp-session-id")?.trim() || null;
      const newLocalSid = randomBytes(24).toString("base64url");
      while (route.sessions.size >= this._maxSessionsPerRoute) {
        const oldest = route.sessions.keys().next().value;
        if (oldest === undefined) break;
        route.sessions.delete(oldest);
      }
      route.sessions.set(newLocalSid, {
        initParams: isPlainObject(message.params) ? structuredClone(message.params) : {},
        upstreamSid,
        upstreamConfigHash: upstream.configHash,
        sessionGate: Promise.resolve(),
      });

      return sendBuffer(
        res,
        response.status,
        sanitizeContentType(response.headers?.get?.("content-type")),
        responseBody,
        { "Mcp-Session-Id": newLocalSid },
      );
    }

    // Case 2: Non-initialize without localSid (e.g. `server/discover`) — forward statelessly.
    if (!localSid) {
      const upstream = snapshotRoute(route);
      if (!upstream) return sendUnauthorized();
      let response;
      try {
        response = await this._postUpstream({
          route,
          url: upstream.url,
          headers: upstream.headers,
          body: rawBody,
          currentSessionId: null,
        });
      } catch (error) {
        return sendUpstreamFailure(error, null);
      }

      if (response.status === 202 || response.status === 204) {
        await drainBody(response);
        if (!route.active) return sendUnauthorized();
        return sendEmpty(res, response.status);
      }
      if (!response.ok) {
        await drainBody(response);
        if (!route.active) return sendUnauthorized();
        return sendJson(res, response.status, {
          jsonrpc: "2.0",
          id: errorId,
          error: { code: -32000, message: `Upstream MCP HTTP ${response.status}` },
        });
      }

      let responseBody;
      try {
        responseBody = await readBoundedBuffer(response, this._maxResponseBytes);
      } catch (error) {
        return sendUpstreamFailure(error, null);
      }

      if (!route.active) return sendUnauthorized();

      return sendBuffer(
        res,
        response.status,
        sanitizeContentType(response.headers?.get?.("content-type")),
        responseBody,
      );
    }

    // Case 3: Non-initialize with Mcp-Session-Id (stateful session with token-rotation + 404 recovery).
    const session = route.sessions.get(localSid);
    if (!session) {
      return sendJson(res, 404, {
        jsonrpc: "2.0",
        id: errorId,
        error: { code: -32001, message: "Unknown MCP session" },
      });
    }

    const initialUpstream = snapshotRoute(route);
    if (!initialUpstream) return sendUnauthorized();

    try {
      if (session.upstreamConfigHash !== initialUpstream.configHash) {
        await this._ensureSessionFresh(route, session);
      } else {
        await session.sessionGate.catch(() => {});
        const afterWait = snapshotRoute(route);
        if (afterWait && session.upstreamConfigHash !== afterWait.configHash) {
          await this._ensureSessionFresh(route, session);
        }
      }
    } catch (error) {
      return sendUpstreamFailure(error, localSid);
    }

    let activeUpstream = snapshotRoute(route);
    if (!activeUpstream) return sendUnauthorized();
    const usedUpstreamSid = session.upstreamConfigHash === activeUpstream.configHash
      ? session.upstreamSid
      : null;

    let response;
    try {
      response = await this._postUpstream({
        route,
        url: activeUpstream.url,
        headers: activeUpstream.headers,
        body: rawBody,
        currentSessionId: usedUpstreamSid,
      });

      // Stale/expired upstream session mid-turn: ONE single-flight re-initialize + retry.
      if (response.status === 404 && usedUpstreamSid !== null) {
        await drainBody(response);
        if (!route.active) return sendUnauthorized();
        await this._ensureSessionFresh(route, session, { forceForSid: usedUpstreamSid });
        activeUpstream = snapshotRoute(route);
        if (!activeUpstream) return sendUnauthorized();
        const retrySid = session.upstreamConfigHash === activeUpstream.configHash
          ? session.upstreamSid
          : null;
        response = await this._postUpstream({
          route,
          url: activeUpstream.url,
          headers: activeUpstream.headers,
          body: rawBody,
          currentSessionId: retrySid,
        });
      }
    } catch (error) {
      return sendUpstreamFailure(error, localSid);
    }

    const returnedUpstreamSid = response?.headers?.get?.("mcp-session-id")?.trim();
    if (returnedUpstreamSid && response.ok && route.active && route.configHash === activeUpstream.configHash) {
      session.upstreamSid = returnedUpstreamSid;
    }

    if (response.status === 202 || response.status === 204) {
      await drainBody(response);
      if (!route.active) return sendUnauthorized();
      return sendEmpty(res, response.status, { "Mcp-Session-Id": localSid });
    }

    if (!response.ok) {
      await drainBody(response);
      if (!route.active) return sendUnauthorized();
      return sendJson(res, response.status, {
        jsonrpc: "2.0",
        id: errorId,
        error: { code: -32000, message: `Upstream MCP HTTP ${response.status}` },
      }, { "Mcp-Session-Id": localSid });
    }

    let responseBody;
    try {
      responseBody = await readBoundedBuffer(response, this._maxResponseBytes);
    } catch (error) {
      return sendUpstreamFailure(error, localSid);
    }

    if (!route.active) return sendUnauthorized();

    return sendBuffer(
      res,
      response.status,
      sanitizeContentType(response.headers?.get?.("content-type")),
      responseBody,
      { "Mcp-Session-Id": localSid },
    );
  }
}

export function createAntigravityMcpProxy(options = {}) {
  return new AntigravityMcpProxy(options);
}
