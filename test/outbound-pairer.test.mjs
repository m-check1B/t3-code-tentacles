import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LoopbackRuntimeAdapter,
  OutboundPairer,
  PAIR_PROTOCOL_VERSION,
  readPairOffer,
  reconnectDelayMs,
  RemoteRpcShim,
  SPHERE_ABILITY,
  SPHERE_PRODUCT_ID,
} from "../src/outbound-pairer.mjs";
import {
  acquirePairStateLock,
  PAIR_STALE_REASONS,
  readPairPresence,
  writePairPresence,
} from "../src/pair-state.mjs";

const PAIR_TOKEN = "pair-secret-never-print-123456";

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tentacles-${label}-`));
}

function writeOffer(directory, patch = {}) {
  const file = path.join(directory, "pair-offer.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    endpoint: "wss://jack.example.test/api/tentacles/pair",
    pairToken: PAIR_TOKEN,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...patch,
  }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function waitFor(check, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }

  message(value) {
    this.emit("message", JSON.stringify(value));
  }
}

function delayedBlob(value) {
  const encoded = JSON.stringify(value);
  const blob = new Blob([encoded]);
  let release;
  const decoded = new Promise((resolve) => { release = () => resolve(encoded); });
  Object.defineProperty(blob, "text", { value: () => decoded });
  return { blob, release };
}

test("pair offers are owner-only WSS files and never serialize their secret", () => {
  const directory = temporaryDirectory("pair-offer");
  const file = writeOffer(directory);
  const offer = readPairOffer(file, { now: Date.parse("2026-08-29T00:00:00.000Z") });
  assert.equal(offer.endpoint, "wss://jack.example.test/api/tentacles/pair");
  assert.equal(offer.expired, false);
  assert.equal(JSON.stringify(offer).includes(PAIR_TOKEN), false);

  fs.chmodSync(file, 0o644);
  assert.throws(() => readPairOffer(file), /mode 0600/);
  fs.chmodSync(file, 0o600);
  writeOffer(directory, { endpoint: `wss://jack.example.test/pair?token=${PAIR_TOKEN}` });
  assert.throws(() => readPairOffer(file), /must not contain credentials, query, or fragment/);
  writeOffer(directory, { endpoint: "ws://jack.example.test/pair" });
  assert.throws(() => readPairOffer(file), /must use wss/);
  writeOffer(directory, { expiresAt: "January 1, 2099" });
  assert.throws(() => readPairOffer(file), /canonical ISO timestamp/);
});

