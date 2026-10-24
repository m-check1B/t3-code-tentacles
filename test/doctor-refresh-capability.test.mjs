import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor, formatDoctor } from "../src/bridge.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";

function fixture(t, { status = "error", enabled = true, installed = true, capability = { talkTurnResult: "v1" } } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-refresh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = { refresh: [], config: 0, capability: 0 };
  let provider = { instanceId: "cursor", driver: "cursor", status, installed, models: status === "ready" ? [{ slug: "synthetic-model" }] : [] };
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: installed ? { cursor: { driver: "cursor", enabled } } : {} }),
    rpc: async (tag) => { assert.equal(tag, "server.getConfig"); calls.config += 1; return { environment: { serverVersion: "0.0.44-test" }, providers: [provider] }; },
    refreshProvider: async (id) => { calls.refresh.push(id); provider = { ...provider, status: "ready", models: [{ slug: "synthetic-model" }] }; },
    request: async (route) => { assert.equal(route, "/api/orchestration/turn-result"); calls.capability += 1; if (capability instanceof Error) throw capability; return capability; },
  };
  const options = { fetchImpl: async () => { throw new Error("Synthetic Hermes absent"); }, pairStateFile: path.join(directory, "pair.json"), openrouterTokenFile: path.join(directory, "absent-token"), hermesHome: directory, refreshDirectory: path.join(directory, "refresh") };
  return { client, calls, options, setProvider: (next) => { provider = next; } };
}
const cursor = (report) => report.labs.find((lab) => lab.instanceId === "cursor");

test("doctor refreshes stale provider_error and rereads ready state", async (t) => {
  const { client, calls, options } = fixture(t);
  const report = await doctor(client, options);
  assert.deepEqual(calls.refresh, ["cursor"]);
  assert.equal(calls.config, 2);
  assert.equal(cursor(report).ready, true);
  assert.deepEqual(cursor(report).models, ["synthetic-model"]);
});

test("doctor also refreshes an installed provider that is not ready", async (t) => {
  const { client, calls, options } = fixture(t, { status: "configured" });
  assert.equal(cursor(await doctor(client, options)).ready, true);
  assert.deepEqual(calls.refresh, ["cursor"]);
});

