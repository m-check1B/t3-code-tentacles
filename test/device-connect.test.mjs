import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { KNOWN_COMMANDS, parseArgs } from "../src/cli.mjs";

const CLI = path.resolve("src/cli.mjs");
const DEVICE_CONNECT = pathToFileURL(path.resolve("src/device-connect.mjs")).href;

test("connect is advertised and refuses a private key before any relay dial", () => {
  assert.equal(KNOWN_COMMANDS.has("connect"), true);
  assert.throws(
    () => parseArgs(["connect", "--signer-fd", "3", "--device-id", "df5c6243-0000-4000-8000-000000000001", "--relay", "wss://jack.example.test/api/v1/jack/devices/connect", "--private-key", "SECRET"]),
    /refuses key material/,
  );
});

test("the connect command exits before dialing when a key flag is present", async () => {
  const { spawnSync } = await import("node:child_process");
  const spawned = spawnSync(process.execPath, [
    CLI, "connect",
    "--signer-fd", "3",
    "--device-id", "df5c6243-0000-4000-8000-000000000001",
    "--relay", "wss://jack.example.test/api/v1/jack/devices/connect",
    "--private-key", "SECRET-KEY-MATERIAL",
  ], { encoding: "utf8" });
  assert.equal(spawned.status, 1);
  assert.match(spawned.stderr, /refuses key material/);
  assert.equal(`${spawned.stdout}${spawned.stderr}`.includes("SECRET-KEY-MATERIAL"), false);
});

