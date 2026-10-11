import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { KNOWN_COMMANDS, parseArgs } from "../src/cli.mjs";
import {
  DEVICE_CHANNELS,
  DeviceConnector,
  HostLink,
  buildDeviceMessage,
  deviceClosePolicy,
} from "../src/device-connect.mjs";

const CLI = path.resolve("src/cli.mjs");
const DEVICE_CONNECT = pathToFileURL(path.resolve("src/device-connect.mjs")).href;
// Byte-for-byte copy of ~/Developer-artifacts/KRA-6945-CONTRACT-v1-vector.json (process rule, KRA-6945).
// Its "message" field is the generator's display form: "\n" written as the two characters backslash, n.
const VECTOR = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/kra6945-contract-v1-vector.json"), "utf8"));
const RELAY = "wss://api.kraliki.com/api/v1/jack/devices/connect";
const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const ISSUED_AT = "2026-10-11T00:00:00Z";
const SIGNATURE = VECTOR.signatureDerB64url;

async function waitFor(check, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FakeHostChannel {
  constructor() {
    this.sent = [];
    this.messageListeners = new Set();
    this.closeListeners = new Set();
  }

  send(message) { this.sent.push(JSON.parse(JSON.stringify(message))); }
  onMessage(listener) { this.messageListeners.add(listener); }
  onClose(listener) { this.closeListeners.add(listener); }
  close() {}
  deliver(message) { for (const listener of this.messageListeners) listener(message); }
  end() { for (const listener of this.closeListeners) listener(); }
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

  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; }
  emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); }
  message(value) { this.emit("message", { data: JSON.stringify(value) }); }
  serverClose(code) { this.emit("close", { code }); }
}

function hostHello(channel, mac = ["notify", "open-url"]) {
  channel.deliver({ version: 1, type: "host.hello", deviceId: DEVICE_ID, keyFingerprint: VECTOR.keyFingerprint, mac });
}

// The fake connector answers every sign.request the way PR6 will: it builds the C1 message from fields.
function answerSignRequests(channel, { signature = SIGNATURE, extra = {}, fingerprint = VECTOR.keyFingerprint } = {}) {
  const answered = new Set();
  const timer = setInterval(() => {
    for (const request of channel.sent.filter((message) => message.type === "sign.request")) {
      if (answered.has(request.id)) continue;
      answered.add(request.id);
      channel.deliver({
        version: 1,
        type: "sign.result",
        id: request.id,
        algorithm: "ECDSA-P256-SHA256",
        keyFingerprint: fingerprint,
        signature,
        ...extra,
      });
    }
  }, 2);
  timer.unref();
  return () => clearInterval(timer);
}

async function startConnector({ runtime = {}, mac, connectorOptions = {} } = {}) {
  FakeWebSocket.instances = [];
  const channel = new FakeHostChannel();
  const host = new HostLink({ channel, signTimeoutMs: 500 });
  hostHello(channel, mac);
  await host.ready();
  const delays = [];
  const events = [];
  const connector = new DeviceConnector({
    runtime: {
      doctorStatus: async () => ({ product: "Tentacles", labs: [] }),
      warmDoctor: async () => {},
      ...runtime,
    },
    host,
    WebSocketImpl: FakeWebSocket,
    appVersion: "3.17.32",
    platform: "macos",
    arch: "arm64",
    random: () => 0.5,
    sleep: async (delayMs) => { delays.push(delayMs); },
    onEvent: (event) => events.push(event),
    ...connectorOptions,
  });
  const controller = new AbortController();
  const stopSigning = answerSignRequests(channel);
  const running = connector.run({ relay: RELAY, signal: controller.signal });
  const stop = async () => { controller.abort(); stopSigning(); return running; };
  return { channel, host, connector, controller, running, delays, events, stop };
}

async function bindSocket(index = 0) {
  const socket = await waitFor(() => FakeWebSocket.instances[index], `device socket ${index}`);
  socket.message({ type: "device.hello", version: 1, nonce: NONCE, issuedAt: ISSUED_AT, audience: RELAY });
  const auth = await waitFor(() => socket.sent.find((message) => message.type === "device.auth"), "device.auth");
  socket.message({ type: "device.bound", version: 1, connectionId: "conn-1", heartbeatSeconds: 15, consentMode: "ask", licence: { state: "active" } });
  return { socket, auth };
}

