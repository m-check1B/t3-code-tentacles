import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LoopbackRuntimeAdapter, OutboundPairer } from "../src/outbound-pairer.mjs";
import { readPairPresence } from "../src/pair-state.mjs";

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tentacles-${label}-`));
}

function writeOffer(directory) {
  const file = path.join(directory, "pair-offer.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    endpoint: "wss://jack.example.test/api/tentacles/pair",
    pairToken: "pair-secret-never-print-123456",
    expiresAt: "2099-01-01T00:00:00.000Z",
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

  constructor() {
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {}

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }

  message(value) {
    this.emit("message", JSON.stringify(value));
  }
}

test("doctor-status answers from the cache and stays under 500ms while doctor is slow", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const logs = [];
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({ talkTurnResult: "v1" }) },
    timingsLog: (entry) => logs.push(entry),
    now: () => 1_000 + calls,
    doctorImpl: async () => {
      calls += 1;
      await gate;
      return {
        product: "Tentacles",
        labs: [{ instanceId: "codex", models: ["gpt-6.1-sol"] }],
        timings: { orchestrationSnapshot: 4, settings: 3, serverConfig: 5, hermesHealth: 2, leakedSessions: 1 },
      };
    },
  });
  const started = Date.now();
  const cold = await Promise.race([
    adapter.doctorStatus({}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("doctor-status blocked on a slow doctor")), 200)),
  ]);
  assert.equal(Date.now() - started < 500, true);
  assert.equal(cold.cache.state, "cold");
  assert.equal(cold.labs.length, 0);
  release();
  await adapter.refreshModels();
  const warm = await adapter.doctorStatus({});
  assert.deepEqual(warm.labs, [{ instanceId: "codex", models: ["gpt-6.1-sol"] }]);
  assert.equal(warm.cache.state, "warm");
  assert.equal(warm.capabilities.talkTurnResult, "v1");
  assert.equal(typeof warm.timings.orchestrationSnapshot, "number");
  assert.equal(typeof warm.timings.doctor, "number");
  assert.equal(logs.at(-1)?.event, "doctor.timings");
  const samples = [];
  for (let index = 0; index < 40; index += 1) {
    const at = Date.now();
    const report = await adapter.doctorStatus({});
    samples.push(Date.now() - at);
    assert.equal(report.labs[0].models[0], "gpt-6.1-sol");
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  assert.equal(p95 < 500, true, `cached doctor-status p95 was ${p95}ms`);
  assert.equal(calls, 1);
});

test("a pairing ping pongs without refreshModels", async () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("warm-ping");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  let modelRefreshes = 0;
  const pairer = new OutboundPairer({
    runtime: {
      seats: async () => null,
      doctorStatus: async () => null,
      refreshModels: async () => { modelRefreshes += 1; },
    },
    WebSocketImpl: FakeWebSocket,
    pairStateFile: stateFile,
    leaseMs: 3_000,
    heartbeatTimeoutMs: 2_000,
    reconnectBaseMs: 1,
    reconnectCapMs: 1,
    random: () => 0,
    now: () => now,
  });
  const runResult = pairer.run({ pairFile, machineId: "sphere-machine-1", signal: controller.signal });
  const socket = await waitFor(() => FakeWebSocket.instances[0], "relay socket");
  socket.emit("open");
  const bind = await waitFor(() => socket.sent.find((message) => message.type === "pair.bind"), "bind");
  socket.message({ version: 1, type: "pair.bound", requestId: bind.requestId });
  await waitFor(() => readPairPresence(stateFile, { now }).status === "paired", "paired");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterBind = modelRefreshes;
  socket.message({ version: 1, type: "ping" });
  await waitFor(() => socket.sent.some((message) => message.type === "pong"), "pong");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(modelRefreshes, afterBind);
  assert.equal(modelRefreshes <= 1, true);
  controller.abort();
  await runResult;
});