test("signer fd returns only a signature and channels are advertised on auth", async () => {
  const deviceConnect = await import(DEVICE_CONNECT);
  const {
    DEVICE_CHANNELS,
    DeviceConnector,
    canonicalSignPayload,
    requestSignature,
  } = deviceConnect;
  assert.deepEqual(Object.keys(DEVICE_CHANNELS), ["labs", "turns", "mac"]);
  assert.equal(DEVICE_CHANNELS.labs.includes("doctor-status"), true);
  assert.equal(DEVICE_CHANNELS.turns.includes("interrupt"), false);
  assert.equal(DEVICE_CHANNELS.mac.length, 0);

  const payload = canonicalSignPayload({
    nonce: "nonce-1",
    deviceId: "df5c6243-0000-4000-8000-000000000001",
    origin: "wss://jack.example.test",
    serverTime: "2026-10-10T21:00:00.000Z",
  });
  assert.equal(payload, "agentjack-device-v1|nonce-1|df5c6243-0000-4000-8000-000000000001|wss://jack.example.test|2026-10-10T21:00:00.000Z");

  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { requestSignature } from ${JSON.stringify(DEVICE_CONNECT)};
    const result = await requestSignature(3, ${JSON.stringify(payload)});
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  `], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const request = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdio[3].setEncoding("utf8");
    child.stdio[3].on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
    child.once("error", reject);
  });
  assert.equal(request.type, "sign.request");
  assert.equal(request.payload, payload);
  assert.equal(JSON.stringify(request).includes("PRIVATE"), false);
  child.stdio[3].write(`${JSON.stringify({
    version: 1,
    type: "sign.result",
    id: request.id,
    algorithm: "ECDSA-P256-SHA256",
    keyFingerprint: "ab".repeat(32),
    signature: "c2lnbmF0dXJlLWJ5dGVz",
  })}\n`);
  const signed = JSON.parse(await new Promise((resolve) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { buffer += chunk; });
    child.stdout.on("end", () => resolve(buffer));
  }));
  assert.equal(signed.signature, "c2lnbmF0dXJlLWJ5dGVz");
  assert.equal(Object.hasOwn(signed, "privateKey"), false);

  const refused = spawn(process.execPath, ["--input-type=module", "-e", `
    import { requestSignature } from ${JSON.stringify(DEVICE_CONNECT)};
    try {
      await requestSignature(3, ${JSON.stringify(payload)});
      process.stdout.write("signed");
    } catch (error) {
      process.stdout.write("refused");
      process.stderr.write(error.message);
      process.exit(1);
    }
  `], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const leaked = await new Promise((resolve, reject) => {
    let buffer = "";
    refused.stdio[3].setEncoding("utf8");
    refused.stdio[3].on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
    });
    refused.once("error", reject);
  });
  refused.stdio[3].write(`${JSON.stringify({
    version: 1,
    type: "sign.result",
    id: leaked.id,
    algorithm: "ECDSA-P256-SHA256",
    keyFingerprint: "ab".repeat(32),
    signature: "c2lnbmF0dXJlLWJ5dGVz",
    privateKey: "MUST-NOT-CROSS",
  })}\n`);
  const refusedOut = await new Promise((resolve) => {
    let buffer = "";
    refused.stdout.setEncoding("utf8");
    refused.stdout.on("data", (chunk) => { buffer += chunk; });
    refused.on("exit", () => resolve(buffer));
  });
  assert.equal(refusedOut.includes("MUST-NOT-CROSS"), false);
  assert.match(refusedOut, /refused/);

  const sent = [];
  let refreshes = 0;
  class FakeWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    send(raw) { sent.push(JSON.parse(raw)); }
    close() {}
    emit(type, data) {
      for (const listener of this.listeners.get(type) || []) listener({ data });
    }
  }
  const connector = new DeviceConnector({
    runtime: {
      refreshModels: async () => { refreshes += 1; },
      warmDoctor: async () => { refreshes += 1; },
      doctorStatus: async () => ({ labs: [] }),
    },
    WebSocketImpl: FakeWebSocket,
    signer: { sign: async (body) => {
      assert.equal(body, payload);
      return { keyFingerprint: "ab".repeat(32), signature: "c2lnbmF0dXJlLWJ5dGVz", algorithm: "ECDSA-P256-SHA256" };
    } },
    handshakeTimeoutMs: 1000,
    heartbeatTimeoutMs: 30_000,
    reconnectBaseMs: 1,
    reconnectCapMs: 1,
    random: () => 0,
  });
  const controller = new AbortController();
  const running = connector.run({
    relay: "wss://jack.example.test/api/v1/jack/devices/connect",
    deviceId: "df5c6243-0000-4000-8000-000000000001",
    signal: controller.signal,
  });
  const opened = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const timer = setInterval(() => {
      if (FakeWebSocket.instances[0]) { clearInterval(timer); resolve(FakeWebSocket.instances[0]); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error("no device socket")); }
    }, 5);
  });
  opened.emit("message", JSON.stringify({ version: 1, type: "hello", nonce: "nonce-1", serverTime: "2026-10-10T21:00:00.000Z" }));
  const auth = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const timer = setInterval(() => {
      const found = sent.find((message) => message.type === "auth");
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error("no auth")); }
    }, 5);
  });
  assert.equal(auth.sig, "c2lnbmF0dXJlLWJ5dGVz");
  assert.equal(auth.keyFingerprint, "ab".repeat(32));
  assert.deepEqual(auth.channels.labs, ["doctor-status"]);
  assert.equal(auth.channels.turns.includes("interrupt"), false);
  assert.deepEqual(auth.channels.mac, []);
  assert.equal(JSON.stringify(auth).toLowerCase().includes("privatekey"), false);
  assert.equal(auth.rpc.includes("interrupt"), false);
  opened.emit("message", JSON.stringify({ version: 1, type: "bound", connectionId: "conn-1" }));
  opened.emit("message", JSON.stringify({ version: 1, type: "ping" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.some((message) => message.type === "pong"), true);
  assert.equal(refreshes <= 1, true);
  const before = refreshes;
  opened.emit("message", JSON.stringify({ version: 1, type: "ping" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshes, before);
  controller.abort();
  await running;
  void requestSignature;
});