test("pair presence is a secret-free lease with paired, unpaired, and expired states", () => {
  const directory = temporaryDirectory("pair-presence");
  const file = path.join(directory, "presence.json");
  assert.deepEqual(readPairPresence(file), { status: "unpaired" });
  writePairPresence("paired", { file, now: 1_000_000, leaseMs: 30_000 });
  assert.deepEqual(readPairPresence(file, { now: 1_010_000 }), { status: "paired" });
  assert.deepEqual(readPairPresence(file, { now: 1_040_000 }), { status: "unpaired" });
  writePairPresence("expired", { file, now: 1_050_000 });
  assert.deepEqual(readPairPresence(file, { now: 1_050_001 }), { status: "expired" });
  writePairPresence("unpaired", { file, now: 1_060_000, staleReason: "relay_connection_closed" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).staleReason, "relay_connection_closed");
  assert.deepEqual(readPairPresence(file, { now: 1_060_001 }), { status: "unpaired" });
  assert.equal(PAIR_STALE_REASONS.includes("relay_heartbeat_timeout"), true);
  assert.throws(
    () => writePairPresence("unpaired", { file, staleReason: "private relay failure text" }),
    /Invalid pair presence stale reason/,
  );
  assert.throws(
    () => writePairPresence("paired", { file, staleReason: "relay_connection_closed" }),
    /cannot carry a stale reason/,
  );
  assert.equal(fs.readFileSync(file, "utf8").includes(PAIR_TOKEN), false);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test("reconnect delay is capped exponential backoff with bounded jitter", () => {
  assert.equal(reconnectDelayMs(0, { baseMs: 100, capMs: 800, random: () => 0 }), 50);
  assert.equal(reconnectDelayMs(1, { baseMs: 100, capMs: 800, random: () => 0 }), 100);
  assert.equal(reconnectDelayMs(2, { baseMs: 100, capMs: 800, random: () => 0.999 }), 400);
  assert.equal(reconnectDelayMs(30, { baseMs: 100, capMs: 800, random: () => 0.999 }), 800);
  assert.throws(() => reconnectDelayMs(-1), /non-negative integer/);
  assert.throws(() => reconnectDelayMs(0, { random: () => 1 }), /in \[0, 1\)/);
});

test("pair state refuses broad custom directories and serializes pairer ownership", () => {
  const broadDirectory = temporaryDirectory("pair-broad-state");
  fs.chmodSync(broadDirectory, 0o755);
  const broadFile = path.join(broadDirectory, "presence.json");
  assert.throws(() => writePairPresence("unpaired", { file: broadFile }), /directory must have mode 0700/);
  assert.equal(fs.statSync(broadDirectory).mode & 0o077, 0o055);

  const privateDirectory = temporaryDirectory("pair-lock");
  const stateFile = path.join(privateDirectory, "presence.json");
  const release = acquirePairStateLock(stateFile);
  assert.equal(typeof release, "function");
  assert.equal(acquirePairStateLock(stateFile), null);
  release();
  const reacquired = acquirePairStateLock(stateFile);
  assert.equal(typeof reacquired, "function");
  reacquired();

  fs.writeFileSync(`${stateFile}.lock`, JSON.stringify({
    version: 1,
    owner: "deadbeef-dead-4eef-8ead-deadbeefdead",
    pid: 999_999_999,
  }), { mode: 0o600 });
  const recovered = acquirePairStateLock(stateFile);
  assert.equal(typeof recovered, "function");
  recovered();

  const target = path.join(privateDirectory, "target.json");
  fs.writeFileSync(target, JSON.stringify({ version: 1, status: "expired" }), { mode: 0o600 });
  fs.symlinkSync(target, stateFile);
  assert.throws(() => readPairPresence(stateFile), /must not be a symlink/);
});

test("loopback adapter keeps the relay surface honest about full-access", async () => {
  const calls = [];
  const adapter = new LoopbackRuntimeAdapter({
    client: { isLoopback: true },
    observeImpl: async (client) => ({
      activeTurns: [{ threadId: "t1", providerInstanceId: client.isLoopback ? "codex" : "other", prompt: "private" }],
      threads: [
        { id: "t1", projectId: "p1", title: "private", session: { status: "running", lastError: "stale private error" } },
        { id: "t2", projectId: "p1", session: { status: "ready", lastError: null } },
        { id: "t3", projectId: "p1", hasPendingUserInput: true, session: { status: "ready", lastError: null } },
        { id: "t4", projectId: "p1", settledAt: "2026-09-09T12:00:00.000Z", session: { status: "ready", lastError: null } },
      ],
      projects: [{ id: "p1", workspaceRoot: "/private/workspace" }],
    }),
    originateImpl: async (client, params) => { calls.push(["originate", client, params]); return { threadId: "t1" }; },
    continueImpl: async (client, params) => { calls.push(["continue", client, params]); return { threadId: params.threadId }; },
    doctorImpl: async (_client, params) => ({ pairing: params.pairStateFile }),
    pairStateFile: "/tmp/synthetic-pair-presence.json",
  });
  assert.deepEqual(await adapter.seats(), {
    activeTurns: [{ threadId: "t1", providerInstanceId: "codex" }],
    threads: [
      {
        id: "t1",
        projectId: "p1",
        report: {
          status: "generating",
          lastActivity: null,
          summary: "generating. model unset, effort unset.",
          effort: null,
        },
      },
      {
        id: "t2",
        projectId: "p1",
        report: {
          status: "ready/idle",
          lastActivity: null,
          summary: "ready/idle. model unset, effort unset.",
          effort: null,
        },
      },
      {
        id: "t3",
        projectId: "p1",
        report: {
          status: "blocked",
          lastActivity: null,
          summary: "blocked. model unset, effort unset.",
          effort: null,
        },
      },
      {
        id: "t4",
        projectId: "p1",
        report: {
          status: "Done",
          lastActivity: null,
          summary: "Done. model unset, effort unset.",
          effort: null,
        },
      },
    ],
  });
  const projected = JSON.stringify(await adapter.seats());
  assert.equal(projected.includes("private"), false);
  assert.equal(projected.includes("stale private error"), false);
  assert.deepEqual(await adapter.originate({ workspace: "/tmp/work", title: "T", message: "M" }), { threadId: "t1" });
  assert.deepEqual(await adapter.continue({ threadId: "t1", message: "again", runtimeMode: "full-access" }), { threadId: "t1" });
  assert.deepEqual(await adapter.doctorStatus(), { pairing: "/tmp/synthetic-pair-presence.json" });
  assert.deepEqual(calls.map((entry) => entry[2].runtimeMode), ["full-access", "full-access"]);
  assert.throws(() => adapter.originate({ runtimeMode: "approval-required" }), /requires runtimeMode full-access/);
  assert.throws(() => adapter.continue({ runtimeMode: "auto" }), /requires runtimeMode full-access/);
  assert.throws(() => adapter.originate({ stateFile: "/tmp/remote-controlled.json" }), /does not accept remote parameter stateFile/);
});

test("seats projection keeps a compact report and drops transcript text", async () => {
  const secret = "transcript-secret-must-not-project";
  const token = "pair-token-must-not-project";
  const adapter = new LoopbackRuntimeAdapter({
    client: { isLoopback: true },
    observeImpl: async () => ({
      activeTurns: [{ threadId: "t1", providerInstanceId: "grok", prompt: secret }],
      threads: [{
        id: "t1",
        projectId: "p1",
        title: secret,
        messages: [{ role: "assistant", text: secret }],
        activities: [
          { kind: "turn.completed", createdAt: "2026-09-24T20:00:00.000Z", payload: { text: secret } },
          { kind: "turn.completed", createdAt: "2026-09-24T21:15:00.000Z", payload: { text: token } },
        ],
        modelSelection: {
          instanceId: "grok",
          model: "grok-4.7",
          options: [{ id: "reasoningEffort", value: "high" }, { id: "fastMode", value: true }],
        },
        session: { status: "running", lastError: token, providerInstanceId: "grok" },
      }],
    }),
  });
  const projected = await adapter.seats();
  assert.deepEqual(projected, {
    activeTurns: [{ threadId: "t1", providerInstanceId: "grok" }],
    threads: [{
      id: "t1",
      projectId: "p1",
      report: {
        status: "generating",
        lastActivity: "2026-09-24T21:15:00.000Z",
        summary: "generating. grok-4.7, effort high.",
        effort: "high",
      },
    }],
  });
  const encoded = JSON.stringify(projected);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes(token), false);
  assert.equal(encoded.includes("fastMode"), false);
});

test("real observe carries a sanitized timestamp and an id-only thread stays unreported", async () => {
  const secret = "activity-payload-must-not-project";
  const adapter = new LoopbackRuntimeAdapter({
    client: {
      isLoopback: true,
      snapshot: async () => ({
        threads: [
          {
            id: "t1",
            projectId: "p1",
            updatedAt: "2026-09-24T21:00:00.000Z",
            lastActivity: "not-iso",
            activities: [
              { createdAt: "2026-09-24T21:15:00.000Z", payload: { text: secret } },
              { createdAt: "yesterday", payload: { text: secret } },
            ],
            modelSelection: {
              model: "grok-4.7",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
            session: { status: "running" },
          },
          { id: "bare", projectId: "p1" },
        ],
      }),
      archivedShell: async () => ({ threads: [] }),
    },
  });
  const projected = await adapter.seats();
  assert.deepEqual(projected, {
    activeTurns: [{ threadId: "t1" }],
    threads: [
      {
        id: "t1",
        projectId: "p1",
        report: {
          status: "generating",
          lastActivity: "2026-09-24T21:15:00.000Z",
          summary: "generating. grok-4.7, effort high.",
          effort: "high",
        },
      },
      { id: "bare", projectId: "p1" },
    ],
  });
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.equal(Object.hasOwn(projected.threads[1], "report"), false);
});

test("RPC shim exposes exactly the loopback surface and fails closed without error details", async () => {
  const runtime = {
    seats: async () => ({ seats: ["codex"] }),
    originate: async () => { throw new Error(`do not leak ${PAIR_TOKEN}`); },
    continue: async () => ({ threadId: "t1" }),
    doctorStatus: async () => ({ pairing: { status: "paired" } }),
  };
  const shim = new RemoteRpcShim(runtime);
  assert.deepEqual(await shim.handle({ version: 1, type: "rpc.request", id: "r1", method: "seats", params: {} }), {
    version: 1,
    type: "rpc.result",
    id: "r1",
    result: { seats: ["codex"] },
  });
  const unavailable = await shim.handle({ version: 1, type: "rpc.request", id: "r2", method: "originate", params: {} });
  assert.deepEqual(unavailable.error, { code: "computer.unavailable", message: "Computer unavailable", data: null });
  assert.equal(JSON.stringify(unavailable).includes(PAIR_TOKEN), false);
  const unsupported = await shim.handle({ version: 1, type: "rpc.request", id: "r3", method: "device-list", params: {} });
  assert.equal(unsupported.error.code, "computer.unavailable");
  assert.equal(unsupported.error.data, null);
});

test("outbound pair binds one Sphere machine, consumes the offer once, and serves RPC", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-run");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const calls = [];
  const runtime = {
    seats: async (params) => { calls.push(["seats", params]); return { seats: ["codex"] }; },
    originate: async (params) => { calls.push(["originate", params]); return { threadId: "new" }; },
    continue: async (params) => { calls.push(["continue", params]); return { threadId: params.threadId }; },
    doctorStatus: async (params) => { calls.push(["doctor-status", params]); return { pairing: { status: "paired" } }; },
  };
  const events = [];
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeWebSocket, pairStateFile: stateFile, onEvent: (event) => events.push(event) });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1" }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const socket = await waitFor(() => FakeWebSocket.instances[0], "outbound socket");
  assert.equal(socket.url, "wss://jack.example.test/api/tentacles/pair");
  socket.emit("open");
  const bind = await waitFor(() => socket.sent.find((message) => message.type === "pair.bind"), "pair.bind");
  assert.equal(bind.version, PAIR_PROTOCOL_VERSION);
  assert.equal(bind.pairToken, PAIR_TOKEN);
  assert.deepEqual(bind.host, {
    machineId: "sphere-machine-1",
    productId: SPHERE_PRODUCT_ID,
    ability: SPHERE_ABILITY,
    runtime: "tentacles",
    rpc: ["seats", "originate", "continue", "doctor-status"],
  });
  assert.equal(fs.existsSync(pairFile), true);

  socket.message({ version: 1, type: "pair.bound", requestId: bind.requestId });
  await waitFor(() => !fs.existsSync(pairFile), "one-shot offer consumption");
  assert.deepEqual(readPairPresence(stateFile), { status: "paired" });
  assert.equal(events.some((event) => event.status === "paired"), true);
  assert.equal(JSON.stringify(events).includes(PAIR_TOKEN), false);

  for (const [id, method, params] of [
    ["rpc-1", "seats", {}],
    ["rpc-2", "originate", { title: "cloud" }],
    ["rpc-3", "continue", { threadId: "new" }],
    ["rpc-4", "doctor-status", {}],
  ]) {
    socket.message({ version: 1, type: "rpc.request", id, method, params });
    await waitFor(() => socket.sent.find((message) => message.type === "rpc.result" && message.id === id), `${method} result`);
  }
  assert.deepEqual(calls.map(([method]) => method), ["seats", "originate", "continue", "doctor-status"]);

  socket.message({ version: 1, type: "rpc.request", id: "rpc-4", method: "doctor-status", params: {} });
  const reconnectSocket = await waitFor(() => FakeWebSocket.instances[1], "protocol-failure reconnect");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).staleReason, "relay_protocol_error");
  // This run has no controller, so an unrecoverable authorization response ends it.
  reconnectSocket.emit("open");
  const reconnectBind = await waitFor(
    () => reconnectSocket.sent.find((message) => message.type === "pair.bind"),
    "protocol-failure rebind",
  );
  assert.equal(reconnectBind.pairToken, PAIR_TOKEN);
  reconnectSocket.message({ version: 1, type: "pair.unpaired" });
  const outcome = await runResult;
  assert.match(outcome.error.message, /authorization was denied/);
  assert.deepEqual(readPairPresence(stateFile), { status: "unpaired" });
});

