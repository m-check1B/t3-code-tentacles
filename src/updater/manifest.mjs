// KRA-8371: signed manifest `tentacles-manifest/v1`. Node builtins only, so the
// updater runs from ~/.tentacles/updater without the swapped version tree.
import { createHash, createPublicKey, verify } from "node:crypto";
import { MANIFEST_SCHEMA } from "./pinned.mjs";

export const ENVELOPE_SCHEMA = "tentacles-manifest-envelope/v1";
export const MAX_MANIFEST_BYTES = 256 * 1024;
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-jack\.([1-9]\d{0,5}))?$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RPC = /^[a-z][a-z-]{0,31}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const ENTRY_KEYS = ["version", "commit", "sha256", "legacyRpc", "t3Contract", "minDesktop", "minApi", "needs", "changelog"];
const MANIFEST_KEYS = ["schema", "serial", "expires", "versions", "securityFloor", "recommended"];
// Ed25519 SubjectPublicKeyInfo prefix for a raw 32-byte key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class UpdateError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isRecord(value)) throw new UpdateError(code);
  const present = Object.keys(value);
  if (present.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new UpdateError(code);
}

export function parseVersion(value) {
  const match = typeof value === "string" ? VERSION.exec(value) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), jack: match[4] === undefined ? null : Number(match[4]) };
}

export function isVersion(value) {
  return parseVersion(value) !== null;
}

/** Semver order for the X.Y.Z[-jack.N] grammar: a -jack.N prerelease sorts below X.Y.Z. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new UpdateError("version_invalid");
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  if (a.jack === b.jack) return 0;
  if (a.jack === null) return 1;
  if (b.jack === null) return -1;
  return a.jack < b.jack ? -1 : 1;
}

export function keyId(rawPublicKey) {
  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

export function publicKeyFromRaw(base64) {
  const raw = Buffer.from(String(base64), "base64");
  if (raw.length !== 32 || raw.toString("base64") !== base64) throw new UpdateError("updater_unconfigured", "Pinned public key must be 32 raw bytes in base64");
  return { id: keyId(raw), key: createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" }) };
}

function validateEntry(entry) {
  exactKeys(entry, ENTRY_KEYS, "manifest_invalid");
  if (!isVersion(entry.version) || !HEX40.test(entry.commit) || !HEX64.test(entry.sha256)) throw new UpdateError("manifest_invalid");
  if (!Array.isArray(entry.legacyRpc) || entry.legacyRpc.length < 1 || entry.legacyRpc.length > 32
    || !entry.legacyRpc.every((name) => typeof name === "string" && RPC.test(name)) || new Set(entry.legacyRpc).size !== entry.legacyRpc.length) {
    throw new UpdateError("manifest_invalid");
  }
  if (typeof entry.t3Contract !== "string" || !TOKEN.test(entry.t3Contract)) throw new UpdateError("manifest_invalid");
  for (const key of ["minDesktop", "minApi"]) {
    if (entry[key] !== null && (typeof entry[key] !== "string" || !TOKEN.test(entry[key]))) throw new UpdateError("manifest_invalid");
  }
  // A version that needs a new OS permission or a new unit is listed here; the
  // updater never applies it on its own (it becomes a consent card).
  if (!Array.isArray(entry.needs) || entry.needs.length > 16 || !entry.needs.every((need) => typeof need === "string" && TOKEN.test(need))) {
    throw new UpdateError("manifest_invalid");
  }
  if (typeof entry.changelog !== "string" || entry.changelog.length > 200 || /[\u0000-\u001f\u007f]/.test(entry.changelog)) {
    throw new UpdateError("manifest_invalid");
  }
}

export function validateManifest(manifest) {
  exactKeys(manifest, MANIFEST_KEYS, "manifest_invalid");
  if (manifest.schema !== MANIFEST_SCHEMA || !Number.isSafeInteger(manifest.serial) || manifest.serial < 1) throw new UpdateError("manifest_invalid");
  if (typeof manifest.expires !== "string" || !Number.isFinite(Date.parse(manifest.expires)) || new Date(Date.parse(manifest.expires)).toISOString() !== manifest.expires) {
    throw new UpdateError("manifest_invalid");
  }
  if (!Array.isArray(manifest.versions) || manifest.versions.length < 1 || manifest.versions.length > 64) throw new UpdateError("manifest_invalid");
  manifest.versions.forEach(validateEntry);
  if (new Set(manifest.versions.map((entry) => entry.version)).size !== manifest.versions.length) throw new UpdateError("manifest_invalid");
  if (!isVersion(manifest.securityFloor) || !isVersion(manifest.recommended)) throw new UpdateError("manifest_invalid");
  if (!manifest.versions.some((entry) => entry.version === manifest.recommended)) throw new UpdateError("manifest_invalid");
  if (compareVersions(manifest.recommended, manifest.securityFloor) < 0) throw new UpdateError("manifest_invalid");
  return manifest;
}

/**
 * Verify an envelope against the pinned keys, then the schema, replay and expiry.
 * Nothing in the result is trusted unless this returns.
 */