test("the C1 connect message matches the contract vector and verifies with its public key", () => {
  const message = buildDeviceMessage({
    purpose: "connect",
    audience: RELAY,
    deviceId: DEVICE_ID,
    keyFingerprint: VECTOR.keyFingerprint,
    nonce: NONCE,
    issuedAt: ISSUED_AT,
  });
  assert.equal(message, VECTOR.message.replaceAll("\\n", "\n"));
  assert.equal(message.split("\n").length, 7);
  assert.equal(message.endsWith("\n"), false);
  const publicKey = createPublicKey({ key: Buffer.from(VECTOR.publicKeySpkiB64url, "base64url"), format: "der", type: "spki" });
  assert.equal(verify("sha256", Buffer.from(message, "utf8"), publicKey, Buffer.from(SIGNATURE, "base64url")), true);
  assert.throws(() => buildDeviceMessage({ purpose: "connect", audience: `${RELAY}\nx`, deviceId: DEVICE_ID, keyFingerprint: VECTOR.keyFingerprint, nonce: NONCE, issuedAt: ISSUED_AT }), /audience/);
  assert.throws(() => buildDeviceMessage({ purpose: "anything", audience: RELAY, deviceId: DEVICE_ID, keyFingerprint: VECTOR.keyFingerprint, nonce: NONCE, issuedAt: ISSUED_AT }), /purpose/);
  assert.throws(() => buildDeviceMessage({ purpose: "connect", audience: RELAY, deviceId: DEVICE_ID, keyFingerprint: "ab".repeat(32), nonce: NONCE, issuedAt: ISSUED_AT }), /fingerprint/);
});

test("connect asks the connector for fields only and sends the C4 device.auth frame", async () => {
  const run = await startConnector();
  const { auth } = await bindSocket();
  const request = run.channel.sent.find((message) => message.type === "sign.request");
  assert.deepEqual(Object.keys(request).sort(), ["audience", "id", "issuedAt", "nonce", "purpose", "type", "version"]);
  assert.equal(request.purpose, "connect");
  assert.equal(request.audience, RELAY);
  assert.equal(request.nonce, NONCE);
  assert.equal(request.issuedAt, ISSUED_AT);
  assert.equal(Object.hasOwn(request, "payload"), false);
  assert.equal(Object.hasOwn(request, "message"), false);
  assert.deepEqual(auth, {
    type: "device.auth",
    version: 1,
    deviceId: DEVICE_ID,
    keyFingerprint: VECTOR.keyFingerprint,
    signature: SIGNATURE,
    app: { version: "3.17.32", platform: "macos", arch: "arm64" },
    channels: ["labs", "turns", "mac"],
    rpc: {
      labs: [...DEVICE_CHANNELS.labs],
      turns: [...DEVICE_CHANNELS.turns],
      mac: ["notify", "open-url"],
    },
  });
  assert.equal(auth.rpc.turns.includes("interrupt"), false);
  await run.stop();
});

test("a hello whose audience is not the dialed relay is never signed", async () => {
  const run = await startConnector();
  const socket = await waitFor(() => FakeWebSocket.instances[0], "device socket");
  socket.message({ type: "device.hello", version: 1, nonce: NONCE, issuedAt: ISSUED_AT, audience: "wss://evil.example.test/api/v1/jack/devices/connect" });
  await waitFor(() => run.delays.length >= 1, "reconnect after a foreign audience");
  assert.equal(run.channel.sent.some((message) => message.type === "sign.request"), false);
  assert.equal(socket.sent.some((message) => message.type === "device.auth"), false);
  await run.stop();
});

test("signer key material or a different fingerprint is refused and never reaches the relay", async () => {
  for (const extra of [{ extra: { privateKey: "MUST-NOT-CROSS" } }, { fingerprint: `sha256:${"ab".repeat(32)}` }]) {
    FakeWebSocket.instances = [];
    const channel = new FakeHostChannel();
    const host = new HostLink({ channel, signTimeoutMs: 500 });
    hostHello(channel);
    await host.ready();
    const delays = [];
    const connector = new DeviceConnector({
      runtime: { doctorStatus: async () => ({}) },
      host,
      WebSocketImpl: FakeWebSocket,
      appVersion: "3.17.32",
      sleep: async (delayMs) => { delays.push(delayMs); },
    });
    const controller = new AbortController();
    const stopSigning = answerSignRequests(channel, extra);
    const running = connector.run({ relay: RELAY, signal: controller.signal });
    const socket = await waitFor(() => FakeWebSocket.instances[0], "device socket");
    socket.message({ type: "device.hello", version: 1, nonce: NONCE, issuedAt: ISSUED_AT, audience: RELAY });
    await waitFor(() => delays.length >= 1, "reconnect after a bad signer reply");
    assert.equal(socket.sent.some((message) => message.type === "device.auth"), false);
    assert.equal(JSON.stringify(socket.sent).includes("MUST-NOT-CROSS"), false);
    controller.abort();
    stopSigning();
    await running;
  }
});

