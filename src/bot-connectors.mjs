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
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { GUARD_FILE } from "./talk-instruction-guard.mjs";

// Jack admits a list only against exactly this advert. Three shapes pass:
// the one reviewed public URL with no headers, Jack's own connector proxy
// (`/mcp/connectors/<name>`) and Jack's own tools (`/mcp`, named `jack`), the
// last two on https with the turn's bearer token. Vendor credentials stay in
// Jack; the token dies with the turn.
export const PUBLIC_MCP_URL = "https://learn.microsoft.com/api/mcp";
export const JACK_SERVER_NAME = "jack";
export const BOT_CONNECTOR_PROVIDERS = Object.freeze(["claudeAgent", "codex"]);
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
export function admitBotConnectors(params, { now = Date.now, jackOrigin = null } = {}) {
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
  if (mcpServers.length && !BOT_CONNECTOR_PROVIDERS.includes(rest.instanceId)) {
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
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Bot connector directory must be a real directory");
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
export function trustCodexWorkspace(codexHome, workspace) {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (!statSync(codexHome).isDirectory()) throw new Error("Codex home is not a directory");
  let file = path.join(codexHome, "config.toml");
  let text = "";
  let mode = 0o600;
  try {
    file = realpathSync(file); // a dotfiles symlink keeps pointing at the owner's real file
    text = readFileSync(file, "utf8");
    mode = statSync(file).mode & 0o777;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const key = JSON.stringify(workspace);
  const single = `'${workspace}'`;
  const lines = text.split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => [`[projects.${key}]`, `[projects.${single}]`].includes(line)
      || line.startsWith(`projects.${key}`) || line.startsWith(`projects.${single}`))) return false;
  if (/^\s*projects\s*[=.]/m.test(text)) throw new Error("Codex home config keeps projects inline; trust this Bot workspace in Codex first");
  const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n# Agent Jack Bot workspace (Tentacles, KRA-10862)\n[projects.${key}]\ntrust_level = "trusted"\n`;
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
  try { writeSync(fd, next); } catch (error) { closeSync(fd); unlinkSync(temporary); throw error; }
  closeSync(fd);
  try {
    let now = "";
    try { now = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (now !== text) throw new Error("Codex home config changed while trusting this Bot workspace; try again");
    renameSync(temporary, file);
  } catch (error) { unlinkSync(temporary); throw error; }
  return true;
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
 * The caller restarts a live session first (connectorsNeedRestart), then writes.
 */
export function writeBotConnectors(workspace, prepared, servers, { codexHome } = {}) {
  if (servers === undefined) return false;
  if (prepared !== true) {
    if (servers.length) throw new Error("Bot connectors need a Bot workspace");
    return false;
  }
  if (codexHome && servers.length) trustCodexWorkspace(codexHome, workspace);
  const mcpServers = Object.fromEntries(servers.map(server => [server.name, {
    type: "http", url: server.url,
    ...(server.headers.length ? { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } : {}),
  }]));
  writePrivate(path.join(workspace, MCP_FILE), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  realDirectory(path.join(workspace, CODEX_DIR));
  writePrivate(path.join(workspace, CODEX_FILE), `# Written by Tentacles before every Jack Bot turn.\n${codexToml(servers)}`);
  // Claude Code asks before it loads a project `.mcp.json`; a Bot turn has
  // nobody to ask. Only this file, which is rewritten every turn, is approved.
  const settings = path.join(workspace, GUARD_FILE);
  writePrivate(settings, `${JSON.stringify({ ...readJson(settings), enableAllProjectMcpServers: servers.length > 0 }, null, 2)}\n`);
  return true;
}

