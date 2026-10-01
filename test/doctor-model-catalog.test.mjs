import assert from "node:assert/strict";
import test from "node:test";
import { doctor } from "../src/bridge.mjs";
import { parseArgs } from "../src/cli.mjs";
import { LoopbackRuntimeAdapter, RemoteRpcShim } from "../src/outbound-pairer.mjs";

function catalogClient(models) {
  return {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: { codex: { driver: "codex", enabled: true } } }),
    rpc: async () => ({ providers: [{ instanceId: "codex", status: "ready", installed: true, models }] }),
  };
}
const fetchImpl = async () => { throw new Error("Synthetic Hermes is absent"); };

test("full doctor returns every live model while default doctor keeps its bounded shape", async () => {
  const models = Array.from({ length: 177 }, (_, index) => ({ slug: `model-${index}`, name: `Model ${index}` }));
  models.push({ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isDefault: true });
  const client = catalogClient(models);
  const summary = (await doctor(client, { fetchImpl })).labs.find((lab) => lab.instanceId === "codex");
  assert.equal(summary.modelCount, 178);
  assert.equal(summary.models.length, 16);
  assert.equal(summary.modelsTruncated, true);
  assert.equal(Object.hasOwn(summary, "modelCatalog"), false);
  assert.equal(summary.defaultModel, "gpt-6.1-sol");
  assert.equal(summary.models.includes("gpt-6.1-sol"), true);
  assert.equal(summary.ready, true);

  const full = (await doctor(client, { fetchImpl, models: "full" })).labs.find((lab) => lab.instanceId === "codex");
  assert.equal(full.models.length, 178);
  assert.equal(full.modelsTruncated, false);
  assert.deepEqual(full.modelCatalog.at(-1), { id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", options: [] });
  assert.deepEqual(full.modelCatalog.map((model) => model.id), full.models);
});

test("model catalog preserves thinking and speed selectors with a closed metadata projection", async () => {
  const capabilities = { optionDescriptors: [
    { id: "reasoningEffort", label: "Thinking", type: "select", currentValue: "high", description: "PRIVATE", promptInjectedValues: ["PRIVATE"], options: [
      { id: "low", label: "Low", description: "PRIVATE" },
      { id: "high", label: "High", isDefault: true, token: "PRIVATE" },
      { id: "high", label: "Duplicate" },
      { id: "bad\nchoice", label: "Malformed" },
    ] },
    { id: "serviceTier", label: "Speed", type: "select", currentValue: "missing", options: [{ id: "fast", label: "Fast" }] },
    { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: true, credential: "PRIVATE" },
    { id: "secret", label: "Private", type: "unknown", currentValue: "PRIVATE" },
    { id: "bad\noption", label: "Bad", type: "boolean" },
  ], diagnostic: "PRIVATE" };
  const models = [
    { slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isDefault: true, capabilities, bearer: "PRIVATE" },
    { slug: "gpt-6.1-sol", name: "Duplicate" },
    { slug: "bad\nmodel", name: "Bad" },
    "legacy-model",
  ];
  const full = (await doctor(catalogClient(models), { fetchImpl, models: "full" })).labs.find((lab) => lab.instanceId === "codex");
  assert.deepEqual(full.modelCatalog, [
    { id: "gpt-6.1-sol", displayName: "GPT 6.1 Sol", options: [
      { id: "reasoningEffort", label: "Thinking", type: "select", currentValue: "high", options: [
        { id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true },
      ] },
      { id: "serviceTier", label: "Speed", type: "select", options: [{ id: "fast", label: "Fast" }] },
      { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: true },
    ] },
    { id: "legacy-model", displayName: "legacy-model", options: [] },
  ]);
  assert.equal(JSON.stringify(full).includes("PRIVATE"), false);
});

test("doctor models flag rejects invalid modes before reading the runtime", async () => {
  assert.deepEqual(parseArgs(["doctor", "--json", "--models", "full"]).options, { _: [], json: true, models: "full" });
  await assert.rejects(doctor({}, { models: "all" }), /summary or full/);
});

test("doctor-status refreshes full models on every completed request and rejects remote controls", async () => {
  let generation = 0;
  const adapter = new LoopbackRuntimeAdapter({
    client: {},
    doctorImpl: async (_client, options) => {
      assert.equal(options.models, "full");
      generation += 1;
      return { labs: [{ instanceId: "codex", models: [`model-${generation}`] }] };
    },
  });
  const shim = new RemoteRpcShim(adapter);
  const first = await shim.handle({ version: 1, type: "rpc.request", id: "first", method: "doctor-status", params: {} });
  const second = await shim.handle({ version: 1, type: "rpc.request", id: "second", method: "doctor-status", params: {} });
  assert.deepEqual(first.result.labs[0].models, ["model-1"]);
  assert.deepEqual(second.result.labs[0].models, ["model-2"]);
  assert.equal(second.id, "second");
  const invalid = await shim.handle({ version: 1, type: "rpc.request", id: "invalid", method: "doctor-status", params: { models: "summary", tokenFile: "PRIVATE" } });
  assert.equal(invalid.type, "rpc.error");
  assert.equal(generation, 2);
});

test("heartbeat refresh coalesces concurrent doctor probes and retries after failure", async () => {
  let finish;
  let calls = 0;
  const adapter = new LoopbackRuntimeAdapter({ client: {}, doctorImpl: () => {
    calls += 1;
    return new Promise((resolve, reject) => { finish = { resolve, reject }; });
  } });
  const heartbeat = adapter.refreshModels();
  const picker = adapter.refreshModels();
  assert.equal(heartbeat, picker);
  await Promise.resolve();
  finish.reject(new Error("Private upstream diagnostics"));
  await assert.rejects(heartbeat);
  const next = adapter.refreshModels();
  await Promise.resolve();
  finish.resolve({ labs: [] });
  assert.deepEqual(await next, { labs: [] });
  assert.equal(calls, 2);
});
