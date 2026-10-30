import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultModelForLab } from "../src/model-selection.mjs";
import { doctor, installDeepSeekProvider, originateDefaultModel } from "../src/bridge.mjs";

// KRA-6909: doctor and originate without --model take the DeepSeek default from
// the installed provider's DEEPSEEK_MODEL; T3_DEEPSEEK_MODEL still wins over it.
const INSTALLED = "synthetic/deepseek-installed";
const BUILT_IN = "deepseek/deepseek-v4-flash";

async function installedInstance(model = INSTALLED, instanceId = "deepseek") {
  let providerInstances;
  await installDeepSeekProvider({
    getSettings: async () => ({ providerInstances: {} }),
    updateSettings: async (patch) => { providerInstances = patch.providerInstances; },
    refreshProvider: async () => {},
  }, { wrapperPath: "/synthetic/deepseek-acp", model, instanceId });
  return providerInstances[instanceId];
}

async function deepseekRow(t, instance, models, instanceId = "deepseek") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra6909-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const openrouterTokenFile = path.join(directory, "openrouter-token");
  fs.writeFileSync(openrouterTokenFile, "synthetic-openrouter-value\n", { mode: 0o600 });
  const provider = { instanceId, driver: "grok", status: "ready", installed: true, enabled: true, models: models.map((slug) => (typeof slug === "string" ? { slug } : slug)) };
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: instance ? { [instanceId]: instance } : {} }),
    rpc: async () => ({ environment: { serverVersion: "0.0.42-test" }, providers: [provider] }),
    refreshProvider: async () => {},
    request: async () => ({ talkTurnResult: "v1" }),
  };
  const report = await doctor(client, {
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    pairStateFile: path.join(directory, "pair.json"),
    openrouterTokenFile,
    hermesHome: directory,
    refreshDirectory: path.join(directory, "refresh"),
  });
  return { report, row: report.labs.find((entry) => entry.instanceId === instanceId) };
}

function withEnv(t, value) {
  const previous = process.env.T3_DEEPSEEK_MODEL;
  if (value === undefined) delete process.env.T3_DEEPSEEK_MODEL;
  else process.env.T3_DEEPSEEK_MODEL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.T3_DEEPSEEK_MODEL;
    else process.env.T3_DEEPSEEK_MODEL = previous;
  });
}

test("an installed DeepSeek model is doctor's default without a CLI override", async (t) => {
  withEnv(t, undefined);
  const { row } = await deepseekRow(t, await installedInstance(), [INSTALLED]);
  assert.equal(row.defaultModel, INSTALLED);
  assert.equal(row.defaultAvailable, true);
  assert.equal(row.code, null);
  assert.equal(row.ready, true);
});

function settingsClient(instance, instanceId = "deepseek") {
  return { getSettings: async () => ({ providerInstances: instance ? { [instanceId]: instance } : {} }) };
}

test("originate without --model selects the installed DeepSeek model doctor reports", async (t) => {
  withEnv(t, undefined);
  const instance = await installedInstance();
  assert.equal(await originateDefaultModel(settingsClient(instance), "deepseek"), INSTALLED);
  const { row } = await deepseekRow(t, instance, [INSTALLED]);
  assert.equal(row.defaultModel, INSTALLED);
});

// A DeepSeek harness installed at a non-deepseek lab id keeps that lab's built-in
// default, so doctor reports it unavailable instead of a false ready.
test("doctor and originate agree on the default for every lab id the installer accepts", async (t) => {
  withEnv(t, undefined);
  for (const lab of ["deepseek", "deepseek-noweb", "grok"]) {
    const instance = await installedInstance(INSTALLED, lab);
    const { row } = await deepseekRow(t, instance, [INSTALLED], lab);
    assert.equal(row.defaultModel, await originateDefaultModel(settingsClient(instance, lab), lab), lab);
  }
  const { row } = await deepseekRow(t, await installedInstance(INSTALLED, "grok"), [INSTALLED], "grok");
  assert.equal(row.defaultModel, defaultModelForLab("grok"));
  assert.equal(row.code, "default_model_unavailable");
  assert.equal(row.ready, false);
  for (const lab of ["deepseek", "deepseek-noweb"]) {
    const { row: deepseek } = await deepseekRow(t, await installedInstance(INSTALLED, lab), [INSTALLED], lab);
    assert.equal(deepseek.defaultModel, INSTALLED, lab);
  }
});

