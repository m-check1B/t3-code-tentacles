import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BOT_CONNECTOR_CAPABILITIES, PUBLIC_MCP_URL, codexHomeFor, trustCodexWorkspace } from "../src/bot-connectors.mjs";
import { continueThread } from "../src/bridge.mjs";
import { freshCapability } from "./helpers/fresh-context-wire.mjs";
import { ensureLocalTalkWorkspace } from "../src/local-talk-workspace.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";

const scope = { businessId: "11111111-1111-4111-8111-111111111111", seatId: "22222222-2222-4222-8222-222222222222", agentId: "33333333-3333-4333-8333-333333333333" };
const learn = { name: "microsoft-learn", type: "http", url: PUBLIC_MCP_URL, headers: [] };
const linear = { name: "linear", type: "http", url: "https://jack.example/mcp/connectors/linear", headers: [{ name: "Authorization", value: "Bearer synthetic-turn-token" }] };
const jack = { name: "jack", type: "http", url: "https://jack.example/mcp", headers: [{ name: "Authorization", value: "Bearer synthetic-turn-token" }] };
const connectors = (servers, extra = {}) => ({ mcpServers: servers, mcpScope: scope, mcpExpiresAt: Date.now() + 60_000, ...extra });

function setup() {
  const settings = {};
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bot-connectors-")));
  fs.chmodSync(home, 0o700);
  // The path Jack sends for a Bot with connectors (paired_mcp_workspace).
  const workspace = path.join(home, ".jack-local-scratch", "seats", "a".repeat(64), "agents", scope.agentId);
  const sent = [];
  const adapter = new LoopbackRuntimeAdapter({
    client: { getSettings: async () => settings },
    prepareTalkWorkspaceImpl: value => ensureLocalTalkWorkspace(value, { home }),
    originateImpl: (_client, params) => { sent.push(params); return { ok: true }; },
    continueImpl: async (_client, params, { prepareTalkWorkspace }) => { sent.push({ ...params, prepared: await prepareTalkWorkspace(workspace) }); return { ok: true }; },
  });
  const read = file => JSON.parse(fs.readFileSync(path.join(workspace, file), "utf8"));
  // T3's Codex homePath, as the owner's Settings would hold it.
  settings.providerInstances = { codex: { config: { homePath: path.join(home, ".codex") } } };
  return { home, workspace, sent, adapter, read };
}

test("a Bot's connectors are written into its own workspace and never reach T3", async () => {
  const { workspace, sent, adapter, read } = setup();
  await adapter.originate({ workspace, message: "hi", instanceId: "claudeAgent", ...connectors([learn]) });
  assert.deepEqual(read(".mcp.json"), { mcpServers: { "microsoft-learn": { type: "http", url: PUBLIC_MCP_URL } } });
  const settings = read(path.join(".claude", "settings.local.json"));
  assert.equal(settings.enableAllProjectMcpServers, true);
  assert.equal(settings.autoMemoryEnabled, false); // the instruction guard survives
  assert.equal(fs.statSync(path.join(workspace, ".mcp.json")).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(sent[0]).filter(key => key.startsWith("mcp")), []);

  // The next turn's list is the truth: an empty list takes the tools away.
  await adapter.continue({ threadId: "t1", message: "again", instanceId: "claudeAgent", model: "claude-opus-5-5", ...connectors([]) });
  assert.deepEqual(read(".mcp.json"), { mcpServers: {} });
  assert.equal(read(path.join(".claude", "settings.local.json")).enableAllProjectMcpServers, false);
  assert.deepEqual(Object.keys(sent[1]).filter(key => key.startsWith("mcp")), []);
  // A live session still holds the old list, so the caller restarts it once more.
  assert.equal(sent[1].prepared.restart, true);
  await adapter.continue({ threadId: "t1", message: "again", instanceId: "claudeAgent", model: "claude-opus-5-5", ...connectors([]) });
  assert.equal(sent[2].prepared.restart, false); // empty after empty changes nothing
});

