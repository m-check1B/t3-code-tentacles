import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";
import {
  ALLOW_ALL_MENTION_POLICY,
  hasRedactedSecrets,
  installProvider,
  isBridgeOwnedProvider,
  isNativeGrokInstance,
  NATIVE_GROK_INSTANCE_ID,
  readBridgeState,
  removeProvider,
  restoreNativeGrok,
  routeMentionsOnce,
  startThread,
  stripMention,
  useNativeGrokCachedAuth,
  writeBridgeState,
} from "../src/bridge.mjs";
import { readToken, requireLoopbackUrl, resolveExecutable } from "../src/config.mjs";
import {
  LAUNCH_AGENT_LABEL,
  assertBridgeOwnedLaunchAgentFile,
  createRuntimeSnapshot,
  isBridgeOwnedLaunchAgent,
  renderLaunchAgent,
} from "../src/service.mjs";

test("HTTP dispatch authenticates and sends the exact client command", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ sequence: 7 }), { status: 200 });
  };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "test-token", fetchImpl });
  const command = { type: "project.delete", commandId: "c", projectId: "p" };
  assert.deepEqual(await client.dispatch(command), { sequence: 7 });
  assert.equal(calls[0].options.headers.authorization, "Bearer test-token");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].options.body), command);
});

test("T3 origin is loopback-only and token files reject symlinks", () => {
  assert.equal(requireLoopbackUrl("http://127.0.0.1:3773", "T3_URL"), "http://127.0.0.1:3773");
  assert.throws(() => requireLoopbackUrl("https://attacker.example", "T3_URL"), /loopback/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-token-test-"));
  const tokenFile = path.join(directory, "token");
  const tokenLink = path.join(directory, "token-link");
  fs.writeFileSync(tokenFile, "a".repeat(32), { mode: 0o600 });
  fs.symlinkSync(tokenFile, tokenLink);
  assert.equal(readToken(tokenFile), "a".repeat(32));
  assert.throws(() => readToken(tokenLink), /must not be a symlink/);
});

test("token, origin, and executable validation fail closed at their boundaries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-config-test-"));
  const tokenFile = path.join(directory, "token");
  fs.writeFileSync(tokenFile, "a".repeat(32), { mode: 0o600 });

  fs.chmodSync(tokenFile, 0o644);
  assert.throws(() => readToken(tokenFile), /permissions are too broad/);
  fs.chmodSync(tokenFile, 0o600);
  fs.writeFileSync(tokenFile, "short");
  assert.throws(() => readToken(tokenFile), /size is outside/);
  fs.writeFileSync(tokenFile, `${"a".repeat(31)}\u0000`);
  assert.throws(() => readToken(tokenFile), /invalid format/);

  assert.throws(() => requireLoopbackUrl("ftp://127.0.0.1:3773", "T3_URL"), /http or https/);
  assert.throws(() => requireLoopbackUrl("http://user:pass@127.0.0.1:3773", "T3_URL"), /origin URL/);
  assert.throws(() => requireLoopbackUrl("http://localhost:3773/not-an-origin", "T3_URL"), /origin URL/);

  const executable = path.join(directory, "bridge-bin");
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
  assert.equal(resolveExecutable("bridge-bin", `${directory}${path.delimiter}/missing`), fs.realpathSync(executable));
  assert.throws(() => resolveExecutable("missing-bin", directory), /Executable not found/);
});

test("HTTP response bodies are size-bounded", async () => {
  const client = new T3Client({
    token: "test-token",
    responseMaxBytes: 100,
    fetchImpl: async () => new Response("x".repeat(101), { status: 200 }),
  });
  await assert.rejects(client.shell(), /exceeds 100 bytes/);
});

test("WebSocket RPC failures redact server-controlled token and prompt material", async () => {
  class FailingWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open"));
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    send(payload) {
      const { id } = JSON.parse(payload);
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({
          _tag: "Exit",
          requestId: id,
          exit: { _tag: "Failure", token: "rpc-token-leak", prompt: "rpc-prompt-leak" },
        }),
      }));
    }

    close() {}

    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
  }

  const client = new T3Client({
    token: "test-token",
    WebSocketImpl: FailingWebSocket,
    fetchImpl: async () => new Response(JSON.stringify({ ticket: "ticket" }), { status: 200 }),
  });
  await assert.rejects(
    client.rpc("server.getSettings"),
    (error) => error.message.includes("[redacted error body]")
      && !error.message.includes("rpc-token-leak")
      && !error.message.includes("rpc-prompt-leak"),
  );
});

