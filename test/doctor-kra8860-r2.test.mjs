import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor, formatDoctor } from "../src/bridge.mjs";

// KRA-8860 R2 (B3 on PR 25): every Hermes health word, every disabled lab and
// every lab's real T3 probe-timeout template gets one specific code and fix.
const GENERIC = /Inspect the upstream runtime/;
const APP_CODEX = "/Applications/Synthetic.app/Contents/Resources/codex";

function fixture(t, { providers = [], instances = {}, health = { status: "ok" }, token = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra8860-r2-"));
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
    fetchImpl: async () => health ? new Response(JSON.stringify(health), { status: 200 }) : Promise.reject(new Error("Synthetic Hermes absent")),
    pairStateFile: path.join(directory, "pair.json"),
    openrouterTokenFile,
    hermesHome: directory,
    refreshDirectory: path.join(directory, "refresh"),
  };
  return { client, options };
}

function lab(instanceId, { driver = "grok", enabled = true, status = "error", message, models = [{ slug: "synthetic:model", isDefault: true }], config, ...extra } = {}) {
  return {
    provider: { instanceId, driver, status, installed: true, enabled, models, ...(message === undefined ? {} : { message }), ...extra },
    instance: { driver, enabled, ...(config ? { config } : {}) },
  };
}

async function run(t, labs, options = {}) {
  const providers = labs.map(([, entry]) => entry.provider);
  const instances = Object.fromEntries(labs.map(([id, entry]) => [id, entry.instance]));
  const { client, options: doctorOptions } = fixture(t, { providers, instances, ...options });
  const report = await doctor(client, doctorOptions);
  return { report, row: (id) => report.labs.find((entry) => entry.instanceId === id) };
}

// P1-1: a reachable Hermes never falls back to the generic code or action.
for (const word of ["degraded", "starting", "synthetic-unknown-word"]) {
  test(`reachable Hermes with health ${word} never gets the generic code or action`, async (t) => {
    const { report, row } = await run(t, [["hermes", lab("hermes", { message: "Hermes ACP adapter crashed SECRET-CANARY" })]], { health: { status: word } });
    const hermes = row("hermes");
    assert.equal(report.hermes.reachable, true);
    assert.equal(hermes.ready, false);
    assert.equal(hermes.code, "hermes_degraded");
    assert.notEqual(hermes.code, "provider_error");
    assert.doesNotMatch(hermes.action, GENERIC);
    assert.match(hermes.action, /health/);
    assert.match(hermes.action, /rerun doctor/);
    assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
  });
}

test("reachable Hermes with health ok still blames the adapter", async (t) => {
  const { row } = await run(t, [["hermes", lab("hermes", { message: "Hermes ACP adapter crashed" })]], { health: { status: "healthy" } });
  assert.equal(row("hermes").code, "hermes_adapter_error");
});

// P1-2: a lab switched off reports disabled over every other finding.
const DISABLED_CASES = [
  ["kimi without an OpenRouter token", "kimi", lab("kimi", { enabled: false, status: "ready" })],
  ["deepseek without an OpenRouter token", "deepseek", lab("deepseek", { enabled: false, status: "ready" })],
  ["deepseek-noweb without a token and with a driver mismatch", "deepseek-noweb", lab("deepseek-noweb", { driver: "opencode", enabled: false })],
  ["codex-app with a misconfigured runtime", "codex-app", lab("codex-app", { driver: "codex", enabled: false, status: "ready", config: { binaryPath: "/usr/local/bin/codex" } })],
  ["codex with an app-bundled binary", "codex", lab("codex", { driver: "codex", enabled: false, config: { binaryPath: APP_CODEX } })],
  ["codex-noweb with a driver mismatch", "codex-noweb", lab("codex-noweb", { driver: "grok", enabled: false })],
  ["grok with a stale T3 probe timeout", "grok", lab("grok", { enabled: false, message: "Grok CLI is installed but timed out while running `grok --version`." })],
  ["claudeAgent signed out", "claudeAgent", lab("claudeAgent", { driver: "claudeAgent", enabled: false, status: "ready", auth: { status: "unauthenticated" } })],
  ["hermes with degraded health", "hermes", lab("hermes", { enabled: false, message: "Hermes ACP adapter crashed" })],
];
for (const [label, id, entry] of DISABLED_CASES) {
  test(`disabled ${label} reports status=disabled code=disabled`, async (t) => {
    const { report, row } = await run(t, [[id, entry]], { health: { status: "degraded" } });
    const disabled = row(id);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.ready, false);
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.code, "disabled");
    assert.equal(disabled.action, `Enable the ${id} instance in T3`);
    assert.match(formatDoctor(report), new RegExp(`${id}\\s+status=disabled\\s+code=disabled`));
  });
}

