// KRA-8715: Tentacles is aware of the T3 managed policy (upstream v0.1.7).
// Synthetic server configs only; no T3, provider or policy file is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor, formatDoctor, originate } from "../src/bridge.mjs";
import { scanCapabilities } from "../src/capabilities.mjs";
import { classifyFailure } from "../src/failure-codes.mjs";
import {
  enforceManagedPolicy, managedPolicyReport, parsePolicyShow, PolicyRefusedError, policyDenialText, POLICY_RESTART_ACTION,
} from "../src/managed-policy.mjs";
import { applyIntent, projectThreadReport } from "../src/orchestrate.mjs";
import { writePairPresence } from "../src/pair-state.mjs";
import { T3Client, T3HttpError } from "../src/t3-client.mjs";

const THREAD_ID = "12345678-1111-4111-8111-111111111111";
const POLICY = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { maxRuntimeMode: "auto-accept-edits", clients: ["desktop", "local-browser"], providers: { allowedDrivers: ["codex"] } },
};
const PROVIDERS = [
  { instanceId: "codex", driver: "codex", status: "ready", installed: true, enabled: true, models: [{ slug: "gpt-5.6-sol" }] },
  { instanceId: "claudeAgent", driver: "claudeAgent", status: "ready", installed: true, enabled: true, models: [{ slug: "claude-opus-5-5" }], auth: { status: "authenticated" } },
];
const config = (serverVersion, managedPolicy) => ({ environment: { serverVersion }, providers: PROVIDERS, ...(managedPolicy ? { managedPolicy } : {}) });
const SHOW_INSTALLED = (loaded) => [
  "Managed by Example Corp (/etc/t3code/policy.json, fingerprint 0123456789ab).",
  "",
  "Settings:",
  "  storageCleanup.logsAfterDays = 7 (locked)",
  "",
  loaded,
].join("\n");

// In-memory T3: records every dispatch, projects what it creates.
function fakeClient(serverConfig, { dispatchError } = {}) {
  const projects = new Map();
  const threads = new Map();
  const dispatched = [];
  return {
    dispatched,
    rpc: async (tag) => {
      if (tag === "server.getConfig") return serverConfig;
      throw new Error(`Synthetic T3 has no RPC ${tag}`);
    },
    snapshot: async () => ({ projects: [...projects.values()], threads: [...threads.values()] }),
    getSettings: async () => ({ providerInstances: {} }),
    request: async () => ({ talkTurnResult: "v1" }),
    thread: async (threadId) => {
      if (!threads.has(threadId)) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread: threads.get(threadId) };
    },
    dispatch: async (command) => {
      dispatched.push(command);
      if (dispatchError) throw dispatchError;
      if (command.type === "project.create") projects.set(command.projectId, { id: command.projectId, workspaceRoot: command.workspaceRoot });
      if (command.type === "thread.create") threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, messages: [] });
      if (command.type === "thread.turn.start") threads.get(command.threadId).messages.push({ id: command.message.messageId, role: "user", text: command.message.text });
      return { sequence: 1 };
    },
  };
}

async function doctorWith(t, serverConfig, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra8715-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pairStateFile = path.join(directory, "pair.json");
  if (options.paired) writePairPresence("paired", { file: pairStateFile });
  return doctor(fakeClient(serverConfig), {
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    pairStateFile,
    hermesHome: directory,
    refreshDirectory: path.join(directory, "refresh"),
    policyShow: options.policyShow ?? null,
    remoteAccess: options.remoteAccess ?? false,
  });
}

const originateInput = (instanceId, runtimeMode = "full-access") => ({
  workspace: "/synthetic/workspace", title: "t", message: "m", instanceId, model: instanceId === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", runtimeMode,
});

test("no policy on a policy-aware server: present false, labs and originate unchanged", async (t) => {
  const report = await doctorWith(t, config("0.1.7"), { policyShow: "No managed policy on this machine. Every setting belongs to the user.\n\nThe running server (pid 1, started x) runs without a policy, as installed.\n" });
  assert.deepEqual(report.managedPolicy, {
    present: false, organization: null, loadedFingerprint: null, installedFingerprint: null,
    policyShow: "ok", mismatch: false, limits: null, warnings: [],
  });
  assert.deepEqual(report.blockedByPolicy, []);
  assert.ok(report.labs.some((lab) => lab.instanceId === "claudeAgent"));
  const client = fakeClient(config("0.1.7"));
  await originate(client, originateInput("claudeAgent"));
  assert.ok(client.dispatched.some((command) => command.type === "thread.turn.start"));
});

