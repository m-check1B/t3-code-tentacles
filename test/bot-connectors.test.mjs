import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { BOT_CONNECTOR_CAPABILITIES, GROK_TRUST_MARKER, PUBLIC_MCP_URL, codexHomeFor, commitCodexTrust, grokHomeFor, planGrokTrust, planGrokUntrust, trustCodexWorkspace } from "../src/bot-connectors.mjs";
import { continueThread, doctor } from "../src/bridge.mjs";
import { freshCapability } from "./helpers/fresh-context-wire.mjs";
import { ensureLocalTalkWorkspace } from "../src/local-talk-workspace.mjs";
import { LoopbackRuntimeAdapter, OutboundPairer, readPairOffer } from "../src/outbound-pairer.mjs";

const ORIGIN = "https://jack.example";
const scope = { businessId: "11111111-1111-4111-8111-111111111111", seatId: "22222222-2222-4222-8222-222222222222", agentId: "33333333-3333-4333-8333-333333333333" };
const bearer = [{ name: "Authorization", value: "Bearer synthetic-turn-token" }];
const learn = { name: "microsoft-learn", type: "http", url: PUBLIC_MCP_URL, headers: [] };
const linear = { name: "linear", type: "http", url: `${ORIGIN}/mcp/connectors/linear`, headers: bearer };
const jack = { name: "jack", type: "http", url: `${ORIGIN}/mcp`, headers: bearer };
const connectors = (servers, extra = {}) => ({ mcpServers: servers, mcpScope: scope, mcpExpiresAt: Date.now() + 60_000, ...extra });
const claude = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const codex = { instanceId: "codex", model: "gpt-6-astra" };
const opencode = { instanceId: "opencode", model: "opencode-go/glm-5.3-flash" };
const grok = { instanceId: "grok", model: "grok-4.7" };
const cursor = { instanceId: "cursor", model: "composer-2.5" };
const antigravity = { instanceId: "antigravity", model: "gemini-4-argon" };
// Jack's paired_mcp_workspace for this scope.
const seatDigest = (value = scope) => createHash("sha256").update(`${value.businessId}:${value.seatId}`).digest("hex");

function setup({ jackOrigin = ORIGIN, running = () => false } = {}) {
  const settings = {};
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bot-connectors-")));
  fs.chmodSync(home, 0o700);
  const workspace = path.join(home, ".jack-local-scratch", "seats", seatDigest(), "agents", scope.agentId);
  const sent = [];
  const stops = [];
  const at = { workspace: null }; // the thread's folder as T3 reports it on continue
  const adapter = new LoopbackRuntimeAdapter({
    client: { getSettings: async () => settings },
    prepareTalkWorkspaceImpl: value => ensureLocalTalkWorkspace(value, { home }),
    originateImpl: (_client, params) => { sent.push(params); return { ok: true }; },
    // The same hook contract continueThread uses: stop first, then the hook writes.
    continueImpl: async (_client, params, { prepareTalkWorkspace }) => {
      await prepareTalkWorkspace(at.workspace ?? workspace, { restartIdleSession: async () => {
        if (running()) throw new Error("This Talk is still answering.");
        stops.push(params.threadId);
      } });
      sent.push(params);
      return { ok: true };
    },
  });
  adapter.jackOrigin = jackOrigin; // what the pairer pins from the owner's pair offer
  const read = file => JSON.parse(fs.readFileSync(path.join(workspace, file), "utf8"));
  // T3's Codex homePath, as the owner's Settings would hold it.
  settings.providerInstances = { codex: { config: { homePath: path.join(home, ".codex") } } };
  return { home, workspace, sent, stops, adapter, read, at };
}

test("a Bot's connectors are written into its own workspace and never reach T3", async () => {
  const { workspace, sent, stops, adapter, read } = setup();
  await adapter.originate({ workspace, message: "hi", ...claude, ...connectors([learn]) });
  assert.deepEqual(read(".mcp.json"), { mcpServers: { "microsoft-learn": { type: "http", url: PUBLIC_MCP_URL } } });
  const settings = read(path.join(".claude", "settings.local.json"));
  assert.equal(settings.enableAllProjectMcpServers, true);
  assert.equal(settings.autoMemoryEnabled, false); // the instruction guard survives
  assert.equal(fs.statSync(path.join(workspace, ".mcp.json")).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(sent[0]).filter(key => key.startsWith("mcp")), []);

  // The next turn's list is the truth: an empty list takes the tools away, and
  // the live session that still holds the old list is stopped first.
  await adapter.continue({ threadId: "t1", message: "again", ...claude, ...connectors([]) });
  assert.deepEqual(read(".mcp.json"), { mcpServers: {} });
  assert.equal(read(path.join(".claude", "settings.local.json")).enableAllProjectMcpServers, false);
  assert.deepEqual(Object.keys(sent[1]).filter(key => key.startsWith("mcp")), []);
  assert.deepEqual(stops, ["t1"]);
  await adapter.continue({ threadId: "t1", message: "again", ...claude, ...connectors([]) });
  assert.deepEqual(stops, ["t1"]); // empty after empty changes nothing
});

test("a signed-in connector reaches the lab as Jack's proxy with the turn token, in a private file", async () => {
  const { workspace, sent, adapter, read } = setup();
  const reply = await adapter.originate({ workspace, message: "hi", ...claude, ...connectors([learn, linear, jack]) });
  assert.deepEqual(read(".mcp.json").mcpServers.linear, { type: "http", url: linear.url, headers: { Authorization: "Bearer synthetic-turn-token" } });
  assert.deepEqual(read(".mcp.json").mcpServers.jack, { type: "http", url: jack.url, headers: { Authorization: "Bearer synthetic-turn-token" } });
  assert.equal(fs.statSync(path.join(workspace, ".mcp.json")).mode & 0o777, 0o600);
  // The token is in that one file only: not in the reply, not in what T3 gets.
  assert.equal(JSON.stringify([reply, sent]).includes("synthetic-turn-token"), false);
  await adapter.continue({ threadId: "t1", message: "again", ...claude, ...connectors([]) });
  assert.equal(fs.readFileSync(path.join(workspace, ".mcp.json"), "utf8").includes("synthetic-turn-token"), false);
  // No temporary file with the token is ever left next to it.
  assert.deepEqual(fs.readdirSync(workspace).filter(name => name.endsWith(".tmp")), []);
});

test("B3 P3-1 on #109: a token with OpenCode substitution braces refuses before the stop, on every lab", async (t) => {
  tryLab(t, "opencode");
  for (const lab of [claude, codex, opencode]) {
    for (const value of ["Bearer {env:OPENCODE_PASSWORD}", "Bearer X{file:~/.ssh/id_ed25519}Y", "Bearer a:b"]) {
      const { workspace, sent, stops, adapter } = setup();
      const turn = { threadId: "t1", message: "again", ...lab, ...connectors([{ ...linear, headers: [{ name: "Authorization", value }] }]) };
      await assert.rejects(async () => adapter.continue(turn), /not an admitted list/, `${lab.instanceId} ${value}`);
      assert.deepEqual(stops, []);
      assert.deepEqual(sent, []);
      assert.equal(fs.existsSync(workspace), false);
    }
  }
  // Jack's real token shape (secrets.token_urlsafe(32)) and padded token68 still pass.
  for (const token of [randomBytes(32).toString("base64url"), "abc+/=="]) {
    const { workspace, adapter, read } = setup();
    await adapter.originate({ workspace, message: "hi", ...opencode, ...connectors([{ ...linear, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }]) });
    assert.equal(read("opencode.json").mcp.linear.headers.Authorization, `Bearer ${token}`);
  }
});

test("a turn without connector fields leaves the workspace as it is", async () => {
  const { workspace, stops, adapter } = setup();
  await adapter.originate({ workspace, message: "hi", ...codex });
  assert.equal(fs.existsSync(path.join(workspace, ".mcp.json")), false);
  assert.equal(fs.existsSync(path.join(workspace, ".codex")), false);
  await adapter.continue({ threadId: "t1", message: "again", ...codex });
  assert.equal(fs.existsSync(path.join(workspace, ".mcp.json")), false);
  assert.deepEqual(stops, []);
});

