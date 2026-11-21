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
 * so the caller restarts the thread's session whenever `restart` is true.
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
function jackOrigin(server) {
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
  return jackOrigin(server) !== null && server.headers.length === 1 && exactKeys(header, ["name", "value"])
    && header.name === "Authorization" && typeof header.value === "string" && BEARER.test(header.value);
}

/**
 * Split the connector fields off remote params. Returns `servers` undefined
 * when Jack sent none (files stay as they are), else the validated list.
 * Every refusal happens here, before the workspace or T3 is touched.
 */
export function admitBotConnectors(params, { now = Date.now } = {}) {
  const { mcpServers, mcpScope, mcpExpiresAt, ...rest } = params;
  if (mcpServers === undefined) {
    if (mcpScope !== undefined || mcpExpiresAt !== undefined) throw new Error("Bot connector metadata requires mcpServers");
    return { params: rest, servers: undefined };
  }
  if (!Array.isArray(mcpServers) || mcpServers.length > MAX_SERVERS || !mcpServers.every(admittedServer)
      || new Set(mcpServers.map(server => server.name)).size !== mcpServers.length
      // Jack's own entries all come from the one Jack that sent the turn.
      || new Set(mcpServers.filter(server => server.url !== PUBLIC_MCP_URL).map(jackOrigin)).size > 1) {
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
  return { params: rest, servers: mcpServers };
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
  renameSync(temporary, file);
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
 * folder. Add the one table for this Bot workspace, once; an existing table for
 * it (trusted or not) is the owner's and stays. An inline `projects = {...}`
 * cannot take a new table, so that refuses instead of breaking the owner's file.
 */
export function trustCodexWorkspace(codexHome, workspace) {
  const file = path.join(codexHome, "config.toml");
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const key = JSON.stringify(workspace);
  const single = `'${workspace}'`;
  if (text.split(/\r?\n/).some(line => [`[projects.${key}]`, `[projects.${single}]`].includes(line.trim()))) return false;
  if (/^\s*projects\s*=/m.test(text)) throw new Error("Codex home config keeps projects inline; trust this Bot workspace in Codex first");
  if (!text) {
    realDirectory(codexHome);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(fd);
  }
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}\n# Agent Jack Bot workspace (Tentacles, KRA-10862)\n[projects.${key}]\ntrust_level = "trusted"\n`);
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
 * Returns `{ restart }`: true when a live lab session would hold a stale list or token.
 */
export function writeBotConnectors(workspace, prepared, servers, { codexHome } = {}) {
  if (servers === undefined) return { restart: false };
  if (prepared !== true) {
    if (servers.length) throw new Error("Bot connectors need a Bot workspace");
    return { restart: false };
  }
  // Tokens change every turn, so a non-empty list always needs a fresh session;
  // an empty list after an empty list changes nothing.
  const restart = servers.length > 0 || listedServers(workspace) > 0;
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
  return { restart };
}

