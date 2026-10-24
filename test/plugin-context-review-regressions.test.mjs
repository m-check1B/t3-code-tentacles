import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PluginInventoryCache, codexPluginContext } from "../src/plugin-inventory.mjs";

const settingsFor = (patch = {}) => ({ providerInstances: { codex: {
  driver: "codex", enabled: true,
  config: { binaryPath: "/synthetic/codex", homePath: "/synthetic/profile", launchArgs: "" },
  ...patch,
} } });

async function observe(settings, env = {}) {
  const calls = [];
  const cache = new PluginInventoryCache({ env, execFileImpl: (_binary, _args, options, done) => {
    calls.push({ home: options.env.CODEX_HOME });
    done(null, JSON.stringify({ installed: [] }));
  } });
  cache.read(settings);
  await Promise.all(cache.inflight.values());
  return { calls, row: cache.read(settings, { refresh: false }) };
}

// Ported from B3 additional-regressions.test.mjs; all settings/execution are synthetic.
test("R5: an instance launch-argument environment override is quarantined before probing", async () => {
  const settings = settingsFor({ environment: [{ name: "T3CODE_CODEX_LAUNCH_ARGS", value: '--config \'plugins."demo@synthetic".enabled=false\'', sensitive: false }] });
  const { calls, row } = await observe(settings);
  assert.equal(calls.length, 0);
  assert.equal(row.state, "unavailable");
  assert.notEqual(codexPluginContext(settings, {}).key, codexPluginContext(settingsFor(), {}).key);
});

test("R5: missing, redacted, sensitive, duplicate and malformed launch overrides refuse", async () => {
  const entry = { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "", sensitive: false };
  for (const environment of [
    [{ name: entry.name }], [{ ...entry, valueRedacted: true }], [{ ...entry, sensitive: true }],
    [{ ...entry, value: null }], [{ ...entry, value: 42 }], [entry, entry],
  ]) {
    const { calls, row } = await observe(settingsFor({ environment }));
    assert.equal(calls.length, 0);
    assert.equal(row.state, "unavailable");
  }
});

test("R5: empty launch overrides retain fallback semantics and distinct cache identities", async () => {
  const absent = settingsFor();
  const empty = settingsFor({ environment: [{ name: "T3CODE_CODEX_LAUNCH_ARGS", value: "", sensitive: false }] });
  const whitespace = settingsFor({ environment: [{ name: "T3CODE_CODEX_LAUNCH_ARGS", value: "  ", sensitive: false }] });
  const contexts = [absent, empty, whitespace].map(settings => codexPluginContext(settings, {}));
  assert.equal(contexts.every(context => !context.error), true);
  assert.equal(new Set(contexts.map(context => context.key)).size, 3);
  const { calls, row } = await observe(empty);
  assert.equal(calls.length, 1);
  assert.equal(row.state, "observed");
  empty.providerInstances.codex.config.launchArgs = "--profile other";
  assert.equal((await observe(empty)).calls.length, 0);
  assert.equal((await observe(absent, { T3CODE_CODEX_LAUNCH_ARGS: "--profile other" })).calls.length, 0);
});

test("R6: unresolved relative and tilde homes are refused before a child starts", async () => {
  for (const homePath of ["relative-profile", "./profile", "../profile", "~", "~/profile", "~\\profile", "~someone/profile"]) {
    const settings = settingsFor({ config: { binaryPath: "/synthetic/codex", homePath } });
    const { calls, row } = await observe(settings);
    assert.equal(calls.length, 0, homePath);
    assert.equal(row.state, "unavailable", homePath);
    assert.equal(typeof codexPluginContext(settings, {}).error, "string");
  }
});

test("R6: a known absolute home is resolved without trimming significant path bytes", async () => {
  for (const homePath of [path.join(path.parse(process.cwd()).root, "synthetic", "profile") + "/../exact", path.join(path.parse(process.cwd()).root, "synthetic", "profile ")]) {
    const settings = settingsFor({ config: { binaryPath: "/synthetic/codex", homePath } });
    const context = codexPluginContext(settings, {});
    assert.equal(context.home, path.resolve(homePath));
    assert.equal(path.isAbsolute(context.home), true);
    const { calls, row } = await observe(settings);
    assert.deepEqual(calls, [{ home: path.resolve(homePath) }]);
    assert.equal(row.state, "observed");
  }
});
