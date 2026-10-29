import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor, installDeepSeekProvider } from "../src/bridge.mjs";

// KRA-6909: plain doctor takes the DeepSeek default from the installed
// provider's DEEPSEEK_MODEL; T3_DEEPSEEK_MODEL still wins over it.
const INSTALLED = "synthetic/deepseek-installed";
const BUILT_IN = "deepseek/deepseek-v4-flash";

async function installedInstance(model = INSTALLED) {
  let providerInstances;
  await installDeepSeekProvider({
    getSettings: async () => ({ providerInstances: {} }),
    updateSettings: async (patch) => { providerInstances = patch.providerInstances; },
    refreshProvider: async () => {},
  }, { wrapperPath: "/synthetic/deepseek-acp", model });
  return providerInstances.deepseek;
}

async function deepseekRow(t, instance, models) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra6909-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const openrouterTokenFile = path.join(directory, "openrouter-token");
  fs.writeFileSync(openrouterTokenFile, "synthetic-openrouter-value\n", { mode: 0o600 });
  const provider = { instanceId: "deepseek", driver: "grok", status: "ready", installed: true, enabled: true, models: models.map((slug) => ({ slug })) };
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: instance ? { deepseek: instance } : {} }),
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
  return { report, row: report.labs.find((entry) => entry.instanceId === "deepseek") };
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

test("T3_DEEPSEEK_MODEL still wins over the installed model", async (t) => {
  withEnv(t, "synthetic/deepseek-override");
  const { row } = await deepseekRow(t, await installedInstance(), [INSTALLED, "synthetic/deepseek-override"]);
  assert.equal(row.defaultModel, "synthetic/deepseek-override");
  assert.equal(row.ready, true);
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
  assert.equal(JSON.stringify({ ...report, labs: report.labs.map(({ models, modelCatalog, ...rest }) => rest) }).includes("SECRET-CANARY"), false);
});