test("WebSocket RPC ignores malformed frames, answers pings, and returns its matching success", async () => {
  class SuccessfulWebSocket {
    constructor() {
      this.listeners = new Map();
      this.sent = [];
      queueMicrotask(() => this.emit("open"));
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
      if (this.sent.length !== 1) return;
      const { id } = this.sent[0];
      queueMicrotask(() => this.emit("message", { data: "not-json" }));
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ _tag: "Ping" }) }));
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: { ready: true } } }),
      }));
    }

    close() {}

    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
  }

  const sockets = [];
  class TrackingWebSocket extends SuccessfulWebSocket {
    constructor(...args) {
      super(...args);
      sockets.push(this);
    }
  }
  const client = new T3Client({
    token: "test-token",
    WebSocketImpl: TrackingWebSocket,
    fetchImpl: async () => new Response(JSON.stringify({ ticket: "ticket" }), { status: 200 }),
  });
  assert.deepEqual(await client.rpc("server.getSettings"), { ready: true });
  assert.deepEqual(sockets[0].sent[1], { _tag: "Pong" });
});

test("runtime snapshots are immutable, reusable, and digest-verified", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-runtime-snapshot-"));
  const overrides = { homeDir };
  const first = createRuntimeSnapshot({ cliPath: path.resolve("src/cli.mjs") }, overrides);
  assert.equal(fs.statSync(first.path).isDirectory(), true);
  assert.equal(fs.statSync(first.cliPath).isFile(), true);
  assert.deepEqual(createRuntimeSnapshot({ cliPath: path.resolve("src/cli.mjs") }, overrides), first);
  fs.chmodSync(first.cliPath, 0o600);
  fs.appendFileSync(first.cliPath, "\n// tampered in test\n");
  assert.throws(
    () => createRuntimeSnapshot({ cliPath: path.resolve("src/cli.mjs") }, overrides),
    /Runtime snapshot digest mismatch/,
  );
});

test("provider install merges existing instances and uses the ACP wrapper", async () => {
  let patch;
  const client = {
    getSettings: async () => ({ providerInstances: { existing: { driver: "codex" } } }),
    updateSettings: async (value) => { patch = value; },
    refreshProvider: async (instanceId) => ({ provider: { instanceId } }),
  };
  await installProvider(client, { wrapperPath: "/tmp/t3-hermes-acp", model: "model-x" });
  assert.equal(patch.providerInstances.existing.driver, "codex");
  assert.equal(patch.providerInstances.hermes.driver, "grok");
  assert.equal(patch.providerInstances.hermes.config.binaryPath, "/tmp/t3-hermes-acp");
  assert.deepEqual(patch.providerInstances.hermes.config.customModels, ["model-x"]);
  assert.equal(patch.providerInstances.hermes.environment[0].name, "T3_HERMES_BRIDGE_OWNER");
  assert.equal(isBridgeOwnedProvider(patch.providerInstances.hermes), true);
});

test("provider install preserves a disabled native Grok connector verbatim", async () => {
  const nativeGrok = { driver: "grok", enabled: false, config: { enabled: false, binaryPath: "grok", customModels: [] } };
  let patch;
  const client = {
    getSettings: async () => ({ providerInstances: { grok: nativeGrok } }),
    updateSettings: async (value) => { patch = value; },
    refreshProvider: async (instanceId) => ({ provider: { instanceId } }),
  };
  await installProvider(client, { wrapperPath: "/tmp/t3-hermes-acp" });
  assert.deepEqual(patch.providerInstances.grok, nativeGrok);
  assert.equal(patch.providerInstances.hermes.driver, "grok");
  assert.equal(isNativeGrokInstance(NATIVE_GROK_INSTANCE_ID, nativeGrok), true);
  assert.equal(isNativeGrokInstance("hermes", patch.providerInstances.hermes), false);
});

test("restoreNativeGrok re-enables a disabled native Grok connector", async () => {
  let patch;
  const client = {
    getSettings: async () => ({
      providerInstances: {
        grok: { driver: "grok", enabled: false, config: { enabled: false, binaryPath: "grok", customModels: [] } },
        hermes: { driver: "grok", enabled: true, environment: [{ name: "T3_HERMES_BRIDGE_OWNER", value: "t3-hermes-bridge/v1" }] },
      },
    }),
    updateSettings: async (value) => { patch = value; },
    refreshProvider: async () => ({}),
  };
  const result = await restoreNativeGrok(client);
  assert.deepEqual(result, { restored: true, instanceId: "grok" });
  assert.equal(patch.providerInstances.grok.enabled, true);
  assert.equal(patch.providerInstances.grok.config.enabled, true);
  assert.equal(patch.providerInstances.hermes.driver, "grok");
});

