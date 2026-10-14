import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  authFromProbe,
  boundForPublish,
  CapabilityCache,
  CAPABILITIES_SCHEMA,
  codexTomlMcpServers,
  formatCapabilities,
  LAB_CONFIG_READERS,
  looksSecret,
  parseVersion,
  probeEnvironment,
  redactCapabilities,
  scanCapabilities,
  servicesForName,
  stripJsonComments,
  writeCapabilitiesFile,
} from "../src/capabilities.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { KNOWN_COMMANDS, parseArgs } from "../src/cli.mjs";

const posix = process.platform !== "win32";
// Synthetic credentials. None of these may appear in any scan output.
const SECRETS = [
  "ghp_SYNTHETICsecretVALUE0123456789",
  "lin_api_SYNTHETICsecret0123456789",
  "sk-SYNTHETICsecret0123456789abcdef",
  "Bearer SYNTHETIC-header-value",
  "synthetic-password-value",
  "fixture.user@example.com",
];

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-capabilities-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  return { root, home, bin };
}

// Containers without an init leave killed orphans as unreaped zombies, which
// still answer kill(pid, 0). A zombie is not running.
function processRunning(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code !== "ESRCH"; }
  try { return !/^\d+ \(.*\) [ZX]/s.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { /* no procfs */ }
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && !/^[ZX]/.test(result.stdout.trim());
}

function fakeCli(bin, name, script) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

function entry(bin, { auth = null, signIn = "fake login", services = ["fake"], install = { default: `install ${bin}` } } = {}) {
  return { id: bin, bin, name: `Fake ${bin}`, category: "test", services, version: ["--version"], auth, install, signIn };
}

const exitAuth = { args: ["auth", "status"], mode: "exit", verified: true };

function scan(box, registry, extra = {}) {
  return scanCapabilities({
    env: { PATH: `${box.bin}:/bin:/usr/bin`, HOME: box.home },
    home: box.home,
    registry,
    readers: {},
    timeoutMs: 400,
    deadlineMs: 10_000,
    ...extra,
  });
}

test("present, signed-out, missing and unverified CLIs report state, version and one fix", { skip: !posix }, async (t) => {
  const box = sandbox(t);
  fakeCli(box.bin, "fakegh", `case "$1" in --version) echo "fakegh version 2.61.0 (2026-10-01)";; auth) echo "Logged in as ${SECRETS[5]} token ${SECRETS[0]}"; exit 0;; esac`);
  fakeCli(box.bin, "fakeout", `case "$1" in --version) echo "1.4.2";; auth) echo "not logged in" >&2; exit 1;; esac`);
  fakeCli(box.bin, "fakeunverified", `case "$1" in --version) echo "0.9.0";; auth) exit 1;; esac`);
  fakeCli(box.bin, "fakeusage", `case "$1" in --version) echo "3.0.0";; auth) exit 2;; esac`);
  const document = await scan(box, [
    entry("fakegh", { auth: exitAuth }),
    entry("fakeout", { auth: exitAuth, signIn: "fakeout auth login" }),
    entry("fakeunverified", { auth: { ...exitAuth, verified: false } }),
    entry("fakeusage", { auth: exitAuth }),
    entry("fake-missing-cli-kra7369"),
  ]);
  assert.equal(document.schema, CAPABILITIES_SCHEMA);
  assert.equal(document.complete, true);
  const rows = Object.fromEntries(document.clis.map((row) => [row.id, row]));
  assert.deepEqual(
    { state: rows.fakegh.state, auth: rows.fakegh.auth, version: rows.fakegh.version, onPath: rows.fakegh.onPath, fix: rows.fakegh.fix },
    { state: "signed_in", auth: "signed_in", version: "2.61.0", onPath: true, fix: null },
  );
  // The fixture lives under TMPDIR, which CI runners put inside a home or a
  // hash-named directory; the gate folds the first and fails closed on the second.
  assert.equal(rows.fakegh.where, redactCapabilities({ where: path.join(box.bin, "fakegh") }, { home: box.home }).where);
  assert.deepEqual([rows.fakeout.state, rows.fakeout.fix], ["signed_out", { kind: "sign_in", command: "fakeout auth login" }]);
  assert.equal(rows.fakeunverified.auth, "unknown", "an unverified probe never claims signed out");
  assert.equal(rows.fakeunverified.state, "installed");
  assert.equal(rows.fakeusage.auth, "unknown", "a usage error is not a sign-out");
  assert.deepEqual(
    [rows["fake-missing-cli-kra7369"].state, rows["fake-missing-cli-kra7369"].installed, rows["fake-missing-cli-kra7369"].fix],
    ["missing", false, { kind: "install", command: "install fake-missing-cli-kra7369" }],
  );
  const text = JSON.stringify(document);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `auth output leaked: ${secret}`);
});