test("fake relay socket drop reconnects, re-announces, and refreshes presence on heartbeat", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-reconnect");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  const events = [];
  let now = Date.parse("2026-09-09T12:00:00.000Z");
  const runtime = { seats: async () => null, originate: async () => null, continue: async () => null, doctorStatus: async () => null };
  const pairer = new OutboundPairer({
    runtime,
    WebSocketImpl: FakeWebSocket,
    pairStateFile: stateFile,
    leaseMs: 3_000,
    heartbeatTimeoutMs: 2_000,
    reconnectBaseMs: 1,
    reconnectCapMs: 1,
    random: () => 0,
    now: () => now,
    onEvent: (event) => events.push(event),
  });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const first = await waitFor(() => FakeWebSocket.instances[0], "first relay socket");
  first.emit("open");
  const firstBind = await waitFor(() => first.sent.find((message) => message.type === "pair.bind"), "first relay bind");
  first.message({ version: 1, type: "pair.bound", requestId: firstBind.requestId });
  await waitFor(() => readPairPresence(stateFile, { now }).status === "paired", "first paired presence");
  const initialUpdatedAt = JSON.parse(fs.readFileSync(stateFile, "utf8")).updatedAt;

  now += 1_000;
  first.message({ version: 1, type: "ping" });
  await waitFor(
    () => JSON.parse(fs.readFileSync(stateFile, "utf8")).updatedAt !== initialUpdatedAt,
    "heartbeat-refreshed presence",
  );
  assert.equal(first.sent.some((message) => message.type === "pong"), true);

  first.emit("close");
  await waitFor(
    () => JSON.parse(fs.readFileSync(stateFile, "utf8")).staleReason === "relay_connection_closed",
    "stale close reason",
  );
  const second = await waitFor(() => FakeWebSocket.instances[1], "reconnected relay socket");
  second.emit("open");
  const secondBind = await waitFor(() => second.sent.find((message) => message.type === "pair.bind"), "presence re-announce");
  assert.equal(secondBind.pairToken, PAIR_TOKEN);
  assert.notEqual(secondBind.requestId, firstBind.requestId);
  second.message({ version: 1, type: "pair.bound", requestId: secondBind.requestId });
  await waitFor(() => events.some((event) => event.event === "pair.paired" && event.reconnected), "reconnected event");
  assert.deepEqual(readPairPresence(stateFile, { now }), { status: "paired" });

  controller.abort();
  assert.deepEqual(await runResult, { status: "unpaired" });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).staleReason, "stopped");
  assert.equal(events.some((event) => event.event === "pair.reannouncing"), true);
  assert.equal(JSON.stringify(events).includes(PAIR_TOKEN), false);
});

