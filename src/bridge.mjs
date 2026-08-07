import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_BRIDGE_STATE_FILE,
  DEFAULT_HERMES_PROFILE,
  DEFAULT_HERMES_URL,
  DEFAULT_INSTANCE_ID,
  DEFAULT_MODEL,
  ensurePrivateDirectory,
  requireLoopbackUrl,
} from "./config.mjs";
import { T3HttpError } from "./t3-client.mjs";

const HERMES_MENTION = /(^|\s)@hermes\b/i;
const BRIDGE_OWNER_VARIABLE = "T3_HERMES_BRIDGE_OWNER";
const BRIDGE_OWNER_VALUE = "t3-hermes-bridge/v1";
const PROCESSED_FALLBACK_LIMIT = 1_000;

export function isBridgeOwnedProvider(instance) {
  if (instance?.driver !== "grok") return false;
  const hasMarker = (instance.environment || []).some(
    (variable) => variable.name === BRIDGE_OWNER_VARIABLE && variable.value === BRIDGE_OWNER_VALUE,
  );
  return hasMarker;
}

export function hasRedactedSecrets(providerInstances) {
  return Object.values(providerInstances || {}).some((instance) =>
    (instance.environment || []).some(
      (variable) => variable.sensitive === true && variable.valueRedacted === true,
    ),
  );
}

export async function installProvider(client, {
  wrapperPath,
  instanceId = DEFAULT_INSTANCE_ID,
  model = DEFAULT_MODEL,
  hermesBin = "hermes",
  hermesProfile = DEFAULT_HERMES_PROFILE,
} = {}) {
  if (!wrapperPath || !path.isAbsolute(wrapperPath)) {
    throw new Error("install-provider requires an absolute ACP wrapper path");
  }
  const settings = await client.getSettings();
  const current = settings.providerInstances || {};
  if (hasRedactedSecrets(current)) {
    throw new Error(
      "Refusing provider map replacement because T3 returned redacted provider secrets; use the T3 settings UI or remove those secrets first",
    );
  }
  if (current[instanceId] && !isBridgeOwnedProvider(current[instanceId])) {
    throw new Error(
      `Refusing to replace provider instance '${instanceId}' because it is not owned by t3-hermes-bridge`,
    );
  }
  const providerInstances = {
    ...current,
    [instanceId]: {
      driver: "grok",
      displayName: "Hermes",
      accentColor: "#8B5CF6",
      enabled: true,
      environment: [
        { name: BRIDGE_OWNER_VARIABLE, value: BRIDGE_OWNER_VALUE, sensitive: false },
        { name: "HERMES_BIN", value: hermesBin, sensitive: false },
        { name: "HERMES_PROFILE", value: hermesProfile, sensitive: false },
      ],
      config: {
        binaryPath: wrapperPath,
        customModels: [model],
      },
    },
  };
  await client.updateSettings({ providerInstances });
  return await client.refreshProvider(instanceId);
}

export async function removeProvider(client, { instanceId = DEFAULT_INSTANCE_ID } = {}) {
  const settings = await client.getSettings();
  const current = settings.providerInstances || {};
  if (hasRedactedSecrets(current)) {
    throw new Error("Refusing provider map replacement because T3 returned redacted provider secrets");
  }
  if (!(instanceId in current)) return { removed: false };
  if (!isBridgeOwnedProvider(current[instanceId])) {
    throw new Error(
      `Refusing to remove provider instance '${instanceId}' because it is not owned by t3-hermes-bridge`,
    );
  }
  const providerInstances = { ...current };
  delete providerInstances[instanceId];
  await client.updateSettings({ providerInstances });
  return { removed: true };
}

function now() {
  return new Date().toISOString();
}

function userMessage(text, messageId = randomUUID()) {
  return { messageId, role: "user", text, attachments: [] };
}