test("pre-policy server: present unknown and nothing is refused", async (t) => {
  const report = await doctorWith(t, config("0.0.45"));
  assert.equal(report.managedPolicy.present, "unknown");
  assert.equal(report.managedPolicy.policyShow, "unavailable");
  assert.match(formatDoctor(report), /Managed policy: unknown \(T3 predates managed policy\)/);
  assert.equal(await enforceManagedPolicy(fakeClient(config("0.0.45")), { instanceId: "claudeAgent", runtimeMode: "full-access" }), undefined);
  // A client without server.getConfig keeps today's behavior.
  assert.equal(await enforceManagedPolicy({}, { instanceId: "claudeAgent", runtimeMode: "full-access" }), undefined);
});

test("policy with allowedDrivers and a ceiling: doctor, capabilities, originate and act", async (t) => {
  const serverConfig = config("0.1.7", POLICY);
  const report = await doctorWith(t, serverConfig);
  assert.equal(report.managedPolicy.present, true);
  assert.equal(report.managedPolicy.organization, "Example Corp");
  assert.deepEqual(report.managedPolicy.limits, { allowedDrivers: ["codex"], maxRuntimeMode: "auto-accept-edits", clients: ["desktop", "local-browser"] });
  assert.ok(!report.labs.some((lab) => lab.instanceId === "claudeAgent"));
  assert.ok(report.labs.some((lab) => lab.instanceId === "codex"));
  assert.deepEqual(report.blockedByPolicy.find((lab) => lab.instanceId === "claudeAgent"), { instanceId: "claudeAgent", name: report.blockedByPolicy.find((lab) => lab.instanceId === "claudeAgent").name, driver: "claudeAgent", code: "policy_refused" });
  const text = formatDoctor(report);
  assert.match(text, /Policy limits: drivers=codex {2}maxRuntimeMode=auto-accept-edits {2}clients=desktop,local-browser/);
  assert.match(text, /Blocked by policy: claudeAgent \(driver claudeAgent\)/);

  const document = await scanCapabilities({ registry: [], readers: {}, doctorReport: report });
  assert.ok(!document.labs.some((lab) => lab.instanceId === "claudeAgent"));
  assert.deepEqual(document.blockedByPolicy.find((lab) => lab.instanceId === "claudeAgent"), { instanceId: "claudeAgent", driver: "claudeAgent", code: "policy_refused" });

  // Driver outside allowedDrivers: refused before any dispatch, no fallback.
  const driverClient = fakeClient(serverConfig);
  await assert.rejects(originate(driverClient, originateInput("claudeAgent", "auto-accept-edits")), (error) => {
    assert.ok(error instanceof PolicyRefusedError);
    assert.equal(error.failure.code, "policy_refused");
    assert.equal(error.message, "policy_refused: Example Corp's policy does not allow the claudeAgent driver. Allowed drivers: codex.");
    return true;
  });
  assert.equal(driverClient.dispatched.length, 0);

  // Runtime mode above the ceiling: refused the same way.
  const modeClient = fakeClient(serverConfig);
  await assert.rejects(originate(modeClient, originateInput("codex", "full-access")),
    /^PolicyRefusedError: policy_refused: Example Corp limits threads to Auto-accept edits\. Requested runtime mode full-access is above the ceiling auto-accept-edits\.$/);
  assert.equal(modeClient.dispatched.length, 0);

  // Allowed driver within the ceiling dispatches.
  const allowed = fakeClient(serverConfig);
  await originate(allowed, originateInput("codex", "auto-accept-edits"));
  assert.ok(allowed.dispatched.length > 0);

  // act: the receipt is rejected with policy_refused and nothing dispatches.
  const actClient = fakeClient(serverConfig);
  await assert.rejects(applyIntent(actClient, { action: "thread.create", threadId: THREAD_ID, projectId: "p", title: "t", instanceId: "claudeAgent", model: "claude-opus-5-5", runtimeMode: "auto-accept-edits" }), (error) => {
    assert.equal(error.receipt.status, "rejected");
    assert.equal(error.receipt.code, "policy_refused");
    assert.match(error.receipt.policyMessage, /^Example Corp's policy does not allow the claudeAgent driver\./);
    assert.match(error.message, /^policy_refused: /);
    return true;
  });
  await assert.rejects(applyIntent(actClient, { action: "thread.set-runtime-mode", threadId: THREAD_ID, runtimeMode: "full-access" }),
    (error) => error.receipt.code === "policy_refused" && /limits threads to Auto-accept edits/.test(error.receipt.policyMessage));
  assert.equal(actClient.dispatched.length, 0);
});

test("loaded and installed fingerprints differ: mismatch with the restart fix", () => {
  const stale = SHOW_INSTALLED("The running server (pid 1, started x) loaded no policy. Restart T3 Code to apply the installed policy.");
  assert.deepEqual(parsePolicyShow(stale), { installed: "0123456789ab", loaded: null, restart: false });
  const other = SHOW_INSTALLED("The running server (pid 1, started x) loaded Example Corp's policy from /etc/t3code/policy.json (fingerprint ba9876543210). Restart T3 Code to apply the installed policy.");
  const report = managedPolicyReport({ config: config("0.1.7", POLICY), serverVersion: "0.1.7", policyShow: other });
  assert.equal(report.installedFingerprint, "0123456789ab");
  assert.equal(report.loadedFingerprint, "ba9876543210");
  assert.equal(report.mismatch, true);
  assert.equal(report.action, POLICY_RESTART_ACTION);
  // The setting value `t3 policy show` prints never reaches the report.
  assert.doesNotMatch(JSON.stringify(report), /logsAfterDays|7 \(locked\)/);
  const same = managedPolicyReport({ config: config("0.1.7", POLICY), serverVersion: "0.1.7", policyShow: SHOW_INSTALLED("The running server (pid 1, started x) loaded this policy.") });
  assert.equal(same.mismatch, false);
  assert.equal(same.loadedFingerprint, "0123456789ab");
  // A server that does not say what it loaded is unknown, not a mismatch.
  assert.equal(managedPolicyReport({ config: config("0.1.7", POLICY), serverVersion: "0.1.7", policyShow: SHOW_INSTALLED("No T3 Code server is running from this T3 home. The installed policy applies when one starts.") }).mismatch, false);
  // A running server that cannot say what it loaded gets upstream's restart advice.
  const silent = managedPolicyReport({ config: config("0.1.7", POLICY), serverVersion: "0.1.7", policyShow: SHOW_INSTALLED("The running server (pid 1, started x) does not report which policy it loaded. Restart it to apply the installed policy.") });
  assert.equal(silent.mismatch, false);
  assert.equal(silent.action, POLICY_RESTART_ACTION);
});

test("T3 denial strings map to policy_refused and show only T3's sentence", async () => {
  assert.equal(policyDenialText('{"_tag":"Failure","cause":{"message":"Example Corp limits threads to Auto. Switch this thread\'s mode to continue."}}'), "Example Corp limits threads to Auto.");
  assert.equal(policyDenialText("a provider said the policy is fine"), null);
  // Upstream disallowedProviderMessage, with no organization set.
  assert.equal(policyDenialText('{"message":"Your organization policy does not allow the cursor provider."}'), "Your organization policy does not allow the cursor provider.");
  // An inner dot does not end the sentence.
  assert.equal(policyDenialText('{"message":"Example Corp\'s policy does not allow T3 Connect, so the server cannot listen on 0.0.0.0."}'),
    "Example Corp's policy does not allow T3 Connect, so the server cannot listen on 0.0.0.0.");
  // A T3 RPC refusal carrying the denial is a rejected receipt, not unconfirmed.
  const denied = fakeClient(config("0.0.45"), { dispatchError: new PolicyRefusedError("Example Corp limits threads to Auto.") });
  await assert.rejects(applyIntent(denied, { action: "thread.set-runtime-mode", threadId: THREAD_ID, runtimeMode: "full-access" }), (error) => {
    assert.equal(error.receipt.status, "rejected");
    assert.equal(error.receipt.code, "policy_refused");
    assert.equal(error.receipt.policyMessage, "Example Corp limits threads to Auto.");
    return true;
  });
});

test("junk before the organization never rides along with the sentence", () => {
  const body = JSON.stringify({ cause: { message: "request id 7f3 user=bob token abc Example Corp's policy does not allow webhook tasks." } });
  // Keyed on the organization from server.getConfig: only the sentence survives.
  assert.equal(policyDenialText(body, { organization: "Example Corp" }), "Example Corp's policy does not allow webhook tasks.");
  // Without it the sentence must fill its own JSON value or line, so this is no match.
  assert.equal(policyDenialText(body), null);
  assert.equal(policyDenialText("T3 thread x entered error: Example Corp's policy does not allow webhook tasks."), null);
  // A different organization's sentence is not this policy's refusal.
  assert.equal(policyDenialText('{"message":"Other Inc\'s policy does not allow webhook tasks."}', { organization: "Example Corp" }), null);
});

test("provider and session text with policy words keeps its own code", () => {
  assert.equal(classifyFailure({ error: new Error("upstream 429: Your organization's policy does not allow use of this model."), httpStatus: 429 }).code, "usage_limit");
  assert.notEqual(classifyFailure({ error: "Example Corp limits threads to Supervised." }).code, "policy_refused");
  const blocked = projectThreadReport({ id: THREAD_ID, session: { status: "error", lastError: "Example Corp limits threads to Auto. Switch this thread's mode to continue." } }, THREAD_ID);
  assert.notEqual(blocked.code, "policy_refused");
  assert.equal(blocked.policyMessage, undefined);
});

test("originate and act resolve the driver like doctor and never use the instance id", async () => {
  const policy = config("0.1.7", { organization: "Example Corp", lockedSettings: [], limits: { providers: { allowedDrivers: ["codex"] } } });
  // Absent from the provider registry, named in settings: refused on the settings driver.
  const fromSettings = { ...fakeClient(policy), getSettings: async () => ({ providerInstances: { "my-claude": { driver: "claudeAgent" } } }) };
  await assert.rejects(enforceManagedPolicy(fromSettings, { instanceId: "my-claude", runtimeMode: "full-access" }),
    /does not allow the claudeAgent driver \(instance my-claude\)/);
  // Absent from both: the driver is unknown, so Tentacles leaves it to T3.
  assert.equal(await enforceManagedPolicy(fakeClient(policy), { instanceId: "my-claude", runtimeMode: "full-access" }), undefined);
});

test("clients without remote warns when Tentacles reaches this host over the tailnet", async (t) => {
  const serverConfig = config("0.1.7", POLICY);
  assert.deepEqual((await doctorWith(t, serverConfig)).managedPolicy.warnings, []);
  for (const options of [{ paired: true }, { remoteAccess: true }]) {
    const report = await doctorWith(t, serverConfig, options);
    assert.equal(report.managedPolicy.warnings[0]?.code, "policy_clients_without_remote");
    assert.match(formatDoctor(report), /Warning \(policy_clients_without_remote\): .*drops Tailscale Serve routes and signs out paired devices, so devices that reach this T3 over the tailnet lose access/);
  }
  const remoteAllowed = config("0.1.7", { ...POLICY, limits: { ...POLICY.limits, clients: ["desktop", "remote"] } });
  assert.deepEqual((await doctorWith(t, remoteAllowed, { paired: true })).managedPolicy.warnings, []);
});

function scriptedSocket(exits) {
  return class ScriptedWebSocket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit("open")); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send(payload) {
      const { id } = JSON.parse(payload);
      const exit = exits.shift();
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ _tag: "Exit", requestId: id, exit }) }));
    }
    close() {}
    emit(type, event = {}) { this.listeners.get(type)?.(event); }
  };
}
const rpcClient = (exits) => new T3Client({ orchestrationProtocol: 1, token: "test-token", WebSocketImpl: scriptedSocket(exits),
  fetchImpl: async () => new Response(JSON.stringify({ ticket: "ticket" }), { status: 200 }) });