test("unknown frames are ignored before and after bind, and ping echoes seq", async () => {
  let warmed = 0;
  const run = await startConnector({ runtime: { warmDoctor: async () => { warmed += 1; } } });
  const socket = await waitFor(() => FakeWebSocket.instances[0], "device socket");
  socket.message({ type: "device.future-hint", version: 1, detail: "ignored" });
  socket.message({ type: "device.hello", version: 1, nonce: NONCE, issuedAt: ISSUED_AT, audience: RELAY });
  await waitFor(() => socket.sent.find((message) => message.type === "device.auth"), "device.auth");
  socket.message({ type: "device.bound", version: 1, connectionId: "conn-1", heartbeatSeconds: 15, consentMode: "ask", licence: { state: "grace", graceEndsAt: "2026-11-10T00:00:00Z" } });
  socket.message({ type: "device.notice", version: 1, text: "unknown to 0.4.1" });
  socket.message({ type: "ping", seq: 7 });
  const pong = await waitFor(() => socket.sent.find((message) => message.type === "pong"), "pong");
  assert.deepEqual(pong, { type: "pong", seq: 7 });
  socket.message({ type: "ping", seq: 8 });
  await waitFor(() => socket.sent.filter((message) => message.type === "pong").length === 2, "second pong");
  assert.equal(socket.closed, false);
  assert.equal(run.delays.length, 0);
  assert.equal(warmed, 1, "bind warms doctor once; pings never refresh");
  await run.stop();
});

test("labs and turns rpc answer with rpcId; an unknown method is method_unsupported, not a socket close", async () => {
  const run = await startConnector({
    runtime: {
      doctorStatus: async (params) => { assert.deepEqual(params, {}); return { product: "Tentacles", labs: [{ instanceId: "codex" }] }; },
      seats: async () => { throw new Error("T3 /api/orchestration/snapshot failed with SECRET-DETAIL"); },
    },
  });
  const { socket } = await bindSocket();
  const deadline = new Date(Date.now() + 10_000).toISOString().replace(/\.\d+Z$/, "Z");
  socket.message({ type: "rpc.request", rpcId: "11111111-1111-4111-8111-111111111111", channel: "labs", method: "doctor-status", params: {}, deadline });
  socket.message({ type: "rpc.request", rpcId: "22222222-2222-4222-8222-222222222222", channel: "turns", method: "interrupt", params: {}, deadline });
  socket.message({ type: "rpc.request", rpcId: "33333333-3333-4333-8333-333333333333", channel: "printers", method: "print", params: {}, deadline });
  socket.message({ type: "rpc.request", rpcId: "44444444-4444-4444-8444-444444444444", channel: "turns", method: "seats", params: {}, deadline });
  await waitFor(() => socket.sent.filter((message) => message.type?.startsWith("rpc.")).length === 4, "four rpc answers");
  const byId = Object.fromEntries(socket.sent.filter((message) => message.rpcId).map((message) => [message.rpcId, message]));
  assert.deepEqual(byId["11111111-1111-4111-8111-111111111111"], {
    type: "rpc.result",
    rpcId: "11111111-1111-4111-8111-111111111111",
    result: { product: "Tentacles", labs: [{ instanceId: "codex" }] },
  });
  assert.equal(byId["22222222-2222-4222-8222-222222222222"].code, "method_unsupported");
  assert.equal(byId["33333333-3333-4333-8333-333333333333"].code, "method_unsupported");
  assert.equal(byId["44444444-4444-4444-8444-444444444444"].code, "lab_error");
  assert.equal(JSON.stringify(socket.sent).includes("SECRET-DETAIL"), false);
  assert.equal(socket.closed, false);
  await run.stop();
});

test("a cold doctor that cannot warm in time answers computer.unavailable, a transient error", async () => {
  const error = Object.assign(new Error("doctor is warming"), { code: "computer.unavailable" });
  const run = await startConnector({ runtime: { doctorStatus: async () => { throw error; } } });
  const { socket } = await bindSocket();
  const deadline = new Date(Date.now() + 10_000).toISOString().replace(/\.\d+Z$/, "Z");
  socket.message({ type: "rpc.request", rpcId: "55555555-5555-4555-8555-555555555555", channel: "labs", method: "doctor-status", params: {}, deadline });
  const answer = await waitFor(() => socket.sent.find((message) => message.rpcId === "55555555-5555-4555-8555-555555555555"), "doctor answer");
  assert.equal(answer.type, "rpc.error");
  assert.equal(answer.code, "computer.unavailable");
  await run.stop();
});