test("a bound pair outlives its consumed offer TTL and can reconnect after it", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-consumed-expiry");
  const expiresAtMs = Date.now() + 500;
  const pairFile = writeOffer(directory, { expiresAt: new Date(expiresAtMs).toISOString() });
  const stateFile = path.join(directory, "presence.json");
  const events = [];
  const runtime = { seats: async () => null, originate: async () => null, continue: async () => null, doctorStatus: async () => null };
  const pairer = new OutboundPairer({
    runtime,
    WebSocketImpl: FakeWebSocket,
    pairStateFile: stateFile,
    leaseMs: 2_000,
    heartbeatTimeoutMs: 2_000,
    reconnectBaseMs: 1,
    reconnectCapMs: 1,
    random: () => 0,
    onEvent: (event) => events.push(event),
  });
  let finished = false;
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1" })
    .then((value) => ({ value }), (error) => ({ error }))
    .finally(() => { finished = true; });
  const first = await waitFor(() => FakeWebSocket.instances[0], "near-expiry socket");
  first.emit("open");
  const firstBind = await waitFor(() => first.sent.find((message) => message.type === "pair.bind"), "near-expiry bind");
  first.message({ version: 1, type: "pair.bound", requestId: firstBind.requestId });
  await waitFor(() => !fs.existsSync(pairFile), "near-expiry offer consumption");

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAtMs - Date.now() + 75)));
  assert.equal(finished, false);
  assert.deepEqual(readPairPresence(stateFile), { status: "paired" });

  first.emit("close");
  const second = await waitFor(() => FakeWebSocket.instances[1], "post-expiry reconnect socket");
  second.emit("open");
  const secondBind = await waitFor(() => second.sent.find((message) => message.type === "pair.bind"), "post-expiry rebind");
  second.message({ version: 1, type: "pair.bound", requestId: secondBind.requestId });
  await waitFor(() => events.some((event) => event.event === "pair.paired" && event.reconnected), "post-expiry rebound pair");
  assert.deepEqual(readPairPresence(stateFile), { status: "paired" });

  second.message({ version: 1, type: "pair.expired" });
  const outcome = await runResult;
  assert.match(outcome.error.message, /authorization expired/);
  assert.deepEqual(readPairPresence(stateFile), { status: "expired" });
});

