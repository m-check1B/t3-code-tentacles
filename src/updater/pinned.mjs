// KRA-8371 (KRA-8367 A3): compiled-in trust roots for the standalone self-update.
//
// The server can never change any of these. The audited current and next public
// keys are pinned below (U1, U2). A missing or unverifiable manifest still refuses
// every install; an empty key list remains `updater_unconfigured` and fails
// `scripts/release/assert-pinned-keys.mjs`.

// The canonical private GitHub release source is compiled into every build.
export { RELEASE_DOWNLOAD as UPDATE_BASE_URL } from "./release-source.mjs";

// The signed manifest is published as an asset of this fixed release tag.
export const MANIFEST_TAG = "tentacles-manifest";
export const MANIFEST_ASSET = "tentacles-manifest.json";

// Ed25519 raw public keys, base64 (32 bytes each): [current, next].
// U6 ceremony 24 Oct 2026, custody s25 403b1a88, GUARDIAN audit PASS.
export const PINNED_PUBLIC_KEYS = Object.freeze([
  // current: keyId 106d3ab825e5e6b7; tentacles-manifest-signing-key-current
  "1IWLY3JieS1Jdof2xsZ5huJW8ATUwq9iAbo695+NhEM=",
  // next: keyId 9e6656980133bd7a; tentacles-manifest-signing-key-next
  "smwpxtGQXv9HpsEosMC9obOZLAFaA70cfrdtkSNiFHM=",
]);

// Losing ~/.tentacles/state never lets the device accept a serial below this (U3).
// Release captain: raise this to the release serial in every audited release PR,
// including the separately installed updater copy; 1 is only the bootstrap floor.
export const MIN_MANIFEST_SERIAL = 1;

export const MANIFEST_SCHEMA = "tentacles-manifest/v1";
