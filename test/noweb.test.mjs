import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor, continueThread, originate } from "../src/bridge.mjs";
import { defaultModelForLab, labKind, ORIGINATE_LABS, resolveModelSelection } from "../src/model-selection.mjs";
import { LoopbackRuntimeAdapter, RemoteRpcShim } from "../src/outbound-pairer.mjs";
import { T3HttpError } from "../src/t3-client.mjs";
import { translateCommand } from "../src/t3-v2.mjs";
import { inspectInstanceWebTools } from "../src/web-tools.mjs";
import { captureWire } from "./helpers/fresh-context-wire.mjs";

const bases = ["codex", "opencode", "grok", "cursor", "deepseek"];
const unknown = { v: 1, state: "unknown", tools: [] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-noweb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = path.join(root, "synthetic.token");
  fs.writeFileSync(token, "synthetic-test-only", { mode: 0o600 });
  return { root, options: { fetchImpl: async () => { throw new Error("Synthetic health absent"); }, openrouterTokenFile: token, pairStateFile: path.join(root, "absent-pair") } };
}
function catalog(settings, providers) {
  return { snapshot: async () => ({ projects: [], threads: [] }), getSettings: async () => settings, rpc: async () => ({ providers }) };
}
function codexFixture(t, content = 'web_search = "disabled"\n') {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "config.toml"), content);
  f.instance = { driver: "codex", enabled: true, environment: [{ name: "T3CODE_CODEX_LAUNCH_ARGS", value: "", sensitive: false }], config: { homePath: f.root, launchArgs: "--config 'web_search=\"disabled\"'" } };
  return f;
}
const provider = (instanceId, status = "ready") => ({ instanceId, status, installed: true, models: [{ slug: defaultModelForLab(instanceId) || "synthetic-model", isDefault: true }] });

test("doctor adds all exact twin rows without borrowing a ready base provider", async (t) => {
  const f = fixture(t);
  const settings = { providerInstances: Object.fromEntries(bases.map(id => [id, { driver: id === "deepseek" ? "grok" : id, enabled: true }])) };
  const report = await doctor(catalog(settings, bases.map(id => provider(id))), f.options);
  for (const base of bases) {
    const twin = report.labs.find(row => row.instanceId === `${base}-noweb`);
    assert.ok(twin, base);
    assert.equal(twin.advertised, true);
    assert.equal(twin.enabled, false);
    assert.equal(twin.installed, false);
    assert.equal(twin.ready, false);
    assert.deepEqual(twin.webTools, unknown);
  }
  assert.ok(report.labs.every(row => row.webTools?.v === 1));
});

test("doctor derives Codex off/on/unknown from the exact home and launch controls", async (t) => {
  const f = codexFixture(t);
  const settings = { providerInstances: { "codex-noweb": f.instance } };
  const read = async () => (await doctor(catalog(settings, [provider("codex-noweb")]), f.options)).labs.find(row => row.instanceId === "codex-noweb");
  assert.deepEqual((await read()).webTools, { v: 1, state: "off", tools: ["web_search"] });
  f.instance.config.launchArgs = "--search";
  assert.deepEqual((await read()).webTools, { v: 1, state: "on", tools: ["web_search"] });
  f.instance.config.launchArgs = "--config 'web_search=\"disabled\"'";
  f.instance.environment[0].value = "--search";
  assert.deepEqual((await read()).webTools, { v: 1, state: "on", tools: ["web_search"] });
  f.instance.environment[0].value = "";
  f.instance.config.launchArgs = "--profile unverified";
  assert.deepEqual((await read()).webTools, unknown);
  f.instance.config.launchArgs = "--config 'web_search=\"disabled\"'";
  fs.writeFileSync(path.join(f.root, "config.toml"), 'web_search = "disabled"\nbroken = [');
  assert.deepEqual((await read()).webTools, unknown);
  fs.unlinkSync(path.join(f.root, "config.toml"));
  assert.deepEqual((await read()).webTools, unknown);
});

test("doctor refuses ambiguous duplicate provider joins including DeepSeek overrides", async (t) => {
  const f = codexFixture(t);
  for (const id of ["codex-noweb", "deepseek-noweb"]) {
    const instance = id === "codex-noweb" ? f.instance : { driver: "grok", enabled: true, config: {} };
    const row = (await doctor(catalog({ providerInstances: { [id]: instance } }, [provider(id), provider(id)]), f.options)).labs.find(row => row.instanceId === id);
    assert.equal(row.ready, false);
    assert.deepEqual(row.webTools, unknown);
  }
});

test("unsupported labs never claim off based on a twin name or claimed config", async (t) => {
  const f = fixture(t);
  for (const base of ["grok", "cursor", "deepseek"]) {
    for (const state of ["off", "on", "unknown"]) {
      const id = `${base}-noweb`;
      const instance = { driver: base === "deepseek" ? "grok" : base, enabled: false, config: { webTools: { v: 1, state }, tools: { web_search: false, webfetch: false }, homePath: f.root } };
      const row = (await doctor(catalog({ providerInstances: { [id]: instance } }, [provider(id)]), f.options)).labs.find(row => row.instanceId === id);
      assert.deepEqual(row.webTools, unknown);
      assert.equal(row.ready, false);
    }
  }
});