test("a hanging probe is killed at its timeout and the scan still completes", { skip: !posix }, async (t) => {
  const box = sandbox(t);
  const pidFile = path.join(box.root, "hang.pid");
  fakeCli(box.bin, "fakehang", `case "$1" in --version) echo "1.0.0";; auth) sleep 30 & echo $! > "${pidFile}"; wait;; esac`);
  fakeCli(box.bin, "fakeslowversion", "sleep 30");
  fakeCli(box.bin, "fakeok", `case "$1" in --version) echo "2.0.0";; auth) exit 0;; esac`);
  const started = Date.now();
  const document = await scan(box, [
    entry("fakehang", { auth: exitAuth }),
    entry("fakeslowversion", { auth: exitAuth }),
    entry("fakeok", { auth: exitAuth }),
  ]);
  assert.ok(Date.now() - started < 5_000, "probes are time-boxed");
  const rows = Object.fromEntries(document.clis.map((row) => [row.id, row]));
  assert.deepEqual([rows.fakehang.state, rows.fakehang.auth, rows.fakehang.version], ["probe_timeout", "timeout", "1.0.0"]);
  assert.deepEqual([rows.fakeslowversion.state, rows.fakeslowversion.auth], ["probe_timeout", "unknown"]);
  assert.equal(rows.fakeok.state, "signed_in");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processRunning(pid), false, "the whole probe process group is killed");
});

test("the scan deadline bounds total time and marks the document incomplete", { skip: !posix }, async (t) => {
  const box = sandbox(t);
  fakeCli(box.bin, "fakeslow", "sleep 30");
  const document = await scan(box, [entry("fakeslow", { auth: exitAuth })], { timeoutMs: 5_000, deadlineMs: 300 });
  assert.equal(document.complete, false);
  assert.equal(document.clis[0].state, "probe_timeout");
  assert.match(formatCapabilities(document), /deadline/);
});

test("probes get no stdin and a non-interactive environment that cannot open a browser", { skip: !posix }, async (t) => {
  const box = sandbox(t);
  const seen = path.join(box.root, "seen");
  fakeCli(box.bin, "fakeenv", `case "$1" in --version) echo "1.0.0";; auth) printf '%s|%s|%s' "$BROWSER" "$GH_PROMPT_DISABLED" "$(cat 2>/dev/null; echo eof)" > "${seen}"; exit 0;; esac`);
  await scan(box, [entry("fakeenv", { auth: exitAuth })]);
  assert.equal(fs.readFileSync(seen, "utf8"), "true|1|eof");
  assert.equal(probeEnvironment({}, "linux").BROWSER, "true");
});

