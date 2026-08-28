import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALLOW_ALL_MENTION_POLICY,
  acquireStateLock,
  doctor,
  formatUntrustedContext,
  originate,
  readBridgeState,
  routeMentionsOnce,
  writeBridgeState,
} from "../src/bridge.mjs";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";

function fixtureState(file, patch = {}) {
  const state = readBridgeState(file);
  Object.assign(state, patch);
  writeBridgeState(state, file);
  return state;
}

function source(id, { projectId = "project", provider = "codex", archivedAt = null, messages = [] } = {}) {
  return { id, projectId, title: id, modelSelection: { instanceId: provider }, archivedAt, messages };
}

function watchingClient(threads, onTurn = () => {}) {
  const commands = [];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return {
    commands,
    shell: async () => ({ threads: [...byId.values()] }),
    thread: async (id) => {
      const thread = byId.get(id);
      if (!thread) throw new T3HttpError({ method: "GET", pathname: id, status: 404, body: null });
      return { thread };
    },
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "thread.create") {
        byId.set(command.threadId, { id: command.threadId, projectId: command.projectId, title: command.title, modelSelection: command.modelSelection, messages: [] });
        return { sequence: commands.length };
      }
      onTurn(command);
      byId.get(command.threadId).messages.push({ id: command.message.messageId, role: "user", text: command.message.text });
      return { sequence: commands.length };
    },
  };
}