test("restoreNativeGrok is a no-op when already enabled or absent", async () => {
  const enabled = {
    getSettings: async () => ({ providerInstances: { grok: { driver: "grok", enabled: true, config: { enabled: true } } } }),
    updateSettings: async () => { throw new Error("must not write"); },
    refreshProvider: async () => ({}),
  };
  assert.deepEqual(await restoreNativeGrok(enabled), { restored: false, reason: "already-enabled" });
  const absent = {
    getSettings: async () => ({ providerInstances: {} }),
    updateSettings: async () => { throw new Error("must not write"); },
    refreshProvider: async () => ({}),
  };
  assert.deepEqual(await restoreNativeGrok(absent), { restored: false, reason: "native-grok-instance-absent" });
});

test("useNativeGrokCachedAuth removes only the native Grok API-key override", async () => {
  const wrapperPath = "/tmp/t3-native-grok-cached-auth";
  const otherProvider = {
    driver: "grok",
    enabled: true,
    environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
  };
  let patch;
  const refreshed = [];
  const client = {
    getSettings: async () => ({
      providerInstances: {
        grok: {
          driver: "grok",
          enabled: true,
          config: { binaryPath: "grok", customModels: [] },
          environment: [
            { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
            { name: "GROK_KEEP", value: "yes", sensitive: false },
          ],
        },
        hermes: otherProvider,
      },
    }),
    updateSettings: async (value) => { patch = value; },
    refreshProvider: async (instanceId) => { refreshed.push(instanceId); },
  };

  assert.deepEqual(await useNativeGrokCachedAuth(client, { wrapperPath }), {
    repaired: true,
    instanceId: "grok",
    authMethod: "cached_token",
    removedApiKeyOverride: true,
    refreshed: true,
  });
  assert.equal(patch.providerInstances.grok.config.binaryPath, wrapperPath);
  assert.deepEqual(patch.providerInstances.grok.environment, [
    { name: "GROK_KEEP", value: "yes", sensitive: false },
  ]);
  assert.deepEqual(patch.providerInstances.hermes, otherProvider);
  assert.deepEqual(refreshed, ["grok"]);
});

test("useNativeGrokCachedAuth refreshes an already configured wrapper and refuses a foreign collision", async () => {
  const wrapperPath = "/tmp/t3-native-grok-cached-auth";
  const refreshed = [];
  const noOverride = {
    getSettings: async () => ({ providerInstances: { grok: { driver: "grok", config: { binaryPath: wrapperPath }, environment: [] } } }),
    updateSettings: async () => { throw new Error("must not write"); },
    refreshProvider: async (instanceId) => { refreshed.push(instanceId); },
  };
  assert.deepEqual(await useNativeGrokCachedAuth(noOverride, { wrapperPath }), {
    repaired: false,
    reason: "native-grok-cached-auth-already-enforced",
    refreshed: true,
  });
  assert.deepEqual(refreshed, ["grok"]);

  const collision = {
    getSettings: async () => ({ providerInstances: { grok: { driver: "codex", environment: [] } } }),
  };
  await assert.rejects(useNativeGrokCachedAuth(collision, { wrapperPath }), /native Grok provider/);
});

test("provider install refuses to overwrite a redacted secret map", async () => {
  const providerInstances = {
    secure: { environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }] },
  };
  assert.equal(hasRedactedSecrets(providerInstances), true);
  await assert.rejects(
    installProvider({ getSettings: async () => ({ providerInstances }) }, { wrapperPath: "/tmp/acp" }),
    /redacted provider secrets/,
  );
});

test("provider install and removal refuse an unowned instance collision", async () => {
  const providerInstances = {
    hermes: {
      driver: "grok",
      environment: [],
      config: { binaryPath: "/opt/another-tool/t3-hermes-acp" },
    },
  };
  assert.equal(isBridgeOwnedProvider(providerInstances.hermes), false);
  const client = { getSettings: async () => ({ providerInstances }) };
  await assert.rejects(
    installProvider(client, { wrapperPath: "/tmp/acp" }),
    /not owned by t3-hermes-bridge/,
  );
  await assert.rejects(removeProvider(client), /not owned by t3-hermes-bridge/);
});

