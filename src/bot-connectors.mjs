/**
 * A Bot's Jack tool servers reach its Local lab as files in the Bot's own
 * workspace, rewritten before every turn (KRA-7685, KRA-10862). Official T3 has
 * no per-turn MCP slot and its provider settings are shared by every Bot, so
 * the lab's own project config is the only per-Bot place. Jack decides the
 * list; this only checks and writes it.
 *
 * Claude Code reads `<workspace>/.mcp.json` (T3 starts it with the user,
 * project and local setting sources). Codex reads `<workspace>/.codex/config.toml`,
 * but only for a project its home's config.toml marks trusted, so the Bot
 * workspace is trusted there once. T3 keeps a lab process alive across turns,
 * so the caller stops an idle live session before the files change.
 */
import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { BOT_CONNECTOR_REFUSALS as R } from "./bot-connector-refusals.mjs";
import { GUARD_FILE } from "./talk-instruction-guard.mjs";

// Jack admits a list only against exactly this advert. Three shapes pass:
// the one reviewed public URL with no headers, Jack's own connector proxy
// (`/mcp/connectors/<name>`) and Jack's own tools (`/mcp`, named `jack`), the
// last two on https with the turn's bearer token. Vendor credentials stay in
// Jack; the token dies with the turn.
export const PUBLIC_MCP_URL = "https://learn.microsoft.com/api/mcp";
export const JACK_SERVER_NAME = "jack";
export const BOT_CONNECTOR_PROVIDERS = Object.freeze(["claudeAgent", "codex"]);
// Labs whose road is built but not yet proven by a real turn (KRA-10869). They are
// admitted and advertised only when the owner names them for a proof run:
// TENTACLES_JACK_TOOLS_TRY=grok. A proven lab moves into BOT_CONNECTOR_PROVIDERS.
export const UNPROVEN_BOT_CONNECTOR_PROVIDERS = Object.freeze(["grok", "cursor", "antigravity"]);
export function botConnectorProviders(env = process.env) {
  const tried = String(env.TENTACLES_JACK_TOOLS_TRY ?? "").split(",").map(value => value.trim());
  return Object.freeze([...BOT_CONNECTOR_PROVIDERS, ...UNPROVEN_BOT_CONNECTOR_PROVIDERS.filter(id => tried.includes(id))]);
}
export const BOT_CONNECTOR_CAPABILITIES = Object.freeze({
  jackMcpConfig: "v1",
  jackMcpProviders: BOT_CONNECTOR_PROVIDERS,
  jackMcpHeaders: false,
  jackMcpPublicUrls: Object.freeze([PUBLIC_MCP_URL]),
  jackMcpProxy: "v1",
  jackMcpSelf: "v1",
});
export const BOT_CONNECTOR_PARAM_KEYS = Object.freeze(["mcpServers", "mcpScope", "mcpExpiresAt"]);
export const MCP_FILE = ".mcp.json";
export const CODEX_DIR = ".codex";
export const CODEX_FILE = path.join(CODEX_DIR, "config.toml");
// T3 runs Cursor through @cursor/sdk with the `project` setting source on
// full-access turns; its local loader reads this file with approvals ignored.
export const CURSOR_DIR = ".cursor";
export const CURSOR_FILE = path.join(CURSOR_DIR, "mcp.json");
// Antigravity discovers plugins under the workspace's `.agents/plugins/` (enabled
// by default) and launches each plugin's `mcp_config.json` servers. T3 starts it
// with cwd = the thread folder and hands over only its own `t3-code` server.
export const ANTIGRAVITY_DIRS = Object.freeze([".agents", path.join(".agents", "plugins"), path.join(".agents", "plugins", "jack-tools")]);
export const ANTIGRAVITY_PLUGIN = path.join(".agents", "plugins", "jack-tools", "plugin.json");
export const ANTIGRAVITY_FILE = path.join(".agents", "plugins", "jack-tools", "mcp_config.json");