test("anything Jack's gate would not admit is refused before the workspace or T3 is touched", async () => {
  const { home, workspace, sent, adapter } = setup();
  const base = { workspace, message: "hi", ...claude };
  for (const [bad, pattern] of [
    [connectors([{ ...learn, url: "https://example.com/mcp" }]), /not an admitted list/],
    [connectors([{ ...learn, headers: bearer }]), /not an admitted list/],
    [connectors([learn, { ...learn }]), /not an admitted list/],
    [connectors([{ ...linear, headers: [] }]), /not an admitted list/],
    [connectors([{ ...linear, headers: [{ name: "Cookie", value: "Bearer x" }] }]), /not an admitted list/],
    [connectors([{ ...linear, headers: [{ name: "Authorization", value: "Bearer a b" }] }]), /not an admitted list/],
    [connectors([{ ...linear, url: "http://jack.example/mcp/connectors/linear" }]), /not an admitted list/],
    [connectors([{ ...linear, url: `${ORIGIN}/mcp/connectors/clickup` }]), /not an admitted list/],
    [connectors([{ ...linear, url: "https://user@jack.example/mcp/connectors/linear" }]), /not an admitted list/],
    [connectors([{ ...linear, url: `${ORIGIN}/mcp/connectors/linear?x=1` }]), /not an admitted list/],
    [connectors([learn], { mcpScope: { ...scope, agentId: "nope" } }), /exact ownership/],
    [connectors([learn], { mcpExpiresAt: Date.now() - 1 }), /expired/],
    [connectors([learn], { mcpExpiresAt: Date.now() + 600_000 }), /expired/],
    [connectors([learn], { instanceId: "antigravity" }), /This lab cannot use Jack tools on Local yet; run this Bot on Server to use them$/],
    [connectors([learn], { instanceId: undefined }), /cannot use Jack tools on Local yet/],
    [connectors([{ ...jack, headers: [] }]), /not an admitted list/],
    [connectors([{ ...jack, name: "jack2" }]), /not an admitted list/],
    [connectors([{ ...jack, url: `${ORIGIN}/mcp/` }]), /not an admitted list/],
    [connectors([{ ...learn, name: "jack" }]), /not an admitted list/],
    [connectors([jack, { ...linear, url: "https://other.example/mcp/connectors/linear" }]), /not an admitted list/],
    [{ mcpScope: scope }, /requires mcpServers/],
  ]) assert.throws(() => adapter.originate({ ...base, ...bad }), pattern);
  // An operator seat's folder is not a Bot workspace.
  await assert.rejects(() => adapter.originate({ ...base, workspace: home, ...connectors([learn]) }), /this Bot's own workspace/);
  assert.equal(fs.existsSync(path.join(home, ".mcp.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".jack-local-scratch")), false);
  assert.equal(sent.length, 0);
});

test("B3 P1-1: Jack-hosted entries go only to the Jack origin pinned at pairing", async () => {
  // A host the computer is not paired with, even in the exact proxy or self shape.
  for (const url of ["https://evil.example/mcp", "https://jack.example:8443/mcp", "https://10.0.0.1/mcp"]) {
    const { workspace, sent, adapter } = setup();
    assert.throws(() => adapter.originate({ workspace, message: "hi", ...claude, ...connectors([{ ...jack, url }]) }), /not paired with/);
    assert.throws(() => adapter.continue({ threadId: "t1", message: "hi", ...claude, ...connectors([{ ...linear, url: `${url}/connectors/linear` }]) }), /not paired with/);
    assert.equal(fs.existsSync(workspace), false);
    assert.equal(sent.length, 0);
  }
  // Paired by an Agent Jack that named no origin: Jack entries fail closed with the fix; the public docs server still works.
  const { workspace, adapter, read } = setup({ jackOrigin: null });
  assert.throws(() => adapter.originate({ workspace, message: "hi", ...claude, ...connectors([jack]) }), /paired again from an updated Agent Jack/);
  await adapter.originate({ workspace, message: "hi", ...claude, ...connectors([learn]) });
  assert.deepEqual(Object.keys(read(".mcp.json").mcpServers), ["microsoft-learn"]);
});

test("B3 P1-1: the pair offer carries the pinned origin, canonical https only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-offer-"));
  const offer = (extra) => {
    const file = path.join(dir, `offer-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, endpoint: "wss://sphere.example/api/v1/jack/pairs/relay", pairToken: "p".repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra }), { mode: 0o600 });
    return readPairOffer(file);
  };
  assert.equal(offer({ jackOrigin: ORIGIN }).jackOrigin, ORIGIN);
  assert.equal(offer({}).jackOrigin, null);
  for (const bad of ["http://jack.example", `${ORIGIN}/`, `${ORIGIN}/mcp`, "https://user@jack.example", 7]) {
    assert.throws(() => offer({ jackOrigin: bad }), /jackOrigin/);
  }
});

test("B3 P2-1: a list lands only in the folder Jack derives from its own scope", async () => {
  const { home, sent, adapter, at } = setup();
  const otherBot = path.join(home, ".jack-local-scratch", "seats", seatDigest(), "agents", "44444444-4444-4444-8444-444444444444");
  const otherSeat = path.join(home, ".jack-local-scratch", "seats", "b".repeat(64), "agents", scope.agentId);
  for (const workspace of [otherBot, otherSeat]) {
    await assert.rejects(() => adapter.originate({ workspace, message: "hi", ...claude, ...connectors([learn]) }), /this Bot's own workspace/);
    at.workspace = workspace;
    await assert.rejects(() => adapter.continue({ threadId: "t1", message: "hi", ...claude, ...connectors([learn]) }), /this Bot's own workspace/);
    assert.equal(fs.existsSync(workspace), false);
  }
  assert.equal(sent.length, 0);
});

test("B3 P2-2: a refused clear changes no file, and its retry still stops the stale session", async () => {
  let running = true;
  const { workspace, stops, sent, adapter, read } = setup({ running: () => running });
  await adapter.originate({ workspace, message: "hi", ...claude, ...connectors([learn]) });
  // The Talk is still answering: the clear is refused before any file changes.
  await assert.rejects(() => adapter.continue({ threadId: "t1", message: "clear", ...claude, ...connectors([]) }), /still answering/);
  assert.deepEqual(Object.keys(read(".mcp.json").mcpServers), ["microsoft-learn"]);
  assert.equal(read(path.join(".claude", "settings.local.json")).enableAllProjectMcpServers, true);
  // Once idle, the retry stops the session that loaded the old list, then clears.
  running = false;
  await adapter.continue({ threadId: "t1", message: "clear", ...claude, ...connectors([]) });
  assert.deepEqual(stops, ["t1"]);
  assert.deepEqual(read(".mcp.json"), { mcpServers: {} });
  assert.equal(sent.length, 2);
});

test("doctor-status advertises exactly what Jack's gate reads, only with Local Talk support", async () => {
  const report = capabilities => {
    const adapter = new LoopbackRuntimeAdapter({ client: {}, doctorImpl: async () => ({ capabilities }) });
    adapter.jackOrigin = ORIGIN; // paired by an Agent Jack that pinned its origin
    return adapter.doctorStatus();
  };
  const { capabilities } = await report({ talkTurnResult: "v1", turnInterrupt: null });
  assert.deepEqual({ ...capabilities, jackMcpProviders: [...capabilities.jackMcpProviders], jackMcpPublicUrls: [...capabilities.jackMcpPublicUrls] },
    { talkTurnResult: "v1", turnInterrupt: null, jackMcpConfig: "v1", jackMcpProviders: ["claudeAgent", "codex"], jackMcpHeaders: false, jackMcpPublicUrls: [PUBLIC_MCP_URL], jackMcpProxy: "v1", jackMcpSelf: "v1" });
  assert.equal(JSON.parse(JSON.stringify(capabilities)).jackMcpConfig, BOT_CONNECTOR_CAPABILITIES.jackMcpConfig);
  assert.deepEqual((await report({ talkTurnResult: null, turnInterrupt: null })).capabilities, { talkTurnResult: null, turnInterrupt: null });
});

test("B3 P3-2 on #109: opencode is advertised only when T3 reports OpenCode 2 or newer", async (t) => {
  tryLab(t, "opencode");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-connectors-doctor-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const providersFor = async version => {
    const provider = { instanceId: "opencode", driver: "opencode", status: "ready", installed: true, enabled: true, version, models: [{ slug: opencode.model }] };
    const client = {
      snapshot: async () => ({ projects: [], threads: [] }),
      getSettings: async () => ({ providerInstances: {} }),
      rpc: async () => ({ environment: { serverVersion: "0.1.11" }, providers: [provider] }),
      refreshProvider: async () => {},
      request: async () => ({ talkTurnResult: "v1" }),
    };
    const report = await doctor(client, {
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      pairStateFile: path.join(directory, "pair.json"),
      openrouterTokenFile: path.join(directory, "none"),
      hermesHome: directory,
      refreshDirectory: path.join(directory, "refresh"),
    });
    const adapter = new LoopbackRuntimeAdapter({ client, doctorImpl: async () => report });
    adapter.jackOrigin = ORIGIN;
    const { capabilities } = await adapter.doctorStatus();
    assert.equal(Object.hasOwn(report.labs.find(lab => lab.instanceId === "opencode"), "version"), false); // kept off the wire
    return [...capabilities.jackMcpProviders];
  };
  for (const version of ["2.3.0", "2.0.0", "10.1.0"]) assert.deepEqual(await providersFor(version), ["claudeAgent", "codex", "opencode"], version);
  for (const version of ["1.14.2", "0.9.0", null, "garbage"]) assert.deepEqual(await providersFor(version), ["claudeAgent", "codex"], String(version));
});

test("Jack's own tools and a connector reach Local Codex through a trusted per-folder config", async () => {
  const { home, workspace, sent, stops, adapter } = setup();
  const reply = await adapter.originate({ workspace, message: "weather?", ...codex, ...connectors([jack, linear, learn]) });
  const toml = fs.readFileSync(path.join(workspace, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.jack\]\nurl = "https:\/\/jack\.example\/mcp"\nhttp_headers = \{ "Authorization" = "Bearer synthetic-turn-token" \}/);
  assert.match(toml, /\[mcp_servers\.microsoft-learn\]\nurl = "https:\/\/learn\.microsoft\.com\/api\/mcp"\n/);
  assert.equal(fs.statSync(path.join(workspace, ".codex", "config.toml")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(workspace, ".mcp.json")).mode & 0o777, 0o600);
  // T3's Codex home now trusts exactly this workspace, once.
  const trust = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.equal(trust.split(`[projects.${JSON.stringify(workspace)}]`).length, 2);
  assert.equal(trust.includes("synthetic-turn-token"), false);
  await adapter.continue({ threadId: "t1", message: "again", ...codex, ...connectors([jack]) });
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), trust);
  assert.deepEqual(stops, ["t1"]);
  assert.equal(JSON.stringify([reply, sent]).includes("synthetic-turn-token"), false);
  await adapter.continue({ threadId: "t1", message: "again", ...codex, ...connectors([]) });
  assert.equal(fs.readFileSync(path.join(workspace, ".codex", "config.toml"), "utf8").includes("mcp_servers"), false);
});

test("the Codex trust entry respects the owner's file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const file = path.join(home, "config.toml");
  // B3 P3-2: an existing empty file is a normal file, not a refusal.
  fs.writeFileSync(file, "", { mode: 0o640 });
  assert.equal(trustCodexWorkspace(home, "/u"), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640); // the owner's mode stays
  fs.writeFileSync(file, 'model = "x"\n[projects."/w"]\ntrust_level = "untrusted"\n');
  assert.equal(trustCodexWorkspace(home, "/w"), false); // the owner's own table stays
  assert.equal(trustCodexWorkspace(home, "/v"), true);
  assert.match(fs.readFileSync(file, "utf8"), /^model = "x"\n\[projects\."\/w"\]\ntrust_level = "untrusted"\n\n# Agent Jack.*\n\[projects\."\/v"\]\ntrust_level = "trusted"\n$/);
  assert.deepEqual(fs.readdirSync(home).filter(name => name.endsWith(".tmp")), []);
  // B3 P3-3: a dotted-key entry for the same folder is the owner's, other dotted or inline projects refuse.
  fs.writeFileSync(file, 'projects."/w".trust_level = "trusted"\n');
  assert.equal(trustCodexWorkspace(home, "/w"), false);
  assert.throws(() => trustCodexWorkspace(home, "/v"), /projects in a form/);
  fs.writeFileSync(file, 'projects = { "/w" = { trust_level = "trusted" } }\n');
  assert.throws(() => trustCodexWorkspace(home, "/v"), /projects in a form/);
  assert.equal(fs.readFileSync(file, "utf8"), 'projects = { "/w" = { trust_level = "trusted" } }\n');
  // A dotfiles symlink keeps pointing at the owner's real file.
  const real = path.join(home, "real.toml");
  fs.rmSync(file);
  fs.writeFileSync(real, 'model = "y"\n');
  fs.symlinkSync(real, file);
  assert.equal(trustCodexWorkspace(home, "/v"), true);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.match(fs.readFileSync(real, "utf8"), /\[projects\."\/v"\]/);
  assert.equal(await codexHomeFor({ getSettings: async () => ({ providerInstances: { codex: { config: { homePath: "~/alt" } } } }) }, { home: "/h" }), "/h/alt");
  assert.equal(await codexHomeFor({ getSettings: async () => { throw new Error("no"); } }, { home: "/h" }), "/h/.codex");
});

test("continue restarts an idle live session before a turn with tools, never a running one", async () => {
  const threadId = "11111111-2222-4333-8444-555555555555";
  const fake = (status) => {
    const state = { status, commands: [], messages: [] };
    state.client = {
      async request() { return freshCapability; },
      async thread() {
        return { thread: { id: threadId, projectId: "p", worktreePath: "/ws", messages: state.messages, modelSelection: { instanceId: "codex", model: "gpt-5.5" },
          session: state.status === null ? null : { status: state.status, activeTurnId: state.status === "running" ? "turn" : null } } };
      },
      async dispatch(command) {
        state.commands.push(command.type);
        if (command.type === "thread.session.stop") state.status = "stopped";
        if (command.type === "thread.turn.start") state.messages.push({ id: command.message.messageId, text: command.message.text });
        return {};
      },
    };
    return state;
  };
  const input = { threadId, message: "weather?", runtimeMode: "full-access", messageId: "m1" };
  const order = [];
  const restart = { prepareTalkWorkspace: async (_workspace, { restartIdleSession }) => { await restartIdleSession(); order.push("write"); } };
  const live = fake("ready");
  await continueThread(live.client, input, restart);
  assert.deepEqual(live.commands, ["thread.session.stop", "thread.turn.start"]);
  assert.deepEqual(order, ["write"]); // stop, then write, then start
  const stopped = fake("stopped");
  await continueThread(stopped.client, input, restart);
  assert.deepEqual(stopped.commands, ["thread.turn.start"]);
  const unchanged = fake("ready");
  await continueThread(unchanged.client, input, { prepareTalkWorkspace: async () => {} });
  assert.deepEqual(unchanged.commands, ["thread.turn.start"]);
  const running = fake("running");
  order.length = 0;
  await assert.rejects(continueThread(running.client, input, restart), /still answering/);
  assert.deepEqual(running.commands, []);
  assert.deepEqual(order, []); // nothing written for a refused turn
});

test("B3 P3-A/P3-B on #99: owner Codex files Tentacles cannot edit safely refuse, the owner's mode stays", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const file = path.join(home, "config.toml");
  // A bare [projects] table holding this folder as a sub-key: a second definition would break the file.
  const bare = '[projects]\n"/w" = { trust_level = "untrusted" }\n';
  fs.writeFileSync(file, bare);
  assert.throws(() => trustCodexWorkspace(home, "/w"), /projects in a form/);
  assert.equal(fs.readFileSync(file, "utf8"), bare);
  // The owner's own header with a trailing comment is the owner's entry.
  fs.writeFileSync(file, '[projects."/w"]  # mine\ntrust_level = "untrusted"\n');
  assert.equal(trustCodexWorkspace(home, "/w"), false);
  // A dangling dotfiles link refuses instead of being replaced by a plain file.
  fs.rmSync(file);
  fs.symlinkSync(path.join(home, "missing.toml"), file);
  assert.throws(() => trustCodexWorkspace(home, "/w"), /links to a missing file/);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  // A group-writable owner file keeps 0664 although the umask would drop it.
  fs.rmSync(file);
  fs.writeFileSync(file, 'model = "x"\n');
  fs.chmodSync(file, 0o664);
  const umask = process.umask(0o022);
  try { assert.equal(trustCodexWorkspace(home, "/w"), true); } finally { process.umask(umask); }
  assert.equal(fs.statSync(file).mode & 0o777, 0o664);
});

test("B3 P3-C on #99: run() pins the origin from the offer, and an offer without one resets it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pair-run-"));
  const runtime = { jackOrigin: "https://stale.example" };
  const pairer = new OutboundPairer({ runtime, WebSocketImpl: class {}, pairStateFile: path.join(dir, "state.json") });
  const run = async (extra) => {
    const file = path.join(dir, `offer-${Math.random().toString(16).slice(2)}.json`);
    // Already expired, so run() stops right after it reads the offer and pins.
    fs.writeFileSync(file, JSON.stringify({ version: 1, endpoint: "wss://sphere.example/api/v1/jack/pairs/relay", pairToken: "p".repeat(40), expiresAt: new Date(Date.now() - 1000).toISOString(), ...extra }), { mode: 0o600 });
    await assert.rejects(pairer.run({ pairFile: file, machineId: "11111111-2222-4333-8444-555555555555" }), /expired/);
  };
  await run({ jackOrigin: ORIGIN });
  assert.equal(runtime.jackOrigin, ORIGIN);
  await run({});
  assert.equal(runtime.jackOrigin, null);
});

test("B3 P3-D on #99: a custody or Codex-home refusal comes before the stop", async () => {
  const { home, workspace, stops, adapter } = setup();
  await adapter.originate({ workspace, message: "hi", ...codex, ...connectors([learn]) });
  const threadId = "11111111-2222-4333-8444-555555555555";
  // The owner's Codex home config takes a form Tentacles refuses to edit.
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'projects = { "/x" = {} }\n');
  fs.rmSync(path.join(workspace, ".codex"), { recursive: true });
  await assert.rejects(adapter.continue({ threadId, message: "again", runtimeMode: "full-access", ...codex, ...connectors([learn]) }), /projects in a form/);
  assert.deepEqual(stops, []);
  // Workspace custody: a group-writable home refuses before any stop as well.
  fs.chmodSync(home, 0o770);
  try {
    await assert.rejects(adapter.continue({ threadId, message: "again", runtimeMode: "full-access", ...claude, ...connectors([learn]) }), /custody/);
  } finally { fs.chmodSync(home, 0o700); }
  assert.deepEqual(stops, []);
});

test("B3 P3-1 on #101: any projects header but Codex's own exact form refuses, the owner's file stays", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const file = path.join(home, "config.toml");
  const forms = [
    '[ projects."/w" ]\ntrust_level = "untrusted"\n',
    '[projects . "/w"]\ntrust_level = "untrusted"\n',
    '[projects."\\u002fw"]\ntrust_level = "untrusted"\n', // the same key, escaped
    '["projects"."/w"]\ntrust_level = "untrusted"\n',
    '["\\u0070rojects"."/w"]\ntrust_level = "untrusted"\n',
    '[[projects]]\npath = "/w"\n',
    '[projects."/w".extra]\nx = 1\n',
    '"projects"."/w".trust_level = "untrusted"\n',
    // B3 P3-1 on #105: escaped top-level key lines.
    '"\\u0070rojects"."/w".trust_level = "untrusted"\n',
    '"\\u0070rojects" = { "/w" = { trust_level = "untrusted" } }\n',
  ];
  for (const text of forms) {
    fs.writeFileSync(file, text);
    assert.throws(() => trustCodexWorkspace(home, "/w"), /projects in a form/, text);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  // Codex's own forms for other folders, with a comment, still take the new table.
  fs.writeFileSync(file, '[projects."/a"]  # mine\ntrust_level = "trusted"\n[projects.\'/b\']\ntrust_level = "trusted"\n[other]\nx = 1\n');
  assert.equal(trustCodexWorkspace(home, "/w"), true);
  assert.match(fs.readFileSync(file, "utf8"), /\n\[projects\."\/w"\]\ntrust_level = "trusted"\n$/);
});

test("B3 P3-2 on #101: a planted .codex or .claude link, or a directory file target, refuses before the stop", async () => {
  const { home, workspace, stops, adapter } = setup();
  await adapter.originate({ workspace, message: "hi", ...codex, ...connectors([learn]) });
  const threadId = "11111111-2222-4333-8444-555555555555";
  const snapshot = () => ["", ".codex/config.toml", ".cursor/mcp.json", ".mcp.json", "opencode.json", ".claude/settings.local.json"].map(name => {
    try { return fs.readFileSync(path.join(workspace, name), "utf8"); } catch (error) { return error.code; }
  });
  const elsewhere = fs.mkdtempSync(path.join(home, "elsewhere-"));
  const plants = [
    [".codex", () => { fs.rmSync(path.join(workspace, ".codex"), { recursive: true }); fs.symlinkSync(elsewhere, path.join(workspace, ".codex")); }, /real directory/],
    [".claude", () => { fs.rmSync(path.join(workspace, ".claude"), { recursive: true }); fs.symlinkSync(elsewhere, path.join(workspace, ".claude")); }, /real directory|director/],
    // B3 P3-3 on #105: the custody guard refuses with a fixed text and leaves no temp file.
    [".claude/settings.local.json", () => { fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true, mode: 0o700 }); fs.rmSync(path.join(workspace, ".claude/settings.local.json"), { force: true }); fs.mkdirSync(path.join(workspace, ".claude/settings.local.json")); }, { message: "Talk instruction guard file must not be a directory" }],
    [".mcp.json", () => { fs.rmSync(path.join(workspace, ".mcp.json")); fs.mkdirSync(path.join(workspace, ".mcp.json")); }, /must not be a directory/],
  ];
  for (const [name, plant, message] of plants) {
    plant();
    // The first refusal lets the existing custody guard settle .claude (idempotent, B3 on #101).
    await assert.rejects(adapter.continue({ threadId, message: "again", runtimeMode: "full-access", ...codex, ...connectors([learn]) }), message, name);
    const before = snapshot();
    for (const lab of [codex, claude]) {
      await assert.rejects(adapter.continue({ threadId, message: "again", runtimeMode: "full-access", ...lab, ...connectors([learn]) }), message, name);
      await assert.rejects(adapter.continue({ threadId, message: "clear", runtimeMode: "full-access", ...lab, ...connectors([]) }), message, name);
    }
    assert.deepEqual(stops, [], name);
    assert.deepEqual(snapshot(), before, name);
    fs.rmSync(path.join(workspace, name), { recursive: true });
  }
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(fs.readdirSync(path.join(workspace, ".claude")).filter(name => name.endsWith(".tmp")), []);
  // Without the plants the turn stops once and writes again.
  await adapter.continue({ threadId, message: "again", runtimeMode: "full-access", ...codex, ...connectors([learn]) });
  assert.equal(stops.length, 1);
});

test("B3 P2-1 on #102: a pairing without a pinned Jack origin invites no Jack-hosted entry", async () => {
  const adapter = new LoopbackRuntimeAdapter({ client: {}, doctorImpl: async () => ({ capabilities: { talkTurnResult: "v1" } }) });
  // Paired by today's Agent Jack: its offer names no origin.
  adapter.jackOrigin = null;
  const unpinned = (await adapter.doctorStatus()).capabilities;
  assert.equal(Object.hasOwn(unpinned, "jackMcpProxy"), false);
  assert.equal(Object.hasOwn(unpinned, "jackMcpSelf"), false);
  // The public docs server road is unchanged.
  assert.deepEqual([unpinned.jackMcpConfig, [...unpinned.jackMcpProviders], unpinned.jackMcpHeaders, [...unpinned.jackMcpPublicUrls]],
    ["v1", ["claudeAgent", "codex"], false, [PUBLIC_MCP_URL]]);
  // A pairing from an Agent Jack that pins its origin gets the whole advert.
  adapter.jackOrigin = ORIGIN;
  const pinned = (await adapter.doctorStatus()).capabilities;
  assert.deepEqual([pinned.jackMcpProxy, pinned.jackMcpSelf], ["v1", "v1"]);
});

test("B3 P2-1 on #102: an older Agent Jack's Bot with no plugins gives T3 the same turn as jack.19", async () => {
  const { home, workspace, sent, stops, adapter, at } = setup({ jackOrigin: null });
  // A new Talk: that Agent Jack sends an empty list with its scope, in the Bot's own folder.
  await adapter.originate({ workspace, message: "hi", ...claude, ...connectors([]) });
  await adapter.originate({ workspace, message: "hi", ...claude });
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, ".mcp.json"), "utf8")), { mcpServers: {} });
  // An existing Talk in its old folder: nothing is written there and no session is stopped.
  const old = path.join(home, ".jack-local-scratch", "jack-talk", "a".repeat(32), "b".repeat(32));
  at.workspace = old;
  await adapter.continue({ threadId: "t1", message: "again", runtimeMode: "full-access", ...claude, ...connectors([]) });
  await adapter.continue({ threadId: "t1", message: "again", runtimeMode: "full-access", ...claude });
  assert.deepEqual(sent[2], sent[3]);
  assert.deepEqual(stops, []);
  assert.equal(fs.existsSync(path.join(old, ".mcp.json")), false);
  // B3 P3-3 on #106: a docs-only list there is refused with the fix, before any stop or write.
  await assert.rejects(adapter.continue({ threadId: "t1", message: "again", runtimeMode: "full-access", ...claude, ...connectors([learn]) }),
    { message: "This Talk started before plugins worked on Local; start a new Talk to use plugins on Local" });
  assert.equal(sent.length, 4);
  assert.deepEqual(stops, []);
  assert.equal(fs.existsSync(path.join(old, ".mcp.json")), false);
});

test("KRA-10869: Jack's own tools, a connector and the docs server reach Local OpenCode through the folder's opencode.json", async (t) => {
  tryLab(t, "opencode");
  const { home, workspace, sent, stops, adapter } = setup();
  const reply = await adapter.originate({ workspace, message: "weather?", ...opencode, ...connectors([jack, linear, learn]) });
  const file = path.join(workspace, "opencode.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { $schema: "https://opencode.ai/config.json", mcp: {
    jack: { type: "remote", url: `${ORIGIN}/mcp`, oauth: false, headers: { Authorization: "Bearer synthetic-turn-token" } },
    linear: { type: "remote", url: `${ORIGIN}/mcp/connectors/linear`, oauth: false, headers: { Authorization: "Bearer synthetic-turn-token" } },
    "microsoft-learn": { type: "remote", url: PUBLIC_MCP_URL, oauth: false },
  } });
  // OpenCode needs no trust entry: nothing outside the Bot workspace changes.
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
  assert.equal(fs.existsSync(path.join(home, ".config")), false);
  assert.equal(JSON.stringify([reply, sent]).includes("synthetic-turn-token"), false);
  // A new token applies to the next turn: the idle session is stopped first.
  await adapter.continue({ threadId: "t1", message: "again", ...opencode, ...connectors([jack], { mcpScope: scope }) });
  assert.deepEqual(stops, ["t1"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcp), ["jack"]);
  // An empty list removes the tools.
  await adapter.continue({ threadId: "t1", message: "again", ...opencode, ...connectors([]) });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcp, {});
  // A directory planted at opencode.json refuses before the stop.
  const stopped = stops.length;
  fs.rmSync(file);
  fs.mkdirSync(file);
  await assert.rejects(async () => adapter.continue({ threadId: "t1", message: "again", ...opencode, ...connectors([jack]) }), /must not be a directory/);
  assert.equal(stops.length, stopped);
  assert.equal(JSON.stringify(sent).includes("synthetic-turn-token"), false);
  assert.equal(sent.some(params => Object.keys(params).some(key => key.startsWith("mcp"))), false);
});

test("KRA-10869: with the switch unset, OpenCode is main: no advert, a list refuses, and opencode.json is never read or written", async (t) => {
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  delete process.env.TENTACLES_JACK_TOOLS_TRY;
  t.after(() => { if (before !== undefined) process.env.TENTACLES_JACK_TOOLS_TRY = before; });
  const { workspace, sent, stops, adapter } = setup();
  let reads = 0;
  const inner = adapter.client;
  adapter.client = { getSettings: async () => { reads += 1; return inner.getSettings(); } };
  await assert.rejects(async () => adapter.originate({ workspace, message: "hi", ...opencode, ...connectors([learn]) }), /cannot use Jack tools on Local/);
  assert.deepEqual([sent, stops, reads], [[], [], 0]);
  assert.equal(fs.existsSync(path.join(workspace, "opencode.json")), false);
  // No list and an empty list: no opencode.json appears, and an existing one keeps its bytes and mode.
  await adapter.originate({ workspace, message: "plain", ...opencode });
  await adapter.continue({ threadId: "t1", message: "clear", ...opencode, ...connectors([]) });
  assert.equal(fs.existsSync(path.join(workspace, "opencode.json")), false);
  const file = path.join(workspace, "opencode.json");
  const owner = '{"mcp":{"mine":{"type":"local","command":["x"]}}}\n';
  fs.writeFileSync(file, owner, { mode: 0o644 });
  await adapter.continue({ threadId: "t1", message: "clear", ...opencode, ...connectors([]) });
  await adapter.continue({ threadId: "t1", message: "docs", ...claude, ...connectors([learn]) });
  assert.equal(fs.readFileSync(file, "utf8"), owner);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  // A directory there is not even checked: main does not look at opencode.json.
  fs.rmSync(file);
  fs.mkdirSync(file);
  await adapter.continue({ threadId: "t1", message: "docs", ...claude, ...connectors([learn]) });
  assert.equal(reads, 0);
  const report = { capabilities: { talkTurnResult: "v1" }, labs: [] };
  const status = await new LoopbackRuntimeAdapter({ client: {}, doctorImpl: async () => report }).doctorStatus();
  assert.deepEqual([...status.capabilities.jackMcpProviders], ["claudeAgent", "codex"]);
});

// Grok's road is unproven (no signed-in Grok on dev-workers): the owner opts in for a proof run.
function tryGrok(t, labs = "grok") { tryLab(t, labs); }
function tryLab(t, lab) {
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  process.env.TENTACLES_JACK_TOOLS_TRY = lab;
  t.after(() => { if (before === undefined) delete process.env.TENTACLES_JACK_TOOLS_TRY; else process.env.TENTACLES_JACK_TOOLS_TRY = before; });
}

test("KRA-10869: Grok is unproven, so it is refused and not advertised unless the owner opts in for a proof", async (t) => {
  const { workspace, sent, adapter } = setup();
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  delete process.env.TENTACLES_JACK_TOOLS_TRY;
  t.after(() => { if (before === undefined) delete process.env.TENTACLES_JACK_TOOLS_TRY; else process.env.TENTACLES_JACK_TOOLS_TRY = before; });
  await assert.rejects(async () => adapter.originate({ workspace, message: "hi", ...grok, ...connectors([learn]) }), /cannot use Jack tools on Local/);
  assert.deepEqual(sent, []);
  assert.equal(fs.existsSync(path.join(workspace, ".mcp.json")), false);
  const doctor = new LoopbackRuntimeAdapter({ client: {}, doctorImpl: async () => ({ capabilities: { talkTurnResult: "v1" } }) });
  assert.deepEqual([...(await doctor.doctorStatus()).capabilities.jackMcpProviders], ["claudeAgent", "codex"]);
  process.env.TENTACLES_JACK_TOOLS_TRY = "grok, cursor, kiro";
  assert.deepEqual([...(await doctor.doctorStatus()).capabilities.jackMcpProviders], ["claudeAgent", "codex", "grok", "cursor"]);
});

test("KRA-10869: Jack's tools reach Local Grok through the folder's .mcp.json once Grok trusts the Bot workspace", async (t) => {
  tryGrok(t);
  const { home, workspace, sent, stops, adapter, read } = setup();
  const grokHome = path.join(home, "grok-home");
  // T3's grok instance can move Grok's home through its environment list.
  const settings = await adapter.client.getSettings();
  settings.providerInstances.grok = { environment: [{ name: "GROK_HOME", value: grokHome }] };
  const reply = await adapter.originate({ workspace, message: "weather?", ...grok, ...connectors([jack, linear, learn]) });
  assert.deepEqual(Object.keys(read(".mcp.json").mcpServers), ["jack", "linear", "microsoft-learn"]);
  const trustFile = path.join(grokHome, "trusted_folders.toml");
  const trust = fs.readFileSync(trustFile, "utf8");
  assert.match(trust, new RegExp(`^\\[folders\\.${JSON.stringify(workspace).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\]\ntrusted = true\ndecided_at = \\d+\n$`));
  assert.equal(fs.statSync(trustFile).mode & 0o777, 0o600);
  assert.equal(trust.includes("synthetic-turn-token"), false);
  assert.equal(fs.existsSync(path.join(home, ".grok")), false); // GROK_HOME wins over ~/.grok
  assert.equal(JSON.stringify([reply, sent]).includes("synthetic-turn-token"), false);
  // Once is enough; the next turn stops the idle session and keeps the trust file as it is.
  await adapter.continue({ threadId: "t1", message: "again", ...grok, ...connectors([jack]) });
  assert.equal(fs.readFileSync(trustFile, "utf8"), trust);
  assert.deepEqual(stops, ["t1"]);
  // A trust file Tentacles will not edit refuses before the stop, on a fresh workspace trust.
  const kept = fs.readFileSync(trustFile, "utf8");
  fs.writeFileSync(trustFile, "version = 2\n");
  settings.providerInstances.grok.environment[0].value = path.join(home, "grok-home-2");
  fs.mkdirSync(path.join(home, "grok-home-2"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, "grok-home-2", "trusted_folders.toml"), "version = 2\n");
  await assert.rejects(adapter.continue({ threadId: "t1", message: "again", ...grok, ...connectors([jack]) }), /does not edit/);
  assert.deepEqual(stops, ["t1"]);
  fs.writeFileSync(trustFile, kept);
  settings.providerInstances.grok.environment[0].value = grokHome;
  await adapter.continue({ threadId: "t1", message: "again", ...grok, ...connectors([]) });
  assert.deepEqual(read(".mcp.json").mcpServers, {});
  // B3 P3-5 on #110: the empty list also drops the trust Tentacles added.
  assert.equal(fs.readFileSync(trustFile, "utf8").includes(JSON.stringify(workspace)), false);
  assert.equal(await grokHomeFor({ getSettings: async () => ({}) }, { home: "/h" }), "/h/.grok");
});

test("B3 P3-2/P3-5 on #110: an untrusted or git-repo Grok workspace refuses before the stop; a turn without tools drops the trust", async (t) => {
  tryGrok(t);
  const { home, workspace, stops, sent, adapter } = setup();
  const grokHome = path.join(home, "grok-home");
  const settings = await adapter.client.getSettings();
  settings.providerInstances.grok = { environment: [{ name: "GROK_HOME", value: grokHome }] };
  await adapter.originate({ workspace, message: "hi", ...grok, ...connectors([learn]) });
  const trustFile = path.join(grokHome, "trusted_folders.toml");
  const ours = fs.readFileSync(trustFile, "utf8");
  // The owner's own table for another folder, and a turn with no fields at all.
  const owner = '[folders."/owner"]\ntrusted = true\ndecided_at = 7\n';
  fs.writeFileSync(trustFile, owner + ours);
  await adapter.continue({ threadId: "t1", message: "plain", ...grok });
  assert.equal(fs.readFileSync(trustFile, "utf8"), owner);
  assert.equal(sent.length, 2);
  // An owner's explicit "no" for this folder refuses with the fix, before any stop.
  fs.writeFileSync(trustFile, `${owner}[folders.${JSON.stringify(workspace)}]\ntrusted = false\ndecided_at = 9\n`);
  const refused = fs.readFileSync(trustFile, "utf8");
  await assert.rejects(async () => adapter.continue({ threadId: "t1", message: "again", ...grok, ...connectors([learn]) }), /Grok does not trust this Bot workspace/);
  assert.deepEqual(stops, []);
  // A turn without tools leaves the owner's "no" as it is.
  await adapter.continue({ threadId: "t1", message: "plain", ...grok });
  assert.equal(fs.readFileSync(trustFile, "utf8"), refused);
  // A Talk root inside a git repository: Grok decides at the repository root, so refuse.
  fs.writeFileSync(trustFile, owner);
  fs.mkdirSync(path.join(home, ".git"));
  await assert.rejects(async () => adapter.continue({ threadId: "t1", message: "again", ...grok, ...connectors([learn]) }), /inside a git repository/);
  assert.deepEqual(stops, []);
  assert.equal(fs.readFileSync(trustFile, "utf8"), owner);
});

test("B3 P3-2 on #110: the marker outlives a failed removal, and the removal uses the Grok home it recorded", async (t) => {
  tryGrok(t);
  const run = async (breakIt, restore) => {
    const { home, workspace, adapter } = setup();
    const grokHome = path.join(home, "grok-home");
    const settings = await adapter.client.getSettings();
    settings.providerInstances.grok = { environment: [{ name: "GROK_HOME", value: grokHome }] };
    await adapter.originate({ workspace, message: "hi", ...grok, ...connectors([learn]) });
    const trustFile = path.join(grokHome, "trusted_folders.toml");
    const marker = path.join(workspace, GROK_TRUST_MARKER);
    assert.match(fs.readFileSync(marker, "utf8"), new RegExp(`^\\d+\\n${grokHome}\\n$`));
    const ctx = { settings, grokHome, trustFile, home };
    await breakIt(ctx);
    await adapter.continue({ threadId: "t1", message: "plain", ...grok });
    return { ...ctx, marker, workspace, adapter };
  };
  const header = workspace => `[folders.${JSON.stringify(workspace)}]`;
  // The two settings cases the reviewer ran: the recorded home is used, so the removal commits.
  for (const value of ["relative/g", "/elsewhere/grok"]) {
    const r = await run(({ settings }) => { settings.providerInstances.grok.environment[0].value = value; });
    assert.doesNotMatch(fs.readFileSync(r.trustFile, "utf8"), /folders/, value);
    assert.equal(fs.existsSync(r.marker), false, value);
  }
  // A file form Tentacles does not edit: nothing changes, the marker stays, and the next turn succeeds.
  const form = await run(({ trustFile }) => { fs.appendFileSync(trustFile, "version = 2\n"); });
  assert.match(fs.readFileSync(form.trustFile, "utf8"), /version = 2/);
  assert.ok(fs.readFileSync(form.trustFile, "utf8").includes(header(form.workspace)));
  assert.equal(fs.existsSync(form.marker), true);
  fs.writeFileSync(form.trustFile, fs.readFileSync(form.trustFile, "utf8").replace("version = 2\n", ""));
  await form.adapter.continue({ threadId: "t1", message: "plain", ...grok });
  assert.equal(fs.readFileSync(form.trustFile, "utf8").includes(header(form.workspace)), false);
  assert.equal(fs.existsSync(form.marker), false);
  // A concurrent Grok edit between the read and the compare: refused, the marker stays.
  const openSync = fs.openSync;
  let grokEdit = true;
  const race = await run(({ trustFile }) => {
    fs.openSync = (file, ...rest) => {
      if (grokEdit && String(file).startsWith(`${trustFile}.`)) { grokEdit = false; fs.appendFileSync(trustFile, '[folders."/grok-just-now"]\ntrusted = true\ndecided_at = 3\n'); }
      return openSync(file, ...rest);
    };
    syncBuiltinESMExports();
  });
  fs.openSync = openSync;
  syncBuiltinESMExports();
  assert.equal(grokEdit, false, "the edit ran inside the commit");
  assert.ok(fs.readFileSync(race.trustFile, "utf8").includes(header(race.workspace)));
  assert.equal(fs.existsSync(race.marker), true);
  await race.adapter.continue({ threadId: "t1", message: "plain", ...grok });
  assert.equal(fs.readFileSync(race.trustFile, "utf8"), '[folders."/grok-just-now"]\ntrusted = true\ndecided_at = 3\n');
  assert.equal(fs.existsSync(race.marker), false);
});

test("delta P2-1 on #110: switched off and with no marker, a Grok turn reads nothing outside the Bot workspace", async (t) => {
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  delete process.env.TENTACLES_JACK_TOOLS_TRY;
  t.after(() => { if (before !== undefined) process.env.TENTACLES_JACK_TOOLS_TRY = before; });
  const { home, workspace, adapter } = setup();
  const grokHome = path.join(home, "grok-home");
  fs.mkdirSync(grokHome, { mode: 0o700 });
  const trustFile = path.join(grokHome, "trusted_folders.toml");
  // The owner trusted this folder in Grok itself: the same three lines Tentacles would write.
  const owner = `[folders.${JSON.stringify(workspace)}]\ntrusted = true\ndecided_at = 1795247300\n`;
  fs.writeFileSync(trustFile, owner, { mode: 0o600 });
  let reads = 0;
  const settings = { providerInstances: { grok: { environment: [{ name: "GROK_HOME", value: grokHome }] } } };
  adapter.client = { getSettings: async () => { reads += 1; return settings; } };
  await adapter.originate({ workspace, message: "plain", ...grok });
  await adapter.continue({ threadId: "t1", message: "plain", ...grok });
  await adapter.continue({ threadId: "t1", message: "clear", ...grok, ...connectors([]) });
  assert.equal(reads, 0);
  assert.equal(fs.readFileSync(trustFile, "utf8"), owner);
  // A marker whose decided_at is not the table's removes nothing either.
  fs.writeFileSync(path.join(workspace, GROK_TRUST_MARKER), "5\n", { mode: 0o600 });
  await adapter.continue({ threadId: "t1", message: "plain", ...grok });
  assert.equal(fs.readFileSync(trustFile, "utf8"), owner);
  assert.equal(fs.existsSync(path.join(workspace, GROK_TRUST_MARKER)), false); // a stale marker is dropped
});

test("delta P2-2 on #110: the untrust removes only the header plus exactly its two keys, and the file stays valid TOML", (t) => {
  const python = spawnSync("python3", ["-c", "import tomllib"]);
  if (python.status !== 0) { t.skip("python3 with tomllib is not available to parse the result"); return; }
  const parse = text => spawnSync("python3", ["-c", "import sys, tomllib; tomllib.loads(sys.stdin.read())"], { input: text }).status === 0;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-untrust-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "trusted_folders.toml");
  const above = '[folders."/a"]\ntrusted = false\ndecided_at = 1\n';
  for (const [middle, removed] of [["", true], ["\n", false], ["# note\n", false]]) {
    for (const keys of ["trusted = true\ndecided_at = 5\n", "decided_at = 5\ntrusted = true\n"]) {
      const text = `${above}[folders."/w"]\n${middle}${keys}`;
      fs.writeFileSync(file, text);
      const plan = planGrokUntrust(home, "/w", "5");
      if (!removed) { assert.equal(plan, null, JSON.stringify(middle)); continue; }
      assert.equal(commitCodexTrust(plan), true);
      const after = fs.readFileSync(file, "utf8");
      assert.equal(after, above);
      assert.ok(parse(after));
    }
  }
  fs.writeFileSync(file, `${above}[folders."/w"]\ntrusted = true\ndecided_at = 6\n`);
  assert.equal(planGrokUntrust(home, "/w", "5"), null); // not the decided_at Tentacles wrote
  assert.equal(planGrokUntrust(path.join(home, "missing"), "/w", "5"), null);
  // B3 P3-1 on #110: a duplicate key after the pair, or a second header, leaves the file untouched.
  for (const extra of ["trusted = true\n", "decided_at = 5\n", '[folders."/w"]\ntrusted = true\ndecided_at = 5\n']) {
    fs.writeFileSync(file, `${above}[folders."/w"]\ntrusted = true\ndecided_at = 5\n${extra}`);
    assert.equal(planGrokUntrust(home, "/w", "5"), null, extra);
  }
});

test("B3 P3-1/P3-3 on #110: the Grok home is T3's last GROK_HOME, absolute only, and a bad one refuses with a fixed text", async () => {
  const client = values => ({ getSettings: async () => ({ providerInstances: { grok: { environment: values.map(value => ({ name: "GROK_HOME", value })) } } }) });
  assert.equal(await grokHomeFor(client(["/first", "/last"]), { home: "/h" }), "/last");
  assert.equal(await grokHomeFor(client(["~/g"]), { home: "/h" }), "/h/g");
  assert.equal(await grokHomeFor(client([""]), { home: "/h" }), "/h/.grok");
  for (const bad of ["relative/g", " /padded", "/padded ", 42, null]) {
    await assert.rejects(grokHomeFor(client([bad]), { home: "/h" }), /^Error: Grok home in T3's grok settings is not an absolute path/, String(bad));
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-bad-"));
  fs.writeFileSync(path.join(home, "file"), "");
  fs.symlinkSync(path.join(home, "missing"), path.join(home, "dangling"));
  for (const name of ["file", "dangling"]) {
    assert.throws(() => planGrokTrust(path.join(home, name), "/w"), /^Error: Grok home is not a directory$/, name);
  }
  // A concurrent change names Grok, not Codex.
  const grokHome = path.join(home, "g");
  const plan = planGrokTrust(grokHome, "/w");
  fs.writeFileSync(path.join(grokHome, "trusted_folders.toml"), "# changed\n");
  assert.throws(() => commitCodexTrust(plan), /^Error: Grok trusted_folders\.toml changed while trusting this Bot workspace; try again$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("KRA-10869: the Grok trust entry respects the owner's file and refuses forms Grok does not write", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  const file = path.join(home, "trusted_folders.toml");
  const own = '[folders."/a"]\ntrusted = true\ndecided_at = 1795247300\n\n[folders."/w"]\ntrusted = false\ndecided_at = 1\n';
  fs.writeFileSync(file, own, { mode: 0o640 });
  // B3 P3-2 on #110: the owner's "no" for this folder refuses rather than running without tools.
  assert.throws(() => planGrokTrust(home, "/w"), /^Error: Grok does not trust this Bot workspace; trust it in Grok first, or run this Bot on Server$/);
  assert.equal(planGrokTrust(home, "/a"), null); // the owner's trust for this folder stays as it is
  assert.equal(commitCodexTrust(planGrokTrust(home, "/v", { now: () => 5000 })), true);
  assert.equal(fs.readFileSync(file, "utf8"), `${own}[folders."/v"]\ntrusted = true\ndecided_at = 5\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  for (const text of ['version = 1\n', '[ folders."/w" ]\ntrusted = true\n', '[folders."\\u002fw"]\ntrusted = true\n', '[[folders]]\npath = "/w"\n', '[folders."/a"]\ntrusted = "yes"\n', '[other]\nx = 1\n']) {
    fs.writeFileSync(file, text);
    assert.throws(() => planGrokTrust(home, "/w"), /Grok trusted_folders\.toml holds a form Tentacles does not edit/, text);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  fs.rmSync(file);
  fs.symlinkSync(path.join(home, "elsewhere.toml"), file);
  assert.throws(() => planGrokTrust(home, "/w"), /is a link/);
});

// Every file under `root` outside `skip`, with its bytes: the owner's files, compared whole.
function outside(root, skip) {
  const files = {};
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (full === skip) continue;
    if (entry.isDirectory()) walk(full); else files[full] = fs.readFileSync(full, "utf8");
  } };
  walk(root);
  return files;
}

test("Pro rule on #111: Cursor, switched off or on, reads and writes nothing outside the Bot workspace", async (t) => {
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  t.after(() => { if (before === undefined) delete process.env.TENTACLES_JACK_TOOLS_TRY; else process.env.TENTACLES_JACK_TOOLS_TRY = before; });
  const { home, workspace, adapter } = setup();
  // Owner files a Cursor road could be tempted to touch.
  fs.mkdirSync(path.join(home, ".cursor"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), '{"mcpServers":{"owner":{"url":"https://owner.example/mcp"}}}\n');
  fs.mkdirSync(path.join(home, ".grok"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".grok", "trusted_folders.toml"), `[folders.${JSON.stringify(workspace)}]\ntrusted = true\ndecided_at = 1\n`);
  let calls = 0;
  const settings = await adapter.client.getSettings();
  adapter.client = { getSettings: async () => { calls += 1; return settings; } };
  const owner = outside(home, path.join(home, ".jack-local-scratch"));
  delete process.env.TENTACLES_JACK_TOOLS_TRY;
  await adapter.originate({ workspace, message: "plain", ...cursor });
  await adapter.continue({ threadId: "t1", message: "plain", ...cursor });
  await assert.rejects(async () => adapter.continue({ threadId: "t1", message: "tools", ...cursor, ...connectors([learn]) }), /cannot use Jack tools on Local yet/);
  process.env.TENTACLES_JACK_TOOLS_TRY = "cursor";
  await adapter.continue({ threadId: "t1", message: "tools", ...cursor, ...connectors([learn]) });
  await adapter.continue({ threadId: "t1", message: "clear", ...cursor, ...connectors([]) });
  assert.equal(calls, 0);
  assert.deepEqual(outside(home, path.join(home, ".jack-local-scratch")), owner);
});

test("B3 P2-1 on #111: with the switch unset, a Claude or Codex turn never reads, checks or writes Cursor's files", async (t) => {
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  delete process.env.TENTACLES_JACK_TOOLS_TRY;
  t.after(() => { if (before !== undefined) process.env.TENTACLES_JACK_TOOLS_TRY = before; });
  const { home, workspace, stops, adapter } = setup();
  for (const lab of [claude, codex]) await adapter.originate({ workspace, message: "docs", ...lab, ...connectors([jack, learn]) });
  assert.equal(fs.existsSync(path.join(workspace, ".cursor")), false);
  // A Cursor-shaped plant does not refuse another lab's turn, and an existing file keeps its bytes.
  const elsewhere = fs.mkdtempSync(path.join(home, "elsewhere-"));
  fs.symlinkSync(elsewhere, path.join(workspace, ".cursor"));
  await adapter.continue({ threadId: "t1", message: "docs", ...codex, ...connectors([learn]) });
  fs.rmSync(path.join(workspace, ".cursor"));
  fs.mkdirSync(path.join(workspace, ".cursor"));
  const file = path.join(workspace, ".cursor", "mcp.json");
  fs.writeFileSync(file, '{"mcpServers":{"mine":{"url":"https://mine.example/mcp"}}}\n', { mode: 0o644 });
  for (const lab of [claude, codex]) {
    await adapter.continue({ threadId: "t1", message: "docs", ...lab, ...connectors([learn]) });
    await adapter.continue({ threadId: "t1", message: "clear", ...lab, ...connectors([]) });
  }
  assert.equal(fs.readFileSync(file, "utf8"), '{"mcpServers":{"mine":{"url":"https://mine.example/mcp"}}}\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(fs.existsSync(path.join(workspace, ".jack-cursor-mcp")), false);
  assert.ok(stops.length > 0); // the turns ran
});

test("B3 P3-2 on #111: Cursor's files ride only on an admitted Cursor turn, whatever the switch says", async (t) => {
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  t.after(() => { if (before === undefined) delete process.env.TENTACLES_JACK_TOOLS_TRY; else process.env.TENTACLES_JACK_TOOLS_TRY = before; });
  const { home, workspace, stops, adapter } = setup();
  // Switch set to cursor: Claude and Codex list turns still leave .cursor absent.
  process.env.TENTACLES_JACK_TOOLS_TRY = "cursor";
  for (const lab of [claude, codex]) await adapter.originate({ workspace, message: "docs", ...lab, ...connectors([jack, learn]) });
  assert.equal(fs.existsSync(path.join(workspace, ".cursor")), false);
  // Switch unset: a Cursor turn with an empty list writes no Cursor file or marker...
  delete process.env.TENTACLES_JACK_TOOLS_TRY;
  await adapter.continue({ threadId: "t1", message: "clear", ...cursor, ...connectors([]) });
  assert.equal(fs.existsSync(path.join(workspace, ".cursor")), false);
  assert.equal(fs.existsSync(path.join(workspace, ".jack-cursor-mcp")), false);
  // ...and a .cursor link does not refuse it, nor is anything written through it.
  const elsewhere = fs.mkdtempSync(path.join(home, "elsewhere-"));
  fs.symlinkSync(elsewhere, path.join(workspace, ".cursor"));
  await adapter.continue({ threadId: "t1", message: "clear", ...cursor, ...connectors([]) });
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(fs.existsSync(path.join(workspace, ".jack-cursor-mcp")), false);
  assert.ok(stops.length > 0);
});

test("B3 P3-2/P3-3 on #111: every Cursor plant, a file Tentacles did not write, and a git repository refuse before the stop", async (t) => {
  tryGrok(t, "cursor");
  const { home, workspace, stops, adapter } = setup();
  await adapter.originate({ workspace, message: "hi", ...cursor, ...connectors([learn]) });
  const dir = path.join(workspace, ".cursor");
  const file = path.join(dir, "mcp.json");
  const ours = fs.readFileSync(file, "utf8");
  const elsewhere = fs.mkdtempSync(path.join(home, "elsewhere-"));
  fs.writeFileSync(path.join(elsewhere, "target.json"), "{}\n");
  const reset = () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); };
  const plants = [
    [".cursor link", () => { fs.rmSync(dir, { recursive: true, force: true }); fs.symlinkSync(elsewhere, dir); }, /^Error: Bot connector directory must be a real directory$/],
    [".cursor file", () => { fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(dir, ""); }, /^Error: Bot connector directory must be a real directory$/],
    [".cursor dangling link", () => { fs.rmSync(dir, { recursive: true, force: true }); fs.symlinkSync(path.join(home, "missing"), dir); }, /^Error: Bot connector directory must be a real directory$/],
    ["mcp.json folder", () => { reset(); fs.mkdirSync(file); }, /^Error: Bot connector file must not be a directory$/],
    ["mcp.json link", () => { reset(); fs.symlinkSync(path.join(elsewhere, "target.json"), file); }, /^Error: This Bot workspace has a \.cursor\/mcp\.json that Tentacles did not write; remove it, then send again$/],
    ["a file Tentacles did not write", () => { reset(); fs.writeFileSync(file, '{"mcpServers":{}}\n'); }, /did not write/],
    ["our file, edited since", () => { reset(); fs.writeFileSync(file, ours.replace("microsoft-learn", "microsoft-learm")); }, /did not write/],
  ];
  for (const [name, plant, message] of plants) {
    plant();
    const snapshot = () => { try { return fs.lstatSync(file).isFile() ? fs.readFileSync(file, "utf8") : "not a file"; } catch (error) { return error.code; } };
    const before = snapshot();
    await assert.rejects(adapter.continue({ threadId: "t1", message: "again", ...cursor, ...connectors([learn]) }), message, name);
    await assert.rejects(adapter.continue({ threadId: "t1", message: "clear", ...cursor, ...connectors([]) }), message, name);
    assert.deepEqual(stops, [], name);
    assert.equal(snapshot(), before, name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(path.join(elsewhere, "target.json"), "utf8"), "{}\n");
  // Once removed, the next turn writes again.
  await adapter.continue({ threadId: "t1", message: "again", ...cursor, ...connectors([learn]) });
  assert.equal(fs.readFileSync(file, "utf8"), ours);
  // A Bot workspace inside a git repository: Cursor would read that repository's file.
  fs.mkdirSync(path.join(home, ".git"));
  const kept = fs.readFileSync(file, "utf8");
  await assert.rejects(adapter.continue({ threadId: "t1", message: "again", ...cursor, ...connectors([jack]) }), /^Error: This Bot workspace is inside a git repository, where Cursor reads/);
  assert.equal(fs.readFileSync(file, "utf8"), kept);
  // B3 P3-1 on #111: a .git in the Bot workspace itself refuses too.
  fs.rmSync(path.join(home, ".git"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".git"));
  await assert.rejects(adapter.continue({ threadId: "t1", message: "again", ...cursor, ...connectors([jack]) }), /^Error: This Bot workspace is inside a git repository, where Cursor reads/);
  assert.equal(fs.readFileSync(file, "utf8"), kept);
});

test("KRA-10869: Jack's tools reach Local Cursor through the folder's .cursor/mcp.json, opt-in until a real T3 turn proves it", async (t) => {
  const { home, workspace, sent, stops, adapter } = setup();
  await assert.rejects(async () => adapter.originate({ workspace, message: "hi", ...cursor, ...connectors([learn]) }), /cannot use Jack tools on Local yet/);
  tryGrok(t, "cursor");
  const reply = await adapter.originate({ workspace, message: "weather?", ...cursor, ...connectors([jack, linear, learn]) });
  const file = path.join(workspace, ".cursor", "mcp.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, {
    jack: { type: "http", url: `${ORIGIN}/mcp`, headers: { Authorization: "Bearer synthetic-turn-token" } },
    linear: { type: "http", url: `${ORIGIN}/mcp/connectors/linear`, headers: { Authorization: "Bearer synthetic-turn-token" } },
    "microsoft-learn": { type: "http", url: PUBLIC_MCP_URL },
  });
  // The SDK ignores approvals on T3's road, so nothing outside the Bot workspace is written.
  assert.equal(fs.existsSync(path.join(home, ".cursor")), false);
  assert.equal(JSON.stringify([reply, sent]).includes("synthetic-turn-token"), false);
  await adapter.continue({ threadId: "t1", message: "again", ...cursor, ...connectors([jack]) });
  assert.deepEqual(stops, ["t1"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers), ["jack"]);
  await adapter.continue({ threadId: "t1", message: "again", ...cursor, ...connectors([]) });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, {});
});

test("KRA-10869: Jack's tools reach Local Antigravity as a workspace plugin, opt-in until a signed-in turn proves it", async (t) => {
  const { home, workspace, sent, stops, adapter } = setup();
  const plugin = path.join(workspace, ".agents", "plugins", "jack-tools");
  // Another lab's turn never creates the plugin.
  await adapter.originate({ workspace, message: "hi", ...claude, ...connectors([learn]) });
  assert.equal(fs.existsSync(path.join(workspace, ".agents")), false);
  await assert.rejects(async () => adapter.continue({ threadId: "t1", message: "hi", ...antigravity, ...connectors([learn]) }), /cannot use Jack tools on Local yet/);
  tryGrok(t, "antigravity");
  await adapter.continue({ threadId: "t1", message: "weather?", ...antigravity, ...connectors([jack, linear, learn]) });
  for (const directory of [".agents", ".agents/plugins", ".agents/plugins/jack-tools"]) assert.equal(fs.lstatSync(path.join(workspace, directory)).isDirectory(), true);
  assert.equal(fs.statSync(path.join(plugin, "mcp_config.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, "plugin.json"), "utf8")).name, "jack-tools");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, "mcp_config.json"), "utf8")).mcpServers, {
    jack: { url: `${ORIGIN}/mcp`, headers: { Authorization: "Bearer synthetic-turn-token" } },
    linear: { url: `${ORIGIN}/mcp/connectors/linear`, headers: { Authorization: "Bearer synthetic-turn-token" } },
    "microsoft-learn": { url: PUBLIC_MCP_URL },
  });
  assert.deepEqual(stops, ["t1"]);
  // T3's shared Antigravity profile is never touched.
  assert.equal(fs.existsSync(path.join(home, ".gemini")), false);
  // Another lab's turn leaves it as it is; an Antigravity clear empties it.
  const written = fs.readFileSync(path.join(plugin, "mcp_config.json"), "utf8");
  await adapter.continue({ threadId: "t1", message: "again", ...claude, ...connectors([]) });
  assert.equal(fs.readFileSync(path.join(plugin, "mcp_config.json"), "utf8"), written);
  await adapter.continue({ threadId: "t1", message: "again", ...antigravity, ...connectors([]) });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, "mcp_config.json"), "utf8")).mcpServers, {});
  assert.equal(JSON.stringify(sent).includes("synthetic-turn-token"), false);
});