test("a signed-in connector reaches the lab as Jack's proxy with the turn token, in a private file", async () => {
  const { workspace, sent, adapter, read } = setup();
  const reply = await adapter.originate({ workspace, message: "hi", instanceId: "claudeAgent", ...connectors([learn, linear]) });
  assert.deepEqual(read(".mcp.json").mcpServers.linear, { type: "http", url: linear.url, headers: { Authorization: "Bearer synthetic-turn-token" } });
  assert.equal(fs.statSync(path.join(workspace, ".mcp.json")).mode & 0o777, 0o600);
  // The token is in that one file only: not in the reply, not in what T3 gets.
  assert.equal(JSON.stringify([reply, sent]).includes("synthetic-turn-token"), false);
  await adapter.continue({ threadId: "t1", message: "again", instanceId: "claudeAgent", model: "claude-opus-5-5", ...connectors([]) });
  assert.equal(fs.readFileSync(path.join(workspace, ".mcp.json"), "utf8").includes("synthetic-turn-token"), false);
});

test("a turn without connector fields leaves the workspace as it is", async () => {
  const { workspace, adapter } = setup();
  await adapter.originate({ workspace, message: "hi", instanceId: "codex" });
  assert.equal(fs.existsSync(path.join(workspace, ".mcp.json")), false);
  assert.equal(fs.existsSync(path.join(workspace, ".codex")), false);
  await adapter.continue({ threadId: "t1", message: "again", instanceId: "codex", model: "gpt-6-astra" });
  assert.equal(fs.existsSync(path.join(workspace, ".mcp.json")), false);
});

test("anything Jack's gate would not admit is refused before the workspace or T3 is touched", async () => {
  const { home, workspace, sent, adapter } = setup();
  const base = { workspace, message: "hi", instanceId: "claudeAgent" };
  for (const [bad, pattern] of [
    [connectors([{ ...learn, url: "https://example.com/mcp" }]), /not an admitted list/],
    [connectors([{ ...learn, headers: [{ name: "Authorization", value: "Bearer x" }] }]), /not an admitted list/],
    [connectors([learn, { ...learn }]), /not an admitted list/],
    [connectors([{ ...linear, headers: [] }]), /not an admitted list/],
    [connectors([{ ...linear, headers: [{ name: "Cookie", value: "Bearer x" }] }]), /not an admitted list/],
    [connectors([{ ...linear, headers: [{ name: "Authorization", value: "Bearer a b" }] }]), /not an admitted list/],
    [connectors([{ ...linear, url: "http://jack.example/mcp/connectors/linear" }]), /not an admitted list/],
    [connectors([{ ...linear, url: "https://jack.example/mcp/connectors/clickup" }]), /not an admitted list/],
    [connectors([{ ...linear, url: "https://user@jack.example/mcp/connectors/linear" }]), /not an admitted list/],
    [connectors([{ ...linear, url: "https://jack.example/mcp/connectors/linear?x=1" }]), /not an admitted list/],
    [connectors([learn], { mcpScope: { ...scope, agentId: "nope" } }), /exact ownership/],
    [connectors([learn], { mcpExpiresAt: Date.now() - 1 }), /expired/],
    [connectors([learn], { mcpExpiresAt: Date.now() + 600_000 }), /expired/],
    [connectors([learn], { instanceId: "antigravity" }), /not supported on this lab/],
    [connectors([learn], { instanceId: undefined }), /not supported on this lab/],
    [connectors([{ ...jack, headers: [] }]), /not an admitted list/],
    [connectors([{ ...jack, name: "jack2" }]), /not an admitted list/],
    [connectors([{ ...jack, url: "https://jack.example/mcp/" }]), /not an admitted list/],
    [connectors([{ ...learn, name: "jack" }]), /not an admitted list/],
    [connectors([jack, { ...linear, url: "https://other.example/mcp/connectors/linear" }]), /not an admitted list/],
    [{ mcpScope: scope }, /requires mcpServers/],
  ]) assert.throws(() => adapter.originate({ ...base, ...bad }), pattern);
  // An operator seat's folder is not a Bot workspace.
  await assert.rejects(() => adapter.originate({ ...base, workspace: home, ...connectors([learn]) }), /need a Bot workspace/);
  assert.equal(fs.existsSync(path.join(home, ".mcp.json")), false);
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(sent.length, 0);
});

