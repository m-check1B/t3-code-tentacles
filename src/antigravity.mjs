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

// KRA-10869: a spent Google quota comes back as an ordinary Antigravity reply. Only
// a reset time is read out of it, by a strict time grammar, and printed from its
// parsed parts; nothing else from the reply reaches the doctor output.
const RESET_PREFIX = String.raw`\bresets? (at|in|on|after) `;
const END = String.raw`(?=$|[\s.,;!)])`;
const RESET_ISO = new RegExp(`${RESET_PREFIX}(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2}))?(?: ?(Z|UTC|GMT|[+-]\\d{2}:?\\d{2}))?${END}`, "i");
const RESET_CLOCK = new RegExp(`${RESET_PREFIX}(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?: ?(AM|PM))?(?: (UTC|GMT|[+-]\\d{2}:?\\d{2}))?${END}`, "i");
const RESET_IN = new RegExp(`${RESET_PREFIX}(\\d{1,4}) (second|minute|hour|day)(s?)${END}`, "i");
const two = value => String(Number(value)).padStart(2, "0");
// B3 P3-4 on #114: an offset is at most ±14:59. A time followed by any other word or a
// bracket (a zone the reader does not know, in any spelling) gives no reset time, except
// a few plain words (B3 P3-1 on #117).
const zoneOk = zone => !zone || !/^[+-]/.test(zone) || (+zone.slice(1, 3) <= 14 && +zone.slice(-2) <= 59);
const AFTER_TIME = new Set(["today", "tomorrow", "and", "on", "in"]);
const unknownZone = (text, match) => {
  const next = /^\s*([A-Za-z(][A-Za-z]*)/.exec(text.slice(match.index + match[0].length));
  return Boolean(next) && !AFTER_TIME.has(next[1].toLowerCase());
};
export function antigravityResetTime(reply) {
  if (typeof reply !== "string") return null;
  const text = reply.slice(0, 4096);
  let m = RESET_ISO.exec(text);
  if (m) {
    const [, , y, mo, d, h, mi, sec, zone] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDate() !== +d || +h > 23 || +mi > 59 || (sec && +sec > 59) || !zoneOk(zone) || (!zone && unknownZone(text, m))) return null;
    return `${y}-${mo}-${d} ${h}:${mi}${sec ? `:${sec}` : ""}${zone ? ` ${zone.toUpperCase()}` : ""}`;
  }
  m = RESET_CLOCK.exec(text);
  if (m) {
    const [, , h, mi, sec, half, zone] = m;
    if (+mi > 59 || (sec && +sec > 59) || (half ? +h < 1 || +h > 12 : +h > 23) || !zoneOk(zone) || (!zone && unknownZone(text, m))) return null;
    return `${half ? Number(h) : two(h)}:${mi}${sec ? `:${sec}` : ""}${half ? ` ${half.toUpperCase()}` : ""}${zone ? ` ${zone.toUpperCase()}` : ""}`;
  }
  m = RESET_IN.exec(text);
  if (m && /^(in|after)$/i.test(m[1]) && Number(m[2]) >= 1) return `${m[1].toLowerCase()} ${Number(m[2])} ${m[3].toLowerCase()}${Number(m[2]) === 1 ? "" : "s"}`;
  return null;
}
export function antigravityQuotaAction(reply) {
  const reset = antigravityResetTime(reply);
  return `not responding: quota${reset ? `; resets ${reset}` : ""}; pass --model with another Antigravity model, or wait until its quota resets`;
}

// Antigravity 1.5.13's own out-of-quota reply, which the shared classifier does not
// know; kept here so other labs' classification stays as it is. A leading sentence, so a
// trailing reset sentence still reaches the reset-time reader (B3 P3-2 on #114).
const ANTIGRAVITY_QUOTA_REPLY = /^You have exhausted your quota on this model(?:\.(?:\s|$)|$)/;
/**
 * The probe outcome for an Antigravity reply that is not OK, or null for main's
 * outcome. Only a reply the shared classifier (or the sentence above) reads as a
 * usage limit is quota; every other reply is left to main (B3 P3-1 on #114). The
 * reply is never echoed.
 */
export function antigravityReplyOutcome(text, classify) {
  const reply = typeof text === "string" ? text.trim() : "";
  if (/^ok\.?$/i.test(reply)) return null;
  const code = ANTIGRAVITY_QUOTA_REPLY.test(reply) ? "usage_limit" : classify(reply);
  return code === "usage_limit" ? { status: "no_response", code, action: antigravityQuotaAction(reply) } : null;
}

// KRA-10869: runtime 1.5.13 dropped the effort-suffixed ids (gemini-4-hydrogen-high);
// effort is the thought_level option now. Never mapped to xhigh (Founder-manual).
const OLD_EFFORT_MODEL = /^(gemini-[a-z0-9][a-z0-9.-]*?)-(low|medium|high)$/;
export function antigravityModelAlias(model) {
  const match = typeof model === "string" ? OLD_EFFORT_MODEL.exec(model) : null;
  return match ? { model: match[1], options: [{ id: "thought_level", value: match[2] }] } : null;
}