test("provider mutation rejects relative wrappers and makes absent removal a safe no-op", async () => {
  assert.equal(isBridgeOwnedProvider({ driver: "other", environment: [{ name: "T3_HERMES_BRIDGE_OWNER", value: "t3-hermes-bridge/v1" }] }), false);
  assert.equal(hasRedactedSecrets(), false);
  await assert.rejects(
    installProvider({ getSettings: async () => ({ providerInstances: {} }) }, { wrapperPath: "relative/acp" }),
    /absolute ACP wrapper path/,
  );
  assert.deepEqual(
    await removeProvider({ getSettings: async () => ({ providerInstances: {} }) }),
    { removed: false },
  );
});

test("mention stripping is case-insensitive and preserves surrounding text", () => {
  assert.equal(stripMention("please @HeRmEs investigate"), "please investigate");
});

test("mention watcher arms without backfilling, then routes a future mention once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-bridge-test-"));
  const stateFile = path.join(directory, "state.json");
  assert.deepEqual(await routeMentionsOnce({}, { stateFile }), []);
  const armed = readBridgeState(stateFile);
  assert.ok(armed.startedAt);

  writeBridgeState({ ...armed, startedAt: "2026-01-01T00:00:00.000Z" }, stateFile);
  const commands = [];
  const threads = new Map();
  threads.set("source-thread", {
    id: "source-thread",
    projectId: "project",
    title: "Source",
    modelSelection: { instanceId: "codex", model: "codex-model" },
    archivedAt: null,
    messages: [{
      id: "message-1",
      role: "user",
      text: "@hermes help",
      createdAt: "2026-01-02T00:00:00.000Z",
    }],
  });
  const client = {
    shell: async () => ({ threads: [...threads.values()] }),
    thread: async (threadId) => {
      const thread = threads.get(threadId);
      if (!thread) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread };
    },
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "thread.create") {
        threads.set(command.threadId, { ...command, id: command.threadId, messages: [] });
      } else if (command.type === "thread.turn.start") {
        threads.get(command.threadId).messages.push({
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
          createdAt: command.createdAt,
        });
      }
      return { sequence: commands.length };
    },
  };
  const routed = await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  assert.equal(routed.length, 1);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].type, "thread.create");
  assert.equal(commands[1].type, "thread.turn.start");
  assert.equal((await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY })).length, 0);
  assert.equal(commands.length, 2);
});

test("mention watcher lock prevents concurrent duplicate scans", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-lock-test-"));
  const stateFile = path.join(directory, "state.json");
  writeBridgeState({
    version: 2,
    mode: "watcher",
    owner: "t3-hermes-bridge/v1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds: [],
    links: {},
    pending: {},
    deadLetters: {},
    threadRetries: {},
    lastSeenMessageByThread: {},
    originations: {},
  }, stateFile);
  let shellCalls = 0;
  const client = {
    shell: async () => {
      shellCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { threads: [] };
    },
  };
  const first = routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  const second = routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  assert.deepEqual(await second, []);
  assert.deepEqual(await first, []);
  assert.equal(shellCalls, 1);
});

test("thread start waits for asynchronous T3 projections", async () => {
  const threads = new Map();
  const client = {
    thread: async (threadId) => {
      const thread = threads.get(threadId);
      if (!thread) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread };
    },
    dispatch: async (command) => {
      if (command.type === "thread.create") {
        setTimeout(() => threads.set(command.threadId, { id: command.threadId, messages: [] }), 10);
      } else {
        setTimeout(() => threads.get(command.threadId).messages.push({
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
        }), 10);
      }
      return { sequence: 1 };
    },
  };
  await startThread(client, {
    projectId: "project",
    threadId: "async-thread",
    title: "Async",
    message: "hello",
    messageId: "async-message",
    runtimeMode: "full-access",
  });
  assert.equal(threads.get("async-thread").messages[0].id, "async-message");
});