test("OpenCode configured deny is unknown when full-access session policy can override it", async (t) => {
  const f = fixture(t);
  for (const permission of ["deny", "allow", "invalid"]) {
    const filename = path.join(f.root, "opencode.json");
    fs.writeFileSync(filename, JSON.stringify({ permission: { webfetch: permission, websearch: permission }, tools: { webfetch: false, websearch: false } }));
    const instance = { driver: "opencode", enabled: false, environment: [{ name: "OPENCODE_CONFIG", value: filename, sensitive: false }], config: {} };
    const row = (await doctor(catalog({ providerInstances: { "opencode-noweb": instance } }, [provider("opencode-noweb")]), f.options)).labs.find(row => row.instanceId === "opencode-noweb");
    assert.deepEqual(row.webTools, unknown);
  }
});

test("OpenCode observes explicit inline enables and rejects missing/malformed/remote controls", () => {
  const instance = { driver: "opencode", config: {}, environment: [] };
  const read = () => inspectInstanceWebTools({ providerInstances: { "opencode-noweb": instance } }, "opencode-noweb");
  assert.deepEqual(read(), unknown);
  for (const value of ["{", "null", '{"tools":{"webfetch":false,"websearch":false},"permission":{"webfetch":"deny","websearch":"deny"}}']) {
    instance.environment = [{ name: "OPENCODE_CONFIG_CONTENT", value, sensitive: false }];
    assert.deepEqual(read(), unknown);
  }
  instance.environment[0].value = '{"tools":{"webfetch":true,"websearch":true},"permission":{"webfetch":"allow","websearch":"allow"}}';
  assert.deepEqual(read(), { v: 1, state: "on", tools: ["webfetch", "websearch"] });
  instance.config.serverUrl = "http://127.0.0.1:9000";
  assert.deepEqual(read(), unknown);
});

test("Codex refuses ambiguous config, launch overrides, files and driver identities", (t) => {
  const f = codexFixture(t);
  const configFile = path.join(f.root, "config.toml");
  const settings = { providerInstances: { "codex-noweb": f.instance } };
  const read = () => inspectInstanceWebTools(settings, "codex-noweb");
  for (const content of ["", 'web_search = "unrecognised"', 'web_search = "disabled"\nweb_search = "live"', '[profiles.other]\nweb_search = "disabled"', 'web_search = "disabled"\ninvalid = "\\/"', 'web_search = "disabled"\n[broken', "x".repeat(65537)]) {
    fs.writeFileSync(configFile, content);
    assert.deepEqual(read(), unknown);
  }
  fs.writeFileSync(configFile, 'web_search = "disabled"\n');
  const original = structuredClone(f.instance);
  for (const patch of [
    { environment: [] },
    { environment: [{ name: "T3CODE_CODEX_LAUNCH_ARGS", valueRedacted: true }] },
    { environment: [...original.environment, ...original.environment] },
    { config: { ...original.config, shadowHomePath: "/synthetic/other" } },
    { config: { ...original.config, setupMode: "managed" } },
    { config: { ...original.config, homePath: "relative" } },
    { config: { ...original.config, launchArgs: "--search --profile other" } },
    { driver: "grok" },
  ]) {
    settings.providerInstances["codex-noweb"] = { ...original, ...patch };
    assert.deepEqual(read(), unknown);
  }
  settings.providerInstances["codex-noweb"] = original;
  fs.renameSync(configFile, path.join(f.root, "real.toml"));
  fs.symlinkSync(path.join(f.root, "real.toml"), configFile);
  assert.deepEqual(read(), unknown);
});

test("twin doctor flags fail closed on disabled config and mismatched driver", async (t) => {
  const f = fixture(t);
  for (const base of bases) {
    const id = `${base}-noweb`;
    for (const instance of [{ driver: base === "deepseek" ? "grok" : base, enabled: true, config: { enabled: false } }, { driver: "wrong", enabled: true, config: {} }]) {
      const row = (await doctor(catalog({ providerInstances: { [id]: instance } }, [provider(id)]), f.options)).labs.find(row => row.instanceId === id);
      assert.equal(row.ready, false, id);
      assert.deepEqual(row.webTools, unknown);
    }
  }
});

test("DeepSeek twin receives the same credential readiness gate as the base", async (t) => {
  const f = fixture(t);
  const id = "deepseek-noweb";
  const client = catalog({ providerInstances: { [id]: { driver: "grok", enabled: true } } }, [provider(id, "error")]);
  let row = (await doctor(client, { ...f.options, openrouterTokenFile: path.join(f.root, "missing.token") })).labs.find(row => row.instanceId === id);
  assert.equal(row.ready, false);
  assert.equal(row.code, "adapter_auth_unavailable");
  row = (await doctor(client, f.options)).labs.find(row => row.instanceId === id);
  assert.equal(row.ready, true);
  assert.equal(row.code, null);
});

