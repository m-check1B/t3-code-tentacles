import assert from "node:assert/strict";
import test from "node:test";
import { doctor, skillInventoryRow } from "../src/bridge.mjs";
import { looksSecret, MAX_PUBLISH_BYTES } from "../src/capabilities.mjs";
import { PluginInventoryCache, codexPluginContext, projectCodexPluginList } from "../src/plugin-inventory.mjs";
import { LoopbackRuntimeAdapter, DEFAULT_MAX_FRAME_BYTES, withoutInventory } from "../src/outbound-pairer.mjs";
import { ORIGINATE_LABS } from "../src/model-selection.mjs";

// Ported from the independent B3 repro. Markers are synthetic; assertions never print them.
test("R1: skill and plugin metadata share the capability secret-shape filter before hashing", () => {
  const marker = ["sk", "SYNTHETIC0123456789abcdef"].join("-");
  assert.equal(looksSecret(marker), true);
  for (const field of ["name", "scope"]) {
    const unsafe = field === "scope" ? ["secret", "synthetic123"].join("_") : marker;
    assert.equal(looksSecret(unsafe), true);
    const row = skillInventoryRow("codex", { skills: [{ name: "review", scope: "user", enabled: true, [field]: unsafe }] });
    assert.equal(row.skills.length, 0);
    assert.equal(row.dropped, 1);
    assert.equal(row.digest, skillInventoryRow("codex", { skills: [] }).digest);
  }
  const safe = { pluginId: "demo@synthetic", name: "Demo", marketplaceName: "synthetic", version: "1.0.0", enabled: true, installed: true };
  for (const field of ["pluginId", "name", "marketplaceName", "version"]) {
    const row = projectCodexPluginList({ installed: [{ ...safe, [field]: marker }] }, "synthetic-time");
    assert.equal(row.plugins.length, 0);
    assert.equal(row.dropped, 1);
    assert.equal(row.digest, projectCodexPluginList({ installed: [] }, "synthetic-time").digest);
  }
});

test("R2: explicit Codex defaults never inherit stale legacy fields", async () => {
  for (const config of [{ binaryPath: "/synthetic/exact/codex", homePath: "" }, { homePath: "/synthetic/exact/home" }, {}]) {
    const settings = {
      providers: { codex: { enabled: false, binaryPath: "/synthetic/legacy/codex", homePath: "/synthetic/legacy/home", launchArgs: "legacy-args" } },
      providerInstances: { codex: { driver: "codex", enabled: true, config } },
    };
    const context = codexPluginContext(settings, {});
    if (config.binaryPath) {
      assert.equal(context.error, undefined);
      assert.equal(context.binary, config.binaryPath);
      assert.equal(context.home, config.homePath || null);
    } else {
      // Explicit defaults still cannot inherit a legacy executable. Without
      // T3's PATH, their default bare command is now quarantined by R8.
      assert.equal(context.error, "binary_unverified");
      assert.equal(Object.hasOwn(context, "binary"), false);
    }
    let childCalls = 0;
    const cache = new PluginInventoryCache({ env: {}, execFileImpl: (binary, _argv, options, done) => {
      childCalls++;
      assert.equal(binary === (config.binaryPath || "codex"), true);
      assert.equal(options.env.CODEX_HOME === (config.homePath || undefined), true);
      done(null, JSON.stringify({ installed: [] }));
    } });
    cache.read(settings);
    await Promise.all(cache.inflight.values());
    assert.equal(childCalls, config.binaryPath ? 1 : 0);
    assert.equal(cache.read(settings).state, config.binaryPath ? "observed" : "unavailable");
  }
  const settings = { providers: { codex: { homePath: "/synthetic/legacy/home" } }, providerInstances: { codex: { driver: "codex", config: {} } } };
  assert.equal(codexPluginContext(settings, { CODEX_HOME: "/synthetic/ambient/home" }).error, "default_context_unverified");
});