test("mac rpc is forwarded to the connector as host.rpc and relayed back; a silent connector is computer.unavailable", async () => {
  const run = await startConnector({ mac: ["notify"] });
  const { socket } = await bindSocket();
  const soon = new Date(Date.now() + 10_000).toISOString().replace(/\.\d+Z$/, "Z");
  socket.message({ type: "rpc.request", rpcId: "66666666-6666-4666-8666-666666666666", channel: "mac", method: "notify", params: { title: "hi" }, deadline: soon });
  const forwarded = await waitFor(() => run.channel.sent.find((message) => message.type === "host.rpc"), "host.rpc");
  assert.deepEqual(forwarded, { version: 1, type: "host.rpc", id: "66666666-6666-4666-8666-666666666666", method: "notify", params: { title: "hi" }, deadline: soon });
  run.channel.deliver({ version: 1, type: "host.rpc.result", id: forwarded.id, result: { shown: true } });
  const relayed = await waitFor(() => socket.sent.find((message) => message.rpcId === forwarded.id), "mac result");
  assert.deepEqual(relayed, { type: "rpc.result", rpcId: forwarded.id, result: { shown: true } });

  socket.message({ type: "rpc.request", rpcId: "77777777-7777-4777-8777-777777777777", channel: "mac", method: "open-url", params: {}, deadline: soon });
  const unsupported = await waitFor(() => socket.sent.find((message) => message.rpcId === "77777777-7777-4777-8777-777777777777"), "unadvertised mac method");
  assert.equal(unsupported.code, "method_unsupported");

  const past = new Date(Date.now() + 1_000).toISOString().replace(/\.\d+Z$/, "Z");
  socket.message({ type: "rpc.request", rpcId: "88888888-8888-4888-8888-888888888888", channel: "mac", method: "notify", params: {}, deadline: past });
  const timedOut = await waitFor(() => socket.sent.find((message) => message.rpcId === "88888888-8888-4888-8888-888888888888"), "mac deadline", 3_000);
  assert.equal(timedOut.type, "rpc.error");
  assert.equal(timedOut.code, "computer.unavailable");
  await run.stop();
});

test("the C4 close-code table drives reconnect timing", () => {
  const random = () => 0.5;
  assert.deepEqual(deviceClosePolicy(4401, { attempt: 0, random }), { kind: "closed", code: 4401 });
  assert.deepEqual(deviceClosePolicy(4403, { attempt: 0, random }), { kind: "closed", code: 4403 });
  assert.equal(deviceClosePolicy(4402, { attempt: 0, random }).delayMs, 3_600_000);
  assert.equal(deviceClosePolicy(4404, { attempt: 0, random }).delayMs, 3_600_000);
  assert.equal(deviceClosePolicy(4404, { attempt: 0, random }).wakeOnSignIn, true);
  for (const sample of [0, 0.5, 0.999]) {
    const superseded = deviceClosePolicy(4100, { attempt: 3, random: () => sample }).delayMs;
    assert.equal(superseded >= 48_000 && superseded <= 72_000, true, `4100 delay ${superseded}`);
  }
  for (const code of [1011, 1012, 1013, 4400, undefined]) {
    for (const attempt of [0, 5, 40]) {
      const { kind, delayMs } = deviceClosePolicy(code, { attempt, random });
      assert.equal(kind, "transient");
      assert.equal(delayMs >= 500 && delayMs <= 60_000, true, `${code}@${attempt} → ${delayMs}`);
    }
  }
  assert.equal(deviceClosePolicy(1013, { attempt: 40, random: () => 0.999 }).delayMs <= 60_000, true);
});

for (const code of [4401, 4403]) {
  test(`close ${code} tells the connector device.closed and stops`, async () => {
    const run = await startConnector();
    const { socket } = await bindSocket();
    socket.serverClose(code);
    const outcome = await run.running;
    assert.deepEqual(outcome, { status: "closed", code });
    assert.deepEqual(run.channel.sent.at(-1), { version: 1, type: "device.closed", code });
    assert.equal(run.delays.length, 0);
  });
}

