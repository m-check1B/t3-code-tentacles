import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// PR 54: the DeepSeek and Kimi installers default to T3_DEEPSEEK_MODEL / T3_KIMI_MODEL,
// captured at import, so a fresh process proves it independent of this host's env.
const CHILD = `
const { installDeepSeekProvider, installKimiProvider } = await import(${JSON.stringify(new URL("../src/bridge.mjs", import.meta.url).href)});
let current = {};
const client = {
  getSettings: async () => ({ providerInstances: current }),
  updateSettings: async (update) => { current = update.providerInstances; },
  refreshProvider: async (instanceId) => ({ provider: { instanceId } }),
};
await installDeepSeekProvider(client, { wrapperPath: "/synthetic/deepseek-acp" });
await installKimiProvider(client, { wrapperPath: "/synthetic/kimi-acp", kimiBin: "/synthetic/kimi" });
const env = (instance, name) => instance.environment.find((variable) => variable.name === name)?.value;
console.log(JSON.stringify({
  deepseek: [current.deepseek.config.customModels, env(current.deepseek, "DEEPSEEK_MODEL")],
  kimi: [current.kimi.config.customModels, env(current.kimi, "KIMI_MODEL")],
}));
`;

test("installers default to T3_DEEPSEEK_MODEL and T3_KIMI_MODEL set in the environment", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles installer env "));
  try {
    // Minimal env: no host HOME, NODE_OPTIONS or other T3_* variables reach the child.
    const env = { PATH: process.env.PATH, HOME: home, T3_DEEPSEEK_MODEL: "synthetic/deepseek-env", T3_KIMI_MODEL: "synthetic/kimi-env" };
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      deepseek: [["synthetic/deepseek-env"], "synthetic/deepseek-env"],
      kimi: [["synthetic/kimi-env"], "synthetic/kimi-env"],
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