test("R3: disabled inner config and foreign or unverified driver never resolve or spawn", async () => {
  for (const instance of [
    { driver: "codex", enabled: true, config: { enabled: false } },
    { driver: "codex", enabled: false, config: { enabled: true } },
    { driver: "other-driver", enabled: true, config: {} },
    { enabled: true, config: {} },
    { driver: "codex", enabled: "true", config: {} },
    { driver: "codex", config: { enabled: "true" } },
    { driver: "codex", config: [] },
    { driver: "codex", config: { binaryPath: 42 } },
    { driver: "codex", environment: {} },
  ]) {
    const settings = { providers: { codex: { enabled: true, binaryPath: "/synthetic/legacy/codex" } }, providerInstances: { codex: instance } };
    let childCalls = 0;
    const cache = new PluginInventoryCache({ env: {}, execFileImpl: (_binary, _argv, _options, done) => {
      childCalls++;
      done(null, JSON.stringify({ installed: [] }));
    } });
    const context = codexPluginContext(settings, {});
    assert.equal(typeof context.error, "string");
    assert.equal(Object.hasOwn(context, "binary"), false);
    const row = cache.read(settings);
    await Promise.all(cache.inflight.values());
    assert.equal(childCalls, 0);
    assert.equal(row.state, "unavailable");
    assert.equal(row.count, null);
  }
});

const frame = (result) => ({ version: 1, type: "rpc.result", id: "synthetic-request", result });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("R4: B3's 1,065,172-byte inventory case keeps the core doctor catalog", async () => {
  const skills = Array.from({ length: 512 }, (_, i) => ({ name: "界".repeat(120) + String(i).padStart(8, "0"), scope: "project", enabled: true }));
  const labs = ["codex", "claudeAgent", "grok", "cursor", "opencode"];
  assert.equal(labs.length, 5);
  const providers = labs.map((instanceId) => ({ instanceId, driver: instanceId, installed: true, status: "ready", skills, models: [{ slug: "synthetic-model", isDefault: true }] }));
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: Object.fromEntries(labs.map((id) => [id, { driver: id, enabled: true }])) }),
    rpc: async () => ({ providers }), request: async () => ({ talkTurnResult: "v1" }),
  };
  const adapter = new LoopbackRuntimeAdapter({ client, pairStateFile: "/synthetic/absent-pair-state", pluginInventory: null,
    doctorImpl: (c, options) => doctor(c, { ...options, openrouterTokenFile: "/synthetic/absent-token", hermesHome: "/synthetic/absent-hermes", fetchImpl: async () => new Response("{}", { status: 503 }) }) });
  const report = await adapter.doctorStatus();
  assert.equal(bytes(frame(report)) <= DEFAULT_MAX_FRAME_BYTES, true);
  assert.equal(bytes({ skillInventory: report.skillInventory, pluginInventory: report.pluginInventory }) <= MAX_PUBLISH_BYTES, true);
  assert.equal(report.labs.length, ORIGINATE_LABS.length);
  const observed = report.skillInventory.labs.filter((row) => row.state === "observed");
  assert.equal(observed.length, 5);
  assert.equal(observed.some((row) => row.truncated), true);
  for (const row of observed) {
    assert.equal(row.count, 512);
    assert.equal(row.dropped, 0);
    assert.equal(row.truncated, row.skills.length < row.count);
    assert.equal(row.digest, skillInventoryRow(row.instanceId, { skills }).digest);
  }
});