async function waitFor(check, description, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for T3 projection: ${description}`);
}

async function getThreadIfProjected(client, threadId) {
  try {
    return await client.thread(threadId);
  } catch (error) {
    if (error instanceof T3HttpError && error.status === 404) return null;
    throw error;
  }
}

async function waitForThread(client, threadId) {
  return await waitFor(() => getThreadIfProjected(client, threadId), `thread ${threadId}`);
}

async function waitForMessage(client, threadId, messageId) {
  return await waitFor(async () => {
    const detail = await getThreadIfProjected(client, threadId);
    return detail?.thread?.messages?.some((message) => message.id === messageId) ? detail : null;
  }, `message ${messageId} in thread ${threadId}`);
}

export async function ensureProject(client, {
  workspace,
  title,
  instanceId = DEFAULT_INSTANCE_ID,
  model = DEFAULT_MODEL,
}) {
  const shell = await client.shell();
  const existing = shell.projects.find((project) => project.workspaceRoot === workspace);
  if (existing) return { project: existing, created: false, shell };

  const projectId = randomUUID();
  const createdAt = now();
  await client.dispatch({
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: title || path.basename(workspace) || "Hermes",
    workspaceRoot: workspace,
    createWorkspaceRootIfMissing: false,
    defaultModelSelection: { instanceId, model },
    createdAt,
  });
  const projected = await waitFor(async () => {
    const nextShell = await client.shell();
    return nextShell.projects.find((project) => project.id === projectId) || null;
  }, `project ${projectId}`);
  return {
    project: projected,
    created: true,
    shell,
  };
}

export async function startThread(client, {
  projectId,
  title,
  message,
  instanceId = DEFAULT_INSTANCE_ID,
  model = DEFAULT_MODEL,
  runtimeMode = "approval-required",
  threadId = randomUUID(),
  threadCommandId = randomUUID(),
  turnCommandId = randomUUID(),
  messageId = randomUUID(),
}) {
  const createdAt = now();
  let detail = await getThreadIfProjected(client, threadId);
  if (!detail) {
    await client.dispatch({
      type: "thread.create",
      commandId: threadCommandId,
      threadId,
      projectId,
      title,
      modelSelection: { instanceId, model },
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    detail = await waitForThread(client, threadId);
  }
  if (!(detail.thread.messages || []).some((entry) => entry.id === messageId)) {
    await client.dispatch({
      type: "thread.turn.start",
      commandId: turnCommandId,
      threadId,
      message: userMessage(message, messageId),
      modelSelection: { instanceId, model },
      titleSeed: title,
      runtimeMode,
      interactionMode: "default",
      createdAt: now(),
    });
    await waitForMessage(client, threadId, messageId);
  }
  return { threadId, projectId };
}

export async function continueThread(client, {
  threadId,
  message,
  instanceId = DEFAULT_INSTANCE_ID,
  model = DEFAULT_MODEL,
  runtimeMode = "approval-required",
  turnCommandId = randomUUID(),
  messageId = randomUUID(),
}) {
  const detail = await waitForThread(client, threadId);
  if (!(detail.thread.messages || []).some((entry) => entry.id === messageId)) {
    await client.dispatch({
      type: "thread.turn.start",
      commandId: turnCommandId,
      threadId,
      message: userMessage(message, messageId),
      modelSelection: { instanceId, model },
      runtimeMode,
      interactionMode: "default",
      createdAt: now(),
    });
    await waitForMessage(client, threadId, messageId);
  }
  return { threadId };
}

export async function originate(client, {
  workspace,
  title,
  message,
  instanceId = DEFAULT_INSTANCE_ID,
  model = DEFAULT_MODEL,
  runtimeMode = "approval-required",
}) {
  const { project, created } = await ensureProject(client, {
    workspace,
    title: path.basename(workspace),
    instanceId,
    model,
  });
  const result = await startThread(client, {
    projectId: project.id,
    title,
    message,
    instanceId,
    model,
    runtimeMode,
  });
  return { ...result, projectCreated: created };
}

export function readBridgeState(stateFile = DEFAULT_BRIDGE_STATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      version: 1,
      startedAt: parsed.startedAt || null,
      processedMessageIds: parsed.processedMessageIds || [],
      links: parsed.links || {},
      pending: parsed.pending || {},
      lastSeenMessageByThread: parsed.lastSeenMessageByThread || {},
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      version: 1,
      startedAt: null,
      processedMessageIds: [],
      links: {},
      pending: {},
      lastSeenMessageByThread: {},
    };
  }
}

export function writeBridgeState(state, stateFile = DEFAULT_BRIDGE_STATE_FILE) {
  ensurePrivateDirectory(path.dirname(stateFile));
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
  fs.chmodSync(stateFile, 0o600);
}

export function stripMention(text) {
  return text.replace(HERMES_MENTION, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

function acquireStateLock(stateFile) {
  ensurePrivateDirectory(path.dirname(stateFile));
  const lockFile = `${stateFile}.lock`;
  const open = () => {
    const descriptor = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`);
    return descriptor;
  };
  let descriptor;
  try {
    descriptor = open();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (age > 60_000) {
        try {
          process.kill(lock.pid, 0);
        } catch (cause) {
          stale = cause.code === "ESRCH";
        }
      }
    } catch {}
    if (!stale) return null;
    fs.unlinkSync(lockFile);
    descriptor = open();
  }
  return () => {
    try {
      fs.closeSync(descriptor);
    } finally {
      try {
        fs.unlinkSync(lockFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
}

export async function routeMentionsOnce(client, {
  stateFile = DEFAULT_BRIDGE_STATE_FILE,
  instanceId = DEFAULT_INSTANCE_ID,
  model = DEFAULT_MODEL,
  maxMessages = 10,
} = {}) {
  const release = acquireStateLock(stateFile);
  if (!release) return [];
  try {
    return await routeMentionsLocked(client, { stateFile, instanceId, model, maxMessages });
  } finally {
    release();
  }
}

async function routeMentionsLocked(client, { stateFile, instanceId, model, maxMessages }) {
  const state = readBridgeState(stateFile);
  if (!state.startedAt) {
    state.startedAt = now();
    writeBridgeState(state, stateFile);
    return [];
  }
  const processed = new Set(state.processedMessageIds);
  const shell = await client.shell();
  const threadById = new Map(shell.threads.map((thread) => [thread.id, thread]));
  const routed = [];

  for (const source of shell.threads) {
    if (routed.length >= maxMessages) break;
    if (source.modelSelection?.instanceId === instanceId || source.archivedAt) continue;
    const detail = await client.thread(source.id);
    const messages = detail.thread.messages || [];
    let lastSeenMessageId = state.lastSeenMessageByThread[source.id];
    let lastSeenIndex = lastSeenMessageId
      ? messages.findIndex((message) => message.id === lastSeenMessageId)
      : -1;
    if (lastSeenIndex < 0 && !lastSeenMessageId && messages.length > 0) {
      const firstPostStartIndex = messages.findIndex(
        (message) => !message.createdAt || message.createdAt > state.startedAt,
      );
      const historicalEndIndex = firstPostStartIndex < 0 ? messages.length - 1 : firstPostStartIndex - 1;
      if (historicalEndIndex >= 0) {
        lastSeenIndex = historicalEndIndex;
        lastSeenMessageId = messages[historicalEndIndex].id;
        state.lastSeenMessageByThread[source.id] = lastSeenMessageId;
        writeBridgeState(state, stateFile);
      }
    }
    const unseenMessages = lastSeenIndex >= 0 ? messages.slice(lastSeenIndex + 1) : messages;
    let cursorDirty = false;
    for (const message of unseenMessages) {
      if (routed.length >= maxMessages) break;
      if (message.role !== "user" || processed.has(message.id) || !HERMES_MENTION.test(message.text)) {
        state.lastSeenMessageByThread[source.id] = message.id;
        cursorDirty = true;
        continue;
      }
      if (message.createdAt && message.createdAt <= state.startedAt) {
        processed.add(message.id);
        state.processedMessageIds = [...processed].slice(-PROCESSED_FALLBACK_LIMIT);
        state.lastSeenMessageByThread[source.id] = message.id;
        cursorDirty = true;
        continue;
      }
      let intent = state.pending[message.id];
      if (!intent) {
        const correlationId = randomUUID();
        let targetThreadId = state.links[source.id];
        if (!targetThreadId || !threadById.has(targetThreadId)) {
          targetThreadId = randomUUID();
          state.links[source.id] = targetThreadId;
        }
        intent = {
          sourceThreadId: source.id,
          targetThreadId,
          correlationId,
          threadCommandId: randomUUID(),
          turnCommandId: randomUUID(),
          targetMessageId: randomUUID(),
          prompt: [
            `[t3-hermes-bridge correlation=${correlationId} sourceThread=${source.id} hop=1/1]`,
            "You were mentioned from another T3 thread. Respond in this linked Hermes thread.",
            "Do not route or repeat @hermes mentions.",
            "",
            stripMention(message.text) || "Please inspect the source thread context and help.",
          ].join("\n"),
        };
        state.pending[message.id] = intent;
        writeBridgeState(state, stateFile);
        cursorDirty = false;
      }

      await startThread(client, {
        projectId: source.projectId,
        title: `[Hermes] ${source.title}`,
        message: intent.prompt,
        instanceId,
        model,
        threadId: intent.targetThreadId,
        threadCommandId: intent.threadCommandId,
        turnCommandId: intent.turnCommandId,
        messageId: intent.targetMessageId,
      });
      threadById.set(intent.targetThreadId, {
        id: intent.targetThreadId,
        modelSelection: { instanceId },
      });
      processed.add(message.id);
      routed.push({
        sourceThreadId: source.id,
        targetThreadId: intent.targetThreadId,
        messageId: message.id,
        correlationId: intent.correlationId,
      });
      state.processedMessageIds = [...processed].slice(-PROCESSED_FALLBACK_LIMIT);
      state.lastSeenMessageByThread[source.id] = message.id;
      delete state.pending[message.id];
      writeBridgeState(state, stateFile);
      cursorDirty = false;
    }
    if (cursorDirty) writeBridgeState(state, stateFile);
  }
  return routed;
}

export async function doctor(client, {
  hermesUrl = process.env.HERMES_URL || DEFAULT_HERMES_URL,
  instanceId = DEFAULT_INSTANCE_ID,
} = {}) {
  const shell = await client.shell();
  const settings = await client.getSettings();
  const config = await client.rpc("server.getConfig", {});
  const provider = config.providers.find((entry) => entry.instanceId === instanceId);
  const hermesOrigin = requireLoopbackUrl(hermesUrl, "HERMES_URL");
  const hermesResponse = await fetch(`${hermesOrigin}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!hermesResponse.ok) throw new Error(`Hermes health check failed (${hermesResponse.status})`);
  const health = await hermesResponse.json();
  return {
    t3: { reachable: true, projects: shell.projects.length, threads: shell.threads.length },
    hermes: { reachable: true, status: health.status || "ok", version: health.version || null },
    provider: {
      configured: Boolean(settings.providerInstances?.[instanceId]),
      instanceId,
      ready: provider?.status === "ready",
      installed: provider?.installed === true,
      status: provider?.status || null,
      modelCount: provider?.models?.length || 0,
    },
  };
}
