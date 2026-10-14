import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultStateDir, executableCandidates, pathFor, readEnvPath, redactHomePaths, signalProcessTree } from "./platform.mjs";

// KRA-7369: capability awareness. Tentacles does not build connectors; it tells
// agents which vendor CLIs, MCP servers, plugins and skills exist on this
// computer, whether they are signed in, and the one fix when they are not.
// Design and redaction rules: docs/capability-awareness.md.

export const CAPABILITIES_SCHEMA = "tentacles.capabilities.v1";
export const CAPABILITY_REGISTRY_VERSION = "2026-10-14.1";
export const DEFAULT_CAPABILITIES_FILE = path.join(defaultStateDir(), "capabilities.v1.json");
export const PROBE_TIMEOUT_MS = 5_000;
export const SCAN_DEADLINE_MS = 30_000;
export const PROBE_CONCURRENCY = 4;
export const CAPABILITY_REFRESH_MS = 5 * 60_000;
export const CAPABILITY_MIN_SCAN_INTERVAL_MS = 30_000;

const MAX_PROBE_STDOUT_BYTES = 4096;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const LIMITS = Object.freeze({ clis: 64, mcp: 256, plugins: 256, skills: 512 });
const SAFE_NAME = /^[A-Za-z0-9@._:+\/-]{1,128}$/;
const SAFE_VERSION = /^[0-9][A-Za-z0-9.+-]{0,63}$/;
const VERSION_TOKEN = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)\b/;

// Curated registry. A probe is an argv run without a shell, without stdin and
// under a timeout. Only the exit code is read for auth ("exit"), or whether
// stdout is non-empty ("stdout-nonempty"); auth output is never kept. Probes
// marked verified:false have not been checked against a signed-out account yet,
// so their non-zero exits other than signedOutExitCodes report "unknown".
// Vault and password-manager CLIs are deliberately absent and never probed.
export const CAPABILITY_REGISTRY = Object.freeze([
  cli("gh", "GitHub CLI", ["github"], "forge", {
    auth: { args: ["auth", "status"], mode: "exit", verified: true },
    install: { darwin: "brew install gh", linux: "Install gh from https://cli.github.com", win32: "winget install --id GitHub.cli" },
    signIn: "gh auth login",
  }),
  cli("glab", "GitLab CLI", ["gitlab"], "forge", {
    auth: { args: ["auth", "status"], mode: "exit", verified: false },
    install: { darwin: "brew install glab", linux: "Install glab from https://gitlab.com/gitlab-org/cli", win32: "winget install --id GLab.GLab" },
    signIn: "glab auth login",
  }),
  cli("tea", "Forgejo/Gitea CLI", ["forgejo", "gitea"], "forge", {
    install: { darwin: "brew install tea", linux: "Install tea from https://gitea.com/gitea/tea", win32: "Install tea from https://gitea.com/gitea/tea" },
    signIn: "tea login add",
  }),
  cli("linear", "Linear CLI", ["linear"], "work", {
    install: { default: "npm install -g @schpet/linear-cli" },
    signIn: "linear auth login",
  }),
  cli("gcloud", "Google Cloud CLI", ["google-cloud", "gcp"], "cloud", {
    auth: { args: ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], mode: "stdout-nonempty", verified: true },
    install: { darwin: "brew install --cask google-cloud-sdk", linux: "Install from https://cloud.google.com/sdk/docs/install", win32: "Install from https://cloud.google.com/sdk/docs/install" },
    signIn: "gcloud auth login",
  }),
  cli("gws", "Google Workspace CLI", ["gmail", "google-drive", "google-calendar", "google-workspace"], "work", {
    install: { default: "npm install -g @googleworkspace/cli" },
    signIn: "gws auth login",
  }),
  cli("slack", "Slack CLI", ["slack"], "chat", {
    install: { default: "Install from https://tools.slack.dev/slack-cli" },
    signIn: "slack login",
  }),
  cli("claude", "Claude Code", ["claude-code"], "lab", {
    auth: { args: ["auth", "status"], mode: "exit", verified: false },
    install: { default: "npm install -g @anthropic-ai/claude-code" },
    signIn: "claude auth login",
  }),
  cli("codex", "Codex CLI", ["codex"], "lab", {
    auth: { args: ["login", "status"], mode: "exit", verified: false },
    install: { default: "npm install -g @openai/codex" },
    signIn: "codex login",
  }),
  cli("cursor-agent", "Cursor Agent", ["cursor"], "lab", {
    install: { default: "curl https://cursor.com/install -fsS | bash" },
    signIn: "cursor-agent login",
  }),
  cli("grok", "Grok Code", ["grok"], "lab", {
    install: { default: "Install Grok Code from https://x.ai" },
    signIn: "grok login",
  }),
  cli("opencode", "OpenCode", ["opencode"], "lab", {
    install: { default: "npm install -g opencode-ai" },
    signIn: "opencode auth login",
  }),
  cli("gemini", "Gemini CLI", ["gemini"], "lab", {
    install: { default: "npm install -g @google/gemini-cli" },
    signIn: "gemini (choose Login with Google)",
  }),
  cli("uv", "uv", ["python-tools"], "toolchain", { install: { default: "curl -LsSf https://astral.sh/uv/install.sh | sh" } }),
  cli("npm", "npm", ["node-tools"], "toolchain", { install: { default: "Install Node.js 22+ from https://nodejs.org" } }),
  cli("docker", "Docker", ["containers"], "toolchain", { install: { default: "Install Docker from https://docs.docker.com/get-docker" } }),
]);

