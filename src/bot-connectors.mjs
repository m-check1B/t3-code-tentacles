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
import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
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
// TENTACLES_JACK_TOOLS_TRY=grok,opencode,cursor,antigravity. A proven lab moves into BOT_CONNECTOR_PROVIDERS.
export const UNPROVEN_BOT_CONNECTOR_PROVIDERS = Object.freeze(["grok", "opencode", "cursor", "antigravity"]);
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
// sha256 of the .cursor/mcp.json Tentacles last wrote; any other file there refuses.
export const CURSOR_MARKER = ".jack-cursor-mcp";
const sha256 = text => createHash("sha256").update(text).digest("hex");
// OpenCode loads `<directory>/opencode.json` for the folder T3 passes per request,
// also on the one server T3 shares across threads, and re-reads it on the next turn.
export const OPENCODE_FILE = "opencode.json";
// Antigravity discovers plugins under the workspace's `.agents/plugins/` (enabled
// by default) and launches each plugin's `mcp_config.json` servers. T3 starts it
// with cwd = the thread folder and hands over only its own `t3-code` server.
export const ANTIGRAVITY_DIRS = Object.freeze([".agents", path.join(".agents", "plugins"), path.join(".agents", "plugins", "jack-tools")]);
export const ANTIGRAVITY_PLUGIN = path.join(".agents", "plugins", "jack-tools", "plugin.json");
export const ANTIGRAVITY_FILE = path.join(".agents", "plugins", "jack-tools", "mcp_config.json");
// sha256 of the plugin.json and mcp_config.json Tentacles last wrote. Those two files
// without a matching marker refuse, and so does any other entry in jack-tools.
export const ANTIGRAVITY_MARKER = ".jack-antigravity-mcp";
// sha256 of the opencode.json Tentacles last wrote; any other file there refuses (B3 P3-1 on #109).
export const OPENCODE_MARKER = ".jack-opencode-mcp";

const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_LIFETIME_MS = 120_000;
const MAX_SERVERS = 16;
// token68 only: OpenCode expands {env:...} and {file:...} inside config strings.
const BEARER = /^Bearer [A-Za-z0-9._~+/-]{1,16384}=*$/;

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
    throw new Error(R.labWithoutJackTools);
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

export function writePrivate(file, text) {
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

// A lab that finds project config by walking up to the git top level (Cursor, Grok,
// Antigravity) would read the owner's repository: refuse when `start` or any parent
// has a `.git` entry. Git variables in T3's own environment are not seen.
function refuseGitAncestor(start, text) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) throw new Error(text);
    if (path.dirname(dir) === dir) return;
  }
}

/**
 * Read-only: refuses, before any session stop, every workspace shape the writer
 * would refuse later. `.claude` and `.codex` must be real directories (or
 * absent) and the four files must not be directories. The Bot can plant either.
 */
