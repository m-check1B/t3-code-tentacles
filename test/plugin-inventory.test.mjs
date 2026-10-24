import assert from "node:assert/strict";
import test from "node:test";
import { doctor } from "../src/bridge.mjs";
import {
  codexPluginContext,
  PluginInventoryCache,
  projectCodexPluginList,
} from "../src/plugin-inventory.mjs";

const listing = {
  installed: [
    { pluginId: "gh@openai", name: "GitHub", marketplaceName: "openai", version: "1.2.0", installed: true, enabled: true, source: { source: "/Users/someone/.codex/plugins/gh", id: "x" }, installPolicy: "AVAILABLE", authPolicy: "ON_USE" },
    { pluginId: "docs@openai", name: "Docs", marketplaceName: "openai", version: "0.1.0", installed: true, enabled: false, source: { source: "/secret", id: "y" } },
    { pluginId: "maybe@openai", name: "Maybe", marketplaceName: "openai", version: "1.0.0", installed: false, enabled: false },
  ],
  available: [{ pluginId: "remote@openai" }],
};
const settings = { providers: { codex: { enabled: true, binaryPath: "/opt/codex/bin/codex", homePath: "", shadowHomePath: "", launchArgs: "" } } };

test("projection keeps installed identity/version/enabled only, never paths (KRA-6203)", () => {
  const row = projectCodexPluginList(listing, "2026-09-29T06:00:00.000Z");
  assert.equal(row.state, "observed");
  assert.equal(row.count, 2);
  assert.deepEqual(row.plugins, [
    { pluginId: "docs@openai", name: "Docs", marketplace: "openai", version: "0.1.0", enabled: false },
    { pluginId: "gh@openai", name: "GitHub", marketplace: "openai", version: "1.2.0", enabled: true },
  ]);
  assert.match(row.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(row), /\/Users\/|\/secret|AVAILABLE|remote@/);
  assert.equal(projectCodexPluginList({ nope: [] }, "t"), null);
  assert.equal(projectCodexPluginList(null, "t"), null);
});

test("projection drops entries it cannot represent exactly", () => {
  const bad = [
    { pluginId: "a/b", name: "x", marketplaceName: "m", version: "1", installed: true, enabled: true },
    { pluginId: " pad", name: "x", marketplaceName: "m", version: "1", installed: true, enabled: true },
    { pluginId: "ok", name: "x", marketplaceName: "m", version: "1 beta", installed: true, enabled: true },
    { pluginId: "ok2", name: "x", marketplaceName: "m", version: "1", installed: true, enabled: "yes" },
    { pluginId: "ok3", name: "x", marketplaceName: "m", version: "1", installed: true, enabled: true },
  ];
  const row = projectCodexPluginList({ installed: bad }, "t");
  assert.equal(row.dropped, 4);
  assert.equal(row.count, 1);
});

test("plugin context is the configured binary and CODEX_HOME; launch args are not guessed", () => {
  const env = {};
  assert.deepEqual(
    [codexPluginContext(settings, env).binary, codexPluginContext(settings, env).home],
    ["/opt/codex/bin/codex", null],
  );
  const homed = codexPluginContext({ providers: { codex: { enabled: true, homePath: "/h" } } }, env);
  assert.deepEqual([homed.binary, homed.home], ["codex", "/h"]);
  assert.notEqual(homed.key, codexPluginContext(settings, env).key);
  assert.equal(codexPluginContext({ providers: { codex: { launchArgs: "-c x=1" } } }, env).error, "launch_args_unverified");
  assert.equal(codexPluginContext({ providers: { codex: { enabled: false } } }, env).error, "disabled");
  assert.equal(codexPluginContext({}, env).error, "disabled");
  // An explicit T3 instance wins over legacy settings, like the doctor lab row.
  const instance = codexPluginContext({
    providers: { codex: { enabled: true, binaryPath: "/legacy/codex" } },
    providerInstances: { codex: { driver: "codex", config: { binaryPath: "/inst/codex", homePath: "/ih" } } },
  }, env);
  assert.deepEqual([instance.binary, instance.home], ["/inst/codex", "/ih"]);
  assert.equal(codexPluginContext({
    providers: { codex: { enabled: true } }, providerInstances: { codex: { enabled: false } },
  }, env).error, "disabled");
  assert.equal(codexPluginContext({
    providerInstances: { codex: { driver: "codex", config: { launchArgs: "-c a=b" } } },
  }, env).error, "launch_args_unverified");
  for (const name of ["CODEX_HOME", "HOME", "PATH"]) {
    assert.equal(codexPluginContext({
      providerInstances: { codex: { driver: "codex", environment: [{ name, value: "/x" }] } },
    }, env).error, "environment_unverified", name);
  }
  // Unrelated instance environment (e.g. harness markers) does not block attribution.
  assert.equal(codexPluginContext({
    providerInstances: { codex: { driver: "codex", environment: [{ name: "OTHER", value: "1" }] } },
  }, env).binary, "codex");
  // No configured home while this process has its own CODEX_HOME: cannot match T3.
  assert.equal(codexPluginContext(settings, { CODEX_HOME: "/elsewhere" }).error, "default_context_unverified");
});

