import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";
import {
  hasRedactedSecrets,
  installProvider,
  isBridgeOwnedProvider,
  readBridgeState,
  removeProvider,
  routeMentionsOnce,
  startThread,
  stripMention,
  writeBridgeState,
} from "../src/bridge.mjs";
import { readToken, requireLoopbackUrl } from "../src/config.mjs";
import {
  LAUNCH_AGENT_LABEL,
  assertBridgeOwnedLaunchAgentFile,
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

test("HTTP response bodies are size-bounded", async () => {
  const client = new T3Client({
    token: "test-token",
    responseMaxBytes: 100,
    fetchImpl: async () => new Response("x".repeat(101), { status: 200 }),
  });
  await assert.rejects(client.shell(), /exceeds 100 bytes/);
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
  const routed = await routeMentionsOnce(client, { stateFile });
  assert.equal(routed.length, 1);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].type, "thread.create");
  assert.equal(commands[1].type, "thread.turn.start");
  assert.equal((await routeMentionsOnce(client, { stateFile })).length, 0);
  assert.equal(commands.length, 2);
});

test("mention watcher lock prevents concurrent duplicate scans", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-lock-test-"));
  const stateFile = path.join(directory, "state.json");
  writeBridgeState({
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds: [],
    links: {},
    pending: {},
  }, stateFile);
  let shellCalls = 0;
  const client = {
    shell: async () => {
      shellCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { threads: [] };
    },
  };
  const first = routeMentionsOnce(client, { stateFile });
  const second = routeMentionsOnce(client, { stateFile });
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
  });
  assert.equal(threads.get("async-thread").messages[0].id, "async-message");
});

test("pending intent reconciles an ambiguous accepted turn without replay", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-reconcile-test-"));
  const stateFile = path.join(directory, "state.json");
  writeBridgeState({
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds: [],
    links: {},
    pending: {},
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
  await assert.rejects(routeMentionsOnce(client, { stateFile }), /ambiguous response/);
  assert.equal(Object.keys(readBridgeState(stateFile).pending).length, 1);
  const recovered = await routeMentionsOnce(client, { stateFile });
  assert.equal(recovered.length, 1);
  assert.equal(turnDispatches, 1);
  assert.equal(Object.keys(readBridgeState(stateFile).pending).length, 0);
});

test("per-thread cursor bounds the fallback dedupe ledger", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-dedupe-test-"));
  const stateFile = path.join(directory, "state.json");
  const processedMessageIds = Array.from({ length: 1_000 }, (_, index) => `message-${index}`);
  writeBridgeState({
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds,
    links: {},
    pending: {},
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
  await routeMentionsOnce(client, { stateFile });
  const state = readBridgeState(stateFile);
  assert.equal(state.processedMessageIds.length, 1_000);
  assert.equal(state.lastSeenMessageByThread.source, "historical-message");
});

test("LaunchAgent contains no bearer material and escapes paths", () => {
  const plist = renderLaunchAgent({ nodePath: "/tmp/node&one", cliPath: "/tmp/cli<one", interval: 2500 });
  assert.match(plist, new RegExp(LAUNCH_AGENT_LABEL.replaceAll(".", "\\.")));
  assert.equal(isBridgeOwnedLaunchAgent(plist), true);
  assert.match(plist, /\/tmp\/node&amp;one/);
  assert.match(plist, /\/tmp\/cli&lt;one/);
  assert.match(plist, /<string>2500<\/string>/);
  assert.doesNotMatch(plist, /Bearer|token/i);
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