const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_LIFETIME_MS = 120_000;
const MAX_SERVERS = 16;
const BEARER = /^Bearer [\x21-\x7e]{1,16384}$/;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** The https origin of a Jack-hosted entry, or null when the URL is not one of Jack's two paths. */
function serverOrigin(server) {
  try {
    const url = new URL(server.url);
    const wanted = server.name === JACK_SERVER_NAME ? "/mcp" : `/mcp/connectors/${server.name}`;
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === wanted && url.href === server.url ? url.origin : null;
  } catch {
    return null;
  }
}

function admittedServer(server) {
  if (!exactKeys(server, ["name", "type", "url", "headers"]) || typeof server.name !== "string" || !NAME.test(server.name)
      || server.type !== "http" || typeof server.url !== "string" || !Array.isArray(server.headers)) return false;
  if (server.url === PUBLIC_MCP_URL) return server.headers.length === 0 && server.name !== JACK_SERVER_NAME;
  const [header] = server.headers;
  return serverOrigin(server) !== null && server.headers.length === 1 && exactKeys(header, ["name", "value"])
    && header.name === "Authorization" && typeof header.value === "string" && BEARER.test(header.value);
}

/** The Jack origin a pair offer names: canonical https origin only, else null. */
export function pinnedJackOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

export const REPAIR_FOR_JACK_TOOLS = "Jack tools need this computer paired again from an updated Agent Jack (Settings > Local labs > pair this computer)";

/**
 * Split the connector fields off remote params. Returns `servers` undefined
 * when Jack sent none (files stay as they are), else the validated list.
 * Every refusal happens here, before the workspace or T3 is touched.
 */
export function admitBotConnectors(params, { now = Date.now, jackOrigin = null, env = process.env } = {}) {
  const { mcpServers, mcpScope, mcpExpiresAt, ...rest } = params;
  if (mcpServers === undefined) {
    if (mcpScope !== undefined || mcpExpiresAt !== undefined) throw new Error("Bot connector metadata requires mcpServers");
    return { params: rest, servers: undefined };
  }
  if (!Array.isArray(mcpServers) || mcpServers.length > MAX_SERVERS || !mcpServers.every(admittedServer)
      || new Set(mcpServers.map(server => server.name)).size !== mcpServers.length
      // Jack's own entries all come from the one Jack that sent the turn.
      || new Set(mcpServers.filter(server => server.url !== PUBLIC_MCP_URL).map(serverOrigin)).size > 1) {
    throw new Error("Bot connectors are not an admitted list");
  }
  if (!exactKeys(mcpScope, ["businessId", "seatId", "agentId"]) || !Object.values(mcpScope).every(id => typeof id === "string" && UUID.test(id))) {
    throw new Error("Bot connectors require exact ownership");
  }
  if (!Number.isInteger(mcpExpiresAt) || mcpExpiresAt <= now() || mcpExpiresAt > now() + MAX_LIFETIME_MS) {
    throw new Error("Bot connector admission expired");
  }
  if (mcpServers.length && !botConnectorProviders(env).includes(rest.instanceId)) {
    throw new Error("Bot connectors are not supported on this lab");
  }
  // B3 P1-1 on #99: a token and a full-access lab go only to the Jack this
  // computer was paired with. The origin comes from the one-shot pair offer the
  // owner's own Agent Jack wrote, never from the request.
  const hosted = mcpServers.filter(server => server.url !== PUBLIC_MCP_URL);
  if (hosted.length && jackOrigin === null) throw new Error(REPAIR_FOR_JACK_TOOLS);
  if (hosted.some(server => serverOrigin(server) !== jackOrigin)) throw new Error("Bot connectors name a host this computer is not paired with");
  return { params: rest, servers: mcpServers, scope: mcpScope };
}

/** Jack's paired_mcp_workspace, relative to the Local Talk root's parent. */
export function botWorkspaceSuffix(scope) {
  const seat = createHash("sha256").update(`${scope.businessId}:${scope.seatId}`).digest("hex");
  return path.join(".jack-local-scratch", "seats", seat, "agents", scope.agentId);
}