test("KRA-10869: an Antigravity plugin Tentacles did not write refuses before the stop; switched off, nothing is read or written", async (t) => {
  const before = process.env.TENTACLES_JACK_TOOLS_TRY;
  t.after(() => { if (before === undefined) delete process.env.TENTACLES_JACK_TOOLS_TRY; else process.env.TENTACLES_JACK_TOOLS_TRY = before; });
  const { home, workspace, stops, adapter } = setup();
  const dir = path.join(workspace, ".agents", "plugins", "jack-tools");
  const config = path.join(dir, "mcp_config.json");
  await adapter.originate({ workspace, message: "plain", ...antigravity });
  // Switched off: an Antigravity clear and other labs' lists never create, read or refuse the plugin, even through a link.
  delete process.env.TENTACLES_JACK_TOOLS_TRY;
  const elsewhere = fs.mkdtempSync(path.join(home, "elsewhere-"));
  fs.symlinkSync(elsewhere, path.join(workspace, ".agents"));
  await adapter.continue({ threadId: "t1", message: "clear", ...antigravity, ...connectors([]) });
  for (const lab of [claude, codex]) await adapter.continue({ threadId: "t1", message: "docs", ...lab, ...connectors([learn]) });
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(fs.existsSync(path.join(workspace, ".jack-antigravity-mcp")), false);
  fs.rmSync(path.join(workspace, ".agents"));
  // Switched on: a plugin of the owner's refuses and keeps its bytes; once removed, ours is written and rewritten.
  process.env.TENTACLES_JACK_TOOLS_TRY = "antigravity";
  fs.mkdirSync(dir, { recursive: true });
  const owner = '{"mcpServers":{"mine":{"url":"https://mine.example/mcp"}}}\n';
  fs.writeFileSync(config, owner);
  const stopped = stops.length;
  const text = /^Error: This Bot workspace has a \.agents\/plugins\/jack-tools plugin that Tentacles did not write; remove that folder, then send again$/;
  await assert.rejects(adapter.continue({ threadId: "t1", message: "again", ...antigravity, ...connectors([learn]) }), text);
  await assert.rejects(adapter.continue({ threadId: "t1", message: "clear", ...antigravity, ...connectors([]) }), text);
  assert.equal(fs.readFileSync(config, "utf8"), owner);
  assert.equal(stops.length, stopped);
  fs.rmSync(path.join(workspace, ".agents"), { recursive: true });
  await adapter.continue({ threadId: "t1", message: "again", ...antigravity, ...connectors([learn]) });
  const ours = fs.readFileSync(config, "utf8");
  await adapter.continue({ threadId: "t1", message: "again", ...antigravity, ...connectors([learn]) });
  assert.equal(fs.readFileSync(config, "utf8"), ours);
  // Our file edited since, or plugin.json replaced, refuses too.
  for (const plant of [() => fs.writeFileSync(config, ours.replace("microsoft-learn", "microsoft-learm")), () => fs.writeFileSync(path.join(dir, "plugin.json"), "{}\n")]) {
    plant();
    await assert.rejects(adapter.continue({ threadId: "t1", message: "again", ...antigravity, ...connectors([learn]) }), text);
    fs.rmSync(path.join(workspace, ".agents"), { recursive: true });
    await adapter.continue({ threadId: "t1", message: "again", ...antigravity, ...connectors([learn]) });
  }
});