test("a CLI found only outside PATH is reported with a PATH fix", { skip: !posix }, async (t) => {
  const box = sandbox(t);
  const localBin = path.join(box.home, ".local", "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fakeCli(localBin, "fakelocal", `echo "5.0.0"`);
  const document = await scan(box, [entry("fakelocal")]);
  const [row] = document.clis;
  assert.deepEqual([row.installed, row.onPath, row.where, row.auth], [true, false, "~/.local/bin/fakelocal", "unknown"]);
  assert.deepEqual(row.fix, { kind: "path", command: "Add ~/.local/bin to PATH" });
});

test("gcloud-style stdout probes keep only the signed-in bit, never the account", () => {
  const auth = { mode: "stdout-nonempty" };
  assert.equal(authFromProbe(auth, { code: 0, stdout: `${SECRETS[5]}\n`, timedOut: false, error: null }), "signed_in");
  assert.equal(authFromProbe(auth, { code: 0, stdout: "  \n", timedOut: false, error: null }), "signed_out");
  assert.equal(authFromProbe(auth, { code: 1, stdout: "", timedOut: false, error: null }), "unknown");
  assert.equal(authFromProbe(auth, { code: null, stdout: "", timedOut: true, error: null }), "timeout");
});

test("versions are a bounded token; anything else from --version is dropped", () => {
  assert.equal(parseVersion("gh version 2.61.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.61.0"), "2.61.0");
  assert.equal(parseVersion("codex-cli 0.162.1"), "0.162.1");
  assert.equal(parseVersion("2026.10.01-e373342"), "2026.10.01-e373342");
  assert.equal(parseVersion(`token=${SECRETS[0]}`), null);
  assert.equal(parseVersion(""), null);
});

function labHome(box) {
  const { home } = box;
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  write(".claude.json", {
    oauthAccount: { emailAddress: SECRETS[5], accessToken: SECRETS[2] },
    mcpServers: {
      linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: SECRETS[3] } },
      "local-files": { command: `${home}/bin/files-mcp`, args: ["--token", SECRETS[0]], env: { API_KEY: SECRETS[1] } },
      [SECRETS[0]]: { command: "x" },
      "has space": { command: "x" },
    },
    projects: {
      [`${home}/github/private-client-repo`]: { mcpServers: { "client-crm": { command: "crm", env: { PASSWORD: SECRETS[4] } } } },
    },
  });
  write(".claude/settings.json", { enabledPlugins: { "github@claude-plugins": true, "notion@claude-plugins": false }, env: { GITHUB_TOKEN: SECRETS[0] } });
  write(".claude/plugins/installed_plugins.json", { plugins: { "github@claude-plugins": [{ installPath: `${home}/.claude/plugins/cache/github` }] } });
  write(".claude/skills/reflect/SKILL.md", "---\nname: reflect\n---\n");
  write(".claude/skills/not-a-skill/README.md", "x");
  write(".codex/config.toml", [
    "model = \"gpt\"",
    "[mcp_servers.linear]",
    "url = \"https://mcp.linear.app/mcp\"",
    "[mcp_servers.\"clickup-verduona\"]",
    `url = "https://user:${SECRETS[4]}@mcp.clickup.com/mcp"`,
    "[mcp_servers.off]",
    "command = \"off-mcp\"",
    "enabled = false",
    "[mcp_servers.off.env]",
    `TOKEN = "${SECRETS[1]}"`,
  ].join("\n"));
  write(".codex/skills/alibaba-open-code-review/SKILL.md", "x");
  write(".cursor/mcp.json", { mcpServers: { github: { url: "https://api.githubcopilot.com/mcp", headers: { Authorization: SECRETS[3] } } } });
  write(".config/opencode/opencode.jsonc", `{
    // comment with a url https://example.invalid
    "$schema": "https://opencode.ai/config.json",
    "mcp": { "sentry": { "type": "remote", "url": "https://mcp.sentry.dev/mcp", }, },
  }`);
  write(".gemini/settings.json", { mcpServers: { figma: { httpUrl: "https://figma.invalid/mcp" } } });
}

test("lab readers report MCP, plugin and skill NAMES only; no config value leaves the computer", { skip: !posix }, async (t) => {
  const box = sandbox(t);
  labHome(box);
  fakeCli(box.bin, "codex", `case "$1 $2" in "mcp list") echo '[{"name":"linear","enabled":true,"auth_status":"not_logged_in","transport":{"url":"${SECRETS[3]}"}},{"name":"clickup-verduona","enabled":true,"auth_status":"o_auth"},{"name":"off","enabled":false,"auth_status":"unsupported"}]';; *) echo "codex-cli 0.162.1";; esac`);
  const document = await scanCapabilities({
    env: { PATH: `${box.bin}:/bin:/usr/bin`, HOME: box.home },
    home: box.home,
    registry: [],
    timeoutMs: 2_000,
  });
  const mcp = document.mcp.map((row) => `${row.lab}:${row.name}:${row.scope}:${row.transport}:${row.state}`).sort();
  assert.deepEqual(mcp, [
    "claude:client-crm:project:unknown:configured",
    "claude:linear:user:http:configured",
    "claude:local-files:user:stdio:configured",
    "codex:clickup-verduona:user:http:signed_in",
    "codex:linear:user:http:signed_out",
    "codex:off:user:stdio:disabled",
    "cursor:github:user:http:configured",
    "gemini:figma:user:http:configured",
    "opencode:sentry:user:http:configured",
  ]);
  assert.equal(document.dropped, 2, "secret-shaped and unsafe server names are dropped");
  const codexLinear = document.mcp.find((row) => row.lab === "codex" && row.name === "linear");
  assert.deepEqual(codexLinear.fix, { kind: "sign_in", command: "codex mcp login linear" });
  assert.deepEqual(codexLinear.services, ["linear"]);
  assert.deepEqual(document.plugins.map((row) => [row.lab, row.name, row.enabled, row.services]), [
    ["claude", "github@claude-plugins", true, ["github"]],
    ["claude", "notion@claude-plugins", false, ["notion"]],
  ]);
  assert.deepEqual(document.skills.map((row) => `${row.lab}:${row.name}`), ["claude:reflect", "codex:alibaba-open-code-review"]);

  const text = JSON.stringify(document);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `config value leaked: ${secret}`);
  assert.equal(text.includes(box.home), false, "home paths never leave the computer");
  for (const leak of ["private-client-repo", "mcp.linear.app", "oauthAccount", "installPath", "API_KEY", "GITHUB_TOKEN"]) {
    assert.equal(text.includes(leak), false, `config detail leaked: ${leak}`);
  }
});