// Guards precedence only; on main the env already won in a real process, so this
// is not the KRA-6909 reproduction (the installed-default tests are).
test("T3_DEEPSEEK_MODEL still wins over the installed model", async (t) => {
  withEnv(t, "synthetic/deepseek-override");
  const { row } = await deepseekRow(t, await installedInstance(), [INSTALLED, "synthetic/deepseek-override"]);
  assert.equal(row.defaultModel, "synthetic/deepseek-override");
  assert.equal(row.ready, true);
  assert.equal(await originateDefaultModel(settingsClient(await installedInstance()), "deepseek"), "synthetic/deepseek-override");
});

test("T3's own marked default still wins over the installed model in doctor", async (t) => {
  withEnv(t, undefined);
  const { row } = await deepseekRow(t, await installedInstance(), [INSTALLED, { slug: "synthetic/t3-default", isDefault: true }]);
  assert.equal(row.defaultModel, "synthetic/t3-default");
});

test("a DEEPSEEK_MODEL entry with sensitive omitted is read", async (t) => {
  withEnv(t, undefined);
  const instance = await installedInstance();
  instance.environment = instance.environment.map((variable) => variable.name === "DEEPSEEK_MODEL"
    ? { name: "DEEPSEEK_MODEL", value: INSTALLED }
    : variable);
  const { row } = await deepseekRow(t, instance, [INSTALLED]);
  assert.equal(row.defaultModel, INSTALLED);
  assert.equal(await originateDefaultModel(settingsClient(instance), "deepseek"), INSTALLED);
});

test("a redacted DEEPSEEK_MODEL entry is never read", async (t) => {
  withEnv(t, undefined);
  const instance = await installedInstance();
  instance.environment = instance.environment.map((variable) => variable.name === "DEEPSEEK_MODEL"
    ? { name: "DEEPSEEK_MODEL", value: "SECRET-CANARY", valueRedacted: true }
    : variable);
  assert.equal(await originateDefaultModel(settingsClient(instance), "deepseek"), BUILT_IN);
  const { row } = await deepseekRow(t, instance, [BUILT_IN]);
  assert.equal(row.defaultModel, BUILT_IN);
});

test("other labs keep their built-in originate default without a settings read", async () => {
  const client = { getSettings: async () => { throw new Error("settings must not be read"); } };
  for (const lab of ["hermes", "grok", "codex", "claudeAgent", "opencode", "cursor"]) {
    assert.equal(await originateDefaultModel(client, lab), defaultModelForLab(lab));
  }
});

test("without a provider configuration doctor falls back to the built-in default", async (t) => {
  withEnv(t, undefined);
  const { row } = await deepseekRow(t, null, [BUILT_IN]);
  assert.equal(row.defaultModel, BUILT_IN);
  assert.equal(row.ready, true);
});

test("a sensitive DEEPSEEK_MODEL entry is never read or echoed", async (t) => {
  withEnv(t, undefined);
  const instance = await installedInstance();
  instance.environment = instance.environment.map((variable) => variable.name === "DEEPSEEK_MODEL"
    ? { name: "DEEPSEEK_MODEL", value: "SECRET-CANARY", sensitive: true }
    : variable);
  const { report, row } = await deepseekRow(t, instance, [BUILT_IN, "SECRET-CANARY"]);
  assert.equal(row.defaultModel, BUILT_IN);
  assert.equal(await originateDefaultModel(settingsClient(instance), "deepseek"), BUILT_IN);
  assert.equal(JSON.stringify({ ...report, labs: report.labs.map(({ models, modelCatalog, ...rest }) => rest) }).includes("SECRET-CANARY"), false);
});
