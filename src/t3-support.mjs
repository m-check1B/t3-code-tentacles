import { compareVersions, SEMVER } from "./t3-auth.mjs";

// The one machine-readable statement of the T3 Code versions Tentacles supports.
// It lives in src/ so every vendored copy (Agent Jack vendors src, bin and
// package.json) has it and Jack's PIN content hash covers it.
export const T3_SUPPORT = Object.freeze({
  schema: 1,
  product: "T3 Code (Beta)",
  source: "https://github.com/pingdotgg/t3code",
  download: "https://github.com/pingdotgg/t3code/releases/latest",
  minimum: "0.1.8",
  testedThrough: "0.1.11",
  testedTag: "v0.1.11",
  testedCommit: "59651c1761f6c63e9b6056839067066968e6a406",
  orchestrationProtocol: 2,
  // shortcut: patched builds (TPLUS fork 0.0.42-tplus.*, Server labs 0.1.0-jack.*) keep the legacy patched
  // turn-result route; drop this and the legacy route once the estate runs stock T3 (STOCK-T3-ROLLOUT.md).
  legacy: Object.freeze({ prereleases: Object.freeze(["tplus", "jack"]), note: "Patched T3 builds keep the legacy patched turn-result route until the estate has moved to stock T3." }),
});

const updateAction = (support) =>
  `update T3 Code to ${support.testedThrough} or newer from the official download (${support.download}), then rerun doctor`;

function place(version, support) {
  const range = { minimum: support.minimum, testedThrough: support.testedThrough };
  const parsed = typeof version === "string" ? SEMVER.exec(version) : null;
  if (!parsed) return { status: "unknown", ...range, action: null };
  const tag = (parsed[4] ?? "").split(".")[0];
  if (support.legacy.prereleases.includes(tag)) {
    return { status: "legacy", ...range, action: `T3 Code ${version} is not an official release; ${updateAction(support)}` };
  }
  if (compareVersions(parsed, SEMVER.exec(support.minimum)) < 0) {
    return { status: "unsupported", ...range, action: `T3 Code ${version} is older than ${support.minimum}, the first release Tentacles supports; ${updateAction(support)}` };
  }
  if (compareVersions(parsed, SEMVER.exec(support.testedThrough)) > 0) return { status: "untested", ...range, action: null };
  return { status: "supported", ...range, action: null };
}

/**
 * Where a T3 server version sits against the supported range.
 * supported: minimum..testedThrough. untested: newer than testedThrough (works
 * unless doctor says otherwise; the scheduled upstream check proves new
 * releases). legacy: a patched build on the old patched route. unsupported:
 * older than minimum. unknown: no parseable version, or the range could not be
 * evaluated. Never throws: doctor and every RPC keep working.
 */
export function t3Support(version, support = T3_SUPPORT) {
  try {
    return place(version, support);
  } catch {
    return { status: "unknown", minimum: support?.minimum ?? null, testedThrough: support?.testedThrough ?? null,
      action: "Tentacles could not evaluate its supported T3 Code range; reinstall Tentacles, then rerun doctor" };
  }
}

/** Recovery text when T3 offers no Local Talk turn-result contract. */
export function talkMissingAction(version, support = T3_SUPPORT) {
  const where = t3Support(version, support);
  if (where.action) return where.action;
  return `This computer's T3 Code does not offer Local Talk; ${updateAction(support)}`;
}
