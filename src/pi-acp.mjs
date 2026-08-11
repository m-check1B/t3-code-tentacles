import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_ACP_LINE_BYTES = 1024 * 1024;
export const MAX_ACP_BUFFER_BYTES = 4 * 1024 * 1024;
export const MAX_ACP_ID_BYTES = 512;
export const MAX_PENDING_ACP_REQUESTS = 4096;

const SHUTDOWN_GRACE_MS = 1_000;

const TRANSFORMED_REQUEST_METHODS = new Set([
  "session/load",
  "session/new",
  "session/set_model",
]);

export function requestKey(id) {
  if (typeof id === "string") {
    if (Buffer.byteLength(id, "utf8") > MAX_ACP_ID_BYTES) return null;
  } else if (typeof id !== "number" || !Number.isFinite(id)) {
    return null;
  }
  return `${typeof id}:${String(id)}`;
}

function selectedId(result, currentKey, legacyKey, entries, idKey) {
  const direct = result[currentKey] ?? result[legacyKey];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && typeof direct.id === "string") return direct.id;
  return entries[0]?.[idKey];
}

/** Convert Pi 0.1.x's legacy session model/mode arrays to ACP state objects. */
export function transformLegacySessionState(result, { currentModelId, currentModeId } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || (!Array.isArray(result.models) && !Array.isArray(result.modes))) return result;
  const transformed = { ...result };
  if (Array.isArray(result.models)) {
    const models = result.models;
    transformed.models = {
      currentModelId: currentModelId || selectedId(result, "currentModelId", "modelId", models, "id"),
      availableModels: models.map((model) => ({ modelId: model?.id, name: model?.name ?? model?.id })),
    };
  }
  if (Array.isArray(result.modes)) {
    const modes = result.modes;
    transformed.modes = {
      currentModeId: currentModeId || selectedId(result, "currentModeId", "modeId", modes, "slug"),
      availableModes: modes.map((mode) => ({ id: mode?.slug ?? mode?.id, name: mode?.name, description: mode?.description })),
    };
  }
  return transformed;
}

export function isAuthenticateRequest(message) {
  return Boolean(message && typeof message === "object" && !Array.isArray(message) && message.method === "authenticate");
}

export function authenticateResponse(request) {
  return { jsonrpc: request?.jsonrpc || "2.0", id: request?.id, result: {} };
}

export function transformPiResponse(message, requestMethod, sessionDefaults) {
  if (!message || typeof message !== "object" || Array.isArray(message) || Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) return message;
  if (requestMethod === "session/set_model") return { ...message, result: {} };
  if (requestMethod === "session/new" || requestMethod === "session/load") {
    const result = transformLegacySessionState(message.result, sessionDefaults);
    return result === message.result ? message : { ...message, result };
  }
  return message;
}

function parseJsonLine(line) {
  try { return JSON.parse(line.toString("utf8")); } catch { return null; }
}

function writeJsonLine(stream, message) {
  return stream.write(`${JSON.stringify(message)}\n`) ? null : stream;
}

export function forwardLine(stream, line) {
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line);
  const framed = Buffer.allocUnsafe(bytes.length + 1);
  bytes.copy(framed);
  framed[bytes.length] = 0x0a;
  return stream.write(framed) ? null : stream;
}

export function consumeJsonLines(
  stream,
  onLine,
  onOversize,
  maxBytes,
  maxBufferedBytes = MAX_ACP_BUFFER_BYTES,
) {
  let pending = Buffer.alloc(0);
  let stopped = false;
  let blocked = false;
  let ended = false;

  const stop = () => {
    stopped = true;
    stream.pause();
  };
  const overflow = () => {
    stop();
    onOversize();
  };
  const processPending = () => {
    if (stopped || blocked) return;
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) {
        if (pending.length > maxBytes || pending.length > maxBufferedBytes) overflow();
        else if (ended) pending = Buffer.alloc(0);
        return;
      }
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length > maxBytes) {
        overflow();
        return;
      }
      const backpressure = onLine(line);
      if (backpressure === false) {
        stop();
        return;
      }
      if (backpressure?.once) {
        blocked = true;
        stream.pause();
        backpressure.once("drain", () => {
          if (stopped) return;
          blocked = false;
          processPending();
          if (!stopped && !blocked) stream.resume();
        });
        return;
      }
    }
  };

  stream.on("data", (chunk) => {
    if (stopped) return;
    const bytes = Buffer.from(chunk);
    if (pending.length + bytes.length > maxBufferedBytes) {
      overflow();
      return;
    }
    pending = Buffer.concat([pending, bytes]);
    processPending();
  });
  stream.on("end", () => {
    ended = true;
    processPending();
    // ACP is JSON-lines; a trailing unterminated value is intentionally not forwarded.
  });
  return { stop, bufferedBytes: () => pending.length };
}

