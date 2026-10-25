import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { doctor, formatDoctor } from "../src/bridge.mjs";

// KRA-8860: Hermes health was ok while the hermes row said provider_error with
// a generic action. T3's provider message is classified, never echoed.
const PROBE_TIMEOUT = "Grok CLI is installed but timed out while running `grok --version`.";
const BINARY_MISSING = "Could not start Grok CLI /Users/private/SECRET-CANARY/bin/t3-hermes-acp. Check Settings → Providers → Grok → Binary path on the server.";

function fixture(t, { message, status = "error", enabled = true, models = [{ slug: "deepseek:deepseek-v4-flash", isDefault: true }], health = { status: "ok", version: "0.18.2" } } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-hermes-row-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = { refresh: [] };
  const provider = { instanceId: "hermes", driver: "grok", status, installed: true, enabled, models, ...(message === undefined ? {} : { message }) };
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: { hermes: { driver: "grok", enabled, config: { binaryPath: "/tmp/synthetic-hermes" } } } }),
    rpc: async () => ({ environment: { serverVersion: "0.0.42-test" }, providers: [provider] }),
    // The KRA-8833 re-check runs, but the synthetic upstream stays broken.
    refreshProvider: async (id) => { calls.refresh.push(id); },
    request: async () => ({ talkTurnResult: "v1" }),
  };
  const options = {
    fetchImpl: async () => health ? new Response(JSON.stringify(health), { status: 200 }) : Promise.reject(new Error("Synthetic Hermes absent")),
    pairStateFile: path.join(directory, "pair.json"),
    openrouterTokenFile: path.join(directory, "absent-token"),
    hermesHome: directory,
    refreshDirectory: path.join(directory, "refresh"),
  };
  return { client, calls, options };
}
const hermes = (report) => report.labs.find((lab) => lab.instanceId === "hermes");

test("health ok with a T3 version-probe timeout gives a specific code and one fix", async (t) => {
  const { client, calls, options } = fixture(t, { message: PROBE_TIMEOUT });
  const report = await doctor(client, options);
  const row = hermes(report);
  assert.deepEqual(calls.refresh, ["hermes"], "the KRA-8833 re-check path ran first");
  assert.equal(report.hermes.status, "ok");
  assert.equal(row.ready, false);
  assert.equal(row.status, "error");
  assert.equal(row.code, "provider_probe_timeout");
  assert.match(row.action, /`hermes --version`/);
  assert.match(row.action, /rerun doctor/);
  assert.doesNotMatch(row.action, /Inspect the upstream runtime/);
  assert.match(formatDoctor(report), /hermes\s+status=error\s+code=provider_probe_timeout\s+action: .*hermes --version/);
  assert.equal(JSON.stringify(report).includes("timed out while running"), false);
});

test("health ok with an unstartable adapter binary names the T3 binary path", async (t) => {
  const { client, options } = fixture(t, { message: BINARY_MISSING });
  const report = await doctor(client, options);
  const row = hermes(report);
  assert.equal(row.code, "provider_binary_unavailable");
  assert.match(row.action, /tentacles install-provider --instance hermes/);
  assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
});

test("health ok with an unrecognised T3 error blames the Hermes adapter, never generically", async (t) => {
  const { client, options } = fixture(t, { message: "SECRET-CANARY upstream exploded" });
  const report = await doctor(client, options);
  const row = hermes(report);
  assert.equal(row.code, "hermes_adapter_error");
  assert.match(row.action, /Hermes health is ok/);
  assert.match(row.action, /tentacles install-provider --instance hermes/);
  assert.doesNotMatch(row.action, /Inspect the upstream runtime/);
  assert.equal(JSON.stringify(report).includes("SECRET-CANARY"), false);
});

test("an unhealthy Hermes keeps the health action, not the adapter one", async (t) => {
  const { client, options } = fixture(t, { message: "upstream exploded", health: null });
  const row = hermes(await doctor(client, options));
  assert.equal(row.code, "hermes_unreachable");
});

for (const [label, input] of [
  ["a stale T3 error", { message: PROBE_TIMEOUT }],
  ["an unreachable Hermes", { message: PROBE_TIMEOUT, health: null }],
  ["missing openai-codex auth", { models: [{ slug: "openai-codex:gpt-6-luna", isDefault: true }] }],
]) {
  test(`a lab switched off on this host reports disabled despite ${label}`, async (t) => {
    const { client, calls, options } = fixture(t, { ...input, enabled: false });
    const report = await doctor(client, options);
    const row = hermes(report);
    assert.deepEqual(calls.refresh, []);
    assert.equal(row.enabled, false);
    assert.equal(row.ready, false);
    assert.equal(row.status, "disabled");
    assert.equal(row.code, "disabled");
    assert.equal(row.action, "Enable the hermes instance in T3");
    assert.match(formatDoctor(report), /hermes\s+status=disabled\s+code=disabled/);
  });
}

test("a retired default model names the override to change", () => {
  // The default is fixed at import from T3_HERMES_MODEL, so pin it in a child.
  const script = `
    const { doctor } = await import(${JSON.stringify(new URL("../src/bridge.mjs", import.meta.url).href)});
    const client = {
      snapshot: async () => ({ projects: [], threads: [] }),
      getSettings: async () => ({ providerInstances: { hermes: { driver: "grok", enabled: true } } }),
      rpc: async () => ({ providers: [{ instanceId: "hermes", driver: "grok", status: "ready", installed: true,
        models: [{ slug: "synthetic:current-model" }, { slug: "synthetic:other-model" }] }] }),
      request: async () => ({ talkTurnResult: "v1" }),
    };
    const report = await doctor(client, {
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      hermesHome: process.env.SYNTHETIC_DIR,
      pairStateFile: process.env.SYNTHETIC_DIR + "/pair.json",
      openrouterTokenFile: process.env.SYNTHETIC_DIR + "/absent",
      refreshDirectory: process.env.SYNTHETIC_DIR + "/refresh",
    });
    process.stdout.write(JSON.stringify(report.labs.find((lab) => lab.instanceId === "hermes")));
  `;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-hermes-retired-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: directory, SYNTHETIC_DIR: directory, T3_HERMES_MODEL: "synthetic:retired-model" },
    });
    assert.equal(result.status, 0, result.stderr);
    const row = JSON.parse(result.stdout);
    assert.equal(row.defaultModel, "synthetic:retired-model");
    assert.equal(row.defaultAvailable, false);
    assert.equal(row.code, "default_model_unavailable");
    assert.match(row.action, /T3_HERMES_MODEL/);
    assert.match(row.action, /synthetic:retired-model/);
    assert.doesNotMatch(row.action, /install the documented default/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