test("cache never blocks, refreshes once in the background and expires", async () => {
  let clock = 0;
  const calls = [];
  let finish;
  const cache = new PluginInventoryCache({
    now: () => clock,
    ttlMs: 1000,
    env: {},
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, home: options.env.CODEX_HOME });
      finish = () => callback(null, JSON.stringify(listing));
    },
  });
  assert.equal(cache.read(settings).code, "refreshing");
  assert.equal(cache.read(settings).code, "refreshing");
  assert.equal(calls.length, 1, "one in-flight refresh per context");
  assert.deepEqual(calls[0], { file: "/opt/codex/bin/codex", args: ["plugin", "list", "--json"], home: undefined });
  finish();
  await Promise.all(cache.inflight.values());
  assert.equal(cache.read(settings).state, "observed");
  clock = 2000;
  assert.equal(cache.read(settings, { refresh: false }).code, "not_refreshed");
  assert.equal(calls.length, 1);
});

test("cache passes CODEX_HOME and hides CLI failures", async () => {
  let clock = 0;
  let calls = 0;
  const cache = new PluginInventoryCache({
    env: {},
    now: () => clock,
    failureTtlMs: 100,
    execFileImpl: (_file, _args, options, callback) => {
      calls += 1;
      assert.equal(options.env.CODEX_HOME, "/h");
      assert.equal(options.killSignal, "SIGKILL");
      callback(new Error("PRIVATE stderr"), "");
    },
  });
  const homed = { providers: { codex: { enabled: true, homePath: "/h" } } };
  cache.read(homed);
  await Promise.all(cache.inflight.values());
  const row = cache.read(homed);
  assert.deepEqual([row.state, row.code, row.count], ["unavailable", "plugin_list_failed", null]);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE/);
  // Failures are retried after the short failure TTL, not the full TTL.
  clock = 200;
  cache.read(homed);
  await Promise.all(cache.inflight.values());
  assert.equal(calls, 2);
});

test("CLI doctor without a cache never spawns and reports plugins unavailable", async () => {
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => settings,
    rpc: async () => ({ providers: [] }),
  };
  const result = await doctor(client, { fetchImpl: async () => new Response("{}", { status: 503 }) });
  assert.equal(result.pluginInventory.version, 1);
  const codex = result.pluginInventory.labs.find((lab) => lab.instanceId === "codex");
  assert.deepEqual([codex.state, codex.code, codex.count], ["unavailable", "not_refreshed", null]);
  assert.ok(result.pluginInventory.labs.filter((lab) => lab.instanceId !== "codex").every((lab) => lab.code === "no_native_plugin_source"));
});

test("a listing that never settles is killed and reported, not left refreshing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const killed = [];
  const cache = new PluginInventoryCache({
    env: {},
    execFileImpl: () => ({ kill: (signal) => killed.push(signal) }),
  });
  assert.equal(cache.read(settings).code, "refreshing");
  t.mock.timers.tick(65_000);
  await Promise.all(cache.inflight.values());
  assert.deepEqual(killed, ["SIGKILL"]);
  assert.equal(cache.inflight.size, 0);
  assert.equal(cache.read(settings, { refresh: false }).code, "plugin_list_failed");
});