test("RPC capacity and pending replay protection span reconnects without over-cap churn", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-global-rpc-cap");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  const resolvers = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const runtime = {
    seats: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return await new Promise((resolve) => {
        resolvers.push(() => { active -= 1; resolve(null); });
      });
    },
    originate: async () => null,
    continue: async () => null,
    doctorStatus: async () => null,
  };
  const pairer = new OutboundPairer({
    runtime,
    WebSocketImpl: FakeWebSocket,
    pairStateFile: stateFile,
    reconnectBaseMs: 1,
    reconnectCapMs: 1,
    random: () => 0,
  });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const first = await waitFor(() => FakeWebSocket.instances[0], "global-cap first socket");
  first.emit("open");
  const firstBind = await waitFor(() => first.sent.find((message) => message.type === "pair.bind"), "global-cap first bind");
  first.message({ version: 1, type: "pair.bound", requestId: firstBind.requestId });
  for (let index = 0; index < 16; index += 1) {
    first.message({ version: 1, type: "rpc.request", id: `pending-${index}`, method: "seats", params: {} });
  }
  await waitFor(() => calls === 16, "sixteen pairer-wide RPCs");

  for (let index = 0; index < 1_000; index += 1) {
    first.message({ version: 1, type: "rpc.request", id: `over-cap-${index}`, method: "seats", params: {} });
  }
  await waitFor(
    () => first.sent.some((message) => message.type === "rpc.error" && message.id === "over-cap-999"),
    "over-cap churn refusal",
  );
  assert.equal(calls, 16);

  first.emit("close");
  const second = await waitFor(() => FakeWebSocket.instances[1], "global-cap reconnect socket");
  second.emit("open");
  const secondBind = await waitFor(() => second.sent.find((message) => message.type === "pair.bind"), "global-cap reconnect bind");
  second.message({ version: 1, type: "pair.bound", requestId: secondBind.requestId });
  second.message({ version: 1, type: "rpc.request", id: "pending-0", method: "seats", params: {} });
  const third = await waitFor(() => FakeWebSocket.instances[2], "pending replay rejection reconnect");
  assert.equal(calls, 16);
  assert.equal(maxActive, 16);

  resolvers.shift()();
  await waitFor(() => active === 15, "one global RPC slot release");
  third.emit("open");
  const thirdBind = await waitFor(() => third.sent.find((message) => message.type === "pair.bind"), "post-replay reconnect bind");
  third.message({ version: 1, type: "pair.bound", requestId: thirdBind.requestId });
  third.message({ version: 1, type: "rpc.request", id: "over-cap-999", method: "seats", params: {} });
  await waitFor(() => calls === 17, "previously refused ID admission");
  assert.equal(maxActive, 16);

  controller.abort();
  assert.deepEqual(await runResult, { status: "unpaired" });
  for (const resolve of resolvers) resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(first.sent.some((message) => message.type === "rpc.result"), false);
  assert.equal(second.sent.some((message) => message.type === "rpc.result"), false);
  assert.equal(third.sent.some((message) => message.type === "rpc.result"), false);
});

