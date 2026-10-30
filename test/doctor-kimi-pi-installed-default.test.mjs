import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { doctor, installKimiProvider, installPiProvider, originateDefaultModel } from "../src/bridge.mjs";

// The KRA-6909 rule for Kimi and Pi: the lab's model env, then the installed
// provider's KIMI_MODEL / PI_MODEL, then the built-in default.
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./helpers/fake-t3-client.mjs", import.meta.url));
const LABS = {
  kimi: { variable: "KIMI_MODEL", env: "T3_KIMI_MODEL", builtIn: "moonshotai/kimi-k3", install: (client, model) => installKimiProvider(client, { wrapperPath: "/synthetic/kimi-acp", kimiBin: "/synthetic/kimi", model }) },
  pi: { variable: "PI_MODEL", env: "T3_PI_MODEL", builtIn: "gpt-5.6-terra", install: (client, model) => installPiProvider(client, { wrapperPath: "/synthetic/pi-acp", piBin: "/synthetic/pi", model }) },
};

async function installedInstance(lab, model = `synthetic/${lab}-installed`) {
  let providerInstances;
  await LABS[lab].install({
    getSettings: async () => ({ providerInstances: {} }),
    updateSettings: async (patch) => { providerInstances = patch.providerInstances; },
    refreshProvider: async () => {},
  }, model);
  return providerInstances[lab];
}

async function labRow(t, lab, instance, models) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-kimipi-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const openrouterTokenFile = path.join(directory, "openrouter-token");
  fs.writeFileSync(openrouterTokenFile, "synthetic-openrouter-value\n", { mode: 0o600 });
  const provider = { instanceId: lab, driver: "grok", status: "ready", installed: true, enabled: true, models: models.map((slug) => ({ slug })) };
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: instance ? { [lab]: instance } : {} }),
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
  return { report, row: report.labs.find((entry) => entry.instanceId === lab), pick: await originateDefaultModel(client, lab) };
}

function withEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function withEntry(instance, name, entry) {
  return { ...instance, environment: instance.environment.map((variable) => (variable.name === name ? entry : variable)) };
}

for (const [lab, { variable, env, builtIn }] of Object.entries(LABS)) {
  const INSTALLED = `synthetic/${lab}-installed`;

  test(`${lab}: doctor and originate without --model agree on the installed model`, async (t) => {
    withEnv(t, env, undefined);
    const { row, pick } = await labRow(t, lab, await installedInstance(lab), [INSTALLED]);
    assert.equal(row.defaultModel, INSTALLED);
    assert.equal(row.defaultSource, "installed");
    assert.equal(pick, INSTALLED);
  });

  test(`${lab}: ${env} still wins over the installed model`, async (t) => {
    withEnv(t, env, `synthetic/${lab}-env`);
    const { row, pick } = await labRow(t, lab, await installedInstance(lab), [INSTALLED, `synthetic/${lab}-env`]);
    assert.equal(row.defaultModel, `synthetic/${lab}-env`);
    assert.equal(row.defaultSource, "env");
    assert.equal(pick, `synthetic/${lab}-env`);
  });

  for (const marker of [{ sensitive: true }, { valueRedacted: true }]) {
    test(`${lab}: a ${Object.keys(marker)[0]} ${variable} entry is never read or echoed`, async (t) => {
      withEnv(t, env, undefined);
      const instance = withEntry(await installedInstance(lab), variable, { name: variable, value: "SECRET-CANARY", ...marker });
      const { report, row, pick } = await labRow(t, lab, instance, [builtIn, "SECRET-CANARY"]);
      assert.equal(row.defaultModel, builtIn);
      assert.equal(row.defaultSource, "built-in");
      assert.equal(pick, builtIn);
      assert.equal(JSON.stringify({ ...report, labs: report.labs.map(({ models, modelCatalog, ...rest }) => rest) }).includes("SECRET-CANARY"), false);
    });
  }

  test(`${lab}: an instance without the harness marker falls back to the built-in default`, async (t) => {
    withEnv(t, env, undefined);
    const installed = await installedInstance(lab);
    const instance = { ...installed, environment: installed.environment.filter((entry) => entry.name !== "T3_HERMES_BRIDGE_HARNESS") };
    const { row, pick } = await labRow(t, lab, instance, [builtIn, INSTALLED]);
    assert.equal(row.defaultModel, builtIn);
    assert.equal(row.defaultSource, "built-in");
    assert.equal(pick, builtIn);
  });

  test(`${lab}: CLI originate without --model sends the installed model`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-originate-kimipi-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const tokenFile = path.join(directory, "token");
    fs.writeFileSync(tokenFile, "synthetic-fixture-only-token", { mode: 0o600 });
    const commandsFile = path.join(directory, "commands.jsonl");
    const childEnv = { ...process.env, HOME: directory, T3_URL: "http://127.0.0.1:9", T3_HERMES_TOKEN_FILE: tokenFile, T3_ORCHESTRATION_PROTOCOL: "1", FAKE_T3_SETTINGS: JSON.stringify({ providerInstances: { [lab]: await installedInstance(lab) } }), FAKE_T3_COMMANDS: commandsFile };
    delete childEnv[env];
    const spawned = spawnSync(process.execPath, ["--import", PRELOAD, CLI, "originate", "--workspace", path.join(directory, "workspace"), "--title", "kimipi", "--message", "hello", "--instance", lab, "--runtime-mode", "full-access"], { encoding: "utf8", env: childEnv });
    assert.equal(spawned.status, 0, spawned.stderr);
    const models = fs.readFileSync(commandsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((command) => command.modelSelection || command.defaultModelSelection)
      .map((command) => (command.modelSelection || command.defaultModelSelection).model);
    assert.ok(models.length >= 2, models.join(","));
    for (const model of models) assert.equal(model, INSTALLED);
  });
}
