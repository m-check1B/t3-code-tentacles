#!/usr/bin/env node
/**
 * Zero-dependency stdio-to-Streamable-HTTP MCP bridge for Local · Antigravity.
 *
 * Antigravity discovers `.agents/plugins/jack-tools/mcp_config.json` lazily on
 * Turn 1 of an `antigravity acp` session. Keeping `mcp_config.json` static and
 * secret-free (pointing at this bridge) while rewriting the per-turn bearer
 * token in `<workspace>/.jack-antigravity-servers.json` lets the same warm
 * `antigravity acp` session stay alive across turns and use every fresh turn
 * token immediately on every JSON-RPC request.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateModeOk } from "./platform.mjs";

export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const MAX_TURN_FILE_BYTES = 256 * 1024;
export const MAX_STDIN_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT = 16;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const NOT_ACTIVE_ERROR_CODE = -32001;
export const NOT_ACTIVE_ERROR_MESSAGE = "Jack MCP server is not active for this turn";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// RFC 9110 field-name token characters (tchar).
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Reject ASCII control characters (including CR, LF, NUL, DEL) in header values.
const HEADER_VALUE_FORBIDDEN_RE = /[\u0000-\u001f\u007f]/;
const MAX_HEADER_VALUE_LEN = 16_384;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultAllowLoopbackHttp(env = process.env) {
  return env?.TENTACLES_BRIDGE_ALLOW_LOOPBACK_HTTP === "1";
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
  if (!isPlainObject(raw)) return null;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || !HEADER_NAME_RE.test(key)) return null;
    if (typeof value !== "string" || value.length > MAX_HEADER_VALUE_LEN || HEADER_VALUE_FORBIDDEN_RE.test(value)) return null;
    headers[key] = value;
  }
  return headers;
}

/**
 * Custody-checked read of `<workspace>/.jack-antigravity-servers.json` for a
 * single server name. Never throws or leaks tokens; returns `{ url, headers }`
 * or `null` when missing, inactive, or failing any custody check.
 */
export function readActiveServer(turnServersPath, serverName, {
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  allowLoopbackHttp = defaultAllowLoopbackHttp(),
} = {}) {
  if (typeof turnServersPath !== "string" || !turnServersPath) return null;
  if (typeof serverName !== "string" || !SERVER_NAME_RE.test(serverName)) return null;
  let fd = null;
  try {
    const linkStat = fs.lstatSync(turnServersPath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
    fd = fs.openSync(
      turnServersPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) return null;
    if (platform !== "win32" && uid !== null && stat.uid !== uid) return null;
    if (!privateModeOk(stat.mode, { platform })) return null;
    if (stat.size < 1 || stat.size > MAX_TURN_FILE_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    const parsed = JSON.parse(buffer.toString("utf8", 0, offset));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.servers)) return null;
    if (!Object.hasOwn(parsed.servers, serverName)) return null;
    const entry = parsed.servers[serverName];
    if (!isPlainObject(entry) || !isAllowedServerUrl(entry.url, { allowLoopbackHttp })) return null;
    const headers = sanitizeHeaders(entry.headers);
    if (headers === null) return null;
    return { url: entry.url, headers };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function hasRequestId(message) {
  return isPlainObject(message) && Object.hasOwn(message, "id") && message.id !== undefined;
}

function configFingerprint(url, headers) {
  const sortedHeaders = Object.keys(headers).sort().map((key) => [key, headers[key]]);
  return createHash("sha256").update(JSON.stringify([url, sortedHeaders])).digest("hex");
}

function normalizeJsonLine(text) {
  const parsed = JSON.parse(text);
  return JSON.stringify(parsed);
}

/**
 * Incremental SSE parser that invokes `onEventData(payload)` for each completed
 * SSE event with one or more `data:` lines.
 */
function createSseParser(onEventData) {
  let buffer = "";
  let dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (payload) onEventData(payload);
  };

  const processLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flushEvent();
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        processLine(line);
      }
    },
    end() {
      if (buffer.length > 0) {
        processLine(buffer);
        buffer = "";
      }
      flushEvent();
    },
  };
}

async function readBoundedText(response, maxBytes) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error("Response exceeds size limit");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("Response exceeds size limit");
  }
  return text;
}

