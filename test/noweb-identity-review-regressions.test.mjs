import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor } from "../src/bridge.mjs";
import { NOWEB_LAB_DRIVERS, defaultModelForLab } from "../src/model-selection.mjs";
import { LoopbackRuntimeAdapter, RemoteRpcShim } from "../src/outbound-pairer.mjs";
import { T3Client } from "../src/t3-client.mjs";

const unknown = { v: 1, state: "unknown", tools: [] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-noweb-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "config.toml"), 'web_search="disabled"\n');
  const instance = { driver: "codex", enabled: true, config: { homePath: root, launchArgs: '--config \'web_search="disabled"\'' }, environment: [{ name: "T3CODE_CODEX_LAUNCH_ARGS", value: "", sensitive: false }] };
  const observed = { instanceId: "codex-noweb", driver: "codex", installed: true, status: "ready", models: [{ slug: "gpt-5.6-luna", isDefault: true }] };
  const options = { hermesHome: path.join(root, "absent-hermes"), openrouterTokenFile: path.join(root, "absent-token"), pairStateFile: path.join(root, "absent-pair"), fetchImpl: async () => { throw new Error("Synthetic health absent"); } };
  const read = async (settings, providers) => (await doctor({ snapshot: async () => ({ projects: [], threads: [] }), getSettings: async () => settings, rpc: async () => ({ providers }) }, options)).labs.find(row => row.instanceId === "codex-noweb");
  return { root, instance, observed, options, read };
}

// Ported from B3 additional-regressions.test.mjs: settings must not mask the snapshot.
test("R7: contradictory observed driver is unready and unknown, never synthesized from settings", async (t) => {
  const f = fixture(t);
  const row = await f.read({ providerInstances: { "codex-noweb": f.instance } }, [{ ...f.observed, driver: "opencode" }]);
  assert.equal(row.ready, false);
  assert.deepEqual(row.webTools, unknown);
  assert.equal(row.runtime.driver, "opencode");
  assert.equal(typeof row.code, "string");
});

test("R7: missing settings/snapshot identity and driver disagreements refuse every twin", async (t) => {
  const f = fixture(t);
  for (const [id, driver] of Object.entries(NOWEB_LAB_DRIVERS)) {
    const good = { ...f.instance, driver };
    const observed = { ...f.observed, instanceId: id, driver, models: [{ slug: defaultModelForLab(id) || "synthetic-model", isDefault: true }] };
    const cases = [
      [{ providerInstances: { [id]: good } }, [{ ...observed, driver: "opencode" === driver ? "codex" : "opencode" }]],
      [{ providerInstances: { [id]: good } }, [{ ...observed, driver: undefined }]],
      [{ providerInstances: { [id]: good } }, [{ ...observed, driver: null }]],
      [{ providerInstances: { [id]: good } }, []],
      [{ providerInstances: { [id]: { ...good, driver: undefined } } }, [observed]],
      [{ providerInstances: { [id]: { ...good, driver: "foreign" } } }, [observed]],
      [{ providers: { [id]: good.config } }, [observed]],
      [{ providerInstances: { [id]: good } }, [observed, observed]],
    ];
    for (const [settings, providers] of cases) {
      const client = { snapshot: async () => ({ projects: [], threads: [] }), getSettings: async () => settings, rpc: async () => ({ providers }) };
      const row = (await doctor(client, f.options)).labs.find(row => row.instanceId === id);
      assert.equal(row.ready, false, id);
      assert.deepEqual(row.webTools, unknown, id);
      assert.equal(typeof row.code, "string", id);
    }
  }
});

test("Codex twin with an unsigned-in provider snapshot cannot borrow the ready base", async (t) => {
  const f = fixture(t);
  const settings = { providerInstances: { codex: { driver: "codex", enabled: true }, "codex-noweb": f.instance } };
  for (const status of ["error", "unavailable"]) {
    const row = await f.read(settings, [{ ...f.observed, instanceId: "codex" }, { ...f.observed, status, auth: { status: "unauthenticated" } }]);
    assert.equal(row.ready, false);
    assert.ok(row.code);
  }
});

for (const protocol of [1, 2]) {
  test(`R7: doctor-status binds settings and observed driver through protocol ${protocol}`, async (t) => {
    const f = fixture(t);
    const paths = [], tags = [], sockets = [];
    let driver = "opencode";
    class Socket extends EventTarget {
      constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(raw) {
        const frame = JSON.parse(raw);
        tags.push(frame.tag);
        const value = frame.tag === "server.getConfig" ? { providers: [{ ...f.observed, driver }] }
          : frame.tag === "server.getSettings" ? { providerInstances: { "codex-noweb": f.instance } } : { threads: [] };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }) })));
      }
      close() { this.closed = true; }
    }
    const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic-identity-only", orchestrationProtocol: "auto", WebSocketImpl: Socket,
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        paths.push(pathname);
        if (pathname === "/.well-known/t3/environment") return Response.json({ orchestrationProtocolVersion: protocol });
        if (pathname === "/api/auth/websocket-ticket") return Response.json({ ticket: "synthetic-ticket" });
        if (pathname === "/api/orchestration/turn-result") return Response.json({ talkTurnResult: "v1" });
        return Response.json(protocol === 2 ? { schemaVersion: 2, snapshotSequence: 0, projects: [], threads: [] } : { projects: [], threads: [] });
      } });
    const shim = new RemoteRpcShim(new LoopbackRuntimeAdapter({ client, pairStateFile: f.options.pairStateFile, doctorImpl: (c, options) => doctor(c, { ...options, ...f.options }) }));
    for (const observedDriver of ["opencode", undefined, "codex"]) {
      driver = observedDriver;
      const reply = await shim.handle({ version: 1, type: "rpc.request", id: "synthetic-doctor", method: "doctor-status", params: {} });
      assert.equal(reply.type, "rpc.result");
      const row = reply.result.labs.find(row => row.instanceId === "codex-noweb");
      assert.equal(row.ready, driver === "codex");
      assert.deepEqual(row.webTools, driver === "codex" ? { v: 1, state: "off", tools: ["web_search"] } : unknown);
      assert.equal(row.runtime.driver, driver ?? null);
      assert.equal(Object.hasOwn(reply.result.capabilities, "jackMcpProviders"), false);
    }
    assert.ok(paths.includes(protocol === 2 ? "/api/orchestration/shell" : "/api/orchestration/snapshot"));
    assert.ok(tags.includes("server.getConfig"));
    assert.ok(tags.includes("server.getSettings"));
    assert.ok(sockets.every(socket => socket.closed));
  });
}
