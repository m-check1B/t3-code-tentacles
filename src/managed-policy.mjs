// T3 managed policy awareness (KRA-8715, upstream T3 v0.1.7).
//
// Tentacles reads only the summary T3 publishes in `server.getConfig`
// (`managedPolicy`: organization, limits) and the fingerprints `t3 policy show`
// prints. It never reads the policy file and never prints setting values.
// Without a summary (no policy, or a server that predates policy) every path
// behaves as before.

import { spawnSync } from "node:child_process";

import { failure } from "./failure-codes.mjs";

export { policyDenialText } from "./failure-codes.mjs";

// Upstream `isRuntimeModeAbove` order, narrowest first.
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"];
const RUNTIME_MODE_LABELS = { "approval-required": "Supervised", "auto-accept-edits": "Auto-accept edits", auto: "Auto", "full-access": "Full access" };
// T3 servers older than this never publish `managedPolicy`.
const POLICY_SERVER_VERSION = [0, 1, 7];
export const POLICY_RESTART_ACTION = "restart T3 to apply the installed policy";
const FINGERPRINT = /^[0-9a-f]{12}$/;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : null);

/** The policy summary a T3 server config publishes, or null. */
export function policySummary(config) {
  const summary = config?.managedPolicy;
  return isRecord(summary) && typeof summary.organization === "string" ? summary : null;
}

/** true / false, or "unknown" when the server predates managed policy. */
export function policyPresence(config, serverVersion) {
  if (policySummary(config)) return true;
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(serverVersion ?? "")?.slice(1).map(Number);
  if (!parts) return "unknown";
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== POLICY_SERVER_VERSION[index]) return parts[index] > POLICY_SERVER_VERSION[index] ? false : "unknown";
  }
  return false;
}

export function policyLimits(summary) {
  const limits = isRecord(summary?.limits) ? summary.limits : {};
  return {
    allowedDrivers: stringList(limits.providers?.allowedDrivers),
    maxRuntimeMode: RUNTIME_MODES.includes(limits.maxRuntimeMode) ? limits.maxRuntimeMode : null,
    clients: stringList(limits.clients),
  };
}

export function isDriverAllowed(summary, driver) {
  const { allowedDrivers } = policyLimits(summary);
  return allowedDrivers === null || typeof driver !== "string" || allowedDrivers.includes(driver);
}

export class PolicyRefusedError extends Error {
  constructor(policyMessage, details = {}) {
    super(`policy_refused: ${policyMessage}`);
    this.name = "PolicyRefusedError";
    this.failure = failure("policy_refused");
    this.policyMessage = policyMessage;
    Object.assign(this, details);
  }
}

/** Refuse a driver or runtime mode the summary forbids. No fallback is chosen. */
export function assertPolicyAllows(summary, { instanceId, driver, runtimeMode } = {}) {
  if (!summary) return;
  const organization = summary.organization;
  const { allowedDrivers, maxRuntimeMode } = policyLimits(summary);
  if (!isDriverAllowed(summary, driver)) {
    throw new PolicyRefusedError(
      `${organization}'s policy does not allow the ${driver} driver${instanceId && instanceId !== driver ? ` (instance ${instanceId})` : ""}. Allowed drivers: ${allowedDrivers.join(", ")}.`,
      { organization, driver, allowedDrivers },
    );
  }
  if (maxRuntimeMode && RUNTIME_MODES.indexOf(runtimeMode) > RUNTIME_MODES.indexOf(maxRuntimeMode)) {
    throw new PolicyRefusedError(
      `${organization} limits threads to ${RUNTIME_MODE_LABELS[maxRuntimeMode]}. Requested runtime mode ${runtimeMode} is above the ceiling ${maxRuntimeMode}.`,
      { organization, runtimeMode, maxRuntimeMode },
    );
  }
}

/**
 * Read the server's policy and refuse before dispatch. A server without
 * `server.getConfig` or without a policy changes nothing; T3 still enforces
 * its own policy and its denial maps to `policy_refused`.
 */
export async function enforceManagedPolicy(client, { instanceId, runtimeMode } = {}) {
  if ((instanceId === undefined && runtimeMode === undefined) || typeof client?.rpc !== "function") return;
  let config;
  try { config = await client.rpc("server.getConfig", {}); } catch { return; }
  const summary = policySummary(config);
  if (!summary) return;
  const provider = Array.isArray(config.providers) ? config.providers.find((entry) => entry?.instanceId === instanceId) : null;
  const driver = instanceId === undefined ? undefined : (typeof provider?.driver === "string" ? provider.driver : instanceId);
  assertPolicyAllows(summary, { instanceId, driver, runtimeMode });
}

/**
 * Parse `t3 policy show`. Only the two fingerprints are kept; settings and
 * limits it prints are discarded. `undefined` means unknown, null means none.
 */
export function parsePolicyShow(stdout) {
  if (typeof stdout !== "string") return { installed: undefined, loaded: undefined };
  let installed;
  if (/^No managed policy on this machine\./m.test(stdout)) installed = null;
  else installed = /^Managed by .*\(.*, fingerprint ([0-9a-f]{12})\)\.$/m.exec(stdout)?.[1];
  let loaded;
  if (/^The running server .* loaded this policy\.$/m.test(stdout)) loaded = installed;
  else if (/^The running server .* (?:runs without a policy, as installed|loaded no policy)\./m.test(stdout)) loaded = null;
  else loaded = /^The running server .* loaded .*\(fingerprint ([0-9a-f]{12})\)\. Restart/m.exec(stdout)?.[1];
  return { installed, loaded };
}

/** Run the local `t3 policy show`; null when no binary or it fails. */
export function runPolicyShow({ t3Bin, t3Home, spawnImpl = spawnSync } = {}) {
  if (!t3Bin) return null;
  try {
    const result = spawnImpl(t3Bin, ["policy", "show", ...(t3Home ? ["--base-dir", t3Home] : [])], { encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return result?.status === 0 && typeof result.stdout === "string" ? result.stdout : null;
  } catch { return null; }
}

/** The doctor `managedPolicy` section. */
export function managedPolicyReport({ config, serverVersion, policyShow = null, remoteAccess = false }) {
  const summary = policySummary(config);
  const show = parsePolicyShow(policyShow);
  const known = (value) => (value === null || FINGERPRINT.test(value ?? "") ? value : undefined);
  const installedFingerprint = known(show.installed);
  const loadedFingerprint = known(show.loaded);
  const report = {
    present: policyPresence(config, serverVersion),
    organization: summary?.organization ?? null,
    loadedFingerprint: loadedFingerprint ?? null,
    installedFingerprint: installedFingerprint ?? null,
    policyShow: policyShow === null ? "unavailable" : "ok",
    mismatch: installedFingerprint !== undefined && loadedFingerprint !== undefined && installedFingerprint !== loadedFingerprint,
    limits: summary ? policyLimits(summary) : null,
    warnings: [],
  };
  if (report.mismatch) report.action = POLICY_RESTART_ACTION;
  const clients = report.limits?.clients;
  if (remoteAccess && clients && !clients.includes("remote")) {
    report.warnings.push({
      code: "policy_clients_without_remote",
      message: `${report.organization}'s policy allows clients ${clients.join(", ")} without remote; T3 drops Tailscale Serve routes and signs out paired devices, so tailnet pairing to this host stops working`,
    });
  }
  return report;
}