function waitForChildOutput(child, expected) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not print ${expected}`)), 2_000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes(expected)) { clearTimeout(timeout); resolve(); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error(`child exited ${code}`)); }
    });
  });
}

test("mention routing rejects invalid work bounds before touching state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-max-messages-"));
  const stateFile = path.join(directory, "state.json");
  for (const maxMessages of [Number.NaN, 0, 101, 1.5]) {
    await assert.rejects(
      routeMentionsOnce({}, { stateFile, maxMessages, policy: ALLOW_ALL_MENTION_POLICY }),
      /integer between 1 and 100/,
    );
  }
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.existsSync(`${stateFile}.lock`), false);
});

test("doctor bounds and validates the Hermes health response", async () => {
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    shell: async () => { throw new Error("hanging shell endpoint must not be called"); },
    getSettings: async () => ({ providerInstances: {} }),
    rpc: async () => ({ providers: [] }),
  };
  const oversized = await doctor(client, {
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok", padding: "x".repeat(65_536) })),
  });
  assert.equal(oversized.hermes.reachable, false);
  assert.match(oversized.hermes.error, /Hermes health response exceeds 65536 bytes/);
  const invalid = await doctor(client, { fetchImpl: async () => new Response("not-json") });
  assert.equal(invalid.hermes.reachable, false);
  assert.match(invalid.hermes.error, /invalid JSON/);
  const result = await doctor(client, {
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok", version: "test-version" })),
  });
  assert.equal(result.hermes.version, "test-version");
  assert.equal(result.product, "Tentacles");
  assert.equal(result.labs.length >= 9, true);
  assert.deepEqual(result.labs.map((lab) => lab.instanceId).slice(0, 9), [
    "hermes", "codex", "claudeAgent", "grok", "cursor", "deepseek", "kimi", "pi", "opencode",
  ]);
});

test("doctor prints an advertised lab matrix without secrets and keeps Cursor explicit", async () => {
  const client = {
    snapshot: async () => ({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }),
    getSettings: async () => ({
      providers: {
        grok: { enabled: true },
        cursor: { enabled: false },
        opencode: { enabled: true, serverPassword: "should-not-leak" },
      },
      providerInstances: {
        grok: { driver: "grok", enabled: true, config: { binaryPath: "/tmp/grok" } },
      },
    }),
    rpc: async () => ({
      providers: [
        { instanceId: "grok", driver: "grok", status: "ready", installed: true, models: [{ slug: "grok-4.6", name: "Grok 4.6" }] },
        { instanceId: "codex", driver: "codex", status: "ready", installed: true, models: [{ slug: "gpt-5.6-luna" }] },
        { instanceId: "claudeAgent", driver: "claudeAgent", status: "ready", installed: true, models: [{ slug: "claude-sonnet-5" }] },
        { instanceId: "opencode", driver: "opencode", status: "ready", installed: true, models: [{ slug: "opencode/big-pickle" }] },
        { instanceId: "cursor", driver: "cursor", status: "disabled", installed: false, models: [], message: "Cursor is disabled in T3 Code settings." },
        { instanceId: "pi", driver: "grok", status: "error", installed: true, models: [{ slug: "gpt-5.6-terra" }], message: "Grok CLI is installed but ACP startup failed." },
      ],
    }),
  };
  const result = await doctor(client, {
    fetchImpl: async () => { throw new Error("hermes down"); },
  });
  const byId = Object.fromEntries(result.labs.map((lab) => [lab.instanceId, lab]));
  assert.equal(result.hermes.reachable, false);
  assert.equal(byId.grok.ready, true);
  assert.equal(byId.grok.kind, "native");
  assert.equal(byId.codex.ready, true);
  assert.equal(byId.claudeAgent.ready, true);
  assert.equal(byId.opencode.ready, true);
  assert.equal(byId.cursor.kind, "explicit");
  assert.equal(byId.cursor.ready, false);
  assert.equal(byId.hermes.kind, "adapter");
  assert.equal(byId.hermes.ready, false);
  assert.match(byId.hermes.install, /install-provider/);
  assert.equal(byId.cursor.defaultModel, null);
  assert.match(byId.cursor.message, /Cursor is disabled/);
  assert.match(byId.pi.message, /ACP startup failed/);
  assert.equal(JSON.stringify(result).includes("should-not-leak"), false);
});

test("missing or pruned cursor never replays an evicted historical mention", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-cursor-"));
  const stateFile = path.join(directory, "state.json");
  fixtureState(stateFile, {
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds: Array.from({ length: 1_000 }, (_, index) => `newer-${index}`),
    lastSeenMessageByThread: { source: { messageId: "pruned-cursor", createdAt: "2026-01-05T00:00:00.000Z" } },
  });
  const client = watchingClient([source("source", { messages: [{ id: "evicted", role: "user", text: "@hermes old", createdAt: "2026-01-02T00:00:00.000Z" }] })]);
  assert.deepEqual(await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY }), []);
  assert.equal(client.commands.length, 0);
});

test("the arm pass and a cursor-less timestamp-less history never backfill", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-arm-"));
  const stateFile = path.join(directory, "state.json");
  assert.deepEqual(await routeMentionsOnce({}, { stateFile, policy: ALLOW_ALL_MENTION_POLICY }), []);
  const client = watchingClient([source("source", { messages: [{ id: "old-no-time", role: "user", text: "@hermes do not replay" }] })]);
  assert.deepEqual(await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY }), []);
  assert.equal(client.commands.length, 0);
});

test("lock recovery is owned, crash-safe, and refuses live PID reuse", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-lock-"));
  const stateFile = path.join(directory, "state.json");
  const lockFile = `${stateFile}.lock`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ version: 1, owner: "crashed", pid: 999_999_999, createdAt: "2000-01-01T00:00:00.000Z" }), { mode: 0o600 });
  const release = acquireStateLock(stateFile, { staleMs: 0 });
  assert.ok(release);
  const ours = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  fs.writeFileSync(lockFile, JSON.stringify({ ...ours, owner: "replacement" }), { mode: 0o600 });
  release();
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).owner, "replacement");
  fs.writeFileSync(lockFile, JSON.stringify({ version: 1, owner: "reused-pid", pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" }), { mode: 0o600 });
  assert.equal(acquireStateLock(stateFile, { staleMs: 0 }), null);
});

test("child-process crash recovery and a recovery barrier admit exactly one owner", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-lock-child-"));
  const stateFile = path.join(directory, "state.json");
  const bridgeUrl = new URL("../src/bridge.mjs", import.meta.url).href;
  const holderScript = `import { acquireStateLock } from ${JSON.stringify(bridgeUrl)}; const release = acquireStateLock(process.argv[1], { staleMs: 0 }); console.log(release ? 'locked' : 'skipped'); setInterval(() => {}, 1000);`;
  const crashed = spawn(process.execPath, ["--input-type=module", "-e", holderScript, stateFile], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForChildOutput(crashed, "locked");
  crashed.kill("SIGKILL");
  await new Promise((resolve) => crashed.once("exit", resolve));

  const contenderScript = `import { acquireStateLock } from ${JSON.stringify(bridgeUrl)}; const release = acquireStateLock(process.argv[1], { staleMs: 0 }); console.log(release ? 'locked' : 'skipped'); if (release) setTimeout(() => { release(); process.exit(0); }, 150);`;
  const first = spawn(process.execPath, ["--input-type=module", "-e", contenderScript, stateFile], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForChildOutput(first, "locked");
  const second = spawn(process.execPath, ["--input-type=module", "-e", contenderScript, stateFile], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForChildOutput(second, "skipped");
  await new Promise((resolve, reject) => first.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`first contender exited ${code}`))));
});

test("a bad intent is retried/dead-lettered without starving healthy work", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-retry-"));
  const stateFile = path.join(directory, "state.json");
  fixtureState(stateFile, { startedAt: "2026-01-01T00:00:00.000Z" });
  const client = watchingClient([
    source("unavailable", { messages: [{ id: "m503", role: "user", text: "@hermes 503", createdAt: "2026-01-02T00:00:00.000Z" }] }),
    source("timeout", { messages: [{ id: "mtimeout", role: "user", text: "@hermes timeout", createdAt: "2026-01-02T00:00:00.000Z" }] }),
    source("gone", { messages: [{ id: "m404", role: "user", text: "@hermes 404", createdAt: "2026-01-02T00:00:00.000Z" }] }),
    source("malformed", { messages: [{ id: "m400", role: "user", text: "@hermes malformed", createdAt: "2026-01-02T00:00:00.000Z" }] }),
    source("healthy", { messages: [{ id: "mok", role: "user", text: "@hermes healthy", createdAt: "2026-01-02T00:00:00.000Z" }] }),
  ], (command) => {
    if (command.message.text.includes("503")) throw new T3HttpError({ method: "POST", pathname: "/dispatch", status: 503, body: "secret-token" });
    if (command.message.text.includes("timeout")) throw new Error("timed out after acceptance is unknown");
    if (command.message.text.includes("404")) throw new T3HttpError({ method: "POST", pathname: "/dispatch", status: 404, body: "prompt" });
    if (command.message.text.includes("malformed")) throw new T3HttpError({ method: "POST", pathname: "/dispatch", status: 400, body: "prompt" });
  });
  const routed = await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  assert.equal(routed.length, 1);
  assert.equal(routed[0].sourceThreadId, "healthy");
  const state = readBridgeState(stateFile);
  assert.equal(state.pending.m503.attempts, 1);
  assert.equal(state.pending.mtimeout.attempts, 1);
  assert.equal(state.deadLetters.m404.lastErrorClass, "permanent");
  assert.equal(state.deadLetters.m400.lastErrorClass, "permanent");
});

test("transient deliveries exhaust retries into a retryable dead letter and thread reads recover", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-retry-exhaustion-"));
  const stateFile = path.join(directory, "state.json");
  fixtureState(stateFile, { startedAt: "2026-01-01T00:00:00.000Z" });
  const client = watchingClient([
    source("transient", { messages: [{ id: "retry-me", role: "user", text: "@hermes unavailable", createdAt: "2026-01-02T00:00:00.000Z" }] }),
  ], () => {
    throw new T3HttpError({ method: "POST", pathname: "/dispatch", status: 503, body: "never-reflect-this" });
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.deepEqual(await routeMentionsOnce(client, { stateFile, policy: ALLOW_ALL_MENTION_POLICY }), []);
    const state = readBridgeState(stateFile);
    if (attempt < 5) {
      assert.equal(state.pending["retry-me"].attempts, attempt);
      state.pending["retry-me"].nextAttemptAt = 0;
      writeBridgeState(state, stateFile);
    }
  }
  const exhausted = readBridgeState(stateFile);
  assert.equal(exhausted.pending["retry-me"], undefined);
  assert.equal(exhausted.deadLetters["retry-me"].attempts, 5);
  assert.equal(exhausted.deadLetters["retry-me"].lastErrorClass, "retryable");

  let detailAttempts = 0;
  const detailClient = {
    shell: async () => ({ threads: [source("unavailable-thread")] }),
    thread: async () => {
      detailAttempts += 1;
      if (detailAttempts === 1) throw new Error("temporary thread read failure");
      return { thread: { messages: [] } };
    },
  };
  await routeMentionsOnce(detailClient, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  const delayed = readBridgeState(stateFile);
  assert.equal(delayed.threadRetries["unavailable-thread"].attempts, 1);
  delayed.threadRetries["unavailable-thread"].nextAttemptAt = 0;
  writeBridgeState(delayed, stateFile);
  await routeMentionsOnce(detailClient, { stateFile, policy: ALLOW_ALL_MENTION_POLICY });
  assert.equal(readBridgeState(stateFile).threadRetries["unavailable-thread"], undefined);
  assert.equal(detailAttempts, 2);
});

test("mention authority is deny-by-default and requires allowed project and provider", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-policy-"));
  const stateFile = path.join(directory, "state.json");
  fixtureState(stateFile, { startedAt: "2026-01-01T00:00:00.000Z" });
  const threads = [
    source("allowed", { projectId: "p1", provider: "codex", messages: [{ id: "a", role: "user", text: "@hermes yes", createdAt: "2026-01-02T00:00:00.000Z" }] }),
    source("wrong-project", { projectId: "p2", provider: "codex", messages: [{ id: "b", role: "user", text: "@hermes no", createdAt: "2026-01-02T00:00:00.000Z" }] }),
    source("wrong-provider", { projectId: "p1", provider: "other", messages: [{ id: "c", role: "user", text: "@hermes no", createdAt: "2026-01-02T00:00:00.000Z" }] }),
    source("archived", { projectId: "p1", archivedAt: "2026-01-02T00:00:00.000Z", messages: [{ id: "d", role: "user", text: "@hermes no", createdAt: "2026-01-02T00:00:00.000Z" }] }),
  ];
  const client = watchingClient(threads);
  assert.deepEqual(await routeMentionsOnce(client, { stateFile }), []);
  assert.equal(client.commands.length, 0);
  const routed = await routeMentionsOnce(client, { stateFile, policy: { projectIds: ["p1"], providerInstanceIds: ["codex"] } });
  assert.deepEqual(routed.map((entry) => entry.sourceThreadId), ["allowed"]);
});

test("untrusted context is role-labelled, bounded, and excludes distant messages", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", text: `${index}: ${"x".repeat(2_000)}` }));
  const context = formatUntrustedContext(messages, messages.length);
  assert.ok(context.length <= 6_000);
  assert.match(context, /untrusted source assistant message id=m9/);
  assert.doesNotMatch(context, /message id=m3/);
  assert.match(context, /\[untrusted source (user|assistant) message/);
});

test("originate idempotency reconciles an accepted-but-ambiguous turn without duplicates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-originate-"));
  const stateFile = path.join(directory, "state.json");
  const projects = new Map();
  const threads = new Map();
  let projectCommands = 0;
  let threadCommands = 0;
  let turnCommands = 0;
  const client = {
    shell: async () => ({ projects: [...projects.values()] }),
    thread: async (id) => {
      const thread = threads.get(id);
      if (!thread) throw new T3HttpError({ method: "GET", pathname: id, status: 404, body: null });
      return { thread };
    },
    dispatch: async (command) => {
      if (command.type === "project.create") { projectCommands += 1; projects.set(command.projectId, { id: command.projectId, workspaceRoot: command.workspaceRoot }); return {}; }
      if (command.type === "thread.create") { threadCommands += 1; threads.set(command.threadId, { id: command.threadId, messages: [] }); return {}; }
      turnCommands += 1;
      threads.get(command.threadId).messages.push({ id: command.message.messageId });
      throw new Error("accepted before connection failure");
    },
  };
  const options = { workspace: "/tmp/idempotent", title: "Idempotent", message: "hello", runtimeMode: "full-access", idempotencyKey: "origin-1", stateFile };
  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds: ["processed"],
    links: { source: "target" },
    pending: {},
    lastSeenMessageByThread: { source: "cursor-message" },
  })}\n`, { mode: 0o600 });
  await assert.rejects(originate(client, options), /accepted before connection failure/);
  const result = await originate(client, options);
  assert.equal(result.idempotencyKey, "origin-1");
  assert.deepEqual({ projectCommands, threadCommands, turnCommands }, { projectCommands: 1, threadCommands: 1, turnCommands: 1 });
  const migrated = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.processedMessageIds, ["processed"]);
  assert.equal(migrated.links.source, "target");
  assert.deepEqual(migrated.lastSeenMessageByThread.source, { messageId: "cursor-message", createdAt: null });
  assert.ok(migrated.originations["origin-1"]);
  await assert.rejects(originate(client, { ...options, message: "different" }), /different input/);
});

