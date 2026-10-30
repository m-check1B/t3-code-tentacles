import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { doctor, formatDoctor, installDeepSeekProvider, originateDefaultModel } from "../src/bridge.mjs";

// KRA-9785: each doctor lab row names which branch picked its defaultModel, and a
// T3 default that originate without --model would not pick carries an action.
const INSTALLED = "synthetic/deepseek-installed";
const ENV_MODEL = "synthetic/deepseek-env";
const T3_MODEL = "synthetic/deepseek-t3";
const BUILT_IN = "deepseek/deepseek-v4-flash";

async function installedInstance() {
  let providerInstances;
  await installDeepSeekProvider({
    getSettings: async () => ({ providerInstances: {} }),
    updateSettings: async (patch) => { providerInstances = patch.providerInstances; },
    refreshProvider: async () => {},
  }, { wrapperPath: "/synthetic/deepseek-acp", model: INSTALLED, instanceId: "deepseek" });
  return providerInstances.deepseek;
}

async function deepseekReport(t, { instance, models, defaultModel }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra9785-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const openrouterTokenFile = path.join(directory, "openrouter-token");
  fs.writeFileSync(openrouterTokenFile, "synthetic-openrouter-value\n", { mode: 0o600 });
  const provider = {
    instanceId: "deepseek", driver: "grok", status: "ready", installed: true, enabled: true,
    models: models.map((slug) => (typeof slug === "string" ? { slug } : slug)),
    ...(defaultModel ? { defaultModel } : {}),
  };
  const settings = { providerInstances: instance ? { deepseek: instance } : {} };
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => settings,
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
  return { report, row: report.labs.find((entry) => entry.instanceId === "deepseek"), pick: await originateDefaultModel(client, "deepseek") };
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

test("defaultSource t3-marked: T3 marks a model row as default", async (t) => {
  withEnv(t, undefined);
  const { row } = await deepseekReport(t, { instance: await installedInstance(), models: [INSTALLED, { slug: T3_MODEL, isDefault: true }] });
  assert.equal(row.defaultModel, T3_MODEL);
  assert.equal(row.defaultSource, "t3-marked");
});

test("defaultSource t3-declared: an older snapshot declares the default", async (t) => {
  withEnv(t, undefined);
  const { row } = await deepseekReport(t, { instance: await installedInstance(), models: [INSTALLED, T3_MODEL], defaultModel: T3_MODEL });
  assert.equal(row.defaultModel, T3_MODEL);
  assert.equal(row.defaultSource, "t3-declared");
});

test("defaultSource env: T3_DEEPSEEK_MODEL picks the default", async (t) => {
  withEnv(t, ENV_MODEL);
  const { row } = await deepseekReport(t, { instance: await installedInstance(), models: [ENV_MODEL, INSTALLED] });
  assert.equal(row.defaultModel, ENV_MODEL);
  assert.equal(row.defaultSource, "env");
  assert.equal(row.action, undefined);
});

test("defaultSource installed: the installed provider's DEEPSEEK_MODEL picks the default", async (t) => {
  withEnv(t, undefined);
  const { row } = await deepseekReport(t, { instance: await installedInstance(), models: [INSTALLED] });
  assert.equal(row.defaultModel, INSTALLED);
  assert.equal(row.defaultSource, "installed");
  assert.equal(row.action, undefined);
});

test("defaultSource built-in: no T3, env or installed default", async (t) => {
  withEnv(t, undefined);
  const { row } = await deepseekReport(t, { instance: null, models: [BUILT_IN] });
  assert.equal(row.defaultModel, BUILT_IN);
  assert.equal(row.defaultSource, "built-in");
});

test("a T3 default that originate without --model would not pick carries an action", async (t) => {
  withEnv(t, undefined);
  const { report, row, pick } = await deepseekReport(t, { instance: await installedInstance(), models: [INSTALLED, { slug: T3_MODEL, isDefault: true }] });
  assert.equal(pick, INSTALLED);
  assert.equal(row.ready, true);
  assert.equal(row.action, `T3 marks ${T3_MODEL} as the deepseek default, but originate without --model picks ${INSTALLED}; pass --model ${T3_MODEL} or make ${INSTALLED} the T3 default`);
  assert.match(formatDoctor(report), new RegExp(`deepseek  action: T3 marks ${T3_MODEL}`));
});

test("a T3 default that matches originate's pick carries no action", async (t) => {
  withEnv(t, undefined);
  const { row, pick } = await deepseekReport(t, { instance: await installedInstance(), models: [{ slug: INSTALLED, isDefault: true }] });
  assert.equal(pick, INSTALLED);
  assert.equal(row.defaultSource, "t3-marked");
  assert.equal(row.action, undefined);
});

test("a not-installed lab with a mismatching T3-marked default carries no action", async () => {
  // KRA-9785 B3 P2-2: the default-model advisory is for ready rows only.
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: {} }),
    rpc: async () => ({ environment: { serverVersion: "0.0.42-test" }, providers: [{
      instanceId: "grok", driver: "grok", status: "error", installed: false, enabled: true,
      models: [{ slug: "synthetic-grok-t3", isDefault: true }],
    }] }),
    refreshProvider: async () => {},
    request: async () => ({ talkTurnResult: "v1" }),
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra9785-"));
  try {
    const report = await doctor(client, {
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      pairStateFile: path.join(directory, "pair.json"),
      openrouterTokenFile: path.join(directory, "absent"),
      hermesHome: directory,
      refreshDirectory: path.join(directory, "refresh"),
    });
    const row = report.labs.find((entry) => entry.instanceId === "grok");
    assert.equal(row.ready, false);
    assert.equal(row.code, "not_installed");
    assert.equal(row.defaultSource, "t3-marked");
    assert.equal(row.action, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("defaultSource for a non-DeepSeek lab: built-in when its model env is unset, env through the codex-app fallback", () => {
  // Model defaults are fixed at import, so each env runs in a child.
  const script = `
    const { doctor } = await import(${JSON.stringify(new URL("../src/bridge.mjs", import.meta.url).href)});
    const provider = (instanceId) => ({ instanceId, driver: "codex", status: "ready", installed: true, enabled: true, models: [{ slug: "synthetic-model" }] });
    const client = {
      snapshot: async () => ({ projects: [], threads: [] }),
      getSettings: async () => ({ providerInstances: {} }),
      rpc: async () => ({ environment: { serverVersion: "0.0.42-test" }, providers: [provider("codex"), provider("codex-app")] }),
      refreshProvider: async () => {},
      request: async () => ({ talkTurnResult: "v1" }),
    };
    const report = await doctor(client, {
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      pairStateFile: process.env.SYNTHETIC_DIR + "/pair.json",
      openrouterTokenFile: process.env.SYNTHETIC_DIR + "/absent",
      hermesHome: process.env.SYNTHETIC_DIR,
      refreshDirectory: process.env.SYNTHETIC_DIR + "/refresh",
    });
    const pick = (id) => { const { defaultModel, defaultSource } = report.labs.find((lab) => lab.instanceId === id); return { defaultModel, defaultSource }; };
    process.stdout.write(JSON.stringify({ codex: pick("codex"), app: pick("codex-app") }));
  `;
  const run = (extra) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kra9785-env-"));
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: directory, SYNTHETIC_DIR: directory, ...extra },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  const builtIn = run({});
  assert.equal(builtIn.codex.defaultSource, "built-in");
  assert.equal(builtIn.app.defaultSource, "built-in");
  const viaFallback = run({ T3_CODEX_MODEL: "synthetic-codex-env" });
  assert.deepEqual(viaFallback.app, { defaultModel: "synthetic-codex-env", defaultSource: "env" });
  assert.deepEqual(viaFallback.codex, { defaultModel: "synthetic-codex-env", defaultSource: "env" });
  // A variable literally named "undefined" must not mark every lab env (B3 P3-1).
  const stray = run({ undefined: "synthetic-stray" });
  assert.equal(stray.codex.defaultSource, "built-in");
});
