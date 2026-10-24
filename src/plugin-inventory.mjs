// KRA-6203: read-only native plugin inventory for the exact configured lab.
//
// T3 reports native skills but not plugins. Codex lists installed plugins with
// `codex plugin list --json`; that call can take seconds (remote marketplaces),
// so the long-running pairer refreshes it in the background and doctor only
// serves a fresh cached observation. Doctor never waits on the CLI and never
// reports an unobserved or stale list as current.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { looksSecret } from "./capabilities.mjs";

export const PLUGIN_INVENTORY_VERSION = 1;
export const PLUGIN_INVENTORY_TTL_MS = 10 * 60 * 1000;
// A failed listing (often a marketplace network blip) is retried sooner.
export const PLUGIN_INVENTORY_FAILURE_TTL_MS = 60 * 1000;
const PLUGIN_LIST_TIMEOUT_MS = 60_000;
const PLUGIN_LIST_SETTLE_MS = 5_000;
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
    && value === value.trim() && !UNSAFE_TEXT.test(value) && !looksSecret(value);
}

const CONTEXT_ENV = new Set(["CODEX_HOME", "HOME", "PATH"]);
const LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setting(config, key) {
  return typeof config[key] === "string" && config[key].trim() ? config[key].trim() : null;
}

// The plugin context of T3's `codex` instance, resolved like the doctor lab
// row: an explicit providerInstances entry wins over legacy provider settings.
// Anything that could make T3's Codex read a different home than this listing
// (effective launch arguments, instance environment for CODEX_HOME/HOME/PATH, or a
// CODEX_HOME in this process with no configured homePath) is not attributed.
// The shadow home only separates auth.json; plugins live in CODEX_HOME.
export function codexPluginContext(settings, env = process.env) {
  const instance = settings?.providerInstances?.codex;
  const legacy = plainObject(settings?.providers?.codex) ? settings.providers.codex : {};
  if (instance === undefined && !plainObject(settings?.providers?.codex)) return { error: "disabled" };
  if (instance !== undefined && !plainObject(instance)) return { error: "disabled" };
  // T3 hydrates an explicit envelope verbatim; the legacy mirror is not a
  // field-level fallback. Missing fields use defaults inside the chosen source.
  const config = instance === undefined ? legacy : instance.config === undefined ? {} : instance.config;
  if (!plainObject(config)) return { error: "config_unverified" };
  const enabled = (value) => value === undefined || value === true;
  if (!enabled(instance?.enabled) || !enabled(config.enabled)) return { error: "disabled" };
  if (instance !== undefined && instance.driver !== "codex") return { error: "driver_unverified" };
  for (const key of ["launchArgs", "binaryPath", "homePath"]) {
    if (config[key] !== undefined && typeof config[key] !== "string") return { error: "config_unverified" };
  }
  if (instance?.environment !== undefined && !Array.isArray(instance.environment)) return { error: "environment_unverified" };
  if (Array.isArray(instance?.environment) && instance.environment.some((variable) => CONTEXT_ENV.has(variable?.name))) {
    return { error: "environment_unverified" };
  }
  const overrides = (instance?.environment ?? []).filter(variable => variable?.name === LAUNCH_ARGS_ENV);
  if (overrides.length > 1 || overrides.some(variable => variable.valueRedacted === true
    || variable.sensitive === true || typeof variable.value !== "string")) {
    return { error: "environment_unverified" };
  }
  const override = overrides.length ? overrides[0].value : env[LAUNCH_ARGS_ENV];
  if (override !== undefined && typeof override !== "string") return { error: "environment_unverified" };
  // T3 resolves the merged environment override before config.launchArgs.
  // No nonempty launch argv is reproduced by `plugin list`, so quarantine it.
  if (override?.trim() || setting(config, "launchArgs")) return { error: "launch_args_unverified" };
  const binary = setting(config, "binaryPath") ?? "codex";
  const configuredHome = config.homePath?.trim() ? config.homePath : null;
  // T3 expands tilde using its own home and resolves relative paths in its
  // server cwd. Neither base is supplied by settings; never guess ours.
  if (configuredHome && !path.isAbsolute(configuredHome)) return { error: "home_unverified" };
  const home = configuredHome ? path.resolve(configuredHome) : null;
  if (!home && typeof env.CODEX_HOME === "string" && env.CODEX_HOME) return { error: "default_context_unverified" };
  // Settings provide neither T3's cwd nor its PATH. Only an absolute binary
  // identifies the selected executable without borrowing the pairer's bases.
  // Windows root-relative paths still depend on the current drive.
  if (!path.isAbsolute(binary) || (process.platform === "win32" && /^[\\/](?![\\/])/.test(binary))) {
    return { error: "binary_unverified" };
  }
  return { binary, home, key: digest(JSON.stringify([binary, home, overrides.length > 0, override ?? null])) };
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
      || typeof entry.version !== "string" || !VERSION_TEXT.test(entry.version) || looksSecret(entry.version)
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
    // execFile only settles once the pipes close; a grandchild holding them
    // open must not pin the refresh forever, so a guard settles it anyway.
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fn(value);
    };
    const guard = setTimeout(() => {
      child?.kill?.("SIGKILL");
      settle(reject, new Error("plugin list timed out"));
    }, PLUGIN_LIST_TIMEOUT_MS + PLUGIN_LIST_SETTLE_MS);
    guard.unref?.();
    const child = execFileImpl(binary, ["plugin", "list", "--json"], {
      env,
      timeout: PLUGIN_LIST_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: PLUGIN_LIST_MAX_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) settle(reject, error);
      else settle(resolve, stdout);
    });
  });
}

export class PluginInventoryCache {
  constructor({
    execFileImpl = execFile,
    now = () => Date.now(),
    ttlMs = PLUGIN_INVENTORY_TTL_MS,
    failureTtlMs = PLUGIN_INVENTORY_FAILURE_TTL_MS,
    env = process.env,
  } = {}) {
    this.execFileImpl = execFileImpl;
    this.now = now;
    this.ttlMs = ttlMs;
    this.failureTtlMs = failureTtlMs;
    this.env = env;
    this.entries = new Map();
    this.inflight = new Map();
  }

  // Returns immediately. Starts at most one background refresh per context.
  read(settings, { refresh = true } = {}) {
    const context = codexPluginContext(settings, this.env);
    if (context.error) return unavailable("codex", context.error);
    const cached = this.entries.get(context.key);
    const ttl = cached?.row.state === "observed" ? this.ttlMs : this.failureTtlMs;
    const fresh = cached && this.now() - cached.at < ttl;
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