test("doctor-status advertises exactly what Jack's gate reads, only with Local Talk support", async () => {
  const report = capabilities => new LoopbackRuntimeAdapter({ client: {}, doctorImpl: async () => ({ capabilities }) }).doctorStatus();
  const { capabilities } = await report({ talkTurnResult: "v1", turnInterrupt: null });
  assert.deepEqual({ ...capabilities, jackMcpProviders: [...capabilities.jackMcpProviders], jackMcpPublicUrls: [...capabilities.jackMcpPublicUrls] },
    { talkTurnResult: "v1", turnInterrupt: null, jackMcpConfig: "v1", jackMcpProviders: ["claudeAgent", "codex"], jackMcpHeaders: false, jackMcpPublicUrls: [PUBLIC_MCP_URL], jackMcpProxy: "v1", jackMcpSelf: "v1" });
  assert.equal(JSON.parse(JSON.stringify(capabilities)).jackMcpConfig, BOT_CONNECTOR_CAPABILITIES.jackMcpConfig);
  assert.deepEqual((await report({ talkTurnResult: null, turnInterrupt: null })).capabilities, { talkTurnResult: null, turnInterrupt: null });
});

test("Jack's own tools and a connector reach Local Codex through a trusted per-folder config", async () => {
  const { home, workspace, sent, adapter } = setup();
  const reply = await adapter.originate({ workspace, message: "weather?", instanceId: "codex", model: "gpt-6-astra", ...connectors([jack, linear, learn]) });
  const toml = fs.readFileSync(path.join(workspace, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.jack\]\nurl = "https:\/\/jack\.example\/mcp"\nhttp_headers = \{ "Authorization" = "Bearer synthetic-turn-token" \}/);
  assert.match(toml, /\[mcp_servers\.microsoft-learn\]\nurl = "https:\/\/learn\.microsoft\.com\/api\/mcp"\n/);
  assert.equal(fs.statSync(path.join(workspace, ".codex", "config.toml")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(workspace, ".mcp.json")).mode & 0o777, 0o600);
  // T3's Codex home now trusts exactly this workspace, once.
  const trust = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.equal(trust.split(`[projects.${JSON.stringify(workspace)}]`).length, 2);
  assert.equal(trust.includes("synthetic-turn-token"), false);
  await adapter.continue({ threadId: "t1", message: "again", instanceId: "codex", model: "gpt-6-astra", ...connectors([jack]) });
  assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), trust);
  assert.equal(sent[1].prepared.restart, true);
  assert.equal(JSON.stringify([reply, sent]).includes("synthetic-turn-token"), false);
  await adapter.continue({ threadId: "t1", message: "again", instanceId: "codex", model: "gpt-6-astra", ...connectors([]) });
  assert.equal(fs.readFileSync(path.join(workspace, ".codex", "config.toml"), "utf8").includes("mcp_servers"), false);
});

test("the Codex trust entry respects the owner's file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const file = path.join(home, "config.toml");
  fs.writeFileSync(file, 'model = "x"\n[projects."/w"]\ntrust_level = "untrusted"\n');
  assert.equal(trustCodexWorkspace(home, "/w"), false); // the owner's own table stays
  assert.equal(trustCodexWorkspace(home, "/v"), true);
  assert.match(fs.readFileSync(file, "utf8"), /^model = "x"\n\[projects\."\/w"\]\ntrust_level = "untrusted"\n\n# Agent Jack.*\n\[projects\."\/v"\]\ntrust_level = "trusted"\n$/);
  fs.writeFileSync(file, 'projects = { "/w" = { trust_level = "trusted" } }\n');
  assert.throws(() => trustCodexWorkspace(home, "/v"), /projects inline/);
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
  const restart = { prepareTalkWorkspace: async () => ({ restart: true }) };
  const live = fake("ready");
  await continueThread(live.client, input, restart);
  assert.deepEqual(live.commands, ["thread.session.stop", "thread.turn.start"]);
  const stopped = fake("stopped");
  await continueThread(stopped.client, input, restart);
  assert.deepEqual(stopped.commands, ["thread.turn.start"]);
  const unchanged = fake("ready");
  await continueThread(unchanged.client, input, { prepareTalkWorkspace: async () => ({ restart: false }) });
  assert.deepEqual(unchanged.commands, ["thread.turn.start"]);
  const running = fake("running");
  await assert.rejects(continueThread(running.client, input, restart), /still answering/);
  assert.deepEqual(running.commands, []);
});
