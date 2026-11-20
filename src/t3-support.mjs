import fs from "node:fs";
import { compareVersions, SEMVER } from "./t3-auth.mjs";

// The one machine-readable statement of the T3 Code versions Tentacles supports
// (config/t3-support.json; the agent-jack-3 lock reads the same file).
export const T3_SUPPORT = Object.freeze(JSON.parse(fs.readFileSync(new URL("../config/t3-support.json", import.meta.url), "utf8")));

const updateAction = (support) =>
  `update T3 Code to ${support.testedThrough} or newer from the official download (${support.download}), then rerun doctor`;

/**
 * Where a T3 server version sits against the supported range.
 * supported: minimum..testedThrough. untested: newer than testedThrough (works
 * unless doctor says otherwise; the scheduled upstream check proves new
 * releases). legacy: a TPLUS fork build on the old patched route. unsupported:
 * older than minimum. unknown: no parseable version.
 */
export function t3Support(version, support = T3_SUPPORT) {
  const range = { minimum: support.minimum, testedThrough: support.testedThrough };
  const parsed = typeof version === "string" ? SEMVER.exec(version) : null;
  if (!parsed) return { status: "unknown", ...range, action: null };
  if (/(^|\.)tplus(\.|$)/.test(parsed[4] ?? "")) {
    return { status: "legacy", ...range, action: `This is a T3 Code TPLUS fork build; ${updateAction(support)}` };
  }
  if (compareVersions(parsed, SEMVER.exec(support.minimum)) < 0) {
    return { status: "unsupported", ...range, action: `T3 Code ${version} is older than ${support.minimum}, the first release Tentacles supports; ${updateAction(support)}` };
  }
  if (compareVersions(parsed, SEMVER.exec(support.testedThrough)) > 0) return { status: "untested", ...range, action: null };
  return { status: "supported", ...range, action: null };
}

/** Recovery text when T3 offers no Local Talk turn-result contract. */
export function talkMissingAction(version, support = T3_SUPPORT) {
  const where = t3Support(version, support);
  if (where.action) return where.action;
  return `This computer's T3 Code does not offer Local Talk; ${updateAction(support)}`;
}