/**
 * Run the T3-to-Pi ACP compatibility relay. It deliberately has no payload
 * logging: ACP messages may contain prompts or local authentication material.
 */
export function startPiAcpProxy({
  piBin = process.env.PI_BIN || "pi",
  piProvider = process.env.PI_PROVIDER?.trim(),
  piModel = process.env.PI_MODEL?.trim(),
  spawnImpl = spawn,
  stdin = process.stdin,
  stdout = process.stdout,
  maxLineBytes = MAX_ACP_LINE_BYTES,
} = {}) {
  const piArgs = ["--acp"];
  if (piProvider) piArgs.push("--provider", piProvider);
  if (piModel) piArgs.push("--model", piModel);
  const child = spawnImpl(piBin, piArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
    detached: process.platform !== "win32",
  });
  const requests = new Map();
  let stopping = false;
  let forceKillTimer;
  let stdinRelay;
  let stdoutRelay;

  const signalChildTree = (signal) => {
    if (!Number.isInteger(child.pid)) {
      try { child.kill(signal); } catch {}
      return;
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (error?.code === "ESRCH") return;
      }
      try { child.kill(signal); } catch {}
      return;
    }
    if (signal === "SIGKILL") {
      try {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
        return;
      } catch {}
    }
    try { child.kill(signal); } catch {}
  };

  const stopRelays = () => {
    stdinRelay?.stop();
    stdoutRelay?.stop();
    stdin.pause?.();
    requests.clear();
    try { child.stdin.destroy(); } catch {}
  };

  const stop = (code = 1) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    stopRelays();
    signalChildTree("SIGTERM");
    forceKillTimer = setTimeout(() => signalChildTree("SIGKILL"), SHUTDOWN_GRACE_MS);
    forceKillTimer.unref();
  };
  const remember = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string" || !Object.hasOwn(message, "id") || message.id === null) return true;
    if (!TRANSFORMED_REQUEST_METHODS.has(message.method)) return true;
    const key = requestKey(message.id);
    if (!key) return false;
    if (requests.has(key) || requests.size >= MAX_PENDING_ACP_REQUESTS) return false;
    requests.set(key, message.method);
    return true;
  };

  stdinRelay = consumeJsonLines(stdin, (line) => {
    const message = parseJsonLine(line);
    if (!message) return forwardLine(child.stdin, line);
    if (isAuthenticateRequest(message)) {
      if (Object.hasOwn(message, "id")) return writeJsonLine(stdout, authenticateResponse(message));
      return;
    }
    if (!remember(message)) { stop(); return false; }
    return forwardLine(child.stdin, line);
  }, stop, maxLineBytes);
  stdin.once("end", () => {
    try { child.stdin.end(); } catch {}
  });

  stdoutRelay = consumeJsonLines(child.stdout, (line) => {
    const message = parseJsonLine(line);
    const responseShaped = message
      && typeof message === "object"
      && !Array.isArray(message)
      && !Object.hasOwn(message, "method")
      && Object.hasOwn(message, "id")
      && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
    if (!responseShaped) {
      return forwardLine(stdout, line);
    }
    const key = requestKey(message.id);
    const method = key ? requests.get(key) : undefined;
    if (method && key) requests.delete(key);
    const transformed = transformPiResponse(message, method, { currentModelId: piModel });
    if (transformed === message) return forwardLine(stdout, line);
    return writeJsonLine(stdout, transformed);
  }, stop, maxLineBytes);

  child.stdin.on("error", () => stop());
  stdout.on?.("error", () => stop());
  child.once("error", () => stop());
  child.once("exit", (code, signal) => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    stopRelays();
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
    if (!stopping) {
      stopping = true;
      if (signal || code !== 0) process.exitCode = code || 1;
    }
  });
  const terminate = () => stop(0);
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startPiAcpProxy();