export function verifyManifest(envelopeBytes, { publicKeys, now, minSerial, lastSerial = 0, lastDigest = null }) {
  if (!Array.isArray(publicKeys) || publicKeys.length === 0) throw new UpdateError("updater_unconfigured");
  const keys = publicKeys.map(publicKeyFromRaw);
  const bytes = Buffer.isBuffer(envelopeBytes) ? envelopeBytes : Buffer.from(envelopeBytes);
  if (bytes.length < 2 || bytes.length > MAX_MANIFEST_BYTES) throw new UpdateError("manifest_invalid");
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new UpdateError("manifest_invalid"); }
  exactKeys(envelope, ["schema", "payload", "signatures"], "manifest_invalid");
  if (envelope.schema !== ENVELOPE_SCHEMA || typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures)
    || envelope.signatures.length < 1 || envelope.signatures.length > 4) {
    throw new UpdateError("manifest_invalid");
  }
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.toString("base64") !== envelope.payload || payload.length > MAX_MANIFEST_BYTES) throw new UpdateError("manifest_invalid");
  let verified = false;
  for (const signature of envelope.signatures) {
    exactKeys(signature, ["keyId", "sig"], "manifest_invalid");
    const key = keys.find((candidate) => candidate.id === signature.keyId);
    if (!key || typeof signature.sig !== "string") continue;
    const sig = Buffer.from(signature.sig, "base64");
    if (sig.length === 64 && sig.toString("base64") === signature.sig && verify(null, payload, key.key, sig)) verified = true;
  }
  if (!verified) throw new UpdateError("manifest_signature_invalid");
  let manifest;
  try { manifest = JSON.parse(payload.toString("utf8")); } catch { throw new UpdateError("manifest_invalid"); }
  validateManifest(manifest);
  const digest = createHash("sha256").update(payload).digest("hex");
  // Serial: never below the compiled-in minimum; strictly above the last one
  // accepted, except a byte-identical re-read of that same manifest.
  if (manifest.serial < minSerial) throw new UpdateError("manifest_replay");
  if (manifest.serial < lastSerial || (manifest.serial === lastSerial && digest !== lastDigest)) throw new UpdateError("manifest_replay");
  if (Date.parse(manifest.expires) <= now) throw new UpdateError("manifest_expired");
  return { manifest, digest };
}

export function manifestEntry(manifest, version) {
  return manifest.versions.find((entry) => entry.version === version) ?? null;
}

export function artifactName(version) {
  if (!isVersion(version)) throw new UpdateError("version_invalid");
  return `tentacles-${version}.tgz`;
}

/**
 * U5: the device decides. The only input is the verified manifest and the
 * running version; no caller can pass a version, URL or hash.
 */
export function selectTarget(manifest, currentVersion) {
  const target = manifest.recommended;
  if (compareVersions(target, manifest.securityFloor) < 0) return { action: "none", code: "manifest_invalid" };
  if (currentVersion === target) return { action: "none", code: "tentacles_up_to_date" };
  const current = isVersion(currentVersion) ? currentVersion : null;
  const currentListed = current !== null && manifestEntry(manifest, current) !== null;
  const currentSafe = current !== null && currentListed && compareVersions(current, manifest.securityFloor) >= 0;
  // Never step down from a listed, safe version; only move up to recommended,
  // or away from a version that is below the floor or was delisted.
  if (currentSafe && compareVersions(target, current) < 0) return { action: "none", code: "tentacles_up_to_date" };
  return { action: "install", version: target, entry: manifestEntry(manifest, target) };
}
