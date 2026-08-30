import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEEPSEEK_HARNESS_VALUE,
  installDeepSeekProvider,
  installKimiProvider,
  KIMI_HARNESS_VALUE,
  providerHarness,
  removeDeepSeekProvider,
  removeKimiProvider,
} from "../src/bridge.mjs";
import {
  buildLaunchPlan,
  openCodeAuthFile,
  readDeepSeekApiKey,
  resolveDshAcpBinary,
} from "../src/deepseek-acp-launch.mjs";

const WRAPPER_DEEPSEEK = path.resolve("bin", "t3-deepseek-acp");
const WRAPPER_KIMI = path.resolve("bin", "t3-kimi-acp");
const DSH_CONFIG = path.resolve("config", "dsh-acp.cordis.yml");

function settingsClient(instances = {}) {
  let current = instances;
  return {
    getSettings: async () => ({ providerInstances: current }),
    updateSettings: async (update) => { current = update.providerInstances; },
    refreshProvider: async (instanceId) => ({ provider: { instanceId } }),
    instances: () => current,
  };
}

function envMap(instance) {
  return new Map((instance.environment || []).map((variable) => [variable.name, variable.value]));
}

test("installDeepSeekProvider registers a grok-driver instance with harness markers and customModels", async () => {
  const client = settingsClient();
  const result = await installDeepSeekProvider(client, { wrapperPath: WRAPPER_DEEPSEEK });
  assert.equal(result.provider.instanceId, "deepseek");
  const instance = client.instances().deepseek;
  assert.equal(instance.driver, "grok");
  assert.equal(instance.displayName, "DeepSeek CLI");
  assert.equal(instance.enabled, true);
  assert.deepEqual(instance.config, { binaryPath: WRAPPER_DEEPSEEK, customModels: ["deepseek/deepseek-v4-flash"] });
  const env = envMap(instance);
  assert.equal(env.get("T3_HERMES_BRIDGE_OWNER"), "t3-hermes-bridge/v1");
  assert.equal(env.get("T3_HERMES_BRIDGE_HARNESS"), "deepseek");
  assert.equal(env.get("DEEPSEEK_MODEL"), "deepseek/deepseek-v4-flash");
  assert.equal(env.has("DSH_ACP_BIN"), false);
});

test("installDeepSeekProvider stores DSH_ACP_BIN only when an absolute path is provided", async () => {
  const client = settingsClient();
  await installDeepSeekProvider(client, { wrapperPath: WRAPPER_DEEPSEEK, dshAcpBin: "/opt/dsh/bin/dsh-acp", model: "deepseek-v4-pro" });
  const env = envMap(client.instances().deepseek);
  assert.equal(env.get("DSH_ACP_BIN"), "/opt/dsh/bin/dsh-acp");
  assert.equal(env.get("DEEPSEEK_MODEL"), "deepseek-v4-pro");
  await assert.rejects(
    installDeepSeekProvider(client, { wrapperPath: WRAPPER_DEEPSEEK, dshAcpBin: "dsh-acp" }),
    /absolute dsh-acp executable path/,
  );
});

test("installDeepSeekProvider refuses foreign instances and redacted secrets", async () => {
  const foreign = settingsClient({
    deepseek: { driver: "grok", displayName: "Someone else", environment: [] },
  });
  await assert.rejects(installDeepSeekProvider(foreign, { wrapperPath: WRAPPER_DEEPSEEK }), /not owned by the DeepSeek harness/);
  const piOwned = settingsClient({
    deepseek: {
      driver: "grok",
      environment: [
        { name: "T3_HERMES_BRIDGE_OWNER", value: "t3-hermes-bridge/v1", sensitive: false },
        { name: "T3_HERMES_BRIDGE_HARNESS", value: "pi", sensitive: false },
      ],
    },
  });
  await assert.rejects(installDeepSeekProvider(piOwned, { wrapperPath: WRAPPER_DEEPSEEK }), /not owned by the DeepSeek harness/);
  const redacted = settingsClient({
    other: { driver: "grok", environment: [{ name: "KEY", sensitive: true, valueRedacted: true }] },
  });
  await assert.rejects(installDeepSeekProvider(redacted, { wrapperPath: WRAPPER_DEEPSEEK }), /redacted provider secrets/);
});

test("reinstalling over an own DeepSeek instance is allowed", async () => {
  const client = settingsClient();
  await installDeepSeekProvider(client, { wrapperPath: WRAPPER_DEEPSEEK });
  await installDeepSeekProvider(client, { wrapperPath: WRAPPER_DEEPSEEK, model: "deepseek-v4-pro" });
  assert.deepEqual(client.instances().deepseek.config.customModels, ["deepseek-v4-pro"]);
});

test("removeDeepSeekProvider refuses foreign instances, reports absent, removes owned", async () => {
  const absent = settingsClient();
  assert.deepEqual(await removeDeepSeekProvider(absent), { removed: false });
  const foreign = settingsClient({ deepseek: { driver: "grok", environment: [] } });
  await assert.rejects(removeDeepSeekProvider(foreign), /not owned by the DeepSeek harness/);
  const owned = settingsClient();
  await installDeepSeekProvider(owned, { wrapperPath: WRAPPER_DEEPSEEK });
  assert.deepEqual(await removeDeepSeekProvider(owned), { removed: true });
  assert.equal("deepseek" in owned.instances(), false);
});