test("the redaction gate replaces secret-shaped strings and folds home paths", () => {
  const home = "/home/synthetic-user";
  const document = redactCapabilities({
    clis: [{ where: `${home}/.local/bin/gh`, version: "2.0.0", fix: { command: `export GH_TOKEN=${SECRETS[0]}` } }],
    other: ["/Users/someone/bin/x", "C:\\Users\\someone\\bin\\x.exe", SECRETS[5], "https://u:p@host.invalid/x", "aB3".repeat(16), "/tmp/-home-someone-github-current-tooling-t3-agent-bridge/x"],
  }, { home });
  assert.equal(document.clis[0].where, "~/.local/bin/gh");
  assert.equal(document.clis[0].fix.command, "[redacted]");
  assert.deepEqual(document.other, ["~/bin/x", "~\\bin\\x.exe", "[redacted]", "[redacted]", "[redacted]", "/tmp/-home-someone-github-current-tooling-t3-agent-bridge/x"]);
  assert.equal(document.redactions, 4);
  // A bare password has no shape; it is kept out by never copying values, which the reader test proves.
  for (const secret of SECRETS.filter((value) => value !== "synthetic-password-value")) {
    assert.equal(looksSecret(secret), true, `secret shape not caught: ${secret}`);
  }
  for (const safe of ["gh", "clickup-verduona", "github@claude-plugins", "2026.10.01-e373342", "codex mcp login linear", "npm install -g @openai/codex"]) {
    assert.equal(looksSecret(safe), false, `false positive: ${safe}`);
  }
});

test("codex TOML and JSONC parsing read table names and keep URLs inside strings", () => {
  const servers = codexTomlMcpServers("[mcp_servers.a]\nurl = \"x\"\n[mcp_servers.'b-c']\ncommand = \"y\"\nenabled = false\n[mcp_servers.a.env]\nK = \"v\"\n[profiles.x]\n");
  assert.deepEqual([...servers], [["a", { enabled: true, transport: "http" }], ["b-c", { enabled: false, transport: "stdio" }]]);
  assert.deepEqual(JSON.parse(stripJsonComments('{ // c\n "u": "https://x//y", /* b */ "a": [1,], }')), { u: "https://x//y", a: [1] });
});

test("service words map MCP and plugin names to the need an agent asks for", () => {
  assert.deepEqual(servicesForName("clickup-verduona"), ["clickup"]);
  assert.deepEqual(servicesForName("linear"), ["linear"]);
  assert.deepEqual(servicesForName("unrelated"), []);
});

