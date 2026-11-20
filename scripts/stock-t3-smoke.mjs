#!/usr/bin/env node
// Stock T3 smoke without any lab login (KRA stock-T3, 20 Nov 2026).
//
//   node scripts/stock-t3-smoke.mjs --t3-bin /abs/path/to/t3 [--json]
//
// Starts the given official T3 binary on a free loopback port with a throwaway
// home, then drives Tentacles exactly as Agent Jack does through Sphere: the
// remote RPC shim (seats, doctor-status, originate, turn-result, continue,
// thread-events, thread-artifact, interrupt) against the DeepSeek adapter,
// whose dsh-acp is a local fake agent (no model, network or credential). It
// also checks the doctor support range and that T3's headless title
// generation reaches the adapter read-only. Exit 0 only if every check passes.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForTicket } from "./stock-t3-ready.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const t3Bin = args[args.indexOf("--t3-bin") + 1];
if (!args.includes("--t3-bin") || !t3Bin || !path.isAbsolute(t3Bin)) {
  console.error("usage: stock-t3-smoke.mjs --t3-bin /absolute/path/to/t3");
  process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-stock-t3-"));
fs.chmodSync(scratch, 0o700);
const home = path.join(scratch, "t3-home");
const work = path.join(scratch, "work");
const stateDir = path.join(scratch, "state");
for (const directory of [home, work, stateDir]) fs.mkdirSync(directory, { mode: 0o700 });
const tokenFile = path.join(stateDir, "t3.token");
const fakeLog = path.join(scratch, "fake-dsh.log");
const fakeToken = path.join(stateDir, "openrouter-fake.token");
fs.writeFileSync(fakeToken, "sk-or-stock-smoke-fake\n", { mode: 0o600 });
fs.writeFileSync(fakeLog, "");

const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok: Boolean(ok), ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

let server;
async function main() {
  const version = spawnSync(t3Bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const t3Version = /v?(\d+\.\d+\.\d+[^\s]*)/.exec(version.stdout ?? "")?.[1] ?? null;
  check("t3 --version", version.status === 0 && t3Version, { t3Version });

  const port = await freePort();
  server = spawn(t3Bin, ["serve", "--base-dir", home, "--port", String(port), "--host", "127.0.0.1", "--no-browser", work],
    { cwd: work, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, T3CODE_HOME: home } });
  let stderrTail = "";
  server.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  let up = false;
  for (let attempt = 0; attempt < 120 && !up; attempt += 1) {
    await delay(500);
    up = await new Promise((resolve) => { const socket = net.connect(port, "127.0.0.1", () => { socket.end(); resolve(true); }); socket.on("error", () => resolve(false)); });
  }
  check("t3 serve listens", up, up ? {} : { stderrTail: stderrTail.slice(-400) });
  if (!up) return;

  // Never print the bearer: stdout goes straight to an owner-only file.
  const issued = spawnSync(t3Bin, ["auth", "session", "issue", "--base-dir", home, "--ttl", "1d", "--label", "stock-smoke", "--subject", "local:stock-smoke", "--token-only"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 20_000 });
  if (issued.status === 0) fs.writeFileSync(tokenFile, `${issued.stdout.trim()}\n`, { mode: 0o600 });
  check("t3 auth session issue", issued.status === 0);
  if (issued.status !== 0) return;

  const ready = await waitForTicket(baseUrl, fs.readFileSync(tokenFile, "utf8").trim());
  check("t3 auth ready (websocket ticket)", ready.status === 200, ready);
  if (ready.status !== 200) return;

  // Tentacles derives its ledger and state paths from HOME at import: keep them in scratch.
  process.env.HOME = scratch;
  process.env.T3_URL = baseUrl;
  process.env.T3_HERMES_TOKEN_FILE = tokenFile;
  const { T3Client } = await import(path.join(root, "src/t3-client.mjs"));
  const { installDeepSeekProvider } = await import(path.join(root, "src/bridge.mjs"));
  const { LoopbackRuntimeAdapter, RemoteRpcShim } = await import(path.join(root, "src/outbound-pairer.mjs"));
  const client = new T3Client({ baseUrl, tokenFile });

  await installDeepSeekProvider(client, { wrapperPath: path.join(root, "bin/t3-deepseek-acp"), dshAcpBin: path.join(root, "scripts/stock-t3-fake-dsh-acp.mjs") });
  const settings = await client.getSettings();
  const instance = settings.providerInstances.deepseek;
  await client.updateSettings({ providerInstances: { ...settings.providerInstances, deepseek: { ...instance, environment: [...instance.environment,
    { name: "OPENROUTER_TOKEN_FILE", value: fakeToken, sensitive: false }, { name: "FAKE_DSH_LOG", value: fakeLog, sensitive: false }] } } });
  check("install DeepSeek adapter on stock T3", true);

  const runtime = new LoopbackRuntimeAdapter({ client, pairStateFile: path.join(stateDir, "pair.json"), threadEventsDirectory: path.join(stateDir, "thread-events") });
  const shim = new RemoteRpcShim(runtime, { enableInterrupt: true });
  const rpc = async (method, params) => {
    const reply = await shim.handle({ version: 1, type: "rpc.request", id: randomUUID(), method, params });
    if (reply.type !== "rpc.result") throw new Error(`${method} answered ${reply.type}`);
    return reply.result;
  };
  const settle = async (tuple) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await rpc("turn-result", tuple);
      if (result.state !== "pending") return result;
      await delay(1500);
    }
    return { state: "timeout" };
  };

  const seats = await rpc("seats", {});
  check("rpc seats", Array.isArray(seats?.threads));
  const doctor = await rpc("doctor-status", {});
  check("rpc doctor-status talkTurnResult v1", doctor.capabilities?.talkTurnResult === "v1" && doctor.t3?.talk?.status === "present", { talk: doctor.t3?.talk?.status });
  check("rpc doctor-status turnInterrupt", doctor.capabilities?.turnInterrupt === "turn-interrupt-v1");
  check("doctor support range", ["supported", "untested"].includes(doctor.t3?.support?.status), { version: doctor.t3?.version, support: doctor.t3?.support?.status });

  const workspace = path.join(work, `jack-like-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(workspace, { mode: 0o700 });
  const opened = await rpc("originate", { workspace, title: "stock smoke", message: "Reply PONG", instanceId: "deepseek", model: "deepseek/deepseek-v4-flash", runtimeMode: "full-access", idempotencyKey: randomUUID() });
  check("rpc originate", typeof opened?.messageId === "string");
  const first = await settle({ threadId: opened.threadId, messageId: opened.messageId, turnCommandId: opened.turnCommandId });
  check("rpc turn-result (originate)", first.state === "succeeded" && first.outputText === "PONG" && first.assistantMessageId, { state: first.state });

  const next = await rpc("continue", { threadId: opened.threadId, message: "Reply PING", instanceId: "deepseek", model: "deepseek/deepseek-v4-flash", runtimeMode: "full-access", turnCommandId: randomUUID(), messageId: randomUUID() });
  const nextTuple = { threadId: opened.threadId, messageId: next.messageId, turnCommandId: next.turnCommandId };
  const second = await settle(nextTuple);
  check("rpc continue + turn-result", second.state === "succeeded" && second.outputText === "PING", { state: second.state });

  const events = await rpc("thread-events", { threadId: opened.threadId, afterSequence: 0, limit: 200, includeTurnEnd: true });
  check("rpc thread-events", Array.isArray(events?.events) && events.events.some((event) => event.kind === "turn_end"), { count: events?.events?.length });
  let artifactRefusal = null;
  try { runtime.threadArtifact({ threadId: opened.threadId, eventId: "missing-event" }); } catch (error) { artifactRefusal = error.message; }
  check("rpc thread-artifact contract", /not journaled/.test(artifactRefusal ?? ""));

  const stop = await rpc("interrupt", { requestId: randomUUID(), ...nextTuple, reason: "user_stop" });
  check("rpc interrupt (settled turn)", stop?.status === "already_terminal" && stop.outcome === "succeeded", { status: stop?.status });

  // Headless title generation through the adapter must run DSH read-only.
  const before = fs.readFileSync(fakeLog, "utf8");
  const current = await client.getSettings();
  await client.updateSettings({ textGenerationModelSelection: { instanceId: "deepseek", model: "deepseek/deepseek-v4-flash" }, providerInstances: current.providerInstances });
  const titled = await rpc("originate", { workspace, title: "New thread", message: "Reply PONG", instanceId: "deepseek", model: "deepseek/deepseek-v4-flash", runtimeMode: "full-access", idempotencyKey: randomUUID() });
  await settle({ threadId: titled.threadId, messageId: titled.messageId, turnCommandId: titled.turnCommandId });
  let headless = [];
  for (let attempt = 0; attempt < 40 && headless.length === 0; attempt += 1) {
    await delay(1000);
    headless = fs.readFileSync(fakeLog, "utf8").slice(before.length).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.client === "t3-code-git-text");
  }
  const interactive = fs.readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.client === "t3-code");
  check("headless text generation is read-only", headless.length > 0 && headless.every((entry) => entry.mode === "read-only"), { headless: headless.length });
  check("interactive turns keep workspace-write", interactive.length > 0 && interactive.every((entry) => entry.mode === "workspace-write"));
}

try {
  await main();
} catch (error) {
  check("smoke completed", false, { error: String(error?.message ?? error).slice(0, 400) });
} finally {
  server?.kill("SIGTERM");
  await delay(1500);
  server?.kill("SIGKILL");
  fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
if (args.includes("--json")) console.log(JSON.stringify({ ok: failed.length === 0, results }));
console.log(failed.length ? `stock-t3-smoke: ${failed.length} check(s) failed` : `stock-t3-smoke: all ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
