import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutable } from "./config.mjs";
import {
  authenticateResponse,
  consumeJsonLines,
  forwardLine,
  isAuthenticateRequest,
  MAX_ACP_LINE_BYTES,
} from "./pi-acp.mjs";

const SHUTDOWN_GRACE_MS = 1_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function resolveKimiBinary(env = process.env) {
  const configured = env.KIMI_BIN;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("KIMI_BIN must be an absolute path to the kimi executable");
    // Same executability gate as resolveDshAcpBinary: an explicit override
    // that is not executable must fail loud instead of surfacing a confusing
    // spawn error later.
    fs.accessSync(configured, fs.constants.X_OK);
    return configured;
  }
  try {
    return resolveExecutable("kimi", env.PATH || "");
  } catch {
    throw new Error("kimi executable not found on PATH; install the Kimi CLI or set KIMI_BIN to an absolute path");
  }
}

function parseJsonObject(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  return message;
}

/**
 * Client→agent: T3's grok driver always sends `authenticate` with methodId
 * "cached_token" (its only non-xai method), but Kimi CLI validates strictly
 * against its own advertised authMethods and hard-fails the session on the
 * unknown method. Kimi is already logged in locally (device-code login), so
 * the call is semantically a no-op: the shim acknowledges it with a success
 * response and never forwards it. Everything else passes through verbatim.
 * Returns { respond } for an intercepted authenticate, { drop } for an
 * authenticate notification, or { line } for pass-through.
 */
export function transformClientToAgentLine(line) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  const message = parseJsonObject(text);
  if (!message || !isAuthenticateRequest(message)) return { line: text };
  if (!Object.hasOwn(message, "id") || message.id === null || message.id === undefined) return { drop: true };
  return { respond: authenticateResponse(message) };
}

/**
 * Run the T3-to-kimi ACP shim. It deliberately has no payload logging: ACP
 * messages may contain prompts or authentication material.
 */
export function startKimiAcpProxy({
  kimiBin,
  childArgs = ["acp"],
  errorLabel = "t3-kimi-acp",
  env = process.env,
  spawnImpl = spawn,
  stdin = process.stdin,
  stdout = process.stdout,
  maxLineBytes = MAX_ACP_LINE_BYTES,
  exitImpl = defaultExit,
} = {}) {
  const binary = kimiBin || resolveKimiBinary(env);
  const child = spawnImpl(binary, childArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env,
    detached: process.platform !== "win32",
  });
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
    }
    try { child.kill(signal); } catch {}
  };

  const stopRelays = () => {
    stdinRelay?.stop();
    stdoutRelay?.stop();
    stdin.pause?.();
    try { child.stdin.destroy(); } catch {}
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopRelays();
    signalChildTree("SIGTERM");
    forceKillTimer = setTimeout(() => signalChildTree("SIGKILL"), SHUTDOWN_GRACE_MS);
    forceKillTimer.unref();
  };

  const forwarders = new Map(FORWARDED_SIGNALS.map((signal) => {
    const forwarder = () => signalChildTree(signal);
    return [signal, forwarder];
  }));
  const removeForwarders = () => {
    for (const [signal, forwarder] of forwarders) process.removeListener(signal, forwarder);
  };

  stdinRelay = consumeJsonLines(stdin, (line) => {
    const transformed = transformClientToAgentLine(line);
    if (transformed.drop) return null;
    if (transformed.respond) return forwardLine(stdout, JSON.stringify(transformed.respond));
    return forwardLine(child.stdin, transformed.line);
  }, stop, maxLineBytes);
  stdin.once("end", () => {
    try { child.stdin.end(); } catch {}
  });

  stdoutRelay = consumeJsonLines(child.stdout, (line) => forwardLine(stdout, line), stop, maxLineBytes);

  child.stdin.on("error", () => stop());
  stdout.on?.("error", () => stop());
  child.once("error", (error) => {
    console.error(`${errorLabel}: failed to start ${binary}: ${error.message}`);
    stop();
  });
  child.once("exit", (code, signal) => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    stopRelays();
    removeForwarders();
    if (signal && exitImpl === defaultExit) {
      process.kill(process.pid, signal);
      return;
    }
    exitImpl(code ?? 1);
  });
  for (const [signal, forwarder] of forwarders) process.on(signal, forwarder);
  return child;
}

function defaultExit(code) {
  process.exit(code);
}

export function main() {
  let binary;
  try {
    binary = resolveKimiBinary();
  } catch (error) {
    console.error(`t3-kimi-acp: ${error.message}`);
    process.exit(1);
  }
  startKimiAcpProxy({ kimiBin: binary });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