test("legacy pending deliveries fail closed without modifying the state file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-legacy-pending-"));
  const stateFile = path.join(directory, "state.json");
  const legacy = `${JSON.stringify({
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    processedMessageIds: [],
    links: {},
    pending: { message: { prompt: "must not be discarded" } },
    lastSeenMessageByThread: {},
  })}\n`;
  fs.writeFileSync(stateFile, legacy, { mode: 0o600 });
  assert.throws(() => readBridgeState(stateFile), /pending deliveries that cannot be migrated safely/);
  assert.equal(fs.readFileSync(stateFile, "utf8"), legacy);
});

test("corrupted, malformed, and oversized bridge state fails closed without mutation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-state-"));
  const stateFile = path.join(directory, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 99 }));
  assert.throws(() => readBridgeState(stateFile), /Unsupported bridge state version/);
  const state = readBridgeState(path.join(directory, "fresh.json"));
  state.processedMessageIds = Array.from({ length: 1_001 }, (_, index) => String(index));
  const untouched = path.join(directory, "untouched.json");
  fs.writeFileSync(untouched, "keep this file");
  assert.throws(() => writeBridgeState(state, untouched), /exceeds its bound/);
  assert.equal(fs.readFileSync(untouched, "utf8"), "keep this file");

  const valid = readBridgeState(path.join(directory, "valid.json"));
  for (const [name, patch, pattern] of [
    ["pending", { pending: [] }, /pending exceeds its bound/],
    ["dead letters", { deadLetters: [] }, /deadLetters exceeds its bound/],
    ["thread retries", { threadRetries: { source: {} } }, /threadRetries\.source/],
    ["originations", { originations: { key: {} } }, /originations\.key/],
  ]) {
    const malformed = path.join(directory, `${name.replaceAll(" ", "-")}.json`);
    const content = `${JSON.stringify({ ...valid, ...patch })}\n`;
    fs.writeFileSync(malformed, content, { mode: 0o600 });
    assert.throws(() => readBridgeState(malformed), pattern);
    assert.equal(fs.readFileSync(malformed, "utf8"), content);
  }

  const oversized = path.join(directory, "oversized-on-disk.json");
  fs.writeFileSync(oversized, "{}");
  const oversizedBytes = (32 * 1024 * 1024) + 1;
  fs.truncateSync(oversized, oversizedBytes);
  assert.throws(() => readBridgeState(oversized), /exceeds 33554432 byte bound/);
  assert.equal(fs.statSync(oversized).size, oversizedBytes);
});

test("HTTP/RPC error bodies never reflect token or prompt material", async () => {
  const client = new T3Client({ token: "test-token", fetchImpl: async () => new Response(JSON.stringify({ token: "leak", prompt: "leak" }), { status: 400 }) });
  await assert.rejects(client.shell(), (error) => error.message.includes("[redacted error body]") && !error.message.includes("leak"));
});