export function checkBotConnectorPaths(workspace, { opencode = false, cursor = false, antigravity = false } = {}) {
  const kind = file => { try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
  // Outer before inner, so no lstat ever runs through a planted link.
  for (const directory of [path.dirname(GUARD_FILE), CODEX_DIR, ...(cursor ? [CURSOR_DIR] : []), ...(antigravity ? ANTIGRAVITY_DIRS : [])]) {
    const info = kind(path.join(workspace, directory));
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(R.realDirectory);
  }
  for (const file of [MCP_FILE, CODEX_FILE, GUARD_FILE, GROK_TRUST_MARKER, ...(opencode ? [OPENCODE_FILE, OPENCODE_MARKER] : []), ...(cursor ? [CURSOR_FILE, CURSOR_MARKER] : []), ...(antigravity ? [ANTIGRAVITY_PLUGIN, ANTIGRAVITY_FILE, ANTIGRAVITY_MARKER] : [])]) {
    if (kind(path.join(workspace, file))?.isDirectory()) throw new Error(R.fileIsDirectory);
  }
  // Unproven OpenCode road: only an admitted OpenCode turn looks at opencode.json.
  if (opencode) {
    const found = kind(path.join(workspace, OPENCODE_FILE));
    let mark = null;
    if (found) try { if (kind(path.join(workspace, OPENCODE_MARKER))?.isFile()) mark = readFileSync(path.join(workspace, OPENCODE_MARKER), "utf8").trim(); } catch { /* none */ }
    if (found && (!found.isFile() || mark !== sha256(readFileSync(path.join(workspace, OPENCODE_FILE), "utf8")))) throw new Error(R.opencodeFileNotOurs);
  }
  // Unproven Antigravity road: only an admitted Antigravity turn looks at its plugin files.
  if (antigravity) {
    // Antigravity walks up from its cwd to the repository root for customizations (B3 P3-1 on #113).
    refuseGitAncestor(workspace, R.antigravityGitRepo);
    // An owner's folder with anything else (hooks.json, rules/) is never adopted (B3 P3-2 on #113).
    const plugin = path.join(workspace, path.dirname(ANTIGRAVITY_PLUGIN));
    if (kind(plugin) && readdirSync(plugin).some(name => name !== "plugin.json" && name !== "mcp_config.json")) throw new Error(R.antigravityFileNotOurs);
    const files = [ANTIGRAVITY_PLUGIN, ANTIGRAVITY_FILE].map(file => [file, kind(path.join(workspace, file))]);
    if (files.some(([, info]) => info)) {
      let mark = null;
      try { if (kind(path.join(workspace, ANTIGRAVITY_MARKER))?.isFile()) mark = readFileSync(path.join(workspace, ANTIGRAVITY_MARKER), "utf8").trim(); } catch { /* none */ }
      if (files.some(([, info]) => !info?.isFile()) || mark !== sha256(files.map(([file]) => readFileSync(path.join(workspace, file), "utf8")).join(""))) throw new Error(R.antigravityFileNotOurs);
    }
  }
  // Unproven Cursor road: only an admitted Cursor turn looks at Cursor's files.
  if (!cursor) return;
  // Cursor reads the git top level's .cursor/mcp.json, which may be the owner's.
  refuseGitAncestor(workspace, R.cursorGitRepo);
  const info = kind(path.join(workspace, CURSOR_FILE));
  if (info) {
    let mark = null;
    try { if (kind(path.join(workspace, CURSOR_MARKER))?.isFile()) mark = readFileSync(path.join(workspace, CURSOR_MARKER), "utf8").trim(); } catch { /* none */ }
    if (!info.isFile() || mark !== sha256(readFileSync(path.join(workspace, CURSOR_FILE), "utf8"))) throw new Error(R.cursorFileNotOurs);
  }
}

// Names match NAME and values are printable ASCII (URL.href, token68 BEARER), so a JSON
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
  let settings;
  try { settings = await client.getSettings(); } catch { /* unreadable settings: T3's own default below */ }
  return codexHomeFromSettings(settings, { home });
}