test("pending intent reconciles an ambiguous accepted turn without replay", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-reconcile-test-"));
  const stateFile = path.join(directory, "state.json");
  writeBridgeState({
    version: 2,
    mode: "watcher",
    owner: "t3-hermes-bridge/v1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds: [],
    links: {},
    pending: {},
    deadLetters: {},
    threadRetries: {},
    lastSeenMessageByThread: {},
    originations: {},
  }, stateFile);
  const threads = new Map([[
    "source",
    {
      id: "source",
      projectId: "project",
      title: "Source",
      modelSelection: { instanceId: "codex", model: "codex-model" },
      archivedAt: null,
      messages: [{
        id: "source-message",
        role: "user",
        text: "@hermes reconcile",
        createdAt: "2026-01-02T00:00:00.000Z",
      }],
    },
  ]]);
  let turnDispatches = 0;
  const client = {
    shell: async () => ({ threads: [...threads.values()] }),
    thread: async (threadId) => {
      const thread = threads.get(threadId);
      if (!thread) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread };
    },
    dispatch: async (command) => {
      if (command.type === "thread.create") {
        threads.set(command.threadId, {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          messages: [],
        });
        return { sequence: 1 };
      }
      turnDispatches += 1;
      threads.get(command.threadId).messages.push({
        id: command.message.messageId,
        role: "user",
        text: command.message.text,
      });
      if (turnDispatches === 1) throw new Error("ambiguous response after acceptance");
      return { sequence: 2 };
    },
  };
  await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  assert.equal(Object.keys(readBridgeState(stateFile).pending).length, 1);
  const pendingState = readBridgeState(stateFile);
  pendingState.pending["source-message"].nextAttemptAt = 0;
  writeBridgeState(pendingState, stateFile);
  const recovered = await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  assert.equal(recovered.length, 1);
  assert.equal(turnDispatches, 1);
  assert.equal(Object.keys(readBridgeState(stateFile).pending).length, 0);
});

test("per-thread cursor bounds the fallback dedupe ledger", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-dedupe-test-"));
  const stateFile = path.join(directory, "state.json");
  const processedMessageIds = Array.from({ length: 1_000 }, (_, index) => `message-${index}`);
  writeBridgeState({
    version: 2,
    mode: "watcher",
    owner: "t3-hermes-bridge/v1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds,
    links: {},
    pending: {},
    deadLetters: {},
    threadRetries: {},
    lastSeenMessageByThread: {},
    originations: {},
  }, stateFile);
  const source = {
    id: "source",
    modelSelection: { instanceId: "codex" },
    archivedAt: null,
  };
  const client = {
    shell: async () => ({ threads: [source] }),
    thread: async () => ({
      thread: {
        messages: [{
          id: "historical-message",
          role: "user",
          text: "@hermes old",
          createdAt: "2025-12-31T00:00:00.000Z",
        }],
      },
    }),
  };
  await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  const state = readBridgeState(stateFile);
  assert.equal(state.processedMessageIds.length, 1_000);
  assert.equal(state.lastSeenMessageByThread.source.messageId, "historical-message");
});

test("LaunchAgent contains no bearer material and escapes paths", () => {
  const plist = renderLaunchAgent({ nodePath: "/tmp/node&one", cliPath: "/tmp/cli<one", interval: 2500 });
  assert.match(plist, new RegExp(LAUNCH_AGENT_LABEL.replaceAll(".", "\\.")));
  assert.equal(isBridgeOwnedLaunchAgent(plist), true);
  assert.match(plist, /\/tmp\/node&amp;one/);
  assert.match(plist, /\/tmp\/cli&lt;one/);
  assert.match(plist, /<string>2500<\/string>/);
  assert.doesNotMatch(plist, /Bearer/i);
  assert.match(plist, /T3_HERMES_TOKEN_FILE/);
});

test("LaunchAgent ownership rejects foreign files and symlinks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-service-test-"));
  const plist = path.join(directory, "bridge.plist");
  const link = path.join(directory, "bridge-link.plist");
  const owned = renderLaunchAgent({ nodePath: "/tmp/node", cliPath: "/tmp/cli" });
  fs.writeFileSync(plist, owned, { mode: 0o644 });
  assert.equal(assertBridgeOwnedLaunchAgentFile(plist), owned);

  fs.writeFileSync(plist, owned.replace("t3-hermes-bridge/v1", "foreign/v1"), { mode: 0o644 });
  assert.equal(isBridgeOwnedLaunchAgent(fs.readFileSync(plist, "utf8")), false);
  assert.throws(() => assertBridgeOwnedLaunchAgentFile(plist), /not owned by t3-hermes-bridge/);

  fs.symlinkSync(plist, link);
  assert.throws(() => assertBridgeOwnedLaunchAgentFile(link), /must not be a symlink/);
});