function cli(bin, name, services, category, { version = ["--version"], auth = null, install, signIn = null }) {
  return Object.freeze({ id: bin, bin, name, services: Object.freeze(services), category, version, auth, install, signIn });
}

// Service words an MCP server or plugin name can carry. "file this in Linear"
// resolves to `linear` whether a CLI or an MCP server provides it.
export const SERVICE_KEYWORDS = Object.freeze({
  linear: ["linear"],
  clickup: ["clickup"],
  github: ["github"],
  gitlab: ["gitlab"],
  forgejo: ["forgejo", "gitea"],
  slack: ["slack"],
  notion: ["notion"],
  gmail: ["gmail"],
  "google-drive": ["gdrive", "google-drive", "googledrive"],
  "google-calendar": ["gcal", "google-calendar", "calendar"],
  "google-workspace": ["google-workspace", "gworkspace"],
  telegram: ["telegram"],
  whatsapp: ["whatsapp"],
  sentry: ["sentry"],
  figma: ["figma"],
  jira: ["jira", "atlassian"],
  playwright: ["playwright"],
  browser: ["browser", "chrome", "puppeteer"],
});

export function servicesForName(name) {
  const lower = String(name).toLowerCase();
  return Object.entries(SERVICE_KEYWORDS)
    .filter(([, words]) => words.some((word) => lower.includes(word)))
    .map(([service]) => service);
}

export function installHint(entry, platform = process.platform) {
  return entry.install?.[platform] ?? entry.install?.default ?? null;
}

// ---------------------------------------------------------------------------
// Probes

/** Runs one argv without a shell, returns { code, stdout, timedOut, error }. Stderr is discarded. */
export function runProbe(file, args, {
  timeoutMs = PROBE_TIMEOUT_MS,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stdout = Buffer.alloc(0);
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnImpl(file, args, {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        detached: platform !== "win32",
        env: probeEnvironment(env, platform),
      });
    } catch {
      finish({ code: null, stdout: "", timedOut: false, error: "spawn_failed" });
      return;
    }
    timer = setTimeout(() => {
      signalProcessTree(child, "SIGKILL", { platform, env });
      finish({ code: null, stdout: "", timedOut: true, error: null });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_PROBE_STDOUT_BYTES) stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_PROBE_STDOUT_BYTES);
    });
    child.on("error", () => finish({ code: null, stdout: "", timedOut: false, error: "spawn_failed" }));
    child.on("close", (code) => finish({ code, stdout: stdout.toString("utf8"), timedOut: false, error: null }));
  });
}

/** The parent environment plus non-interactive switches, so no probe can open a login flow. */
export function probeEnvironment(env = process.env, platform = process.platform) {
  const copy = { ...env, NO_COLOR: "1", TERM: "dumb", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NONINTERACTIVE: "1" };
  // A probe that tries to open a browser gets a no-op and then hits its timeout.
  copy.BROWSER = platform === "win32" ? "cmd /c rem" : "true";
  return copy;
}

