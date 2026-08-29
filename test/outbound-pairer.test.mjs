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
  RemoteRpcShim,
  SPHERE_ABILITY,
  SPHERE_PRODUCT_ID,
} from "../src/outbound-pairer.mjs";
import { acquirePairStateLock, readPairPresence, writePairPresence } from "../src/pair-state.mjs";

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
  assert.equal(fs.readFileSync(file, "utf8").includes(PAIR_TOKEN), false);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
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
    owner: "11111111-1111-4111-8111-111111111111",
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
    client: { local: true },
    observeImpl: async (client) => ({ seats: [client.local] }),
    originateImpl: async (client, params) => { calls.push(["originate", client, params]); return { threadId: "t1" }; },
    continueImpl: async (client, params) => { calls.push(["continue", client, params]); return { threadId: params.threadId }; },
    doctorImpl: async (_client, params) => ({ pairing: params.pairStateFile }),
    pairStateFile: "/tmp/synthetic-pair-presence.json",
  });
  assert.deepEqual(await adapter.seats(), { seats: [true] });
  assert.deepEqual(await adapter.originate({ workspace: "/tmp/work", title: "T", message: "M" }), { threadId: "t1" });
  assert.deepEqual(await adapter.continue({ threadId: "t1", message: "again", runtimeMode: "full-access" }), { threadId: "t1" });
  assert.deepEqual(await adapter.doctorStatus(), { pairing: "/tmp/synthetic-pair-presence.json" });
  assert.deepEqual(calls.map((entry) => entry[2].runtimeMode), ["full-access", "full-access"]);
  assert.throws(() => adapter.originate({ runtimeMode: "approval-required" }), /requires runtimeMode full-access/);
  assert.throws(() => adapter.continue({ runtimeMode: "auto" }), /requires runtimeMode full-access/);
  assert.throws(() => adapter.originate({ stateFile: "/tmp/remote-controlled.json" }), /does not accept remote parameter stateFile/);
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
  const outcome = await runResult;
  assert.match(outcome.error.message, /protocol failed closed/);
  assert.deepEqual(readPairPresence(stateFile), { status: "unpaired" });
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
  assert.match(outcome.error.message, /no longer authorized/);
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
  assert.match(outcome.error.message, /protocol failed closed/);
  assert.equal(fs.existsSync(pairFile), true);
  assert.equal(fs.existsSync(originalFile), true);
  assert.equal(outcome.error.message.includes(PAIR_TOKEN), false);
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
