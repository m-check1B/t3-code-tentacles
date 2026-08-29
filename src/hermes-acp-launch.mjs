import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DEFAULT_HERMES_PROFILE, resolveExecutable } from "./config.mjs";
import {
  consumeJsonLines,
  forwardLine,
  MAX_ACP_LINE_BYTES,
  MAX_PENDING_ACP_REQUESTS,
  requestKey,
} from "./pi-acp.mjs";

const SHUTDOWN_GRACE_MS = 1_000;
const PROVIDER_VERIFY_TIMEOUT_MS = 5_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SESSION_OPEN_METHODS = new Set(["session/new", "session/load", "session/resume"]);
const GATED_METHODS = new Set(["session/set_model", ...SESSION_OPEN_METHODS]);

export const CODEX_AUTH_MISSING = "codex_auth_missing";
export const PROVIDER_NOT_CONSTRUCTABLE = "provider_not_constructable";
export const PROVIDER_IDENTITY_MISMATCH = "provider_identity_mismatch";
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const GROK_BUILD_MODEL = "grok-build";

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
  if (SESSION_OPEN_METHODS.has(message.method)) {
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

function normalizedModelIdentity(modelId) {
  if (typeof modelId !== "string") return null;
  const trimmed = modelId.trim();
  const requested = requestedProviderFromModel(trimmed);
  if (!requested) {
    // Hermes advertises grok-build as a bare alias. It still requires runtime
    // identity verification: otherwise its profile fallback can answer through
    // DeepSeek while T3 displays grok-build.
    return trimmed === GROK_BUILD_MODEL ? { provider: null, model: trimmed } : null;
  }
  return {
    provider: requested.provider.trim().toLowerCase(),
    model: requested.model.trim(),
  };
}

export function currentModelIdFromSessionResult(result) {
  const models = result?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const current = models.currentModelId ?? models.current_model_id;
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

export function answeringModelMatchesRequested(requestedModelId, answeringModelId) {
  const requested = normalizedModelIdentity(requestedModelId);
  const answering = normalizedModelIdentity(answeringModelId);
  return Boolean(
    requested
    && answering
    && requested.provider === answering.provider
    && requested.model === answering.model,
  );
}

export function providerIdentityMismatchResponse(request, {
  requestedModelId,
  answeringModelId = null,
  code = PROVIDER_IDENTITY_MISMATCH,
} = {}) {
  const requested = normalizedModelIdentity(requestedModelId);
  const answering = normalizedModelIdentity(answeringModelId);
  const renderedRequested = requestedModelId || "unknown";
  const renderedAnswering = answeringModelId || "unverifiable";
  return {
    jsonrpc: request?.jsonrpc || "2.0",
    id: request?.id,
    error: {
      code: -32002,
      message: `${code}: Hermes bound ${renderedAnswering} instead of requested ${renderedRequested}. Refusing to let another provider answer.`,
      data: {
        code,
        requestedProvider: requested?.provider || null,
        requestedModel: requested?.model || null,
        answeringProvider: answering?.provider || null,
        answeringModel: answering?.model || null,
      },
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
  providerVerifyTimeoutMs = PROVIDER_VERIFY_TIMEOUT_MS,
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
  let verificationSequence = 0;
  const requests = new Map();
  const sessions = new Map();
  const verifications = new Map();

  const writeResponse = (message) => forwardLine(stdout, JSON.stringify(message));

  const rememberRequest = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)
      || typeof message.method !== "string" || !Object.hasOwn(message, "id")
      || message.id === null || message.id === undefined) return true;
    const key = requestKey(message.id);
    if (!key || requests.has(key) || requests.size >= MAX_PENDING_ACP_REQUESTS) return false;
    requests.set(key, message);
    return true;
  };

  const sessionFor = (sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) return null;
    let state = sessions.get(sessionId);
    if (!state) {
      if (sessions.size >= MAX_PENDING_ACP_REQUESTS) return null;
      state = { cwd: null, requestedModelId: null, answeringModelId: null, verified: false };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const failSessionRequest = (request, state) => writeResponse(providerIdentityMismatchResponse(request, {
    requestedModelId: state?.requestedModelId,
    answeringModelId: state?.answeringModelId,
  }));

  const nextVerificationId = () => {
    while (true) {
      verificationSequence += 1;
      const id = `tentacles:provider-verify:${verificationSequence}`;
      const key = requestKey(id);
      if (key && !requests.has(key) && !verifications.has(key)) return { id, key };
    }
  };

  const beginVerification = (request, originalResponse) => {
    const sessionId = request.params?.sessionId;
    const state = typeof sessionId === "string" ? sessions.get(sessionId) : null;
    if (!state?.cwd) {
      writeResponse(providerIdentityMismatchResponse(request, { requestedModelId: requestedModelId(request) }));
      return null;
    }
    state.requestedModelId = requestedModelId(request);
    state.answeringModelId = null;
    state.verified = false;
    if (verifications.size >= MAX_PENDING_ACP_REQUESTS) {
      failSessionRequest(request, state);
      stop();
      return false;
    }
    const { id, key } = nextVerificationId();
    const verification = { request, originalResponse, sessionId, key, timer: null };
    verification.timer = setTimeout(() => {
      if (!verifications.delete(key)) return;
      failSessionRequest(request, state);
      stop();
    }, providerVerifyTimeoutMs);
    verification.timer.unref?.();
    verifications.set(key, verification);
    // Hermes returns an empty success for session/set_model even when its
    // _make_agent catch path built the profile fallback. session/load is the
    // nearest structured runtime identity surface: it calls _build_model_state
    // from the actual agent without invoking the model. Replay notifications
    // are suppressed below, and the original success stays withheld until the
    // provider-qualified currentModelId matches exactly.
    return forwardLine(child.stdin, JSON.stringify({
      jsonrpc: request.jsonrpc || "2.0",
      id,
      method: "session/load",
      params: { sessionId, cwd: state.cwd },
    }));
  };

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
    requests.clear();
    sessions.clear();
    for (const verification of verifications.values()) clearTimeout(verification.timer);
    verifications.clear();
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
    if (transformed.respond) return writeResponse(transformed.respond);
    const message = parseJsonObject(transformed.line);
    if (message?.method === "session/prompt") {
      const state = sessionFor(message.params?.sessionId);
      if (state?.requestedModelId && !state.verified) {
        if (!Object.hasOwn(message, "id") || message.id === null || message.id === undefined) return null;
        return failSessionRequest(message, state);
      }
    }
    if (message?.method === "session/set_model") {
      const requestedModel = requestedModelId(message);
      if (normalizedModelIdentity(requestedModel)) {
        const state = sessionFor(message.params?.sessionId);
        if (state) {
          state.requestedModelId = requestedModel;
          state.answeringModelId = null;
          state.verified = false;
        }
        if (!Object.hasOwn(message, "id") || message.id === null || message.id === undefined) return null;
      }
    }
    if (!rememberRequest(message)) {
      stop();
      return false;
    }
    return forwardLine(child.stdin, transformed.line);
  }, stop, maxLineBytes);
  stdin.once("end", () => {
    try { child.stdin.end(); } catch {}
  });

  stdoutRelay = consumeJsonLines(child.stdout, (line) => {
    const message = parseJsonObject(Buffer.isBuffer(line) ? line.toString("utf8") : String(line));
    if (message?.method === "session/update") {
      const sessionId = message.params?.sessionId;
      if ([...verifications.values()].some((verification) => verification.sessionId === sessionId)) return null;
      return forwardLine(stdout, line);
    }
    if (!message || typeof message !== "object" || Array.isArray(message)
      || !Object.hasOwn(message, "id")
      || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) {
      return forwardLine(stdout, line);
    }
    const key = requestKey(message.id);
    const verification = key ? verifications.get(key) : null;
    if (verification) {
      clearTimeout(verification.timer);
      verifications.delete(key);
      const state = sessionFor(verification.sessionId);
      const answeringModelId = Object.hasOwn(message, "result")
        ? currentModelIdFromSessionResult(message.result)
        : null;
      if (state) {
        state.answeringModelId = answeringModelId;
        state.verified = answeringModelMatchesRequested(state.requestedModelId, answeringModelId);
      }
      if (!state?.verified) return failSessionRequest(verification.request, state);
      return writeResponse(verification.originalResponse);
    }
    const request = key ? requests.get(key) : null;
    if (!request) return forwardLine(stdout, line);
    requests.delete(key);
    if (Object.hasOwn(message, "error")) return forwardLine(stdout, line);
    if (request.method === "session/set_model" && normalizedModelIdentity(requestedModelId(request))) {
      return beginVerification(request, message);
    }
    if (SESSION_OPEN_METHODS.has(request.method)) {
      const sessionId = request.params?.sessionId || message.result?.sessionId;
      const state = sessionFor(sessionId);
      if (state) {
        state.cwd = request.params?.cwd || state.cwd;
        state.requestedModelId = requestedModelId(request) || state.requestedModelId;
        state.answeringModelId = currentModelIdFromSessionResult(message.result);
        if (state.requestedModelId) {
          state.verified = answeringModelMatchesRequested(state.requestedModelId, state.answeringModelId);
        }
      }
      if (normalizedModelIdentity(requestedModelId(request)) && !state?.verified) {
        return failSessionRequest(request, state);
      }
    }
    return forwardLine(stdout, line);
  }, stop, maxLineBytes);

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
