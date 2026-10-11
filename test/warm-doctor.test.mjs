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
    coldWaitMs: 50,
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
  // Cold and still warming past the cold wait: a transient error, never an empty "not capable" report.
  await assert.rejects(adapter.doctorStatus({}), (error) => error.code === "computer.warming");
  assert.equal(Date.now() - started < 500, true);
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

test("a cold doctor-status waits for the first warm instead of answering empty", async () => {
  let calls = 0;
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({ talkTurnResult: "v1" }) },
    timingsLog: () => {},
    doctorImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { product: "Tentacles", labs: [{ instanceId: "codex", models: ["gpt-6.1-sol"] }] };
    },
  });
  const first = await adapter.doctorStatus({});
  assert.equal(first.cache.state, "warm");
  assert.equal(first.capabilities.talkTurnResult, "v1");
  assert.deepEqual(first.labs, [{ instanceId: "codex", models: ["gpt-6.1-sol"] }]);
  assert.equal(calls, 1);
  assert.throws(() => new LoopbackRuntimeAdapter({ client: {}, coldWaitMs: 10_000 }), /cold wait/);
});

test("a cold doctor-status whose warm fails is a transient error", async () => {
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({}) },
    timingsLog: () => {},
    doctorImpl: async () => { throw new Error("T3 unreachable"); },
  });
  await assert.rejects(adapter.doctorStatus({}), (error) => error.code === "computer.warming");
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

// B3 10623: a stale doctor report must never stand in for current readiness.
function boundedAdapter() {
  const state = { now: 10_000, calls: 0, fail: false };
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({ talkTurnResult: "v1" }) },
    timingsLog: () => {},
    cacheMaxAgeMs: 60_000,
    coldWaitMs: 50,
    now: () => state.now,
    doctorImpl: async () => {
      state.calls += 1;
      if (state.fail) throw new Error("T3 unreachable");
      return { product: "Tentacles", t3: { reachable: true }, labs: [{ instanceId: "codex", ready: true, models: ["gpt-6.1-sol"] }] };
    },
  });
  return { adapter, state };
}

test("B3 10623: past the age bound a failing doctor is an error, never the old ready report", async () => {
  const { adapter, state } = boundedAdapter();
  await adapter.refreshModels();
  assert.equal((await adapter.doctorStatus({})).labs[0].ready, true);
  state.fail = true;
  state.now += 60_001;
  await assert.rejects(adapter.doctorStatus({}), (error) => error.code === "computer.warming");
  // Time moving back inside the bound cannot resurrect the dropped report.
  state.now -= 30_000;
  await assert.rejects(adapter.doctorStatus({}), (error) => error.code === "computer.warming");
  state.fail = false;
  const recovered = await adapter.doctorStatus({});
  assert.equal(recovered.labs[0].ready, true);
  assert.equal(recovered.cache.stale, false);
});

test("B3 10623: past the age bound a working doctor answers with a fresh report", async () => {
  const { adapter, state } = boundedAdapter();
  await adapter.refreshModels();
  state.now += 120_000;
  const report = await adapter.doctorStatus({});
  assert.equal(report.cache.ageMs, 0);
  assert.equal(report.cache.stale, false);
  assert.equal(state.calls, 2);
  // Inside the bound the cache answers without another doctor run.
  state.now += 1_000;
  assert.equal((await adapter.doctorStatus({})).cache.ageMs, 1_000);
  assert.equal(state.calls, 2);
});

// A9 (KRA-6931): while paired or bound, Tentacles keeps the doctor warm itself.
function scheduledAdapter({ doctorMs = 0 } = {}) {
  const state = { now: 1_000_000, calls: 0, timers: [] };
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({ talkTurnResult: "v1" }) },
    timingsLog: () => {},
    cacheMaxAgeMs: 60_000,
    coldWaitMs: 50,
    now: () => state.now,
    random: () => 0.5,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    doctorImpl: async () => {
      state.calls += 1;
      if (doctorMs) await new Promise((resolve) => setTimeout(resolve, doctorMs));
      return { product: "Tentacles", labs: [{ instanceId: "codex", ready: true, models: ["gpt-6.1-sol"] }] };
    },
  });
  const pending = () => state.timers.filter((timer) => !timer.cleared && !timer.fired);
  const fire = async () => {
    const [timer] = pending();
    assert.ok(timer, "a warm is scheduled");
    timer.fired = true;
    timer.callback();
    await adapter.modelRefresh;
    await new Promise((resolve) => setImmediate(resolve));
    return timer;
  };
  return { adapter, state, pending, fire };
}