test("the published inventory is bounded: skills go before plugins, CLI rows stay", () => {
  const document = {
    schema: CAPABILITIES_SCHEMA,
    clis: [{ id: "gh", state: "signed_in" }],
    mcp: [{ lab: "codex", name: "linear" }],
    plugins: Array.from({ length: 50 }, (_, index) => ({ lab: "claude", name: `plugin-${index}` })),
    skills: Array.from({ length: 2_000 }, (_, index) => ({ lab: "claude", name: `skill-${index}-${"x".repeat(40)}` })),
    truncated: { mcp: false, plugins: false, skills: false },
  };
  const bounded = boundForPublish(document, 8 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 8 * 1024);
  assert.equal(bounded.truncated.skills, true);
  assert.deepEqual(bounded.clis, document.clis);
  assert.deepEqual(bounded.mcp, document.mcp);
  assert.deepEqual(boundForPublish(document, 1_000_000), document, "an inventory under the bound is unchanged");
  assert.equal(boundForPublish({ clis: ["x".repeat(500)] }, 100), null);
});

test("the daemon cache coalesces scans, rate-limits forced refreshes and refreshes when stale", async () => {
  let clock = 1_000_000;
  let scans = 0;
  const cache = new CapabilityCache({
    scan: async () => ({ scan: ++scans }),
    refreshMs: 300_000,
    minIntervalMs: 30_000,
    file: null,
    now: () => clock,
  });
  assert.equal(cache.current, null);
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.deepEqual([a, b, scans], [{ scan: 1 }, { scan: 1 }, 1]);
  clock += 10_000;
  assert.deepEqual(await cache.get({ maxAgeMs: 0 }), { scan: 1 }, "forced refreshes are rate-limited");
  clock += 30_000;
  assert.deepEqual(await cache.get({ maxAgeMs: 0 }), { scan: 2 });
  assert.deepEqual(await cache.refreshIfStale(), { scan: 2 });
  clock += 300_000;
  assert.deepEqual(await cache.refreshIfStale(), { scan: 3 });
});

test("a failed scan keeps the last inventory and never persists a partial file", async (t) => {
  const box = sandbox(t);
  const file = path.join(box.root, "state", "capabilities.v1.json");
  let fail = false;
  const cache = new CapabilityCache({ scan: async () => { if (fail) throw new Error("scan failed"); return { ok: true }; }, file, refreshMs: 0, minIntervalMs: 0 });
  await cache.refresh();
  if (posix) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fail = true;
  await assert.rejects(cache.refresh(), /scan failed/);
  assert.deepEqual(cache.current, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["capabilities.v1.json"]);
  writeCapabilitiesFile({ ok: 2 }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: 2 });
});

test("doctor-status carries the last inventory without waiting for a scan", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let scans = 0;
  const cache = new CapabilityCache({ scan: async () => { scans += 1; await blocked; return { schema: CAPABILITIES_SCHEMA, clis: [] }; }, file: null });
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({}) },
    doctorImpl: async () => ({ labs: [] }),
    capabilityCache: cache,
  });
  const first = await adapter.doctorStatus();
  assert.equal(first.capabilityInventory, null, "the first reply does not block on the scan");
  assert.equal(scans, 1, "the reply starts a background scan");
  release();
  await cache.pending;
  const second = await adapter.doctorStatus();
  assert.deepEqual(second.capabilityInventory, { schema: CAPABILITIES_SCHEMA, clis: [] });
  assert.deepEqual(second.capabilities, { talkTurnResult: null, turnInterrupt: null });
  await adapter.refreshCapabilities();
  assert.equal(scans, 1, "a fresh inventory is not rescanned on every heartbeat");
});

test("an adapter without a capability cache keeps the doctor-status shape unchanged", async () => {
  const adapter = new LoopbackRuntimeAdapter({ client: { request: async () => ({}) }, doctorImpl: async () => ({ labs: [] }) });
  assert.equal(Object.hasOwn(await adapter.doctorStatus(), "capabilityInventory"), false);
  assert.equal(await adapter.refreshCapabilities(), null);
});

test("capabilities scan is a known command with --json and --no-labs flags", () => {
  assert.equal(KNOWN_COMMANDS.has("capabilities"), true);
  assert.deepEqual(parseArgs(["capabilities", "scan", "--json", "--no-labs"]), {
    command: "capabilities",
    options: { _: ["scan"], json: true, "no-labs": true },
  });
});

