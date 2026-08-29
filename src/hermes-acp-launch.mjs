import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DEFAULT_HERMES_PROFILE, resolveExecutable } from "./config.mjs";
import { consumeJsonLines, forwardLine, MAX_ACP_LINE_BYTES } from "./pi-acp.mjs";

const SHUTDOWN_GRACE_MS = 1_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const GATED_METHODS = new Set(["session/set_model", "session/new"]);

export const CODEX_AUTH_MISSING = "codex_auth_missing";
export const PROVIDER_NOT_CONSTRUCTABLE = "provider_not_constructable";
export const OPENAI_CODEX_PROVIDER = "openai-codex";

export function hermesAuthFile(home = os.homedir()) {
  return path.join(home, ".hermes", "auth.json");
}

export function codexCliAuthFile(home = os.homedir(), env = process.env) {
  const configured = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("CODEX_HOME must be an absolute path");
    return path.join(configured, "auth.json");
  }
  return path.join(home, ".codex", "auth.json");
}

export function resolveHermesBinary(env = process.env) {
  const configured = env.HERMES_BIN;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("HERMES_BIN must be an absolute path to the hermes executable");
    fs.accessSync(configured, fs.constants.X_OK);
    return configured;
  }
  try {
    return resolveExecutable("hermes", env.PATH || "");
  } catch {
    throw new Error("hermes executable not found on PATH; install Hermes Agent or set HERMES_BIN to an absolute path");
  }
}

export function requestedProviderFromModel(modelId) {
  if (typeof modelId !== "string") return null;
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) };
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readJsonObject(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Auth file unreadable: ${file} (${error.code || error.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Auth file unreadable: ${file} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

function tokensLookPresent(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;
  return hasNonEmptyString(tokens.access_token) && hasNonEmptyString(tokens.refresh_token);
}

function hermesStoreHasCodexAuth(parsed) {
  if (!parsed) return false;
  const providerState = parsed.providers?.[OPENAI_CODEX_PROVIDER];
  if (tokensLookPresent(providerState?.tokens)) return true;
  const pool = parsed.credential_pool?.[OPENAI_CODEX_PROVIDER];
  if (!Array.isArray(pool)) return false;
  return pool.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && hasNonEmptyString(entry.access_token));
}

export function hasOpenAiCodexAuth({
  home = os.homedir(),
  env = process.env,
  hermesAuthPath = hermesAuthFile(home),
  codexAuthPath = codexCliAuthFile(home, env),
} = {}) {
  if (hermesStoreHasCodexAuth(readJsonObject(hermesAuthPath))) return true;
  const cli = readJsonObject(codexAuthPath);
  return tokensLookPresent(cli?.tokens);
}

export function inspectHermesOpenaiCodexAuth(options) {
  const present = hasOpenAiCodexAuth(options);
  return present
    ? { present: true, constructable: true, provider: OPENAI_CODEX_PROVIDER }
    : { present: false, constructable: false, provider: OPENAI_CODEX_PROVIDER, code: CODEX_AUTH_MISSING };
}

export function providerNotConstructableMessage(provider = OPENAI_CODEX_PROVIDER, code = CODEX_AUTH_MISSING) {
  return `${code}: Hermes cannot construct ${provider}; credentials are not stored. Refusing to fall open to another provider.`;
}

export function requireRequestedProviderConstructable(modelId, options) {
  const requested = requestedProviderFromModel(modelId);
  if (!requested) return null;
  if (requested.provider !== OPENAI_CODEX_PROVIDER) return requested;
  if (hasOpenAiCodexAuth(options)) return requested;
  const error = new Error(providerNotConstructableMessage(requested.provider, CODEX_AUTH_MISSING));
  error.code = CODEX_AUTH_MISSING;
  error.provider = requested.provider;
  throw error;
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

function requestedModelId(message) {
  const params = message?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  if (message.method === "session/set_model") {
    return typeof params.modelId === "string" ? params.modelId : typeof params.model === "string" ? params.model : null;
  }
  if (message.method === "session/new") {
    return typeof params.modelId === "string" ? params.modelId : typeof params.model === "string" ? params.model : null;
  }
  return null;
}

export function providerConstructionErrorResponse(request, { provider = OPENAI_CODEX_PROVIDER, code = CODEX_AUTH_MISSING } = {}) {
  return {
    jsonrpc: request?.jsonrpc || "2.0",
    id: request.id,
    error: {
      code: -32001,
      message: providerNotConstructableMessage(provider, code),
      data: { code, provider },
    },
  };
}

/**
 * Client→agent: fail closed when T3 asks Hermes for openai-codex and Codex
 * credentials are missing. Hermes ACP otherwise accepts session/set_model and
 * silently constructs the profile's fallback provider. Returns { respond }
 * for a named auth error, { drop } for a notification with no id, or { line }
 * for pass-through. Never logs payloads.
 */
export function transformClientToAgentLine(line, options) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  const message = parseJsonObject(text);
  if (!message || typeof message.method !== "string" || !GATED_METHODS.has(message.method)) {
    return { line: text };
  }
  const modelId = requestedModelId(message);
  if (!modelId) return { line: text };
  try {
    requireRequestedProviderConstructable(modelId, options);
    return { line: text };
  } catch (error) {
    if (error?.code !== CODEX_AUTH_MISSING) throw error;
    if (!Object.hasOwn(message, "id") || message.id === null || message.id === undefined) return { drop: true };
    return {
      respond: providerConstructionErrorResponse(message, {
        provider: error.provider || OPENAI_CODEX_PROVIDER,
        code: error.code,
      }),
    };
  }
}

export function startHermesAcpProxy({
  hermesBin,
  hermesProfile = process.env.HERMES_PROFILE || DEFAULT_HERMES_PROFILE,
  env = process.env,
  spawnImpl = spawn,
  stdin = process.stdin,
  stdout = process.stdout,
  maxLineBytes = MAX_ACP_LINE_BYTES,
  exitImpl = defaultExit,
  authOptions,
} = {}) {
  const binary = hermesBin || resolveHermesBinary(env);
  const profile = hermesProfile || DEFAULT_HERMES_PROFILE;
  const child = spawnImpl(binary, ["--profile", profile, "acp"], {
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
    const transformed = transformClientToAgentLine(line, authOptions);
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
    console.error(`t3-hermes-acp: failed to start ${binary}: ${error.message}`);
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
    binary = resolveHermesBinary();
  } catch (error) {
    console.error(`t3-hermes-acp: ${error.message}`);
    process.exit(1);
  }
  startHermesAcpProxy({ hermesBin: binary });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