/** B3 P2-1 on #99: one Bot's list lands only in that Bot's own folder. */
export function requireBotWorkspace(workspace, scope) {
  return typeof workspace === "string" && workspace.endsWith(`${path.sep}${botWorkspaceSuffix(scope)}`);
}

/** True when a live lab session would hold a stale list or token after this list is written. */
export function connectorsNeedRestart(workspace, servers) {
  // Tokens change every turn, so a non-empty list always needs a fresh session;
  // an empty list after an empty list changes nothing.
  return servers !== undefined && (servers.length > 0 || listedServers(workspace) > 0);
}

function readJson(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePrivate(file, text) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { writeSync(fd, text); } catch (error) { closeSync(fd); unlinkSync(temporary); throw error; }
  closeSync(fd);
  // rename replaces a planted symlink itself, never its target.
  try { renameSync(temporary, file); } catch (error) { unlinkSync(temporary); throw error; }
}

function realDirectory(directory) {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(R.realDirectory);
}

/**
 * Read-only: refuses, before any session stop, every workspace shape the writer
 * would refuse later. `.claude` and `.codex` must be real directories (or
 * absent) and the four files must not be directories. The Bot can plant either.
 */
export function checkBotConnectorPaths(workspace) {
  const kind = file => { try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  // Outer before inner, so no lstat ever runs through a planted link.
  for (const directory of [path.dirname(GUARD_FILE), CODEX_DIR, CURSOR_DIR, ...ANTIGRAVITY_DIRS]) {
    const info = kind(path.join(workspace, directory));
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(R.realDirectory);
  }
  for (const file of [MCP_FILE, CODEX_FILE, CURSOR_FILE, ANTIGRAVITY_PLUGIN, ANTIGRAVITY_FILE, GUARD_FILE]) {
    if (kind(path.join(workspace, file))?.isDirectory()) throw new Error(R.fileIsDirectory);
  }
}

// Names match NAME and values are printable ASCII (URL.href, BEARER), so a JSON
// string is a valid TOML basic string.
function codexToml(servers) {
  return servers.map(server => [
    `[mcp_servers.${server.name}]`,
    `url = ${JSON.stringify(server.url)}`,
    ...(server.headers.length ? [`http_headers = { ${server.headers.map(h => `${JSON.stringify(h.name)} = ${JSON.stringify(h.value)}`).join(", ")} }`] : []),
    "",
  ].join("\n")).join("\n");
}

/** The Codex home T3's `codex` instance shares: its homePath setting, else ~/.codex. */
export async function codexHomeFor(client, { home = os.homedir() } = {}) {
  let configured = "";
  try {
    const settings = await client.getSettings();
    configured = settings?.providerInstances?.codex?.config?.homePath ?? settings?.providers?.codex?.homePath ?? "";
  } catch { /* unreadable settings: T3's own default below */ }
  if (typeof configured !== "string" || !configured.trim()) return path.join(home, ".codex");
  const value = configured.trim();
  return path.resolve(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
}

/**
 * Codex loads a folder's `.codex/config.toml` only when its home trusts that
 * folder. Add the one table for this Bot workspace, once; an existing entry for
 * it (trusted or not) is the owner's and stays. `projects` kept inline or as
 * top-level dotted keys cannot take a new table, so that refuses instead of
 * breaking the owner's file. The new file replaces the old one atomically, and
 * a concurrent writer between read and rename makes this refuse, not merge.
 */
export function planCodexTrust(codexHome, workspace) {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (!statSync(codexHome).isDirectory()) throw new Error(R.codexHomeNotDirectory);
  let file = path.join(codexHome, "config.toml");
  let text = "";
  let mode = 0o600;
  let link = false;
  try { link = lstatSync(file).isSymbolicLink(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (link) {
    // A dotfiles symlink keeps pointing at the owner's real file; a dangling one
    // would be replaced by a plain file, so it refuses.
    try { file = realpathSync(file); } catch (error) {
      if (error.code === "ENOENT") throw new Error(R.codexLinkMissing);
      throw error;
    }
  }
  try {
    text = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const key = JSON.stringify(workspace);
  const headers = [`[projects.${key}]`, `[projects.'${workspace}']`];
  const lines = text.split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => headers.some(header => line === header || (line.startsWith(header) && /^\s*#/.test(line.slice(header.length))))
      || line.startsWith(`projects.${key}`) || line.startsWith(`projects.'${workspace}'`))) return null;
  // A bare [projects] table, inline projects or dotted projects keys cannot take
  // a second definition of this folder without breaking the owner's file.
  // Any other header whose first key may be `projects` ([ projects."…" ],
  // [projects . "…"], ["projects"…], an escaped key, [[projects]]) may name this
  // same folder, so only the exact form Codex itself writes is passed (B3 P3-1 on #101).
  const refuse = () => { throw new Error(R.codexProjectsForm); };
  if (/^\s*["']?projects["']?\s*[=.]/m.test(text) || /^\s*\[\s*projects\s*\]\s*(#.*)?$/m.test(text)) refuse();
  for (const line of lines) {
    // Key lines too: an escaped or quoted top-level `projects` key (B3 P3-1 on #105).
    const keyFirst = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*[.=]/.exec(line)?.[1];
    if (keyFirst && (keyFirst.includes("\\") || keyFirst.replace(/^["']|["']$/g, "") === "projects")) refuse();
    const first = /^\[\[?\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(line)?.[1];
    if (!first || !(first.includes("\\") || first.replace(/^["']|["']$/g, "") === "projects")) continue;
    if (!/^\[projects\.("[^"\\]*"|'[^']*')\](\s*#.*)?$/.test(line)) refuse();
  }
  const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n# Agent Jack Bot workspace (Tentacles, KRA-10862)\n[projects.${key}]\ntrust_level = "trusted"\n`;
  return { file, text, mode, next };
}

/** Writes a planCodexTrust or planGrokTrust plan; a concurrent change since the plan refuses. */
export function commitCodexTrust(plan) {
  if (!plan) return false;
  const { file, text, mode, next } = plan;
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
  try { fchmodSync(fd, mode); writeSync(fd, next); } catch (error) { closeSync(fd); unlinkSync(temporary); throw error; }
  closeSync(fd);
  try {
    let now = "";
    try { now = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (now !== text) throw new Error(R.codexChanged);
    renameSync(temporary, file);
  } catch (error) { unlinkSync(temporary); throw error; }
  return true;
}

/** The Grok home T3's `grok` instance uses: GROK_HOME in its environment list, else ~/.grok. */
export async function grokHomeFor(client, { home = os.homedir() } = {}) {
  let configured = "";
  try {
    const settings = await client.getSettings();
    const environment = settings?.providerInstances?.grok?.environment;
    configured = Array.isArray(environment) ? environment.find(entry => entry?.name === "GROK_HOME")?.value ?? "" : "";
  } catch { /* unreadable settings: Grok's own default below */ }
  if (typeof configured !== "string" || !configured.trim()) return path.join(home, ".grok");
  const value = configured.trim();
  return path.resolve(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
}

/**
 * Grok starts a folder's own MCP servers (its `.mcp.json` or `.grok/config.toml`)
 * only when `<Grok home>/trusted_folders.toml` trusts that folder. Grok writes
 * that file itself as `[folders."<path>"]` tables with `trusted` and
 * `decided_at`; anything else in it refuses, so the owner's file never breaks.
 * An existing table for the folder (trusted or not) is the owner's and stays.
 */
export function planGrokTrust(grokHome, workspace, { now = Date.now } = {}) {
  mkdirSync(grokHome, { recursive: true, mode: 0o700 });
  if (!statSync(grokHome).isDirectory()) throw new Error(R.grokHomeNotDirectory);
  const file = path.join(grokHome, "trusted_folders.toml");
  if ((() => { try { return lstatSync(file).isSymbolicLink(); } catch (error) { if (error.code === "ENOENT") return false; throw error; } })()) {
    throw new Error(R.grokTrustLink);
  }
  let text = "";
  let mode = 0o600;
  try { text = readFileSync(file, "utf8"); mode = statSync(file).mode & 0o777; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const header = `[folders.${JSON.stringify(workspace)}]`;
  let inTable = false;
  for (const line of text.split(/\r?\n/).map(value => value.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    if (line === header) return null;
    if (/^\[folders\."[^"\\]*"\]$/.test(line)) { inTable = true; continue; }
    if (inTable && /^(trusted|decided_at) = (true|false|\d{1,15})$/.test(line)) continue;
    throw new Error(R.grokTrustForm);
  }
  const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${header}\ntrusted = true\ndecided_at = ${Math.floor(now() / 1000)}\n`;
  return { file, text, mode, next };
}

export function trustCodexWorkspace(codexHome, workspace) {
  return commitCodexTrust(planCodexTrust(codexHome, workspace));
}

function listedServers(workspace) {
  const servers = readJson(path.join(workspace, MCP_FILE)).mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers).length : 0;
}

/**
 * `prepared` is ensureLocalTalkWorkspace's answer: true only for a Bot's
 * private workspace, where the guard has already made `.claude` a real
 * directory. Anywhere else a non-empty list is refused and nothing is written.
 * `codexHome` is set for a Codex turn with a list; that home then trusts this workspace.
 * `codexTrust` is a planCodexTrust plan made before the restart; it wins over `codexHome`.
 * The caller restarts a live session first (connectorsNeedRestart), then writes.
 */
export function writeBotConnectors(workspace, prepared, servers, { codexHome, codexTrust, instanceId } = {}) {
  if (servers === undefined) return false;
  if (prepared !== true) {
    if (servers.length) throw new Error(R.notBotWorkspace);
    return false;
  }
  if (codexTrust !== undefined && servers.length) commitCodexTrust(codexTrust);
  else if (codexHome && servers.length) trustCodexWorkspace(codexHome, workspace);
  const mcpServers = Object.fromEntries(servers.map(server => [server.name, {
    type: "http", url: server.url,
    ...(server.headers.length ? { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } : {}),
  }]));
  writePrivate(path.join(workspace, MCP_FILE), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  // Only an Antigravity turn creates the plugin (other labs may scan `.agents/`);
  // once it exists every turn rewrites it, so a changed or empty list applies.
  if (instanceId === "antigravity" || existsSync(path.join(workspace, ANTIGRAVITY_FILE))) {
    for (const directory of ANTIGRAVITY_DIRS) realDirectory(path.join(workspace, directory));
    writePrivate(path.join(workspace, ANTIGRAVITY_PLUGIN), `${JSON.stringify({ name: "jack-tools", description: "Agent Jack tools for this Bot, rewritten by Tentacles before every turn" }, null, 2)}\n`);
    writePrivate(path.join(workspace, ANTIGRAVITY_FILE), `${JSON.stringify({ mcpServers: Object.fromEntries(servers.map(server => [server.name, {
      url: server.url, ...(server.headers.length ? { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } : {}),
    }])) }, null, 2)}\n`);
  }
  realDirectory(path.join(workspace, CURSOR_DIR));
  writePrivate(path.join(workspace, CURSOR_FILE), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  realDirectory(path.join(workspace, CODEX_DIR));
  writePrivate(path.join(workspace, CODEX_FILE), `# Written by Tentacles before every Jack Bot turn.\n${codexToml(servers)}`);
  // Claude Code asks before it loads a project `.mcp.json`; a Bot turn has
  // nobody to ask. Only this file, which is rewritten every turn, is approved.
  const settings = path.join(workspace, GUARD_FILE);
  writePrivate(settings, `${JSON.stringify({ ...readJson(settings), enableAllProjectMcpServers: servers.length > 0 }, null, 2)}\n`);
  return true;
}