test("an absent lab stays absent, and an enabled broken lab is never hidden as disabled", async (t) => {
  const { row } = await run(t, [["kimi", lab("kimi", { status: "ready" })]]);
  assert.equal(row("pi").code, "absent");
  assert.equal(row("kimi").code, "adapter_auth_unavailable");
  assert.notEqual(row("kimi").status, "disabled");
});

// P2-1/P2-2: every lab's real T3 probe-timeout template, with one concrete command.
const TIMEOUTS = [
  ["cursor", { driver: "cursor", models: [{ slug: "synthetic:model" }] }, "Cursor Agent CLI is installed but timed out while running `agent about`.", /run `agent about`/],
  ["grok", {}, "Grok CLI is installed but timed out while running `grok --version`.", /run `grok --version`/],
  ["opencode", { driver: "opencode" }, "Failed to execute OpenCode CLI health check: OpenCode CLI version probe timed out after 4 seconds.", /run `opencode --version`/],
  ["kimi", {}, "Grok CLI is installed but timed out while running `grok --version`.", /run `tentacles install-kimi-provider --instance kimi`/],
  ["codex-app", { driver: "codex", config: { binaryPath: APP_CODEX } }, "Timed out while checking Codex app-server provider status.", /open the Codex app.*`tentacles install-codex-app-provider --instance codex-app`/],
];
for (const [id, options, message, command] of TIMEOUTS) {
  test(`${id}: T3's real probe-timeout template names the exact command to run`, async (t) => {
    const { report, row } = await run(t, [[id, lab(id, { ...options, message })]], { token: true });
    const timedOut = row(id);
    assert.equal(timedOut.code, "provider_probe_timeout");
    assert.match(timedOut.action, command);
    assert.match(timedOut.action, /rerun doctor/);
    assert.doesNotMatch(timedOut.action, /make it answer quickly/);
    assert.equal(JSON.stringify(report).includes(message), false);
  });
}

for (const message of [
  "Model grok-4.6 timed out while running `grok --version --json`",
  "Request timed out while running `codex exec --version-check`. SECRET-CANARY",
  "Grok CLI is installed but timed out while running `/Users/private/SECRET-CANARY/grok --version`. Extra",
]) {
  test(`a near-miss timeout stays provider_error and is never echoed: ${message.slice(0, 40)}`, async (t) => {
    const { report, row } = await run(t, [["grok", lab("grok", { message })]]);
    assert.equal(row("grok").code, "provider_error");
    assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
  });
}

test("an unrecognised command in T3's template is classified without echoing it", async (t) => {
  const { report, row } = await run(t, [["grok", lab("grok", { message: "Grok CLI is installed but timed out while running `synthetic-canary-bin --version`." })]]);
  assert.equal(row("grok").code, "provider_probe_timeout");
  assert.match(row("grok").action, /version check/);
  assert.equal(JSON.stringify(report).includes("synthetic-canary-bin"), false);
});

test("codex-app default-model action names its T3_CODEX_MODEL fallback too", async (t) => {
  const { row } = await run(t, [["codex-app", lab("codex-app", { driver: "codex", status: "ready", models: [{ slug: "synthetic:other" }], config: { binaryPath: APP_CODEX } })]]);
  const codexApp = row("codex-app");
  assert.equal(codexApp.code, "default_model_unavailable");
  assert.match(codexApp.action, /T3_CODEX_APP_MODEL/);
  assert.match(codexApp.action, /T3_CODEX_MODEL\b/);
});

test("codex-app with an unstartable bundle names the app prerequisite before reinstallation", async (t) => {
  const message = "Could not start Codex CLI /private/SECRET-CANARY.app/Contents/Resources/codex. Check Settings → Providers → Codex → Binary path on the server.";
  const { report, row } = await run(t, [["codex-app", lab("codex-app", {
    driver: "codex", message, models: [], config: { binaryPath: APP_CODEX },
  })]]);
  const app = row("codex-app");
  assert.equal(app.ready, false);
  assert.equal(app.code, "provider_binary_unavailable");
  assert.equal(app.runtime.binarySource, "app-bundled");
  assert.match(app.action, /[Ii]nstall or restore the Codex app/);
  assert.match(app.action, /<App>\.app\/Contents\/Resources\/codex/);
  assert.match(app.action, /`tentacles install-codex-app-provider --instance codex-app`/);
  assert.match(app.action, /--codex-app-bin/);
  assert.match(app.action, /rerun doctor/);
  assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
});

test("codex CLI binary failure keeps its standalone fix", async (t) => {
  const { row } = await run(t, [["codex", lab("codex", {
    driver: "codex", message: "Could not start Codex CLI. Check Binary path.",
  })]]);
  assert.equal(row("codex").code, "provider_binary_unavailable");
  assert.match(row("codex").action, /Settings → Providers/);
  assert.doesNotMatch(row("codex").action, /[Ii]nstall or restore the Codex app/);
});