test("4404 waits an hour but host.signed-in retries at once; 4100 waits about a minute", async () => {
  let release;
  const run = await startConnector({
    connectorOptions: {
      sleep: (delayMs, signal) => {
        run.delays.push(delayMs);
        if (delayMs < 3_600_000) return Promise.resolve(true);
        return new Promise((resolve) => {
          release = resolve;
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
    },
  });
  const { socket } = await bindSocket(0);
  socket.serverClose(4404);
  await waitFor(() => run.delays.includes(3_600_000), "hourly 4404 wait");
  run.channel.deliver({ version: 1, type: "host.signed-in" });
  const second = await waitFor(() => FakeWebSocket.instances[1], "retry after host.signed-in");
  assert.ok(second);
  void release;
  const { socket: again } = await bindSocket(1);
  again.serverClose(4100);
  await waitFor(() => run.delays.some((delayMs) => delayMs >= 48_000 && delayMs <= 72_000), "superseded wait");
  await run.stop();
});

test("no inbound frame for the idle window reconnects", async () => {
  const run = await startConnector({ connectorOptions: { idleTimeoutMs: 40 } });
  await bindSocket();
  await waitFor(() => run.delays.length >= 1, "idle reconnect");
  assert.equal(run.events.some((event) => event.reason === "relay_idle_timeout"), true);
  await run.stop();
});

test("connector EOF stops the device connection", async () => {
  const run = await startConnector();
  await bindSocket();
  run.channel.end();
  const outcome = await run.running;
  assert.equal(outcome.status, "stopped");
});

test("host link requires host.hello first and refuses a malformed one", async () => {
  const channel = new FakeHostChannel();
  const host = new HostLink({ channel, signTimeoutMs: 200 });
  channel.deliver({ version: 1, type: "host.hello", deviceId: "not-a-uuid", keyFingerprint: VECTOR.keyFingerprint, mac: [] });
  await assert.rejects(host.ready(), /deviceId/);
  const plain = new HostLink({ channel: new FakeHostChannel(), signTimeoutMs: 200 });
  plain.channel.deliver({ version: 1, type: "host.hello", deviceId: DEVICE_ID, keyFingerprint: "ab".repeat(32), mac: [] });
  await assert.rejects(plain.ready(), /keyFingerprint/);
});

test("connect is advertised, refuses key material, and needs exactly one host transport", () => {
  assert.equal(KNOWN_COMMANDS.has("connect"), true);
  assert.throws(
    () => parseArgs(["connect", "--signer-fd", "3", "--relay", RELAY, "--private-key", "SECRET"]),
    /refuses key material/,
  );
  const both = spawnSync(process.execPath, [CLI, "connect", "--signer-fd", "3", "--host-port", "--relay", RELAY], { encoding: "utf8" });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /exactly one of --signer-fd or --host-port/);
  const neither = spawnSync(process.execPath, [CLI, "connect", "--relay", RELAY], { encoding: "utf8" });
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /exactly one of --signer-fd or --host-port/);
  const keyed = spawnSync(process.execPath, [CLI, "connect", "--signer-fd", "3", "--relay", RELAY, "--private-key", "SECRET-KEY-MATERIAL"], { encoding: "utf8" });
  assert.equal(keyed.status, 1);
  assert.match(keyed.stderr, /refuses key material/);
  assert.equal(`${keyed.stdout}${keyed.stderr}`.includes("SECRET-KEY-MATERIAL"), false);
});

test("the A1 line protocol works over a real inherited descriptor and EOF ends the child", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { HostLink, fdHostChannel } from ${JSON.stringify(DEVICE_CONNECT)};
    const host = new HostLink({ channel: fdHostChannel(3), signTimeoutMs: 2000 });
    const hello = await host.ready();
    const signed = await host.sign({ purpose: "connect", audience: ${JSON.stringify(RELAY)}, nonce: ${JSON.stringify(NONCE)}, issuedAt: ${JSON.stringify(ISSUED_AT)} });
    process.stdout.write(JSON.stringify({ deviceId: hello.deviceId, signature: signed.signature }) + "\\n");
    await host.closed;
    process.stdout.write("eof\\n");
  `], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const fd = child.stdio[3];
  fd.setEncoding("utf8");
  fd.write(`${JSON.stringify({ version: 1, type: "host.hello", deviceId: DEVICE_ID, keyFingerprint: VECTOR.keyFingerprint, mac: [] })}\n`);
  const request = await new Promise((resolve, reject) => {
    let buffer = "";
    fd.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
    child.once("error", reject);
  });
  assert.equal(request.type, "sign.request");
  assert.equal(request.purpose, "connect");
  fd.write(`${JSON.stringify({ version: 1, type: "sign.result", id: request.id, algorithm: "ECDSA-P256-SHA256", keyFingerprint: VECTOR.keyFingerprint, signature: SIGNATURE })}\n`);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("\n"), "signed line");
  assert.deepEqual(JSON.parse(stdout.split("\n")[0]), { deviceId: DEVICE_ID, signature: SIGNATURE });
  fd.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  assert.match(stdout, /eof/);
});