test("installKimiProvider registers a grok-driver instance with KIMI_BIN and customModels", async () => {
  const client = settingsClient();
  const result = await installKimiProvider(client, { wrapperPath: WRAPPER_KIMI, kimiBin: "/opt/kimi/bin/kimi" });
  assert.equal(result.provider.instanceId, "kimi");
  const instance = client.instances().kimi;
  assert.equal(instance.driver, "grok");
  assert.equal(instance.displayName, "Kimi CLI");
  assert.deepEqual(instance.config, { binaryPath: WRAPPER_KIMI, customModels: ["moonshotai/kimi-k3"] });
  const env = envMap(instance);
  assert.equal(env.get("T3_HERMES_BRIDGE_HARNESS"), "kimi");
  assert.equal(env.get("KIMI_BIN"), "/opt/kimi/bin/kimi");
  assert.equal(env.get("KIMI_MODEL"), "moonshotai/kimi-k3");
});

test("installKimiProvider requires an absolute kimiBin and refuses foreign instances", async () => {
  const client = settingsClient();
  await assert.rejects(installKimiProvider(client, { wrapperPath: WRAPPER_KIMI, kimiBin: "kimi" }), /absolute Kimi executable path/);
  const foreign = settingsClient({ kimi: { driver: "grok", environment: [] } });
  await assert.rejects(installKimiProvider(foreign, { wrapperPath: WRAPPER_KIMI, kimiBin: "/opt/kimi/bin/kimi" }), /not owned by the Kimi CLI harness/);
  const redacted = settingsClient({
    other: { driver: "grok", environment: [{ name: "KEY", sensitive: true, valueRedacted: true }] },
  });
  await assert.rejects(installKimiProvider(redacted, { wrapperPath: WRAPPER_KIMI, kimiBin: "/opt/kimi/bin/kimi" }), /redacted provider secrets/);
});

test("removeKimiProvider refuses foreign instances, reports absent, removes owned", async () => {
  const absent = settingsClient();
  assert.deepEqual(await removeKimiProvider(absent), { removed: false });
  const foreign = settingsClient({ kimi: { driver: "grok", environment: [] } });
  await assert.rejects(removeKimiProvider(foreign), /not owned by the Kimi harness/);
  const owned = settingsClient();
  await installKimiProvider(owned, { wrapperPath: WRAPPER_KIMI, kimiBin: "/opt/kimi/bin/kimi" });
  assert.deepEqual(await removeKimiProvider(owned), { removed: true });
  assert.equal("kimi" in owned.instances(), false);
});

test("providerHarness classification keeps abandoned markers inert legacy state", () => {
  const owned = (environment) => ({ driver: "grok", environment });
  const ownerMarker = { name: "T3_HERMES_BRIDGE_OWNER", value: "t3-hermes-bridge/v1", sensitive: false };
  assert.equal(providerHarness(owned([ownerMarker])), "hermes");
  assert.equal(providerHarness(owned([ownerMarker, { name: "T3_HERMES_BRIDGE_HARNESS", value: "pi", sensitive: false }])), "pi");
  assert.equal(providerHarness(owned([ownerMarker, { name: "T3_HERMES_BRIDGE_HARNESS", value: "deepseek", sensitive: false }])), "deepseek");
  assert.equal(providerHarness(owned([ownerMarker, { name: "T3_HERMES_BRIDGE_HARNESS", value: "kimi", sensitive: false }])), "kimi");
  assert.equal(providerHarness(owned([ownerMarker, { name: "T3_HERMES_BRIDGE_HARNESS", value: "claude-openrouter", sensitive: false }])), "claude-openrouter");
  assert.equal(providerHarness(owned([ownerMarker, { name: "T3_HERMES_BRIDGE_HARNESS", value: "unknown", sensitive: false }])), null);
  assert.equal(providerHarness({ driver: "grok", environment: [] }), null);
  assert.equal(DEEPSEEK_HARNESS_VALUE, "deepseek");
  assert.equal(KIMI_HARNESS_VALUE, "kimi");
});

test("surviving installers and removers refuse the abandoned instance without reading settings", async () => {
  const client = {
    getSettings: async () => assert.fail("reserved instance must fail before settings read"),
  };
  await assert.rejects(
    installDeepSeekProvider(client, { instanceId: "claude-openrouter", wrapperPath: WRAPPER_DEEPSEEK }),
    /reserved legacy state/,
  );
  await assert.rejects(removeDeepSeekProvider(client, { instanceId: "claude-openrouter" }), /reserved legacy state/);
  await assert.rejects(
    installKimiProvider(client, { instanceId: "claude-openrouter", wrapperPath: WRAPPER_KIMI, kimiBin: "/opt/kimi/bin/kimi" }),
    /reserved legacy state/,
  );
  await assert.rejects(removeKimiProvider(client, { instanceId: "claude-openrouter" }), /reserved legacy state/);
});

