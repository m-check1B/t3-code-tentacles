// KRA-6203: read-only native plugin inventory for the exact configured lab.
//
// T3 reports native skills but not plugins. Codex lists installed plugins with
// `codex plugin list --json`; that call can take seconds (remote marketplaces),
// so the long-running pairer refreshes it in the background and doctor only
// serves a fresh cached observation. Doctor never waits on the CLI and never
// reports an unobserved or stale list as current.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export const PLUGIN_INVENTORY_VERSION = 1;
export const PLUGIN_INVENTORY_TTL_MS = 10 * 60 * 1000;
const PLUGIN_LIST_TIMEOUT_MS = 60_000;
const PLUGIN_LIST_MAX_BYTES = 1024 * 1024;
const PLUGIN_LIMIT = 256;
const TEXT_MAX = 128;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩/\\]/;
const VERSION_TEXT = /^[A-Za-z0-9._+-]{1,64}$/;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unavailable(instanceId, code) {
  return { instanceId, state: "unavailable", code, count: null, dropped: 0, truncated: false, digest: null, observedAt: null, plugins: [] };
}

function exactText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= TEXT_MAX
    && value === value.trim() && !UNSAFE_TEXT.test(value);
}

// The plugin context of T3's `codex` instance: its binary and CODEX_HOME.
// Launch arguments may override config for app-server sessions, so a lab with
// launch arguments is not attributed an inventory read without them.
export function codexPluginContext(settings) {
  const codex = settings?.providers?.codex;
  if (!codex || codex.enabled === false) return { error: "disabled" };
  if (typeof codex.launchArgs === "string" && codex.launchArgs.trim()) return { error: "launch_args_unverified" };
  const binary = typeof codex.binaryPath === "string" && codex.binaryPath.trim() ? codex.binaryPath.trim() : "codex";
  const home = typeof codex.homePath === "string" && codex.homePath.trim() ? codex.homePath.trim() : null;
  return { binary, home, key: digest(JSON.stringify([binary, home])) };
}

// Installed plugins only. Identity, publisher marketplace, version and enabled
// state; source paths and policies stay on this computer. Nothing is
// normalized: an entry that cannot be represented exactly is dropped.
export function projectCodexPluginList(payload, observedAt) {
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.installed)) return null;
  const rows = [];
  let dropped = 0;
  for (const entry of payload.installed) {
    if (entry?.installed !== true) continue;
    if (
      !exactText(entry.pluginId) || !exactText(entry.name) || !exactText(entry.marketplaceName)
      || typeof entry.version !== "string" || !VERSION_TEXT.test(entry.version)
      || typeof entry.enabled !== "boolean"
    ) {
      dropped += 1;
      continue;
    }
    rows.push({ pluginId: entry.pluginId, name: entry.name, marketplace: entry.marketplaceName, version: entry.version, enabled: entry.enabled });
  }
  rows.sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
  const kept = rows.slice(0, PLUGIN_LIMIT);
  return {
    instanceId: "codex",
    state: "observed",
    code: null,
    count: rows.length,
    dropped,
    truncated: kept.length < rows.length,
    digest: digest(JSON.stringify(rows.map((row) => [row.pluginId, row.marketplace, row.version, row.enabled]))),
    observedAt,
    plugins: kept,
  };
}

function runPluginList({ binary, home }, execFileImpl) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (home) env.CODEX_HOME = home;
    else delete env.CODEX_HOME;
    execFileImpl(binary, ["plugin", "list", "--json"], {
      env,
      timeout: PLUGIN_LIST_TIMEOUT_MS,
      maxBuffer: PLUGIN_LIST_MAX_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export class PluginInventoryCache {
  constructor({ execFileImpl = execFile, now = () => Date.now(), ttlMs = PLUGIN_INVENTORY_TTL_MS } = {}) {
    this.execFileImpl = execFileImpl;
    this.now = now;
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.inflight = new Map();
  }

  // Returns immediately. Starts at most one background refresh per context.
  read(settings, { refresh = true } = {}) {
    const context = codexPluginContext(settings);
    if (context.error) return unavailable("codex", context.error);
    const cached = this.entries.get(context.key);
    const fresh = cached && this.now() - cached.at < this.ttlMs;
    if (!fresh && refresh && !this.inflight.has(context.key)) {
      const pending = this.refresh(context).finally(() => this.inflight.delete(context.key));
      this.inflight.set(context.key, pending);
    }
    if (!fresh) return unavailable("codex", refresh ? "refreshing" : "not_refreshed");
    return cached.row;
  }

  async refresh(context) {
    const at = this.now();
    let row;
    try {
      const projected = projectCodexPluginList(JSON.parse(await runPluginList(context, this.execFileImpl)), new Date(at).toISOString());
      row = projected ?? unavailable("codex", "plugin_list_invalid");
    } catch {
      // No raw CLI output or error text leaves this computer.
      row = unavailable("codex", "plugin_list_failed");
    }
    this.entries.set(context.key, { at, row });
    return row;
  }
}

export function pluginInventoryBlock(labIds, codexRow) {
  return {
    version: PLUGIN_INVENTORY_VERSION,
    labs: labIds.map((labId) => (labId === "codex" ? codexRow : unavailable(labId, "no_native_plugin_source"))),
  };
}
