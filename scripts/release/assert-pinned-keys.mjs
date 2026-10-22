#!/usr/bin/env node
// KRA-8371: a production release build fails closed until the two real Ed25519
// public keys (current, next) are pinned in src/updater/pinned.mjs.
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { PINNED_PUBLIC_KEYS } from "../../src/updater/pinned.mjs";
import { publicKeyFromRaw } from "../../src/updater/manifest.mjs";

export function assertPinnedKeys(keys = PINNED_PUBLIC_KEYS) {
  if (!Array.isArray(keys) || keys.length !== 2) throw new Error("release refused: two pinned Ed25519 public keys (current, next) are required");
  if (new Set(keys).size !== 2) throw new Error("release refused: the current and next pinned keys must differ");
  for (const key of keys) publicKeyFromRaw(key);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { assertPinnedKeys(); console.log("pinned update keys: 2 configured"); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
