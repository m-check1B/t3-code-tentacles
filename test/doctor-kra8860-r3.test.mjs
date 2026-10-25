import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor } from "../src/bridge.mjs";
import { NOWEB_LAB_DRIVERS } from "../src/model-selection.mjs";

// KRA-8860 R3 (B3 R2 on PR 25): T3's verbatim probe-timeout strings for every
// lab, a Hermes-specific fix for a reachable Hermes that T3 calls not ready,
// no ready deepseek over a T3 error, and noweb runtime text naming its lab.
const GENERIC = /Inspect the upstream runtime/;
const APP_CODEX = "/Applications/Synthetic.app/Contents/Resources/codex";
const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/t3-probe-timeouts.json", import.meta.url), "utf8"));

function fixture(t, { providers, instances, health = { status: "ok" }, token = false }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra8860-r3-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const openrouterTokenFile = path.join(directory, "openrouter-token");
  if (token) fs.writeFileSync(openrouterTokenFile, "synthetic-openrouter-value\n", { mode: 0o600 });
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: instances }),
    rpc: async () => ({ environment: { serverVersion: "0.0.42-test" }, providers }),
    refreshProvider: async () => {},
    request: async () => ({ talkTurnResult: "v1" }),
  };
  const options = {
    fetchImpl: async () => new Response(JSON.stringify(health), { status: 200 }),
    pairStateFile: path.join(directory, "pair.json"),
    openrouterTokenFile,
    hermesHome: directory,
    refreshDirectory: path.join(directory, "refresh"),
  };
  return { client, options };
}

const DRIVERS = { claudeAgent: "claudeAgent", codex: "codex", "codex-app": "codex", opencode: "opencode", cursor: "cursor", antigravity: "antigravity", ...NOWEB_LAB_DRIVERS };

function lab(instanceId, { status = "error", message, models = [{ slug: "synthetic:model", isDefault: true }] } = {}) {
  const driver = DRIVERS[instanceId] ?? "grok";
  const config = instanceId === "codex-app" ? { binaryPath: APP_CODEX } : undefined;
  return {
    provider: { instanceId, driver, status, installed: true, enabled: true, models, ...(message === undefined ? {} : { message }) },
    instance: { driver, enabled: true, ...(config ? { config } : {}) },
  };
}

async function run(t, entries, options = {}) {
  const providers = entries.map(([, entry]) => entry.provider);
  const instances = Object.fromEntries(entries.map(([id, entry]) => [id, entry.instance]));
  const { client, options: doctorOptions } = fixture(t, { providers, instances, ...options });
  const report = await doctor(client, doctorOptions);
  return { report, row: (id) => report.labs.find((entry) => entry.instanceId === id) };
}

// P2-A: every verbatim T3 probe-timeout string, for every lab that can show it.
for (const { source, message, labs } of FIXTURE.templates) {
  for (const [id, expected] of Object.entries(labs)) {
    test(`${id}: T3's ${source} timeout is provider_probe_timeout with its own command`, async (t) => {
      const { report, row } = await run(t, [[id, lab(id, { message })]], { token: true });
      const timedOut = row(id);
      assert.equal(timedOut.ready, false);
      assert.equal(timedOut.code, "provider_probe_timeout");
      assert.ok(timedOut.action.includes(expected), timedOut.action);
      assert.match(timedOut.action, /rerun doctor/);
      assert.doesNotMatch(timedOut.action, GENERIC);
      assert.equal(JSON.stringify(report).includes(message), false);
    });
  }
}

test("a command T3 never probes with is classified but not named back", async (t) => {
  const message = "Codex CLI is installed but timed out while running `codex --version`.";
  const { report, row } = await run(t, [["grok", lab("grok", { message })]]);
  assert.equal(row("grok").code, "provider_probe_timeout");
  assert.equal(JSON.stringify(report).includes("codex --version"), false);
});