test("a T3 RPC Exit carrying a policy denial keeps only T3's sentence", async () => {
  const client = rpcClient([{ _tag: "Failure", token: "rpc-token-leak", cause: { message: "Example Corp limits threads to Auto. Switch this thread's mode to continue." } }]);
  await assert.rejects(client.rpc("orchestration.dispatchCommand"), (error) => {
    assert.ok(error instanceof PolicyRefusedError);
    assert.equal(error.policyMessage, "Example Corp limits threads to Auto.");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /rpc-token-leak/);
    return true;
  });
});

test("after server.getConfig the RPC refusal is keyed on the policy organization", async () => {
  const client = rpcClient([
    { _tag: "Success", value: { managedPolicy: POLICY } },
    { _tag: "Failure", cause: { message: "request id 7f3 user=bob token abc Example Corp's policy does not allow webhook tasks." } },
  ]);
  await client.rpc("server.getConfig");
  await assert.rejects(client.rpc("orchestration.dispatchCommand"), (error) => {
    assert.ok(error instanceof PolicyRefusedError);
    assert.equal(error.policyMessage, "Example Corp's policy does not allow webhook tasks.");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /7f3|bob|token abc/);
    return true;
  });
  // Without a known organization the same body stays redacted.
  await assert.rejects(rpcClient([{ _tag: "Failure", cause: { message: "request id 7f3 user=bob token abc Example Corp's policy does not allow webhook tasks." } }])
    .rpc("orchestration.dispatchCommand"), (error) => !(error instanceof PolicyRefusedError) && /\[redacted error body\]/.test(error.message));
});