test("a delayed bind frame from a closed socket cannot restore paired state", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-stale-close-frame");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  const events = [];
  const runtime = { seats: async () => null, originate: async () => null, continue: async () => null, doctorStatus: async () => null };
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeWebSocket, pairStateFile: stateFile, reconnectBaseMs: 1, reconnectCapMs: 1, random: () => 0, onEvent: (event) => events.push(event) });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const first = await waitFor(() => FakeWebSocket.instances[0], "delayed-close socket");
  first.emit("open");
  const bind = await waitFor(() => first.sent.find((message) => message.type === "pair.bind"), "delayed-close bind");
  const delayed = delayedBlob({ version: 1, type: "pair.bound", requestId: bind.requestId });
  first.emit("message", delayed.blob);
  first.emit("close");
  await waitFor(() => FakeWebSocket.instances[1], "delayed-close reconnect");
  delayed.release();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fs.existsSync(pairFile), true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).staleReason, "relay_connection_closed");
  assert.equal(events.some((event) => event.event === "pair.paired"), false);
  controller.abort();
  assert.deepEqual(await runResult, { status: "unpaired" });
});

test("a delayed bind frame from an aborted socket has no post-abort side effects", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-stale-abort-frame");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  const events = [];
  const runtime = { seats: async () => null, originate: async () => null, continue: async () => null, doctorStatus: async () => null };
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeWebSocket, pairStateFile: stateFile, onEvent: (event) => events.push(event) });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const socket = await waitFor(() => FakeWebSocket.instances[0], "delayed-abort socket");
  socket.emit("open");
  const bind = await waitFor(() => socket.sent.find((message) => message.type === "pair.bind"), "delayed-abort bind");
  const delayed = delayedBlob({ version: 1, type: "pair.bound", requestId: bind.requestId });
  socket.emit("message", delayed.blob);
  controller.abort();
  assert.deepEqual(await runResult, { status: "unpaired" });
  delayed.release();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fs.existsSync(pairFile), true);
  assert.deepEqual(readPairPresence(stateFile), { status: "unpaired" });
  assert.equal(events.some((event) => event.event === "pair.paired"), false);
});