export function createAntigravityMcpBridge({
  turnServersPath,
  serverName,
  writeLine,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  allowLoopbackHttp = defaultAllowLoopbackHttp(),
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) {
  if (typeof serverName !== "string" || !SERVER_NAME_RE.test(serverName)) {
    throw new Error("Invalid MCP server name");
  }
  if (typeof turnServersPath !== "string" || !turnServersPath) {
    throw new Error("Missing turn servers path");
  }
  if (typeof writeLine !== "function") {
    throw new Error("Missing writeLine sink");
  }

  let activeConfigHash = null;
  let sessionId = null;
  let lastInitParams = null;
  // Single-flight gate for initialize, notifications/initialized, and stateful token-rotation transitions.
  let sessionGate = Promise.resolve();

  const runSerialized = (task) => {
    const run = sessionGate.catch(() => {}).then(task);
    sessionGate = run.catch(() => {});
    return run;
  };

  const emitError = (id, code, message) => {
    writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  };

  const postJsonRpc = async ({ url, headers, body, currentSessionId }) => {
    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value);
    }
    // Bridge-owned headers always win case-insensitively.
    requestHeaders.set("Content-Type", "application/json");
    requestHeaders.set("Accept", "application/json, text/event-stream");
    if (currentSessionId) requestHeaders.set("Mcp-Session-Id", currentSessionId);
    else requestHeaders.delete("Mcp-Session-Id");
    return fetchImpl(url, {
      method: "POST",
      headers: requestHeaders,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  const drainBody = async (response) => {
    try {
      if (response?.body?.cancel) await response.body.cancel();
      else if (typeof response?.text === "function") await response.text();
    } catch {}
  };

  const reinitializeStatefulSession = async (active, expectedConfigHash) => {
    if (!lastInitParams || activeConfigHash !== expectedConfigHash) return null;
    try {
      const initBody = JSON.stringify({
        jsonrpc: "2.0",
        id: "__tentacles_bridge_reinit__",
        method: "initialize",
        params: lastInitParams,
      });
      const initResponse = await postJsonRpc({
        url: active.url,
        headers: active.headers,
        body: initBody,
        currentSessionId: null,
      });
      const nextSessionId = initResponse?.headers?.get?.("mcp-session-id")?.trim() || null;
      await drainBody(initResponse);
      if (!initResponse.ok || activeConfigHash !== expectedConfigHash) return null;
      if (nextSessionId) {
        sessionId = nextSessionId;
        try {
          const notifResponse = await postJsonRpc({
            url: active.url,
            headers: active.headers,
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            currentSessionId: nextSessionId,
          });
          await drainBody(notifResponse);
        } catch {}
      }
      return nextSessionId;
    } catch {
      return null;
    }
  };

  const emitSseResponse = async (response) => {
    let emitted = 0;
    const parser = createSseParser((payload) => {
      try {
        writeLine(normalizeJsonLine(payload));
        emitted += 1;
      } catch {
        // Skip non-JSON SSE control/keepalive payloads.
      }
    });
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxResponseBytes) {
            try { await reader.cancel(); } catch {}
            throw new Error("Response exceeds size limit");
          }
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.end();
      } finally {
        try { reader.releaseLock?.(); } catch {}
      }
      return emitted;
    }
    const text = await readBoundedText(response, maxResponseBytes);
    parser.push(text);
    parser.end();
    return emitted;
  };

  const processMessage = async (rawLine, message, { insideGate = false } = {}) => {
    const isRequest = hasRequestId(message);
    const isInitialize = message.method === "initialize";
    if (isInitialize) {
      lastInitParams = isPlainObject(message.params) ? message.params : {};
    }

    const active = readActiveServer(turnServersPath, serverName, { platform, uid, allowLoopbackHttp });
    if (!active) {
      sessionId = null;
      activeConfigHash = null;
      if (isRequest) emitError(message.id, NOT_ACTIVE_ERROR_CODE, NOT_ACTIVE_ERROR_MESSAGE);
      return;
    }

    const requestConfigHash = configFingerprint(active.url, active.headers);
    if (requestConfigHash !== activeConfigHash) {
      const transition = async () => {
        if (requestConfigHash === activeConfigHash) return;
        const wasStateful = sessionId !== null;
        sessionId = null;
        activeConfigHash = requestConfigHash;
        if (wasStateful && !isInitialize && lastInitParams) {
          await reinitializeStatefulSession(active, requestConfigHash);
        }
      };
      if (insideGate) await transition();
      else await runSerialized(transition);
    }

    const usedSessionId = isInitialize ? null : (activeConfigHash === requestConfigHash ? sessionId : null);

    let response;
    try {
      response = await postJsonRpc({
        url: active.url,
        headers: active.headers,
        body: rawLine,
        currentSessionId: usedSessionId,
      });

      if (response.status === 404 && !isInitialize && usedSessionId !== null && lastInitParams) {
        await drainBody(response);
        const reinit = async () => {
          if (activeConfigHash !== requestConfigHash || sessionId !== usedSessionId) return;
          sessionId = null;
          await reinitializeStatefulSession(active, requestConfigHash);
        };
        if (insideGate) await reinit();
        else await runSerialized(reinit);
        const retrySessionId = activeConfigHash === requestConfigHash ? sessionId : null;
        response = await postJsonRpc({
          url: active.url,
          headers: active.headers,
          body: rawLine,
          currentSessionId: retrySessionId,
        });
      }
    } catch (error) {
      if (isRequest) {
        const safeMessage = error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "Upstream MCP request timed out"
          : "Upstream MCP request failed";
        emitError(message.id, -32000, safeMessage);
      }
      return;
    }

    const returnedSessionId = response?.headers?.get?.("mcp-session-id")?.trim();
    if (returnedSessionId && activeConfigHash === requestConfigHash) {
      sessionId = returnedSessionId;
    }

    if (response.status === 202 || response.status === 204) {
      await drainBody(response);
      return;
    }

    if (!response.ok) {
      await drainBody(response);
      if (isRequest) emitError(message.id, -32000, `Upstream MCP HTTP ${response.status}`);
      return;
    }

    const contentType = String(response?.headers?.get?.("content-type") ?? "").toLowerCase();
    try {
      if (contentType.includes("text/event-stream")) {
        const emitted = await emitSseResponse(response);
        if (emitted === 0 && isRequest) {
          emitError(message.id, -32000, "Upstream MCP returned an empty response");
        }
        return;
      }
      const text = (await readBoundedText(response, maxResponseBytes)).trim();
      if (!text) {
        if (isRequest) emitError(message.id, -32000, "Upstream MCP returned an empty response");
        return;
      }
      writeLine(normalizeJsonLine(text));
    } catch {
      if (isRequest) emitError(message.id, -32000, "Upstream MCP returned an invalid response");
    }
  };

  const handleLine = async (rawInput) => {
    const rawLine = rawInput.endsWith("\r") ? rawInput.slice(0, -1) : rawInput;
    if (!rawLine.trim()) return;
    let message;
    try {
      message = JSON.parse(rawLine);
    } catch {
      emitError(null, -32700, "Parse error");
      return;
    }
    if (!isPlainObject(message)) {
      emitError(null, -32600, "Invalid Request");
      return;
    }

    const needsLifecycleGate = message.method === "initialize" || message.method === "notifications/initialized";
    if (needsLifecycleGate) {
      await runSerialized(() => processMessage(rawLine, message, { insideGate: true }));
      return;
    }

    await sessionGate;
    await processMessage(rawLine, message, { insideGate: false });
  };

  return {
    handleLine,
    getSessionId: () => sessionId,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

export function runStdioBridge(argv = process.argv) {
  const [, , turnServersPath, serverName] = argv;
  if (typeof turnServersPath !== "string" || !turnServersPath || typeof serverName !== "string" || !SERVER_NAME_RE.test(serverName)) {
    process.exitCode = 2;
    return;
  }

  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") process.exit(0);
  });

  const writeLine = (line) => {
    try {
      process.stdout.write(`${line}\n`);
    } catch {}
  };

  const bridge = createAntigravityMcpBridge({
    turnServersPath,
    serverName,
    writeLine,
  });

  let buffer = "";
  let droppingOversized = false;
  let stdinEnded = false;
  const queue = [];
  const pending = new Set();

  const maybeExit = () => {
    if (stdinEnded && queue.length === 0 && pending.size === 0) {
      process.exit(0);
    }
  };

  const pump = () => {
    while (pending.size < MAX_IN_FLIGHT && queue.length > 0) {
      const line = queue.shift();
      const task = bridge.handleLine(line).catch(() => {});
      pending.add(task);
      task.finally(() => {
        pending.delete(task);
        if (!stdinEnded && queue.length < MAX_IN_FLIGHT) process.stdin.resume();
        pump();
        maybeExit();
      });
    }
    if (!stdinEnded && queue.length >= MAX_IN_FLIGHT) {
      process.stdin.pause();
    }
    maybeExit();
  };

  const enqueueLine = (line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_STDIN_LINE_BYTES) {
      writeLine(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }));
      return;
    }
    queue.push(line);
    pump();
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) {
        if (!droppingOversized && Buffer.byteLength(buffer, "utf8") > MAX_STDIN_LINE_BYTES) {
          droppingOversized = true;
          buffer = "";
        } else if (droppingOversized) {
          buffer = "";
        }
        break;
      }
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (droppingOversized) {
        droppingOversized = false;
        writeLine(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }));
      } else {
        enqueueLine(line);
      }
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    if (droppingOversized) {
      droppingOversized = false;
      writeLine(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }));
    } else if (buffer.trim()) {
      enqueueLine(buffer);
      buffer = "";
    }
    pump();
  });
  process.stdin.resume();
}

if (isMainModule()) {
  runStdioBridge(process.argv);
}