test("readDeepSeekApiKey fails loud without leaking material", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-dsh-auth-"));
  const missing = path.join(directory, "missing", "auth.json");
  assert.throws(() => readDeepSeekApiKey(missing), /DeepSeek API key not found/);
  const invalid = path.join(directory, "invalid.json");
  fs.writeFileSync(invalid, "not json sk-should-not-appear");
  assert.throws(() => readDeepSeekApiKey(invalid), /not valid JSON/);
  const empty = path.join(directory, "empty.json");
  fs.writeFileSync(empty, JSON.stringify({ deepseek: { key: "  " } }));
  assert.throws(() => readDeepSeekApiKey(empty), /no non-empty \.deepseek\.key entry/);
  const valid = path.join(directory, "valid.json");
  fs.writeFileSync(valid, JSON.stringify({ deepseek: { key: "sk-test-key-material" } }));
  assert.equal(readDeepSeekApiKey(valid), "sk-test-key-material");
  for (const file of [missing, invalid, empty]) {
    try {
      readDeepSeekApiKey(file);
      assert.fail("expected a failure");
    } catch (error) {
      assert.equal(error.message.includes("sk-test-key-material"), false);
      assert.equal(error.message.includes("sk-should-not-appear"), false);
    }
  }
});

test("resolveDshAcpBinary rejects relative paths and hints at npm i -g dsh-acp", () => {
  assert.throws(() => resolveDshAcpBinary({ DSH_ACP_BIN: "dsh-acp" }), /absolute path/);
  assert.throws(() => resolveDshAcpBinary({ PATH: "" }), /npm i -g dsh-acp/);
  assert.equal(resolveDshAcpBinary({ DSH_ACP_BIN: process.execPath }), process.execPath);
});

test("buildLaunchPlan keeps the key out of argv and prepares a private sessions root", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-dsh-home-"));
  const tokenFile = path.join(home, ".local", "state", "t3-hermes-bridge", "openrouter.token");
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, "sk-plan-key-material", { mode: 0o600 });
  const plan = buildLaunchPlan({ env: { DSH_ACP_BIN: process.execPath, PATH: "" }, home, cwd: "/repo/alpha" });
  assert.equal(plan.binary, process.execPath);
  assert.deepEqual(plan.args, ["--config", path.resolve("config", "dsh-acp.cordis.yml")]);
  assert.equal(plan.args.some((argument) => argument.includes("sk-plan-key-material")), false);
  assert.equal(plan.env.DEEPSEEK_API_KEY, "sk-plan-key-material");
  assert.equal(plan.env.DEEPSEEK_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(plan.env.DEEPSEEK_MODEL, "deepseek/deepseek-v4-flash");
  assert.equal(plan.env.DSH_PERMISSION_MODE, "workspace-write");
  const sessionsRoot = plan.env.DSH_SESSIONS_ROOT;
  const suffix = path.basename(sessionsRoot);
  assert.match(suffix, /^[0-9a-f]{16}$/);
  assert.equal(suffix, createHash("sha256").update("/repo/alpha").digest("hex").slice(0, 16));
  assert.equal(path.dirname(sessionsRoot), path.join(home, ".dsh", "acp-sessions"));
  assert.equal(fs.statSync(sessionsRoot).mode & 0o777, 0o700);
  // The default root is deterministic per cwd and distinct across cwds.
  const again = buildLaunchPlan({ env: { DSH_ACP_BIN: process.execPath, PATH: "" }, home, cwd: "/repo/alpha" });
  assert.equal(again.env.DSH_SESSIONS_ROOT, sessionsRoot);
  const other = buildLaunchPlan({ env: { DSH_ACP_BIN: process.execPath, PATH: "" }, home, cwd: "/repo/beta" });
  assert.notEqual(other.env.DSH_SESSIONS_ROOT, sessionsRoot);
  // An explicit DSH_SESSIONS_ROOT override replaces the default entirely.
  const explicit = buildLaunchPlan({
    env: { DSH_ACP_BIN: process.execPath, PATH: "", DSH_SESSIONS_ROOT: path.join(home, "custom-root") },
    home,
    cwd: "/repo/alpha",
  });
  assert.equal(explicit.env.DSH_SESSIONS_ROOT, path.join(home, "custom-root"));
  const overridden = buildLaunchPlan({
    env: { DSH_ACP_BIN: process.execPath, PATH: "", DEEPSEEK_MODEL: "deepseek-v4-pro", DSH_PERMISSION_MODE: "danger-full-access" },
    home,
    cwd: "/repo/alpha",
  });
  assert.equal(overridden.env.DEEPSEEK_MODEL, "deepseek-v4-pro");
  assert.equal(overridden.env.DSH_PERMISSION_MODE, "danger-full-access");
});

test("bridge DSH config bounds Claude output below its OpenRouter context window", () => {
  const config = fs.readFileSync(DSH_CONFIG, "utf8");
  assert.match(config, /maxTokens: !!js "Number\(process\.env\.DSH_MAX_TOKENS \?\? 256000\)"/);
  assert.match(config, /- id: anthropic\/claude-3-haiku/);
});