test("a delayed RPC frame from a lost bound socket cannot start local work", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-stale-rpc-frame");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  let calls = 0;
  const runtime = {
    seats: async () => { calls += 1; return null; },
    originate: async () => null,
    continue: async () => null,
    doctorStatus: async () => null,
  };
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeWebSocket, pairStateFile: stateFile, reconnectBaseMs: 1, reconnectCapMs: 1, random: () => 0 });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const first = await waitFor(() => FakeWebSocket.instances[0], "delayed-RPC socket");
  first.emit("open");
  const bind = await waitFor(() => first.sent.find((message) => message.type === "pair.bind"), "delayed-RPC bind");
  first.message({ version: 1, type: "pair.bound", requestId: bind.requestId });
  await waitFor(() => !fs.existsSync(pairFile), "delayed-RPC offer consumption");
  const delayed = delayedBlob({ version: 1, type: "rpc.request", id: "stale-rpc", method: "seats", params: {} });
  first.emit("message", delayed.blob);
  first.emit("close");
  await waitFor(() => FakeWebSocket.instances[1], "delayed-RPC reconnect");
  delayed.release();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 0);
  assert.equal(first.sent.some((message) => message.id === "stale-rpc"), false);
  controller.abort();
  assert.deepEqual(await runResult, { status: "unpaired" });
});

test("missed relay heartbeat marks presence stale and reconnects", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-heartbeat-timeout");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  const runtime = { seats: async () => null, originate: async () => null, continue: async () => null, doctorStatus: async () => null };
  const pairer = new OutboundPairer({
    runtime,
    WebSocketImpl: FakeWebSocket,
    pairStateFile: stateFile,
    leaseMs: 1_000,
    heartbeatTimeoutMs: 1_000,
    reconnectBaseMs: 1,
    reconnectCapMs: 1,
    random: () => 0,
  });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const first = await waitFor(() => FakeWebSocket.instances[0], "heartbeat socket");
  first.emit("open");
  const bind = await waitFor(() => first.sent.find((message) => message.type === "pair.bind"), "heartbeat bind");
  first.message({ version: 1, type: "pair.bound", requestId: bind.requestId });
  const second = await waitFor(() => FakeWebSocket.instances[1], "heartbeat-timeout reconnect");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).staleReason, "relay_heartbeat_timeout");
  controller.abort();
  assert.deepEqual(await runResult, { status: "unpaired" });
  assert.equal(second.closed, true);
});