// B3 #51 (comment 12161): token-shaped names a user chose must never leave the computer.
const TOKEN_SHAPED_NAMES = [
  "AIzaSyD-SYNTHETIC0123456789abcdefghijk",
  "sk_live_SYNTHETIC0123456789abcd",
  "sk_test_SYNTHETIC0123456789abcd",
  "rk_live_SYNTHETIC0123456789abcd",
  "123456789:AAHsyntheticTelegramBotToken012345",
  "hf_SYNTHETICabcdefghijklmnop0123",
  "xapp-1-A0SYNTHETIC-0123456789-abcdef",
  "ntn_SYNTHETIC0123456789abcdefghij",
  "secret_SYNTHETIC0123456789abcdefgh",
  "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y",
  "api-key-ABCDEF1234567890ABCDEF",
  "abcdefghijklmnopqrstuvwxyzabcdefgh",
];

test("token-shaped names are caught by the gate and dropped as names", () => {
  for (const name of TOKEN_SHAPED_NAMES) {
    assert.equal(looksSecret(name), true, `token shape passed the gate: ${name}`);
  }
  for (const safe of ["alibaba-open-code-review", "clickup-verduona", "github@claude-plugins", "playwright", "google-workspace-mcp", "27037243-41c5-42b6-9465-da5ba7dfeb8a"]) {
    assert.equal(looksSecret(safe), false, `false positive: ${safe}`);
  }
});