test("golden twin doctor row and doctor-status preserve webTools without fabricating capabilities", async (t) => {
  const f = codexFixture(t);
  const client = catalog({ providerInstances: { "codex-noweb": f.instance } }, [provider("codex-noweb")]);
  const runDoctor = () => doctor(client, f.options);
  const report = await runDoctor();
  assert.deepEqual(report, JSON.parse(fs.readFileSync(new URL("./fixtures/noweb-doctor.json", import.meta.url), "utf8")));
  const row = report.labs.find(row => row.instanceId === "codex-noweb");
  assert.deepEqual(row, {
    instanceId: "codex-noweb", name: "Codex CLI (noweb)", advertised: true, kind: "native", enabled: true, installed: true, ready: true, status: "ready", code: null,
    modelCount: 1, models: ["gpt-5.6-luna"], modelsTruncated: false, defaultModel: "gpt-5.6-luna", defaultAvailable: true, webTools: { v: 1, state: "off", tools: ["web_search"] },
    runtime: { id: "codex-cli", label: "Codex CLI", integration: "t3-native", driver: "codex", transport: "app-server", binarySource: "standalone-cli", configuredBinarySource: "standalone-cli" },
  });
  const shim = new RemoteRpcShim(new LoopbackRuntimeAdapter({ client, doctorImpl: runDoctor }));
  const reply = await shim.handle({ version: 1, type: "rpc.request", id: "doctor", method: "doctor-status", params: {} });
  assert.deepEqual(reply.result.labs.find(row => row.instanceId === "codex-noweb").webTools, row.webTools);
  assert.equal(Object.hasOwn(reply.result.capabilities, "jackMcpProviders"), false);
  assert.equal(JSON.stringify(row).includes(f.root), false);
});

test("twins inherit model semantics and effort without replacing the selected instance", () => {
  for (const base of bases) {
    const id = `${base}-noweb`;
    assert.ok(ORIGINATE_LABS.includes(id));
    assert.equal(labKind(id), labKind(base));
    assert.equal(defaultModelForLab(id), defaultModelForLab(base));
    assert.deepEqual(resolveModelSelection({ instanceId: id, model: "synthetic-model" }), { ...resolveModelSelection({ instanceId: base, model: "synthetic-model" }), instanceId: id });
  }
});

test("real legacy/V2 client transports and result receipts retain all twin selections", async () => {
  for (const protocol of [1, 2]) {
    for (const base of bases) {
      const instanceId = `${base}-noweb`;
      const captured = await captureWire(protocol, { instanceId });
      const turns = captured.wire.map(entry => entry.body || entry.payload).filter(value => ["thread.turn.start", "message.dispatch"].includes(value?.type));
      assert.equal(turns.length, 2);
      assert.ok(turns.every(turn => turn.modelSelection.instanceId === instanceId));
      assert.equal(captured.receipt.instanceId, instanceId);
      assert.equal(Object.hasOwn(captured.doctor.capabilities, "jackMcpProviders"), false);
    }
  }
});

test("originate, continue, legacy/V2 commands and exact turn-result keep every twin id", async (t) => {
  const f = fixture(t);
  for (const base of bases) {
    const id = `${base}-noweb`, commands = [], projects = [], threads = new Map();
    const client = { shell: async () => ({ projects }),
      thread: async (threadId) => {
        if (!threads.has(threadId)) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
        return { thread: threads.get(threadId) };
      },
      dispatch: async (cmd) => {
        commands.push(cmd);
        if (cmd.type === "project.create") projects.push({ id: cmd.projectId, workspaceRoot: cmd.workspaceRoot });
        if (cmd.type === "thread.create") threads.set(cmd.threadId, { id: cmd.threadId, projectId: cmd.projectId, modelSelection: cmd.modelSelection, messages: [] });
        if (cmd.type === "thread.turn.start") threads.get(cmd.threadId).messages.push({ id: cmd.message.messageId, text: cmd.message.text });
        return { sequence: commands.length };
      } };
    const selection = { instanceId: id, model: "synthetic-model", runtimeMode: "full-access" };
    const first = await originate(client, { ...selection, workspace: f.root, title: "Synthetic Bot", message: "first", stateFile: path.join(f.root, `${id}.json`) });
    const second = await continueThread(client, { ...selection, threadId: first.threadId, message: "second" });
    const turns = commands.filter(cmd => cmd.type === "thread.turn.start");
    for (const turn of turns) {
      assert.equal(turn.modelSelection.instanceId, id);
      assert.equal((await translateCommand(turn)).at(-1).payload.modelSelection.instanceId, id);
    }
    client.request = async () => ({ ...second, turnId: "turn", assistantMessageId: "assistant", instanceId: id, model: selection.model, effort: null, state: "succeeded", outputText: "Synthetic reply" });
    const { threadId, messageId, turnCommandId } = second;
    const result = await new LoopbackRuntimeAdapter({ client }).turnResult({ threadId, messageId, turnCommandId });
    assert.equal(result.instanceId, id);
  }
});