test("Sphere revoke is handled while a local RPC remains in flight", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-revoke");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  let rpcStarted = false;
  let resolveRpc;
  const runtime = {
    seats: async () => {
      rpcStarted = true;
      return await new Promise((resolve) => { resolveRpc = resolve; });
    },
    originate: async () => null,
    continue: async () => null,
    doctorStatus: async () => null,
  };
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeWebSocket, pairStateFile: stateFile });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1" }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const socket = await waitFor(() => FakeWebSocket.instances[0], "revoke socket");
  socket.emit("open");
  const bind = await waitFor(() => socket.sent.find((message) => message.type === "pair.bind"), "revoke bind");
  socket.message({ version: 1, type: "pair.bound", requestId: bind.requestId });
  await waitFor(() => !fs.existsSync(pairFile), "revoke bind acknowledgement");
  socket.message({ version: 1, type: "rpc.request", id: "slow-rpc", method: "seats", params: {} });
  await waitFor(() => rpcStarted, "slow RPC start");
  socket.message({ version: 1, type: "pair.revoked" });
  const outcome = await runResult;
  assert.match(outcome.error.message, /authorization was revoked/);
  assert.deepEqual(readPairPresence(stateFile), { status: "unpaired" });
  resolveRpc({ seats: ["must-not-send-after-revoke"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(socket.sent.some((message) => message.type === "rpc.result" && message.id === "slow-rpc"), false);
});

test("bind acknowledgement refuses to consume a replaced offer path", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-replaced-offer");
  const pairFile = writeOffer(directory);
  const originalFile = path.join(directory, "original-offer.json");
  const stateFile = path.join(directory, "presence.json");
  const runtime = { seats: async () => null, originate: async () => null, continue: async () => null, doctorStatus: async () => null };
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeWebSocket, pairStateFile: stateFile });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1" }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const socket = await waitFor(() => FakeWebSocket.instances[0], "replacement socket");
  socket.emit("open");
  const bind = await waitFor(() => socket.sent.find((message) => message.type === "pair.bind"), "replacement bind");
  fs.renameSync(pairFile, originalFile);
  writeOffer(directory, { pairToken: "different-one-shot-secret-1234" });
  socket.message({ version: 1, type: "pair.bound", requestId: bind.requestId });
  const outcome = await runResult;
  assert.match(outcome.error.message, /presence activation failed/);
  assert.equal(fs.existsSync(pairFile), true);
  assert.equal(fs.existsSync(originalFile), true);
  assert.equal(outcome.error.message.includes(PAIR_TOKEN), false);
});

test("abort before socket open never sends the one-shot pair offer", async () => {
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("pair-abort-before-open");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  const runtime = { seats: async () => null, originate: async () => null, continue: async () => null, doctorStatus: async () => null };
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeWebSocket, pairStateFile: stateFile });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const socket = await waitFor(() => FakeWebSocket.instances[0], "aborted outbound socket");

  controller.abort();
  assert.deepEqual(await runResult, { status: "unpaired" });
  socket.emit("open");

  assert.deepEqual(socket.sent, []);
  assert.equal(fs.existsSync(pairFile), true);
  assert.deepEqual(readPairPresence(stateFile), { status: "unpaired" });
});

test("expired pair offers fail closed without exposing pair tokens", async () => {
  const directory = temporaryDirectory("pair-expired");
  const pairFile = writeOffer(directory, { expiresAt: "2020-01-01T00:00:00.000Z" });
  const stateFile = path.join(directory, "presence.json");
  const events = [];
  class MustNotConnect { constructor() { throw new Error("must not connect"); } }
  const pairer = new OutboundPairer({ runtime: {}, WebSocketImpl: MustNotConnect, pairStateFile: stateFile, onEvent: (event) => events.push(event) });
  await assert.rejects(pairer.run({ pairFile, machineId: "sphere-machine-1" }), /Pair offer has expired/);
  assert.deepEqual(readPairPresence(stateFile), { status: "expired" });
  assert.equal(fs.existsSync(pairFile), true);
  assert.equal(JSON.stringify(events).includes(PAIR_TOKEN), false);
});
