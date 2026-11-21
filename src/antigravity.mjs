// KRA-6725: Google Antigravity (Gemini) is a T3-native lab. T3 owns the ACP
// agent download and the Google sign-in. Tentacles only reads T3's provider
// snapshot and never handles Google credentials.

export const ANTIGRAVITY_INSTANCE_ID = "antigravity";

// Minimum desktop setup-link contract; a version alone never proves readiness.
export const ANTIGRAVITY_MIN_T3_VERSION = "0.0.43";

// T3's own provider settings page, where "Install Antigravity" and
// "Sign in with Google" live. A fixed URL: no caller can choose the target.
export const ANTIGRAVITY_SETUP_URL = "t3code://app/settings/providers?instanceId=antigravity";

function versionParts(value) {
  const match = typeof value === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(value) : null;
  return match ? match.slice(1, 4).map(Number) : null;
}

export function t3SupportsAntigravity(serverVersion) {
  const have = versionParts(serverVersion);
  if (!have) return null;
  const need = versionParts(ANTIGRAVITY_MIN_T3_VERSION);
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
}

// KRA-8860: T3's message when its Antigravity health check times out, matched
// whole and never echoed.
const T3_HEALTH_CHECK_TIMEOUT = /^Antigravity did not respond to its local health check within [0-9]{1,6} [a-z]{1,12}\.$/;

// KRA-10863: T3's three managed-runtime messages that its own Antigravity setup
// repairs (AntigravityInstallation, T3 0.1.11), matched whole and never echoed.
// "changed on disk" arrives with installed=false, so it is read before that.
const T3_RUNTIME_PREDATES_CLI = /^Antigravity [0-9A-Za-z.+-]{1,64} predates the Antigravity CLI and no longer works with this T3 Code release\. Update it in Antigravity setup\.$/;
const T3_RUNTIME_CHANGED = /^The managed Antigravity runtime changed on disk\. Reinstall it in Antigravity setup\.$/;
// A managed runtime whose release T3 has withdrawn (resolve step); same fix as "predates".
const T3_RUNTIME_WITHDRAWN = /^Antigravity [0-9A-Za-z.+-]{1,64} no longer works with this T3 Code release\. Update it in Antigravity setup\.$/;

function repairCode(configProvider) {
  if (configProvider.status !== "error" || typeof configProvider.message !== "string") return null;
  const message = configProvider.message.trim();
  return T3_RUNTIME_PREDATES_CLI.test(message) || T3_RUNTIME_WITHDRAWN.test(message) ? "runtime_update_required"
    : T3_RUNTIME_CHANGED.test(message) ? "runtime_changed" : null;
}

// Only T3's observed provider and authentication states establish readiness.
// An initialized agent or a cached model list does not prove Google sign-in.
export function applyAntigravityState(row, configProvider, serverVersion) {
  const authStatus = configProvider?.auth?.status;
  const installed = configProvider?.installed === true;
  row.installed = installed;
  row.signedIn = authStatus === "authenticated" ? true : authStatus === "unauthenticated" ? false : null;
  row.setupUrl = ANTIGRAVITY_SETUP_URL;
  if (!configProvider) {
    row.ready = false;
    row.code = t3SupportsAntigravity(serverVersion) === false ? "t3_update_required" : "absent";
    row.status = "absent";
    return row;
  }
  if (!row.enabled) {
    row.ready = false;
    row.code = "disabled";
    return row;
  }
  const repair = repairCode(configProvider);
  if (repair) {
    row.ready = false;
    row.code = repair;
    row.status = "installed";
    return row;
  }
  if (!installed) {
    row.ready = false;
    row.code = "not_installed";
    row.status = "absent";
    return row;
  }
  if (row.signedIn === false) {
    row.ready = false;
    row.code = "not_signed_in";
    row.status = "installed";
    return row;
  }
  if (configProvider.status === "error") {
    row.ready = false;
    const message = typeof configProvider.message === "string" ? configProvider.message.trim() : "";
    row.code = T3_HEALTH_CHECK_TIMEOUT.test(message) ? "provider_probe_timeout" : "provider_error";
    return row;
  }
  if (row.signedIn !== true) {
    row.ready = false;
    row.code = "sign_in_unchecked";
    row.status = "installed";
    return row;
  }
  row.ready = configProvider.status === "ready" && row.defaultAvailable === true;
  row.code = configProvider.status !== "ready" ? "provider_not_ready"
    : row.ready ? null : "default_model_unavailable";
  row.status = row.ready ? "ready" : "installed";
  return row;
}

export function antigravityAction(code) {
  switch (code) {
    case "t3_update_required":
      return `Update T3 Code to ${ANTIGRAVITY_MIN_T3_VERSION} or later, then enable Antigravity in Settings → Providers`;
    case "absent":
    case "disabled":
      return `Enable Antigravity in T3 Code: ${ANTIGRAVITY_SETUP_URL}`;
    case "not_installed":
      return `Install Antigravity in T3 Code: ${ANTIGRAVITY_SETUP_URL}`;
    case "not_signed_in":
      return `Sign in with Google in T3 Code: ${ANTIGRAVITY_SETUP_URL}`;
    case "sign_in_unchecked":
      return `Sign in with Google in T3 Code, or refresh Antigravity there if you already did: ${ANTIGRAVITY_SETUP_URL}`;
    case "runtime_update_required":
      return `T3's Antigravity runtime is older than the Antigravity CLI; update it in T3 Code's Antigravity setup, then rerun doctor: ${ANTIGRAVITY_SETUP_URL}`;
    case "runtime_changed":
      return `T3's managed Antigravity runtime changed on disk; reinstall it in T3 Code's Antigravity setup, then rerun doctor: ${ANTIGRAVITY_SETUP_URL}`;
    case "provider_probe_timeout":
      return `T3's Antigravity health check timed out; refresh Antigravity in T3 Code, or reinstall it there if it stays stuck, then rerun doctor: ${ANTIGRAVITY_SETUP_URL}`;
    default:
      return null;
  }
}
