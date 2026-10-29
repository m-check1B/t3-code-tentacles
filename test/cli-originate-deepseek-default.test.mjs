import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installDeepSeekProvider } from "../src/bridge.mjs";

// KRA-6909: CLI originate without --model sends the installed DeepSeek model,
// not the built-in default it validated before the T3 client existed.
const INSTALLED = "synthetic/installed";
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./helpers/fake-t3-client.mjs", import.meta.url));

async function installedSettings() {
  let providerInstances;
  await installDeepSeekProvider({
    getSettings: async () => ({ providerInstances: {} }),
    updateSettings: async (patch) => { providerInstances = patch.providerInstances; },
    refreshProvider: async () => {},
  }, { wrapperPath: "/synthetic/deepseek-acp", model: INSTALLED });
  return { providerInstances };
}

async function originateCommands(t, extra) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-originate-kra6909-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "token");
  fs.writeFileSync(tokenFile, "synthetic-fixture-only-token", { mode: 0o600 });
  const commandsFile = path.join(directory, "commands.jsonl");
  const env = { ...process.env, HOME: directory, T3_URL: "http://127.0.0.1:9", T3_HERMES_TOKEN_FILE: tokenFile, T3_ORCHESTRATION_PROTOCOL: "1", FAKE_T3_SETTINGS: JSON.stringify(await installedSettings()), FAKE_T3_COMMANDS: commandsFile };
  delete env.T3_DEEPSEEK_MODEL;
  const spawned = spawnSync(process.execPath, ["--import", PRELOAD, CLI, "originate", "--workspace", path.join(directory, "workspace"), "--title", "KRA-6909", "--message", "hello", "--instance", "deepseek", "--runtime-mode", "full-access", ...extra], { encoding: "utf8", env });
  assert.equal(spawned.status, 0, spawned.stderr);
  return fs.readFileSync(commandsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function selectedModels(commands) {
  return commands.filter((command) => command.modelSelection || command.defaultModelSelection)
    .map((command) => `${command.type}=${(command.modelSelection || command.defaultModelSelection).model}`);
}

test("CLI originate without --model sends the installed DeepSeek model", async (t) => {
  const models = selectedModels(await originateCommands(t, []));
  assert.ok(models.length >= 2, models.join(","));
  for (const model of models) assert.match(model, new RegExp(`=${INSTALLED}$`));
  assert.ok(models.some((model) => model.startsWith("thread.turn.start=")), models.join(","));
});

test("CLI originate with --model sends the explicit model", async (t) => {
  const models = selectedModels(await originateCommands(t, ["--model", "synthetic/explicit"]));
  assert.ok(models.length >= 2, models.join(","));
  for (const model of models) assert.match(model, /=synthetic\/explicit$/);
});