export function codexHomeFromSettings(settings, { home = os.homedir(), instanceId = "codex" } = {}) {
  const configured = settings?.providerInstances?.[instanceId]?.config?.homePath ?? settings?.providers?.codex?.homePath ?? "";
  if (typeof configured !== "string" || !configured.trim()) return path.join(home, ".codex");
  const value = configured.trim();
  return path.resolve(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
}

// KRA-10891: the server names the Codex home config defines. Codex deep-merges a
// project `[mcp_servers.<name>]` into the home's table of the same name, so an
// owner's keys (`command`, `bearer_token_env_var`, headers, `enabled`) would join a
// Bot's entry. `inline` is a top-level `mcp_servers = {…}` (names not parsed); `form`
// is a quoted `mcp_servers` root, an escaped first key or an escaped name, which Codex
// reads but this does not, or a file that is not TOML.
export function codexServerNames(text) {
  const names = new Set();
  let inline = false, form = false, table = false, headerSeen = false;
  const key = String.raw`("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
  const header = new RegExp(String.raw`^\[\s*${key}\s*(?:\.\s*${key}\s*)?[\].]`);
  const keyLine = new RegExp(String.raw`^${key}\s*(?:\.\s*${key}\s*)?[.=]`);
  const bare = value => value.replace(/^"(.*)"$|^'(.*)'$/s, "$1$2");
  const add = name => { if (name.startsWith('"') && name.includes("\\")) form = true; else names.add(bare(name)); };
  const isRoot = name => {
    // An escaped quoted first key may spell mcp_servers (B3 P3-2 on #116).
    if (name.startsWith('"') && name.includes("\\")) { form = true; return false; }
    if (bare(name) !== "mcp_servers") return false;
    if (name !== "mcp_servers") form = true; // a quoted root key
    return true;
  };
  // B3 P2-1/P2-2/P3-1 on #117: a line counts only if it starts outside every string,
  // comment and open value; a file that is not TOML (an open string or value) is `form`.
  const starts = codexLineStarts(String(text));
  if (!starts) return { names, inline, form: true };
  String(text).split(/\r?\n/).forEach((raw, n) => {
    if (!starts[n]) return;
    const line = raw.trim();
    if (line.startsWith("[")) {
      headerSeen = true;
      table = false;
      if (line.startsWith("[[")) return; // an array of tables is not a server
      const match = header.exec(line);
      if (match && isRoot(match[1])) { if (match[2]) add(match[2]); else table = true; }
      return;
    }
    const match = keyLine.exec(line);
    if (!match) return;
    if (table) add(match[1]);
    // Dotted and inline keys name a server only at the top level, before any header.
    else if (!headerSeen && isRoot(match[1])) { if (match[2]) add(match[2]); else inline = true; }
  });
  return { names, inline, form };
}

// One character pass over a TOML file. For each line: does it start in the plain state
// (no open string, comment, array or inline table)? null when the file is not TOML:
// it ends inside a string or value, a one-line string runs past its line, or a bracket
// closes nothing. A header's own brackets and a value's nesting are told apart by place:
// a `[` that opens a line at depth 0 starts a header.
function codexLineStarts(text) {
  const starts = [true];
  let state = null, depth = 0, header = false, lineStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\n") {
      if (state === '"' || state === "'") return null;
      if (state === "#") state = null;
      header = false;
      lineStart = i + 1;
      starts.push(state === null && depth === 0);
    } else if (state === "#") {
      // a comment runs to the end of its line
    } else if (state === '"""' || state === "'''") {
      if (c === "\\" && state === '"""') { if (text[i + 1] !== "\n") i += 1; } else if (text.startsWith(state, i)) {
        // Up to two more of the same quote belong to the content.
        let run = 3;
        while (text[i + run] === c) run += 1;
        if (run > 5) return null;
        i += run - 1;
        state = null;
      }
    } else if (state === '"') {
      if (c === "\\") { if (text[i + 1] !== "\n") i += 1; } else if (c === '"') state = null;
    } else if (state === "'") {
      if (c === "'") state = null;
    } else if (c === "#") state = "#";
    else if (text.startsWith('"""', i) || text.startsWith("'''", i)) { state = text.slice(i, i + 3); i += 2; }
    else if (c === '"' || c === "'") state = c;
    else if (header) {
      // a header's brackets are not a value's
    } else if (c === "[" && depth === 0 && starts.at(-1) && !text.slice(lineStart, i).trim()) header = true;
    else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") { if (depth === 0) return null; depth -= 1; }
  }
  return state === null || state === "#" ? (depth === 0 ? starts : null) : null;
}

export function checkCodexServerNames(codexHome, names) {
  let text = "";
  try { text = readFileSync(path.join(codexHome, "config.toml"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const owner = codexServerNames(text);
  if (names.some(name => owner.names.has(name))) throw new Error(R.codexServerClash);
  if (owner.inline || owner.form) throw new Error(R.codexServersForm);
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

/**
 * Writes a planCodexTrust or planGrokTrust plan; a concurrent change since the plan refuses.
 * shortcut: Grok's own trusted_folders.toml.lock is not taken, so a Grok rewrite landing
 * between the compare and the rename (microseconds) is lost; take it if that is ever seen.
 */
export function commitCodexTrust(plan) {
  if (!plan) return false;
  const { file, text, mode, next, changed = R.codexChanged } = plan;
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
  try { fchmodSync(fd, mode); writeSync(fd, next); } catch (error) { closeSync(fd); unlinkSync(temporary); throw error; }
  closeSync(fd);
  try {
    let now = "";
    try { now = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (now !== text) throw new Error(changed);
    renameSync(temporary, file);
  } catch (error) { unlinkSync(temporary); throw error; }
  return true;
}

/**
 * The Grok home T3's `grok` instance uses: the last GROK_HOME in its environment list
 * (T3 merges that list over its own env, last wins), else ~/.grok. A GROK_HOME exported
 * to T3's own process environment is not seen here.
 */
export async function grokHomeFor(client, { home = os.homedir(), strict = false } = {}) {
  let entries = [];
  try {
    const environment = (await client.getSettings())?.providerInstances?.grok?.environment;
    entries = Array.isArray(environment) ? environment.filter(entry => entry?.name === "GROK_HOME") : [];
  } catch (error) {
    // strict (B3 P3-1 on #115): a removal must not guess ~/.grok when settings fail.
    if (strict) throw error;
  }
  if (!entries.length) return path.join(home, ".grok");
  const value = entries.at(-1).value;
  if (value === "") return path.join(home, ".grok");
  // T3 passes the value as it is; Grok would resolve a relative one from the thread folder.
  const expanded = typeof value !== "string" ? null : value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  if (!expanded || expanded !== expanded.trim() || !path.isAbsolute(expanded)) throw new Error(R.grokHomeForm);
  // resolve, not normalize: no trailing slash, so it equals the home a marker records (B3 P3-3 on #117).
  return path.resolve(expanded);
}

/**
 * Grok starts a folder's own MCP servers (its `.mcp.json` or `.grok/config.toml`)
 * only when `<Grok home>/trusted_folders.toml` trusts that folder. Grok writes
 * that file itself as `[folders."<path>"]` tables with `trusted` and
 * `decided_at`; anything else in it refuses, so the owner's file never breaks.
 * An existing trusted table for the folder stays as it is; an untrusted one refuses,
 * and so does a folder inside a git repository (Grok decides at the repository root).
 */
export function planGrokTrust(grokHome, workspace, { now = Date.now } = {}) {
  refuseGitAncestor(path.dirname(workspace), R.grokGitRepo);
  const { file, text, mode, tables } = readGrokTrust(grokHome, { create: true });
  const header = `[folders.${JSON.stringify(workspace)}]`;
  if (tables.has(header)) {
    if (tables.get(header).trusted !== "true") throw new Error(R.grokNotTrusted);
    return null;
  }
  const decidedAt = Math.floor(now() / 1000);
  const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${header}\ntrusted = true\ndecided_at = ${decidedAt}\n`;
  return { file, text, mode, next, changed: R.grokChanged, decidedAt };
}

/**
 * B3 P3-5 / delta P2-1 and P2-2 on #110: a Grok turn in a Bot workspace with no list
 * (or an empty one) drops the trust Tentacles added, so Bot-written Grok config never
 * runs in a later session without tools. Only Tentacles' own table goes: the marker
 * Tentacles wrote holds its `decided_at`, and the table must be the header followed
 * directly by exactly `trusted = true` and that `decided_at`. Null otherwise.
 */
export const GROK_TRUST_MARKER = ".jack-grok-trust";
export function planGrokUntrust(grokHome, workspace, decidedAt) {
  const { file, text, mode, tables } = readGrokTrust(grokHome, { create: false });
  if (file === undefined) return null;
  const lines = text.split("\n");
  const header = `[folders.${JSON.stringify(workspace)}]`;
  const at = lines.findIndex(line => line.trim() === header);
  // Exactly one such table with exactly two keys, or the file stays as it is.
  if (at < 0 || lines.filter(line => line.trim() === header).length !== 1 || tables.get(header)?.keys !== 2) return null;
  const pair = lines.slice(at + 1, at + 3).map(line => line.trim()).sort();
  if (pair[0] !== `decided_at = ${decidedAt}` || pair[1] !== "trusted = true") return null;
  lines.splice(at, 3);
  return { file, text, mode, next: lines.join("\n"), changed: R.grokChanged };
}

// Grok's own form only: blank or comment lines, `[folders."<path>"]` headers, and
// `trusted` / `decided_at` inside those tables. Anything else refuses.
function readGrokTrust(grokHome, { create }) {
  try {
    if (create) mkdirSync(grokHome, { recursive: true, mode: 0o700 });
    if (!statSync(grokHome).isDirectory()) throw new Error(R.grokHomeNotDirectory);
  } catch (error) {
    if (!create && error.code === "ENOENT") return { text: "", tables: new Map() };
    if (["EEXIST", "ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw new Error(R.grokHomeNotDirectory);
    throw error;
  }
  const file = path.join(grokHome, "trusted_folders.toml");
  if ((() => { try { return lstatSync(file).isSymbolicLink(); } catch (error) { if (error.code === "ENOENT") return false; throw error; } })()) {
    throw new Error(R.grokTrustLink);
  }
  let text = "";
  let mode = 0o600;
  try { text = readFileSync(file, "utf8"); mode = statSync(file).mode & 0o777; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tables = new Map();
  let table = null;
  for (const line of text.split(/\r?\n/).map(value => value.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    if (/^\[folders\."[^"\\]*"\]$/.test(line)) { table = { keys: 0 }; tables.set(line, table); continue; }
    const pair = table && /^(trusted|decided_at) = (true|false|\d{1,15})$/.exec(line);
    if (!pair) throw new Error(R.grokTrustForm);
    table[pair[1]] = pair[2];
    table.keys += 1;
  }
  return { file, text, mode, tables };
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
export function writeBotConnectors(workspace, prepared, servers, { codexHome, codexTrust, opencode = false, cursor = false, antigravity = false } = {}) {
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
  if (cursor) {
    const text = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
    realDirectory(path.join(workspace, CURSOR_DIR));
    writePrivate(path.join(workspace, CURSOR_FILE), text);
    writePrivate(path.join(workspace, CURSOR_MARKER), `${sha256(text)}\n`);
  }
  // Unproven: only an admitted Antigravity turn writes the plugin (other labs may scan `.agents/`).
  if (antigravity) {
    const plugin = `${JSON.stringify({ name: "jack-tools", description: "Agent Jack tools for this Bot, rewritten by Tentacles before every turn" }, null, 2)}\n`;
    const config = `${JSON.stringify({ mcpServers: Object.fromEntries(servers.map(server => [server.name, {
      url: server.url, ...(server.headers.length ? { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } : {}),
    }])) }, null, 2)}\n`;
    for (const directory of ANTIGRAVITY_DIRS) realDirectory(path.join(workspace, directory));
    writePrivate(path.join(workspace, ANTIGRAVITY_PLUGIN), plugin);
    writePrivate(path.join(workspace, ANTIGRAVITY_FILE), config);
    writePrivate(path.join(workspace, ANTIGRAVITY_MARKER), `${sha256(plugin + config)}\n`);
  }
  realDirectory(path.join(workspace, CODEX_DIR));
  writePrivate(path.join(workspace, CODEX_FILE), `# Written by Tentacles before every Jack Bot turn.\n${codexToml(servers)}`);
  // Unproven: only an admitted OpenCode turn reads or writes opencode.json.
  if (opencode) {
    const text = `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: Object.fromEntries(servers.map(server => [server.name, {
      type: "remote", url: server.url, oauth: false,
      ...(server.headers.length ? { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } : {}),
    }])) }, null, 2)}\n`;
    writePrivate(path.join(workspace, OPENCODE_FILE), text);
    writePrivate(path.join(workspace, OPENCODE_MARKER), `${sha256(text)}\n`);
  }
  // Claude Code asks before it loads a project `.mcp.json`; a Bot turn has
  // nobody to ask. Only this file, which is rewritten every turn, is approved.
  const settings = path.join(workspace, GUARD_FILE);
  writePrivate(settings, `${JSON.stringify({ ...readJson(settings), enableAllProjectMcpServers: servers.length > 0 }, null, 2)}\n`);
  return true;
}