for (const message of [
  "Timed out while checking Codex app-server provider status. SECRET-CANARY",
  "Failed to execute OpenCode CLI health check: OpenCode CLI version probe timed out after SECRET-CANARY.",
  "Claude Agent CLI is installed but failed to run. SECRET-CANARY",
]) {
  test(`a near-miss of a fixed T3 template stays provider_error: ${message.slice(0, 40)}`, async (t) => {
    const { report, row } = await run(t, [["codex", lab("codex", { message })]]);
    assert.equal(row("codex").code, "provider_error");
    assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
  });
}

test("a near-miss of T3's Antigravity health-check timeout stays provider_error", async (t) => {
  const message = "Antigravity did not respond to its local health check within SECRET-CANARY.";
  const { report, row } = await run(t, [["antigravity", lab("antigravity", { message })]]);
  assert.equal(row("antigravity").code, "provider_error");
  assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
});

// P2-B: a reachable Hermes that T3 calls not ready gets a Hermes-specific fix.
test("reachable Hermes with health ok that T3 calls not ready names the Hermes fix", async (t) => {
  const { row } = await run(t, [["hermes", lab("hermes", { status: "warning" })]], { health: { status: "ok" } });
  const hermes = row("hermes");
  assert.equal(hermes.ready, false);
  assert.equal(hermes.code, "hermes_adapter_not_ready");
  assert.match(hermes.action, /`tentacles install-provider --instance hermes`/);
  assert.doesNotMatch(hermes.action, GENERIC);
});

test("reachable degraded Hermes that T3 calls not ready names the health fix", async (t) => {
  const { row } = await run(t, [["hermes", lab("hermes", { status: "warning" })]], { health: { status: "degraded" } });
  assert.equal(row("hermes").code, "hermes_degraded");
  assert.doesNotMatch(row("hermes").action, GENERIC);
});

test("a duplicate Hermes id keeps provider_not_ready", async (t) => {
  const entry = lab("hermes", { status: "ready" });
  const providers = [entry.provider, { ...entry.provider }];
  const { client, options } = fixture(t, { providers, instances: { hermes: entry.instance } });
  const report = await doctor(client, options);
  const hermes = report.labs.find((row) => row.instanceId === "hermes");
  assert.equal(hermes.ready, false);
  assert.equal(hermes.code, "provider_not_ready");
});

// Pre-existing: the deepseek override never hides a T3 error as ready.
for (const id of ["deepseek", "deepseek-noweb"]) {
  test(`${id} with a T3 error is not reported ready`, async (t) => {
    const { row } = await run(t, [[id, lab(id, { message: "DeepSeek Harness is installed but timed out while running `dsh --version`." })]], { token: true });
    assert.equal(row(id).ready, false);
    assert.equal(row(id).code, "provider_probe_timeout");
    assert.notEqual(row(id).status, "configured");
  });
}

test("deepseek that T3 reports not ready still gets the override", async (t) => {
  const { row } = await run(t, [["deepseek", lab("deepseek", { status: "warning" })]], { token: true });
  assert.equal(row("deepseek").ready, true);
  assert.equal(row("deepseek").code, null);
});

// Pre-existing: runtime_misconfigured names the lab that is misconfigured.
for (const [id, driver] of Object.entries(NOWEB_LAB_DRIVERS)) {
  test(`${id} runtime_misconfigured names ${id}, not codex`, async (t) => {
    const wrong = driver === "grok" ? "opencode" : "grok";
    const entry = lab(id, { status: "ready" });
    entry.provider.driver = wrong;
    entry.instance.driver = wrong;
    const { row } = await run(t, [[id, entry]], { token: true });
    assert.equal(row(id).code, "runtime_misconfigured");
    assert.ok(row(id).action.startsWith(`${id} `), row(id).action);
    if (id !== "codex-noweb") assert.match(row(id).action, new RegExp(`T3 ${driver}-driver instance`));
  });
}
