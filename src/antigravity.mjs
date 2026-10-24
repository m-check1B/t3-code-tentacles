// KRA-6725: Google Antigravity (Gemini) is a T3-native lab. T3 owns the ACP
// agent download and the Google sign-in. Tentacles only reads T3's provider
// snapshot and never handles Google credentials.

export const ANTIGRAVITY_INSTANCE_ID = "antigravity";

// T3 has shipped the Antigravity driver (macOS arm64, Linux, Windows) since
// 0.0.39; 0.0.43 is the first desktop that opens ANTIGRAVITY_SETUP_URL. Intel
// Macs need the 1.3.0 ACP agent, first shipped in T3 0.0.46.
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
    row.code = "provider_error";
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
    default:
      return null;
  }
}