test("names reject colons, a leading dash, and more than 64 characters", { skip: !posix }, async (t) => {
  const box = sandbox(t);
  const servers = Object.fromEntries([
    ...TOKEN_SHAPED_NAMES,
    "--version",
    "host:port",
    `a${"b".repeat(64)}`,
    "kept-server",
  ].map((name) => [name, { command: "x" }]));
  fs.writeFileSync(path.join(box.home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
  const document = await scanCapabilities({ env: { PATH: "/bin" }, home: box.home, registry: [], readers: { claude: LAB_CONFIG_READERS.claude } });
  assert.deepEqual(document.mcp.map((row) => row.name), ["kept-server"]);
  assert.equal(document.dropped, TOKEN_SHAPED_NAMES.length + 3);
  const text = JSON.stringify(document);
  for (const name of TOKEN_SHAPED_NAMES) assert.equal(text.includes(name), false);
});

test("root and other user homes are folded to ~", () => {
  const document = redactCapabilities({ where: ["/root/.local/bin/gh", "/rootless/bin/x"] }, { home: "/home/none" });
  assert.deepEqual(document.where, ["~/.local/bin/gh", "/rootless/bin/x"]);
});

test("a failing scan backs off instead of rescanning on every heartbeat", async () => {
  let clock = 0;
  let scans = 0;
  const cache = new CapabilityCache({ scan: async () => { scans += 1; throw new Error("scan failed"); }, file: null, refreshMs: 300_000, minIntervalMs: 30_000, now: () => clock });
  await assert.rejects(cache.refreshIfStale());
  await cache.refreshIfStale();
  clock += 10_000;
  await cache.refreshIfStale();
  assert.equal(scans, 1, "a failed scan is not retried inside minIntervalMs");
  clock += 30_000;
  await assert.rejects(cache.refreshIfStale());
  assert.equal(scans, 2);
});

test("the state directory is tightened to 0700 when the file is written", { skip: !posix }, (t) => {
  const box = sandbox(t);
  const directory = path.join(box.root, "state");
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  writeCapabilitiesFile({ ok: true }, path.join(directory, "capabilities.v1.json"));
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  // A directory owned by someone else (sticky /tmp) is written into, never chmodded.
  if (process.getuid() !== 0 && fs.statSync("/tmp").uid !== process.getuid()) {
    const shared = path.join("/tmp", `kra7369-shared-${process.pid}.json`);
    try {
      writeCapabilitiesFile({ ok: true }, shared);
      assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(shared, { force: true });
    }
  }
});

// B3 #51 blocking 1: a near-full lab catalog must not turn doctor-status into "unavailable".
function bigInventory(rows) {
  return {
    schema: CAPABILITIES_SCHEMA,
    clis: [{ id: "gh", state: "signed_in" }],
    mcp: [],
    plugins: [],
    skills: Array.from({ length: rows }, (_, index) => ({ lab: "claude", name: `skill-${index}-${"x".repeat(40)}` })),
    truncated: { mcp: false, plugins: false, skills: false },
  };
}

test("the inventory is sized to the room the lab catalog leaves in the frame", async () => {
  const frameBytes = 64 * 1024;
  const catalog = { labs: [{ instanceId: "codex", models: ["m".repeat(60 * 1024)] }] };
  const cache = new CapabilityCache({ scan: async () => bigInventory(500), file: null });
  await cache.refresh();
  const adapter = new LoopbackRuntimeAdapter({
    client: { request: async () => ({}) },
    doctorImpl: async () => catalog,
    capabilityCache: cache,
    frameBytes,
  });
  const reply = await adapter.doctorStatus();
  const envelope = JSON.stringify({ version: 1, type: "rpc.result", id: "x".repeat(128), result: reply });
  assert.ok(Buffer.byteLength(envelope) <= frameBytes, "the whole reply fits the frame");
  assert.equal(reply.capabilityInventory.truncated.skills, true, "skills are trimmed to the room left");
  assert.deepEqual(reply.capabilityInventory.clis, [{ id: "gh", state: "signed_in" }]);
  assert.deepEqual(reply.labs, catalog.labs, "the lab catalog is never trimmed");
  // Near-full catalog at the real 1 MiB pair frame: 990 KiB of models, 128 KiB inventory wanted.
  const nearFull = new LoopbackRuntimeAdapter({
    client: { request: async () => ({}) },
    doctorImpl: async () => ({ labs: [{ instanceId: "cursor", models: Array.from({ length: 990 }, (_, i) => `${i}-${"m".repeat(1012)}`) }] }),
    capabilityCache: cache,
  });
  const nearReply = await nearFull.doctorStatus();
  const nearEnvelope = JSON.stringify({ version: 1, type: "rpc.result", id: "x".repeat(128), result: nearReply });
  assert.ok(Buffer.byteLength(nearEnvelope) <= 1024 * 1024, "a near-full catalog plus inventory still fits 1 MiB");
  assert.equal(nearReply.labs[0].models.length, 990);
  const full = new LoopbackRuntimeAdapter({
    client: { request: async () => ({}) },
    doctorImpl: async () => ({ labs: [{ instanceId: "codex", models: ["m".repeat(frameBytes)] }] }),
    capabilityCache: cache,
    frameBytes,
  });
  assert.equal((await full.doctorStatus()).capabilityInventory, null, "no room means no inventory, not an error");
});

test("a doctor-status reply that still overflows is resent without the inventory, never unavailable", async () => {
  const sent = [];
  const sockets = [];
  class FakeSocket {
    constructor() { sockets.push(this); this.listeners = {}; setTimeout(() => this.emit("open"), 0); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    emit(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
    send(data) { sent.push(JSON.parse(data)); }
    close() {}
  }
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-capabilities-pair-"));
  try {
    const pairFile = path.join(box, "offer.json");
    fs.writeFileSync(pairFile, JSON.stringify({ version: 1, endpoint: "wss://jack.example.invalid/api/tentacles/pair", pairToken: "synthetic-pair-token-value", expiresAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
    const runtime = {
      seats: async () => null, originate: async () => null, continue: async () => null,
      doctorStatus: async () => ({ pairing: { status: "paired" }, labs: [], capabilityInventory: { schema: CAPABILITIES_SCHEMA, filler: "y".repeat(4096) } }),
    };
    const { OutboundPairer } = await import("../src/outbound-pairer.mjs");
    const controller = new AbortController();
    const pairer = new OutboundPairer({ runtime, WebSocketImpl: FakeSocket, pairStateFile: path.join(box, "pair-presence.json"), maxFrameBytes: 2048 });
    const running = pairer.run({ pairFile, machineId: "synthetic-machine", signal: controller.signal });
    const until = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
    await until(() => sent.some((frame) => frame.type === "pair.bind"));
    const bind = sent.find((frame) => frame.type === "pair.bind");
    sockets[0].emit("message", { data: JSON.stringify({ version: 1, type: "pair.bound", requestId: bind.requestId }) });
    sockets[0].emit("message", { data: JSON.stringify({ version: 1, type: "rpc.request", id: "rpc-1", method: "doctor-status", params: {} }) });
    await until(() => sent.some((frame) => frame.id === "rpc-1"));
    controller.abort();
    await running;
    const reply = sent.find((frame) => frame.id === "rpc-1");
    assert.equal(reply.type, "rpc.result");
    assert.deepEqual(reply.result, { pairing: { status: "paired" }, labs: [], capabilityInventory: null });
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
});
