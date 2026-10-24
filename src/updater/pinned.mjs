// KRA-8371 (KRA-8367 A3): compiled-in trust roots for the standalone self-update.
//
// The server can never change any of these. A release that ships with an empty
// key list cannot verify any manifest, so the updater refuses every install
// (`updater_unconfigured`) and `scripts/release/assert-pinned-keys.mjs` fails
// the release build. Real keys are added only by a Founder-approved PR after the
// GUARDIAN audit of the signer and the vault item setup (U1, U2).

// The canonical private GitHub release source is compiled into every build.
export { RELEASE_DOWNLOAD as UPDATE_BASE_URL } from "./release-source.mjs";

// The signed manifest is published as an asset of this fixed release tag.
export const MANIFEST_TAG = "tentacles-manifest";
export const MANIFEST_ASSET = "tentacles-manifest.json";

// Ed25519 raw public keys, base64 (32 bytes each): [current, next].
// Empty until the first GUARDIAN-audited key ceremony.
export const PINNED_PUBLIC_KEYS = Object.freeze([]);

// Losing ~/.tentacles/state never lets the device accept a serial below this (U3).
// Release captain: raise this to the release serial in every audited release PR,
// including the separately installed updater copy; 1 is only the bootstrap floor.
export const MIN_MANIFEST_SERIAL = 1;

export const MANIFEST_SCHEMA = "tentacles-manifest/v1";