test("doctor cooldown includes failed refreshes and permits retry after 60 seconds", async (t) => {
  const { client, calls, options } = fixture(t);
  let clock = 1_000;
  client.refreshProvider = async (id) => { calls.refresh.push(id); throw new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC"); };
  const run = () => doctor(client, { ...options, now: () => clock });
  await run();
  clock += 59_999;
  const second = await run();
  assert.equal(cursor(second).ready, false);
  assert.deepEqual(calls.refresh, ["cursor"]);
  assert.equal(JSON.stringify(second).includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"), false);
  clock += 1;
  await run();
  assert.deepEqual(calls.refresh, ["cursor", "cursor"]);
});

for (const input of [{ status: "ready" }, { enabled: false }, { installed: false }]) {
  test(`doctor does not refresh ${JSON.stringify(input)}`, async (t) => {
    const { client, calls, options } = fixture(t, input);
    await doctor(client, options);
    assert.deepEqual(calls.refresh, []);
  });
}

test("doctor never refreshes an uninstalled snapshot with retained enabled settings", async (t) => {
  const { client, calls, options } = fixture(t, { installed: false, status: "error" });
  client.getSettings = async () => ({ providerInstances: { cursor: { driver: "cursor", enabled: true } } });
  await doctor(client, options);
  assert.deepEqual(calls.refresh, []);
  assert.equal(calls.config, 1);
  assert.equal(fs.existsSync(options.refreshDirectory), false);
});

test("doctor aborts a hanging refresh inside its deadline and retains a fail-closed row", async (t) => {
  const { client, calls, options } = fixture(t);
  let signal;
  client.refreshProvider = (id, opts) => { calls.refresh.push(id); signal = opts.signal; return new Promise(() => {}); };
  const report = await doctor(client, { ...options, timeoutMs: 30 });
  assert.deepEqual(calls.refresh, ["cursor"]);
  assert.equal(signal.aborted, true);
  assert.equal(cursor(report).ready, false);
  assert.equal(cursor(report).code, "provider_error");
});

for (const [label, capability] of [
  ["upstream SPA", "<html>SYNTHETIC_PRIVATE_BODY</html>"],
  ["missing capability", { talkTurnResult: "v2", body: "SYNTHETIC_PRIVATE_BODY" }],
  ["unknown field", { talkTurnResult: "v1", junk: true }],
  ["unrelated body", { talkTurnResult: "v1", body: "SYNTHETIC_PRIVATE_BODY" }],
  ["unagreed extension", { talkTurnResult: "v1", talkFreshProviderContext: "v1", talkFreshProviderContextProviders: ["codex"] }],
  ["missing route", new T3HttpError({ method: "GET", pathname: "/api/orchestration/turn-result", status: 404 })],
]) {
  test(`doctor reports actionable missing capability for ${label}`, async (t) => {
    const { client, calls, options } = fixture(t, { status: "ready", capability });
    const report = await doctor(client, options);
    assert.equal(calls.capability, 1);
    assert.equal(report.capabilities.talkTurnResult, null);
    assert.equal(report.capabilities.turnInterrupt ?? null, null);
    assert.equal(Object.hasOwn(report.capabilities, "talkFreshProviderContext"), false);
    assert.equal(report.t3.talk.status, "missing");
    assert.equal(report.t3.talk.code, "t3_not_patched");
    assert.match(report.t3.talk.action, /update T3/i);
    assert.match(formatDoctor(report), /t3_not_patched/);
    assert.equal(JSON.stringify(report).includes("SYNTHETIC_PRIVATE_BODY"), false);
    assert.equal(cursor(report).ready, true);
  });
}

test("doctor reports only bounded capability fields for a patched T3", async (t) => {
  const { client, options } = fixture(t, { status: "ready", capability: { talkTurnResult: "v1" } });
  const report = await doctor(client, options);
  assert.equal(report.capabilities.talkTurnResult, "v1");
  assert.deepEqual(report.t3.talk, { status: "present", code: null, action: null });
  assert.equal(JSON.stringify(report).includes("SYNTHETIC_PRIVATE_BODY"), false);
});

test("capability timeout never passes and aborts the connection", async (t) => {
  const { client, options } = fixture(t, { status: "ready" });
  let signal;
  client.request = (_route, opts) => { signal = opts.signal; return new Promise(() => {}); };
  const report = await doctor(client, { ...options, timeoutMs: 30 });
  assert.equal(signal.aborted, true);
  assert.equal(report.capabilities.talkTurnResult, null);
  assert.equal(report.t3.talk.code, "t3_capability_timeout");
});

test("pairer publishes the same doctor capability outcome without probing twice", async (t) => {
  const { client, calls, options } = fixture(t, { status: "ready", capability: {} });
  const adapter = new LoopbackRuntimeAdapter({ client, doctorImpl: (value) => doctor(value, options) });
  const report = await adapter.doctorStatus();
  assert.equal(calls.capability, 1);
  assert.equal(report.t3.talk.code, "t3_not_patched");
  assert.equal(report.capabilities.talkTurnResult, null);
});

test("real T3Client capability HTTP call uses the doctor abort signal", async (t) => {
  const { options } = fixture(t);
  let aborted = false;
  const client = new T3Client({ token: "synthetic-token", fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  client.snapshot = async () => ({ projects: [], threads: [] });
  client.getSettings = async () => ({ providerInstances: {} });
  client.rpc = async () => ({ providers: [] });
  const report = await doctor(client, { ...options, timeoutMs: 30 });
  assert.equal(aborted, true);
  assert.equal(report.t3.talk.code, "t3_capability_timeout");
});


test("doctor cooldown survives a new client on the same T3 origin", async (t) => {
  const { client, options, calls } = fixture(t);
  client.baseUrl = "http://127.0.0.1:3773";
  client.refreshProvider = async (id) => { calls.refresh.push(id); throw new Error("Synthetic stale provider"); };
  await doctor(client, options);
  await doctor({ ...client }, options);
  assert.deepEqual(calls.refresh, ["cursor"]);
});

test("concurrent doctor calls claim only one refresh per instance", async (t) => {
  const { client, options, calls } = fixture(t);
  client.refreshProvider = async (id) => { calls.refresh.push(id); await new Promise(resolve => setImmediate(resolve)); };
  await Promise.all([doctor(client, options), doctor(client, options)]);
  assert.deepEqual(calls.refresh, ["cursor"]);
});

test("doctor refresh closes an actual fake RPC socket at the deadline", async (t) => {
  const { options } = fixture(t);
  let socket;
  class Socket {
    constructor() { this.listeners = {}; this.closed = false; socket = this; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    close() { this.closed = true; }
    send() { assert.equal(this.closed, false, "no send after timeout"); }
  }
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic-token", orchestrationProtocol: 1, WebSocketImpl: Socket,
    fetchImpl: async (url) => new Response(JSON.stringify(url.endsWith("turn-result") ? { talkTurnResult: "v1" } : { ticket: "synthetic-ticket" })),
  });
  client.snapshot = async () => ({ projects: [], threads: [] });
  client.getSettings = async () => ({ providerInstances: { cursor: { driver: "cursor", enabled: true } } });
  const rpc = client.rpc.bind(client);
  client.rpc = (tag, payload, opts) => tag === "server.getConfig" ? Promise.resolve({ providers: [{ instanceId: "cursor", installed: true, status: "error", models: [] }] }) : rpc(tag, payload, opts);
  const report = await doctor(client, { ...options, timeoutMs: 100 });
  assert.equal(cursor(report).ready, false);
  assert.equal(socket.closed, true);
  socket.listeners.open();
  await socket.listeners.message({ data: JSON.stringify({ _tag: "Ping" }) });
});

test("doctor never touches an unsafe persisted refresh directory", async (t) => {
  const { client, options, calls } = fixture(t);
  client.baseUrl = "http://127.0.0.1:3773";
  fs.mkdirSync(options.refreshDirectory, { mode: 0o755 });
  await doctor(client, options);
  assert.deepEqual(calls.refresh, []);
  assert.equal(fs.statSync(options.refreshDirectory).mode & 0o777, 0o755);
});

test("doctor keeps the original error snapshot when the refresh reread fails", async (t) => {
  const { client, options, calls } = fixture(t);
  const rpc = client.rpc;
  client.rpc = async (...args) => { if (calls.config) throw new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC"); return rpc(...args); };
  const report = await doctor(client, options);
  assert.deepEqual(calls.refresh, ["cursor"]);
  assert.equal(cursor(report).ready, false);
  assert.equal(cursor(report).code, "provider_error");
  assert.equal(JSON.stringify(report).includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"), false);
});

test("persisted cooldown expires after 60 seconds and remains independent per origin", async (t) => {
  const { client, options, calls } = fixture(t);
  client.baseUrl = "http://127.0.0.1:3773";
  client.refreshProvider = async (id) => { calls.refresh.push(id); throw new Error("Synthetic stale provider"); };
  let clock = 1_000;
  const run = (value = client) => doctor(value, { ...options, now: () => clock });
  await run();
  clock = 60_999;
  await run({ ...client });
  assert.equal(calls.refresh.length, 1);
  clock = 61_000;
  await run({ ...client });
  assert.equal(calls.refresh.length, 2);
  await run({ ...client, baseUrl: "http://127.0.0.1:3774" });
  assert.equal(calls.refresh.length, 3);
  for (const name of fs.readdirSync(options.refreshDirectory)) {
    assert.match(name, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(path.join(options.refreshDirectory, name)).size, 0);
  }
});

test("cooldown is per provider instance and ambiguous rows are never refreshed", async (t) => {
  const { client, options, calls } = fixture(t);
  client.getSettings = async () => ({ providerInstances: { cursor: { enabled: true }, opencode: { enabled: true } } });
  client.rpc = async () => ({ providers: ["cursor", "opencode", "opencode"].map(instanceId => ({ instanceId, installed: true, status: "error", models: [] })) });
  client.refreshProvider = async (id) => { calls.refresh.push(id); };
  await doctor(client, options);
  assert.deepEqual(calls.refresh, ["cursor"]);
});

test("persisted cooldown refuses symlinks without changing their target", async (t) => {
  const { client, options, calls } = fixture(t);
  client.baseUrl = "http://127.0.0.1:3773";
  client.refreshProvider = async (id) => { calls.refresh.push(id); throw new Error("Synthetic stale provider"); };
  await doctor(client, { ...options, now: () => 1_000 });
  const file = path.join(options.refreshDirectory, fs.readdirSync(options.refreshDirectory)[0]);
  const target = path.join(path.dirname(options.refreshDirectory), "synthetic-target");
  fs.writeFileSync(target, "synthetic-fixture", { mode: 0o600 });
  fs.unlinkSync(file);
  fs.symlinkSync(target, file);
  const before = fs.statSync(target).mtimeMs;
  await doctor({ ...client }, { ...options, now: () => 61_000 });
  assert.equal(calls.refresh.length, 1);
  assert.equal(fs.statSync(target).mtimeMs, before);
});

test("authentication failure before capability probing never publishes support", async (t) => {
  const { client, options, calls } = fixture(t);
  client.getSettings = async () => { throw new T3HttpError({ method: "POST", pathname: "/api/auth/websocket-ticket", status: 401 }); };
  const report = await doctor(client, options);
  assert.equal(report.capabilities.talkTurnResult, null);
  assert.equal(report.t3.talk.code, "t3_reauth_required");
  assert.equal(calls.capability, 0);
  assert.deepEqual(calls.refresh, []);
});