test("A9: after more than 60 s idle while paired, doctor-status answers from cache within 500 ms", async () => {
  const { adapter, state, pending, fire } = scheduledAdapter({ doctorMs: 1_000 });
  const release = adapter.keepWarm();
  const first = await fire();
  assert.equal(first.delayMs, 0, "keepWarm warms at bind");
  // Idle: no doctor-status reads at all, only the background schedule.
  const boundAt = state.now;
  for (let tick = 0; tick < 4; tick += 1) {
    const [next] = pending();
    assert.equal(next.delayMs >= 24_000 && next.delayMs <= 36_000, true, `warm interval ${next.delayMs}`);
    state.now += next.delayMs;
    await fire();
  }
  state.now += 20_000;
  assert.equal(state.now - boundAt > 60_000, true, "no doctor-status read for more than 60 s");
  const calls = state.calls;
  const started = Date.now();
  const report = await adapter.doctorStatus({});
  assert.equal(Date.now() - started < 500, true);
  assert.equal(report.cache.state, "warm");
  assert.equal(report.labs[0].ready, true);
  assert.equal(state.calls, calls, "served from the background-warmed cache");
  release();
});

test("A9: keepWarm runs one refresh at a time and stops when every holder releases", async () => {
  const { adapter, pending, fire } = scheduledAdapter();
  const releaseA = adapter.keepWarm();
  const releaseB = adapter.keepWarm();
  assert.equal(pending().length, 1, "two holders share one schedule");
  await fire();
  assert.equal(pending().length, 1, "the next warm is scheduled only after the last one finished");
  releaseA();
  assert.equal(pending().length, 1);
  releaseB();
  releaseB();
  assert.equal(pending().length, 0);
});

test("A9: a cold doctor-status miss is computer.warming", async () => {
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({}) },
    timingsLog: () => {},
    coldWaitMs: 20,
    doctorImpl: () => new Promise(() => {}),
  });
  await assert.rejects(adapter.doctorStatus({}), (error) => error.code === "computer.warming");
});

test("A9: the legacy pair path keeps the bound pair warm and stops on disconnect", async () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");
  FakeWebSocket.instances = [];
  const directory = temporaryDirectory("warm-hold");
  const pairFile = writeOffer(directory);
  const stateFile = path.join(directory, "presence.json");
  const controller = new AbortController();
  let holds = 0;
  let releases = 0;
  const pairer = new OutboundPairer({
    runtime: {
      seats: async () => null,
      doctorStatus: async () => null,
      keepWarm: () => { holds += 1; return () => { releases += 1; }; },
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
  await waitFor(() => holds === 1, "keepWarm at bind");
  assert.equal(releases, 0);
  controller.abort();
  await runResult;
  assert.equal(releases, 1);
});

test("maintenance cache keeps selfUpdate current without another doctor read", async () => {
  let calls = 0;
  let summary = { schema: "tentacles-self-update/v1", held: false };
  const adapter = new LoopbackRuntimeAdapter({
    client: {}, timingsLog: () => {},
    doctorImpl: async () => { calls += 1; return { labs: [] }; },
    selfUpdateSummaryImpl: () => summary,
  });
  assert.deepEqual((await adapter.doctorStatus()).selfUpdate, summary);
  summary = { ...summary, held: true };
  assert.deepEqual((await adapter.doctorStatus()).selfUpdate, summary);
  summary = null;
  assert.equal("selfUpdate" in await adapter.doctorStatus(), false);
  assert.equal(calls, 1);
});

test("a warm that finishes past its age bound cannot publish ready or reset age to zero", async () => {
  let now = 1_000;
  const adapter = new LoopbackRuntimeAdapter({
    client: {}, timingsLog: () => {}, now: () => now,
    doctorImpl: async () => { now += 60_000; return { labs: [{ ready: true }] }; },
    selfUpdateSummaryImpl: () => null,
  });
  await assert.rejects(adapter.doctorStatus(), (error) => error.code === "computer.warming");
});
