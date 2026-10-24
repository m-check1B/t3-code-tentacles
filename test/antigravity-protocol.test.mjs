import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor } from "../src/bridge.mjs";
import { T3Client } from "../src/t3-client.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { ANTIGRAVITY_SETUP_URL } from "../src/antigravity.mjs";

for (const protocol of [1, 2]) {
  test(`Antigravity doctor-status uses observed auth and models over protocol ${protocol}`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-antigravity-protocol-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let authStatus = "authenticated";
    const frames = [], sockets = [];
    class Socket extends EventTarget {
      constructor(url) {
        super(); sockets.push(this);
        assert.equal(new URL(url).searchParams.get("orchestrationProtocol"), protocol === 2 ? "2" : null);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(raw) {
        const frame = JSON.parse(raw); frames.push(frame.tag);
        const value = frame.tag === "server.getSettings"
          ? { providerInstances: { antigravity: { enabled: true, driver: "antigravity" } } }
          : frame.tag === "server.getConfig" ? { environment: { serverVersion: "0.1.0-jack.1" }, providers: [{
            instanceId: "antigravity", driver: "antigravity", installed: true, status: "ready",
            auth: { status: authStatus, account: "PRIVATE ACCOUNT" },
            models: [{ slug: "gemini-4-argon-high", isDefault: true }],
          }] } : { threads: [] };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value },
        }) })));
      }
      close() { this.closed = true; }
    }
    const client = new T3Client({
      baseUrl: "http://127.0.0.1:3773", token: "synthetic-antigravity-only", orchestrationProtocol: "auto", WebSocketImpl: Socket,
      fetchImpl: async (url, init) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/.well-known/t3/environment") return Response.json({ orchestrationProtocolVersion: protocol });
        if (pathname === "/api/auth/websocket-ticket") return Response.json({ ticket: "synthetic-ticket" });
        assert.equal(init.headers["x-t3-orchestration-protocol"], protocol === 2 ? "2" : undefined);
        if (pathname === "/api/orchestration/turn-result") return Response.json({ talkTurnResult: "v1" });
        return Response.json(protocol === 2 ? { schemaVersion: 2, snapshotSequence: 0, projects: [], threads: [] } : { projects: [], threads: [] });
      },
    });
    const adapter = new LoopbackRuntimeAdapter({ client, pairStateFile: path.join(directory, "pair.json"),
      doctorImpl: (c, options) => doctor(c, { ...options, openrouterTokenFile: path.join(directory, "absent-token"), fetchImpl: async () => new Response("{}", { status: 503 }) }),
    });
    for (const [auth, ready, signedIn, code] of [
      ["authenticated", true, true, null], ["unknown", false, null, "sign_in_unchecked"],
      ["unauthenticated", false, false, "not_signed_in"],
    ]) {
      authStatus = auth;
      const result = await adapter.doctorStatus();
      const row = result.labs.find((entry) => entry.instanceId === "antigravity");
      assert.deepEqual([row.ready, row.signedIn, row.code], [ready, signedIn, code]);
      assert.equal(row.defaultModel, "gemini-4-argon-high");
      assert.deepEqual(row.modelCatalog.map((model) => model.id), ["gemini-4-argon-high"]);
      assert.equal(row.setupUrl, ANTIGRAVITY_SETUP_URL);
      assert.equal(result.capabilities.turnInterrupt, "turn-interrupt-v1");
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE ACCOUNT/);
    }
    assert.ok(frames.every((tag) => ["server.getSettings", "server.getConfig", "orchestration.getArchivedShellSnapshot"].includes(tag)));
    assert.ok(sockets.every((socket) => socket.closed));
  });
}