export function parseVersion(stdout) {
  const match = VERSION_TOKEN.exec(String(stdout ?? "").slice(0, MAX_PROBE_STDOUT_BYTES));
  return match && SAFE_VERSION.test(match[1]) ? match[1] : null;
}

export function authFromProbe(auth, result) {
  if (result.timedOut) return "timeout";
  if (result.error || result.code === null) return "unknown";
  if (auth.mode === "stdout-nonempty") {
    if (result.code !== 0) return "unknown";
    return result.stdout.trim() ? "signed_in" : "signed_out";
  }
  if (result.code === 0) return "signed_in";
  const signedOut = auth.signedOutExitCodes ?? [1];
  return auth.verified !== false && signedOut.includes(result.code) ? "signed_out" : "unknown";
}

/** Directories searched beyond PATH: service managers often start Tentacles with a short PATH. */
export function extraSearchDirectories({ home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") return [];
  const paths = pathFor(platform);
  return [
    paths.join(home, ".local", "bin"),
    paths.join(home, ".local", "node", "bin"),
    paths.join(home, "bin"),
    paths.join(home, ".grok", "bin"),
    paths.join(home, ".cargo", "bin"),
    paths.join(home, ".bun", "bin"),
    paths.join(home, ".npm-global", "bin"),
    paths.join(home, "go", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

function isExecutableFile(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function locateExecutable(bin, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const searchPath = readEnvPath(env, platform);
  for (const candidate of executableCandidates(bin, searchPath, { platform, env })) {
    if (isExecutableFile(candidate, platform)) return { file: candidate, onPath: true };
  }
  const extra = extraSearchDirectories({ home, platform }).join(pathFor(platform).delimiter);
  for (const candidate of executableCandidates(bin, extra, { platform, env })) {
    if (isExecutableFile(candidate, platform)) return { file: candidate, onPath: false };
  }
  return null;
}

async function inspectCli(entry, { env, platform, home, timeoutMs, spawnImpl }) {
  const base = {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    services: [...entry.services],
    installed: false,
    onPath: false,
    where: null,
    version: null,
    auth: "not_applicable",
    state: "missing",
    fix: null,
  };
  const located = locateExecutable(entry.bin, { env, platform, home });
  if (!located) return { ...base, fix: { kind: "install", command: installHint(entry, platform) } };
  const row = { ...base, installed: true, onPath: located.onPath, where: located.file, state: "installed" };
  // Windows .cmd/.bat shims need a shell to run; Tentacles never spawns one for a probe.
  const needsShell = platform === "win32" && /\.(?:cmd|bat)$/i.test(located.file);
  const probe = (args) => (needsShell
    ? Promise.resolve({ code: null, stdout: "", timedOut: false, error: "shell_required" })
    : runProbe(located.file, args, { timeoutMs, env, platform, spawnImpl }));
  const versionResult = await probe(entry.version);
  if (versionResult.timedOut) {
    row.state = "probe_timeout";
    if (entry.auth) row.auth = "unknown";
    return row;
  }
  row.version = versionResult.code === 0 ? parseVersion(versionResult.stdout) : null;
  if (entry.auth) {
    row.auth = authFromProbe(entry.auth, await probe(entry.auth.args));
    if (row.auth === "signed_in") row.state = "signed_in";
    else if (row.auth === "signed_out") row.state = "signed_out";
    else if (row.auth === "timeout") row.state = "probe_timeout";
    else row.state = "installed";
  } else if (entry.signIn) {
    row.auth = "unknown";
  }
  if (row.state === "signed_out" && entry.signIn) row.fix = { kind: "sign_in", command: entry.signIn };
  if (!row.onPath) row.fix ??= { kind: "path", command: `Add ${pathFor(platform).dirname(located.file)} to PATH` };
  return row;
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Lab configuration: NAMES only. Each reader returns names and a small closed
// set of flags; no value from a config file is ever copied into the result.

function readBounded(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file, { jsonc = false } = {}) {
  const text = readBounded(file);
  if (text === null) return null;
  try { return JSON.parse(jsonc ? stripJsonComments(text) : text); } catch { return null; }
}

/** Removes // and /* *\/ comments and trailing commas outside strings. */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") { out += text[i + 1] ?? ""; i += 1; }
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; out += char; continue; }
    if (char === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; out += "\n"; continue; }
    if (char === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1; i += 1; continue; }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function transportOf(server) {
  if (!isRecord(server)) return "unknown";
  if (server.type === "stdio" || server.type === "local" || typeof server.command === "string" || Array.isArray(server.command)) return "stdio";
  if (["http", "sse", "streamable-http", "remote"].includes(server.type) || typeof server.url === "string" || typeof server.httpUrl === "string" || typeof server.serverUrl === "string") return "http";
  return "unknown";
}

function enabledOf(server) {
  if (!isRecord(server)) return true;
  return server.disabled !== true && server.enabled !== false;
}

function mcpEntries(lab, servers, scope) {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, server]) => ({
    lab,
    name,
    scope,
    transport: transportOf(server),
    state: enabledOf(server) ? "configured" : "disabled",
  }));
}

function directoryNames(directory, { requireFile } = {}) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
      .filter((entry) => !requireFile || fs.existsSync(path.join(directory, entry.name, requireFile)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Names of `[mcp_servers.<name>]` tables in a Codex config.toml, plus `enabled = false`. */
export function codexTomlMcpServers(text) {
  const servers = new Map();
  let current = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
    if (header) {
      current = header[1] ?? header[2] ?? header[3];
      if (!servers.has(current)) servers.set(current, { enabled: true, transport: "unknown" });
      continue;
    }
    if (line.startsWith("[")) { current = null; continue; }
    if (!current) continue;
    const entry = servers.get(current);
    if (/^enabled\s*=\s*false\b/.test(line)) entry.enabled = false;
    if (/^command\s*=/.test(line)) entry.transport = "stdio";
    if (/^url\s*=/.test(line)) entry.transport = "http";
  }
  return servers;
}

const CODEX_AUTH_STATES = Object.freeze({
  o_auth: "signed_in",
  oauth: "signed_in",
  bearer_token: "signed_in",
  not_logged_in: "signed_out",
  unsupported: "configured",
});

async function readCodex({ home, env, platform, timeoutMs, spawnImpl }) {
  const servers = codexTomlMcpServers(readBounded(path.join(home, ".codex", "config.toml")));
  const mcp = [...servers].map(([name, info]) => ({
    lab: "codex", name, scope: "user", transport: info.transport, state: info.enabled ? "configured" : "disabled",
  }));
  // `codex mcp list --json` knows each server's OAuth state; only name,
  // enabled and auth_status are read from it.
  const codex = servers.size ? locateExecutable("codex", { env, platform, home }) : null;
  if (codex && !(platform === "win32" && /\.(?:cmd|bat)$/i.test(codex.file))) {
    const result = await runProbe(codex.file, ["mcp", "list", "--json"], { timeoutMs, env, platform, spawnImpl });
    let listed = null;
    if (result.code === 0) { try { listed = JSON.parse(result.stdout); } catch { listed = null; } }
    if (Array.isArray(listed)) {
      for (const item of listed) {
        const row = isRecord(item) ? mcp.find((entry) => entry.name === item.name) : null;
        if (!row) continue;
        if (item.enabled === false) row.state = "disabled";
        else row.state = CODEX_AUTH_STATES[item.auth_status] ?? "configured";
      }
    }
  }
  return {
    mcp,
    plugins: [],
    skills: directoryNames(path.join(home, ".codex", "skills")).map((name) => ({ lab: "codex", name })),
  };
}

function readClaude({ home }) {
  const user = readJson(path.join(home, ".claude.json"));
  const mcp = mcpEntries("claude", user?.mcpServers, "user");
  if (isRecord(user?.projects)) {
    const projectNames = new Set();
    for (const project of Object.values(user.projects)) {
      if (isRecord(project?.mcpServers)) for (const name of Object.keys(project.mcpServers)) projectNames.add(name);
    }
    // Project paths are never reported, only that a project scope configures the name.
    for (const name of [...projectNames].sort()) {
      if (!mcp.some((entry) => entry.name === name)) mcp.push({ lab: "claude", name, scope: "project", transport: "unknown", state: "configured" });
    }
  }
  const settings = readJson(path.join(home, ".claude", "settings.json"));
  const installed = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const pluginNames = new Map();
  if (isRecord(installed?.plugins)) for (const name of Object.keys(installed.plugins)) pluginNames.set(name, false);
  if (isRecord(settings?.enabledPlugins)) {
    for (const [name, enabled] of Object.entries(settings.enabledPlugins)) pluginNames.set(name, enabled === true);
  }
  return {
    mcp,
    plugins: [...pluginNames].sort(([a], [b]) => a.localeCompare(b)).map(([name, enabled]) => ({ lab: "claude", name, enabled })),
    skills: directoryNames(path.join(home, ".claude", "skills"), { requireFile: "SKILL.md" }).map((name) => ({ lab: "claude", name })),
  };
}

function readCursor({ home }) {
  return { mcp: mcpEntries("cursor", readJson(path.join(home, ".cursor", "mcp.json"))?.mcpServers, "user"), plugins: [], skills: [] };
}

function readOpenCode({ home }) {
  const directory = path.join(home, ".config", "opencode");
  const config = readJson(path.join(directory, "opencode.json"), { jsonc: true })
    ?? readJson(path.join(directory, "opencode.jsonc"), { jsonc: true });
  return { mcp: mcpEntries("opencode", config?.mcp, "user"), plugins: [], skills: [] };
}

function readGemini({ home }) {
  const settings = readJson(path.join(home, ".gemini", "settings.json"));
  return {
    mcp: mcpEntries("gemini", settings?.mcpServers, "user"),
    plugins: directoryNames(path.join(home, ".gemini", "extensions")).map((name) => ({ lab: "gemini", name, enabled: true })),
    skills: [],
  };
}

export const LAB_CONFIG_READERS = Object.freeze({
  claude: readClaude,
  codex: readCodex,
  cursor: readCursor,
  opencode: readOpenCode,
  gemini: readGemini,
});

// ---------------------------------------------------------------------------
// Redaction: the last gate before anything is written or published.

const SECRET_SHAPES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/,
  /\bglpat-[A-Za-z0-9_-]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{8,}/,
  /\bpk_[A-Za-z0-9_]{16,}/,
  /\bya29\.[A-Za-z0-9_-]{8,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:bearer|basic|token|password|passwd|secret|api[_-]?key)\s*[:=]/i,
  /\bbearer\s+\S{8,}/i,
  /[0-9a-f]{32,}/i,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

// A long base64/base64url run with mixed case and digits. Path separators end a
// run, so long directory names (lowercase words and dashes) are not flagged.
const LONG_TOKEN = /[A-Za-z0-9+_=-]{40,}/g;

export function looksSecret(value) {
  if (SECRET_SHAPES.some((shape) => shape.test(value))) return true;
  return (String(value).match(LONG_TOKEN) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));
}

/**
 * Walks the document. Strings get home paths folded to ~ and are replaced by
 * "[redacted]" when they look like a credential, an email or a URL with
 * userinfo. Names that fail SAFE_NAME are dropped by the caller first.
 */
export function redactCapabilities(document, { home = os.homedir() } = {}) {
  let redactions = 0;
  const walk = (value) => {
    if (typeof value === "string") {
      const folded = redactHomePaths(value, home);
      if (looksSecret(folded)) { redactions += 1; return "[redacted]"; }
      return folded;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  const result = walk(document);
  result.redactions = (result.redactions ?? 0) + redactions;
  return result;
}

function safeNames(rows, limit) {
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    if (typeof row.name !== "string" || !SAFE_NAME.test(row.name) || looksSecret(row.name)) { dropped += 1; continue; }
    kept.push(row);
  }
  return { rows: kept.slice(0, limit), dropped, truncated: kept.length > limit };
}

// One sign-in fix per lab for a signed-out MCP server; the name is a safe name.
const MCP_SIGN_IN = Object.freeze({
  codex: (name) => `codex mcp login ${name}`,
  claude: (name) => `In Claude Code run /mcp and authenticate ${name}`,
  cursor: (name) => `In Cursor open Settings > MCP and sign in to ${name}`,
  opencode: (name) => `opencode mcp auth ${name}`,
  gemini: (name) => `In Gemini CLI run /mcp auth ${name}`,
});

function withMcpFix(row) {
  const signIn = MCP_SIGN_IN[row.lab];
  return { ...row, fix: row.state === "signed_out" && signIn ? { kind: "sign_in", command: signIn(row.name) } : null };
}

// ---------------------------------------------------------------------------
// Scan

/** Optional lab readiness from Tentacles doctor; closed projection, no models. */
export function labsFromDoctor(report) {
  if (!Array.isArray(report?.labs)) return null;
  return report.labs.map((lab) => ({
    instanceId: typeof lab.instanceId === "string" ? lab.instanceId : null,
    name: typeof lab.name === "string" ? lab.name : null,
    ready: lab.ready === true,
    code: typeof lab.code === "string" ? lab.code : null,
    fix: typeof lab.action === "string" ? { kind: "lab", command: lab.action } : null,
  })).filter((lab) => lab.instanceId);
}

export async function scanCapabilities({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  registry = CAPABILITY_REGISTRY,
  readers = LAB_CONFIG_READERS,
  doctorReport,
  timeoutMs = PROBE_TIMEOUT_MS,
  deadlineMs = SCAN_DEADLINE_MS,
  concurrency = PROBE_CONCURRENCY,
  spawnImpl = spawn,
  version = null,
  now = () => Date.now(),
} = {}) {
  const started = now();
  const context = { env, platform, home, timeoutMs, spawnImpl };
  let deadlineHit = false;
  let deadlineTimer;
  const deadline = new Promise((resolve) => { deadlineTimer = setTimeout(() => { deadlineHit = true; resolve(null); }, deadlineMs); });
  try {
    const clisPromise = mapLimited([...registry].slice(0, LIMITS.clis), concurrency, (entry) => (deadlineHit
      ? Promise.resolve({ ...missingRow(entry), state: "probe_timeout", installed: null })
      : inspectCli(entry, context)));
    const labsPromise = Promise.all(Object.entries(readers).map(async ([lab, reader]) => {
      try { return await reader(context); } catch { return { mcp: [], plugins: [], skills: [], error: lab }; }
    }));
    const finished = await Promise.race([Promise.all([clisPromise, labsPromise]), deadline]);
    const [clis, labConfigs] = finished ?? [
      registry.map((entry) => ({ ...missingRow(entry), state: "probe_timeout", installed: null })),
      [],
    ];
    const mcp = safeNames(labConfigs.flatMap((config) => config.mcp ?? []).map((row) => ({ ...row, services: servicesForName(row.name) })), LIMITS.mcp);
    const plugins = safeNames(labConfigs.flatMap((config) => config.plugins ?? []).map((row) => ({ ...row, services: servicesForName(row.name) })), LIMITS.plugins);
    const skills = safeNames(labConfigs.flatMap((config) => config.skills ?? []), LIMITS.skills);
    const document = {
      schema: CAPABILITIES_SCHEMA,
      generatedAt: new Date(now()).toISOString(),
      registryVersion: CAPABILITY_REGISTRY_VERSION,
      tentaclesVersion: version,
      computer: { platform, arch: os.arch() },
      complete: finished !== null,
      durationMs: Math.max(0, now() - started),
      clis,
      mcp: mcp.rows.map(withMcpFix),
      plugins: plugins.rows,
      skills: skills.rows,
      labs: doctorReport ? labsFromDoctor(doctorReport) : null,
      labsState: doctorReport === undefined ? "skipped" : doctorReport ? "ok" : "unavailable",
      truncated: { mcp: mcp.truncated, plugins: plugins.truncated, skills: skills.truncated },
      dropped: mcp.dropped + plugins.dropped + skills.dropped,
      redactions: 0,
    };
    return redactCapabilities(document, { home });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function missingRow(entry) {
  return {
    id: entry.id, name: entry.name, category: entry.category, services: [...entry.services],
    installed: false, onPath: false, where: null, version: null, auth: "unknown", state: "missing", fix: null,
  };
}

export const MAX_PUBLISH_BYTES = 128 * 1024;

/**
 * The inventory shares the 1 MiB pair frame with the lab catalog, so it is
 * capped. Skills go first, then plugins, then MCP rows; CLI rows always stay.
 */
export function boundForPublish(document, maxBytes = MAX_PUBLISH_BYTES) {
  const size = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(document) <= maxBytes) return document;
  const bounded = { ...document, truncated: { ...(document.truncated ?? {}) } };
  for (const key of ["skills", "plugins", "mcp"]) {
    if (size(bounded) <= maxBytes) break;
    const rows = Array.isArray(bounded[key]) ? [...bounded[key]] : [];
    while (rows.length && size({ ...bounded, [key]: rows }) > maxBytes) rows.splice(Math.floor(rows.length / 2));
    bounded[key] = rows;
    bounded.truncated[key] = true;
  }
  return size(bounded) <= maxBytes ? bounded : null;
}

/** Writes the last scan owner-only, atomically, for local agents and `scan --cached`. */
export function writeCapabilitiesFile(document, file = DEFAULT_CAPABILITIES_FILE) {
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return destination;
}

// ---------------------------------------------------------------------------
// Daemon cache: coalesced, rate-limited, refreshed in the background.

export class CapabilityCache {
  constructor({
    scan = scanCapabilities,
    refreshMs = CAPABILITY_REFRESH_MS,
    minIntervalMs = CAPABILITY_MIN_SCAN_INTERVAL_MS,
    file = DEFAULT_CAPABILITIES_FILE,
    persist = writeCapabilitiesFile,
    now = () => Date.now(),
  } = {}) {
    this.scanImpl = scan;
    this.refreshMs = refreshMs;
    this.minIntervalMs = minIntervalMs;
    this.file = file;
    this.persist = persist;
    this.now = now;
    this.current = null;
    this.scannedAt = 0;
    this.pending = null;
  }

  ageMs() {
    return this.current ? this.now() - this.scannedAt : Infinity;
  }

  refresh() {
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => this.scanImpl()).then((document) => {
        this.current = document;
        this.scannedAt = this.now();
        if (this.file && this.persist) { try { this.persist(document, this.file); } catch { /* the RPC answer does not depend on the file */ } }
        return document;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  /** Background refresh hook for the heartbeat: rescans only when the inventory is stale. */
  refreshIfStale() {
    if (this.ageMs() >= this.refreshMs) return this.refresh();
    return Promise.resolve(this.current);
  }

  /** maxAgeMs bounds staleness; never rescans more often than minIntervalMs. */
  async get({ maxAgeMs = this.refreshMs } = {}) {
    const age = this.ageMs();
    if (this.current && (age <= maxAgeMs || age < this.minIntervalMs)) return this.current;
    return this.refresh();
  }
}

// ---------------------------------------------------------------------------
// Text output

export function formatCapabilities(document) {
  const lines = [
    "Tentacles capabilities — connectors on this computer",
    "Names and states only. Never values, tokens or environment.",
    "",
    "CLIs:",
  ];
  for (const row of document.clis ?? []) {
    const parts = [row.id.padEnd(13), String(row.state).padEnd(13), (row.version ?? "").padEnd(10)];
    if (row.where) parts.push(row.onPath ? row.where : `${row.where} (not on PATH)`);
    if (row.fix?.command) parts.push(`fix: ${row.fix.command}`);
    lines.push(`  ${parts.join("  ").trimEnd()}`);
  }
  lines.push("", "MCP servers:");
  if (!document.mcp?.length) lines.push("  none configured");
  for (const row of document.mcp ?? []) lines.push(`  ${row.lab.padEnd(9)} ${row.name.padEnd(28)} ${row.state.padEnd(11)} ${row.transport}`);
  lines.push("", `Plugins: ${document.plugins?.length ?? 0}   Skills: ${document.skills?.length ?? 0}`);
  for (const row of document.plugins ?? []) lines.push(`  ${row.lab.padEnd(9)} ${row.name}${row.enabled ? "" : " (disabled)"}`);
  if (document.labs) {
    lines.push("", `Labs ready: ${document.labs.filter((lab) => lab.ready).map((lab) => lab.instanceId).join(", ") || "none"}`);
  }
  if (!document.complete) lines.push("", "Scan hit its deadline; some rows are probe_timeout.");
  lines.push("", "Machine JSON: tentacles capabilities scan --json");
  return `${lines.join("\n")}\n`;
}