test("R4: relay fallback removes every optional inventory while preserving core fields", () => {
  const core = { labs: [{ instanceId: "codex", ready: true }], pairing: { status: "paired" } };
  const original = frame({ ...core,
    skillInventory: { version: 1, labs: [{ instanceId: "codex", state: "observed", count: 512, dropped: 2, truncated: false, digest: "synthetic-digest", skills: [{ name: "review" }] }] },
    pluginInventory: { version: 1, labs: [{ instanceId: "codex", state: "observed", count: 1, dropped: 0, truncated: false, digest: "synthetic-digest", plugins: [{ name: "Demo" }] }] },
    capabilityInventory: { skills: [{ name: "review" }] },
  });
  const slim = withoutInventory(original);
  assert.equal(slim !== null, true);
  assert.deepEqual(slim.result.labs, core.labs);
  assert.deepEqual(slim.result.pairing, core.pairing);
  assert.equal(bytes(slim) < bytes(original), true);
  assert.equal(slim.result.skillInventory?.labs[0]?.skills.length ?? 0, 0);
  assert.equal(slim.result.pluginInventory?.labs[0]?.plugins.length ?? 0, 0);
  assert.equal(slim.result.capabilityInventory, null);
  assert.equal(original.result.skillInventory.labs[0].skills.length, 1, "cache/source is not mutated");
  const nativeOnly = { ...original.result };
  delete nativeOnly.capabilityInventory;
  assert.equal(withoutInventory(frame(nativeOnly)) !== null, true);
  assert.equal(withoutInventory(frame(core)), null);
});


test("R4: skills, plugins and capabilities share the aggregate budget at custom frame sizes", async () => {
  const skills = Array.from({ length: 512 }, (_, i) => ({ name: "界".repeat(120) + String(i).padStart(8, "0"), enabled: true }));
  const installed = Array.from({ length: 256 }, (_, i) => ({ pluginId: `demo-${i}@synthetic`, name: "界".repeat(120), marketplaceName: "界".repeat(120), version: "1.0.0", enabled: true, installed: true }));
  const catalog = {
    labs: [{ instanceId: "codex", ready: true, model: "synthetic-model" }],
    skillInventory: { version: 1, labs: [skillInventoryRow("codex", { skills })] },
    pluginInventory: { version: 1, labs: [projectCodexPluginList({ installed }, "synthetic-time")] },
  };
  const capabilityCache = {
    current: { schema: "tentacles.capabilities.v1", clis: [{ id: "gh", state: "signed_in" }], mcp: [], plugins: [], skills: skills.map((row, i) => ({ lab: "codex", name: `review-${i}` })), truncated: { mcp: false, plugins: false, skills: false } },
    refreshIfStale: async () => {},
  };
  const original = JSON.stringify(catalog);
  for (const frameBytes of [DEFAULT_MAX_FRAME_BYTES, 8 * 1024]) {
    const adapter = new LoopbackRuntimeAdapter({ client: { request: async () => ({}) }, doctorImpl: async () => catalog, capabilityCache, pluginInventory: null, frameBytes });
    const reply = await adapter.doctorStatus();
    const optional = { skillInventory: reply.skillInventory, pluginInventory: reply.pluginInventory, capabilityInventory: reply.capabilityInventory };
    assert.equal(bytes(optional) <= MAX_PUBLISH_BYTES, true);
    assert.equal(bytes(frame(reply)) <= frameBytes, true);
    assert.deepEqual(reply.labs, catalog.labs);
    assert.equal(reply.skillInventory.labs[0].count, 512);
    assert.equal(reply.pluginInventory.labs[0].count, 256);
    assert.equal(reply.skillInventory.labs[0].truncated, true);
    assert.equal(reply.pluginInventory.labs[0].truncated, true);
    assert.equal(JSON.stringify(catalog) === original, true);
  }
});


test("R4: insufficient metadata room explicitly marks inventories unavailable", async () => {
  const core = { labs: [{ instanceId: "codex", models: ["m".repeat(7500)] }] };
  const report = { ...core, skillInventory: { version: 1, labs: [skillInventoryRow("codex", { skills: [{ name: "review" }] })] }, pluginInventory: { version: 1, labs: [] } };
  const adapter = new LoopbackRuntimeAdapter({ client: { request: async () => ({}) }, doctorImpl: async () => report, pluginInventory: null, frameBytes: 8192 });
  const reply = await adapter.doctorStatus();
  assert.equal(reply.skillInventory, null);
  assert.equal(reply.pluginInventory, null);
  assert.deepEqual(reply.labs, core.labs);
  assert.equal(bytes(frame(reply)) <= 8192, true);
});
