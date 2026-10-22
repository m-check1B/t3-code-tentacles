#!/usr/bin/env node
// KRA-8371 (U1, U2): the no-AI manifest signer. The release captain (an AI
// seat) may call it, but only this script decides whether a manifest is
// signed. It refuses unless every new version entry proves its provenance:
//
//   * the commit is the merge commit of a merged PR into the protected branch,
//     and is an ancestor of that branch tip;
//   * that PR carries a B3 receipt comment citing the PR head sha;
//   * a clean rebuild (git archive + npm pack) of the commit has the entry's
//     sha256, and the published release asset has the same sha256;
//   * the commit's package.json version and REMOTE_RPC_METHODS match the entry.
//
// Founder OK (`--founder-ok REF`) is required to lower securityFloor, to add
// or rotate a pinned public key, or to sign anything below recommended.
//
// Key custody: the private key is fetched only after every check passed, from
// KEY_SOURCE by the exact item name SIGNING_ITEM. It arrives on a pipe, lives
// in memory only, and never touches argv, env, disk or stdout. The next key's
// private half (NEXT_SIGNING_ITEM) is never fetched by this script.
//
// This script is NOT shipped to devices (package.json "files" excludes it).
// Before its first real run GUARDIAN audits these exact bytes and the vault items.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  compareVersions, ENVELOPE_SCHEMA, keyId, validateManifest,
} from "../../src/updater/manifest.mjs";

export const FORGEJO_API = "http://192.168.0.21:3000/api/v1";
export const FORGEJO_GIT = "ssh://git@192.168.0.21:2222/matej/t3-code-tentacles.git";
export const REPOSITORY = "matej/t3-code-tentacles";
export const PROTECTED_BRANCH = "jack/0.4.1-maintenance";
export const RELEASE_DOWNLOAD = `http://192.168.0.21:3000/${REPOSITORY}/releases/download`;
export const SIGNING_ITEM = "tentacles-manifest-signing-key-current";
export const NEXT_SIGNING_ITEM = "tentacles-manifest-signing-key-next"; // never fetched here
export const FORGEJO_READ_ITEM = "tentacles-signer-forgejo-read-token";
// Audited helper: `<KEY_SOURCE> <exact item name>` writes the value to stdout
// (a pipe into this process). It must match the exact name, never a prefix.
export const KEY_SOURCE = path.join(os.homedir(), "bin", "tentacles-signer-key-source");
export const MAX_EXPIRY_DAYS = 45;
const B3_RECEIPT = /^B3 (?:APPROVE|CLEAR|PASS)\b/;
const FOUNDER_REF = /^[A-Za-z0-9._:#/-]{3,160}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class SignerRefusal extends Error {
  constructor(code, detail = code) { super(`refused: ${code}${detail === code ? "" : ` (${detail})`}`); this.code = code; }
}

function refuse(code, detail) { throw new SignerRefusal(code, detail); }

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

/** Run a child with an explicit, minimal environment; collects stdout in memory. */
export function runChild(spawnImpl, command, args, { cwd, input = null, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), LANG: "C" };
    const child = spawnImpl(command, args, { cwd, env, stdio: [input === null ? "ignore" : "pipe", "pipe", "ignore"] });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.on("error", () => reject(new SignerRefusal("subprocess_failed", path.basename(command))));
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks);
      if (code === 0 && size <= maxBytes) resolve(stdout);
      else { stdout.fill(0); reject(new SignerRefusal("subprocess_failed", path.basename(command))); }
    });
    if (input !== null) child.stdin.end(input);
  });
}

function parsePinnedKeys(source) {
  const match = /export const PINNED_PUBLIC_KEYS = Object\.freeze\(\[([^\]]*)\]\);/.exec(source);
  if (!match) refuse("pinned_keys_unreadable");
  return [...match[1].matchAll(/"([A-Za-z0-9+/=]{44})"/g)].map((item) => item[1]);
}

function parseRemoteRpc(source) {
  const match = /export const REMOTE_RPC_METHODS = Object\.freeze\(\[([^\]]*)\]\);/.exec(source);
  if (!match) refuse("rpc_list_unreadable");
  return [...match[1].matchAll(/"([a-z-]+)"/g)].map((item) => item[1]);
}

/** Default provenance backends; tests replace them with fixtures. */
export function defaultBackends({ spawnImpl = spawn, fetchImpl = globalThis.fetch, workDir }) {
  const mirror = path.join(workDir, "mirror.git");
  const git = (args) => runChild(spawnImpl, "git", ["--git-dir", mirror, ...args]);
  let fetched = false;
  return {
    async syncMirror() {
      if (!fs.existsSync(mirror)) await runChild(spawnImpl, "git", ["init", "--bare", "--quiet", mirror]);
      await git(["fetch", "--quiet", "--prune", FORGEJO_GIT, `+refs/heads/${PROTECTED_BRANCH}:refs/heads/${PROTECTED_BRANCH}`]);
      fetched = true;
    },
    async isAncestor(commit) {
      if (!fetched) refuse("mirror_not_synced");
      try { await git(["merge-base", "--is-ancestor", commit, `refs/heads/${PROTECTED_BRANCH}`]); return true; } catch { return false; }
    },
    async showFile(commit, file) { return (await git(["show", `${commit}:${file}`])).toString("utf8"); },
    async rebuildSha256(commit) {
      const build = fs.mkdtempSync(path.join(workDir, "rebuild-"));
      try {
        const archive = await git(["archive", "--format=tar", commit]);
        await runChild(spawnImpl, "tar", ["-x", "-f", "-", "-C", build], { input: archive });
        const name = (await runChild(spawnImpl, "npm", ["pack", "--ignore-scripts", "--silent"], { cwd: build })).toString("utf8").trim().split("\n").pop();
        if (!/^tentacles-[0-9A-Za-z.-]+\.tgz$/.test(name)) refuse("rebuild_failed");
        return sha256(fs.readFileSync(path.join(build, name)));
      } finally { fs.rmSync(build, { recursive: true, force: true }); }
    },
    async api(token, suffix) {
      const response = await fetchImpl(`${FORGEJO_API}/repos/${REPOSITORY}${suffix}`, {
        redirect: "error", signal: AbortSignal.timeout(30_000), headers: { authorization: `token ${token}` },
      });
      if (!response.ok) { await response.body?.cancel?.(); refuse("forgejo_unavailable", `${response.status}`); }
      return response.json();
    },
    async releaseAssetSha256(token, version) {
      const response = await fetchImpl(`${RELEASE_DOWNLOAD}/v${version}/tentacles-${version}.tgz`, {
        redirect: "error", signal: AbortSignal.timeout(120_000), headers: { authorization: `token ${token}` },
      });
      if (!response.ok) { await response.body?.cancel?.(); refuse("release_asset_unavailable", version); }
      return sha256(Buffer.from(await response.arrayBuffer()));
    },
  };
}

/** Fetch one vault value by exact item name through the audited pipe helper. */
export async function fetchSecret(spawnImpl, keySource, item) {
  if (![SIGNING_ITEM, FORGEJO_READ_ITEM].includes(item)) refuse("vault_item_not_allowed");
  if (!fs.existsSync(keySource)) refuse("key_source_missing");
  return runChild(spawnImpl, keySource, [item], { maxBytes: 16 * 1024 });
}

function rawPublicKey(privateKey) {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) refuse("signing_key_not_ed25519");
  return der.subarray(12);
}

function decodeEnvelope(text) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { refuse("previous_manifest_invalid"); }
  if (envelope?.schema !== ENVELOPE_SCHEMA || typeof envelope.payload !== "string") refuse("previous_manifest_invalid");
  const payload = Buffer.from(envelope.payload, "base64");
  let manifest;
  try { manifest = validateManifest(JSON.parse(payload.toString("utf8"))); } catch { refuse("previous_manifest_invalid"); }
  return { envelope, payload, manifest };
}

function readLogTail(logFile) {
  let text = "";
  try { text = fs.readFileSync(logFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const lines = text.split("\n").filter(Boolean);
  if (text && !text.endsWith("\n")) refuse("signing_log_torn");
  if (!lines.length) return { hash: null, serial: 0 };
  let last;
  try { last = JSON.parse(lines.at(-1)); } catch { refuse("signing_log_invalid"); }
  if (!Number.isSafeInteger(last?.serial)) refuse("signing_log_invalid");
  return { hash: sha256(Buffer.from(lines.at(-1))), serial: last.serial };
}

/** Policy rules that need the Founder's OK; returns the rule names that fired. */
export function founderRules(previous, draft, keysChanged) {
  const rules = [];
  if (!previous) return ["first_manifest", ...(keysChanged ? ["pinned_keys_changed"] : [])];
  if (compareVersions(draft.securityFloor, previous.securityFloor) < 0) rules.push("security_floor_lowered");
  if (compareVersions(draft.recommended, previous.recommended) < 0) rules.push("recommended_lowered");
  const known = new Set(previous.versions.map((entry) => entry.version));
  if (draft.versions.some((entry) => !known.has(entry.version) && compareVersions(entry.version, previous.recommended) < 0)) {
    rules.push("version_below_recommended");
  }
  if (keysChanged) rules.push("pinned_keys_changed");
  return rules;
}

export async function signManifest({
  draftFile, previousFile = null, logFile, outFile, founderOk = null, now = Date.now(),
}, {
  spawnImpl = spawn, fetchImpl = globalThis.fetch, keySource = KEY_SOURCE, backends = null,
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-signer-")),
} = {}) {
  const ownsWorkDir = backends === null;
  const backend = backends ?? defaultBackends({ spawnImpl, fetchImpl, workDir });
  let token = null;
  let keyBytes = null;
  try {
    if (founderOk !== null && !FOUNDER_REF.test(founderOk)) refuse("founder_ok_reference_invalid");
    if (fs.existsSync(outFile)) refuse("output_exists");
    let draft;
    try { draft = validateManifest(JSON.parse(fs.readFileSync(draftFile, "utf8"))); } catch { refuse("draft_invalid"); }
    const previous = previousFile ? decodeEnvelope(fs.readFileSync(previousFile, "utf8")) : null;
    const expires = Date.parse(draft.expires);
    if (!(expires > now) || expires - now > MAX_EXPIRY_DAYS * 86_400_000) refuse("expiry_out_of_range");
    if (previous && draft.serial !== previous.manifest.serial + 1) refuse("serial_not_next");
    const logTail = readLogTail(logFile);
    if (draft.serial <= logTail.serial) refuse("serial_already_signed");

    // Entries already signed must be carried over byte-for-byte.
    const previousEntries = new Map((previous?.manifest.versions ?? []).map((entry) => [entry.version, entry]));
    const fresh = draft.versions.filter((entry) => {
      const old = previousEntries.get(entry.version);
      if (old && JSON.stringify(old) !== JSON.stringify(entry)) refuse("signed_entry_changed", entry.version);
      return !old;
    });

    token = (await fetchSecret(spawnImpl, keySource, FORGEJO_READ_ITEM)).toString("utf8").trim();
    if (!/^[A-Za-z0-9]{16,128}$/.test(token)) refuse("forgejo_read_token_invalid");
    const branch = await backend.api(token, `/branches/${encodeURIComponent(PROTECTED_BRANCH)}`);
    if (branch?.protected !== true) refuse("branch_not_protected");
    await backend.syncMirror();

    const pinnedAt = new Map();
    for (const entry of fresh) {
      if (!HEX40.test(entry.commit) || !(await backend.isAncestor(entry.commit))) refuse("commit_not_on_protected_branch", entry.version);
      const pull = await backend.api(token, `/commits/${entry.commit}/pull`);
      if (pull?.merged !== true || pull?.base?.ref !== PROTECTED_BRANCH || pull?.merge_commit_sha !== entry.commit
        || !Number.isSafeInteger(pull?.number) || !HEX40.test(pull?.head?.sha ?? "")) {
        refuse("pr_not_merged", entry.version);
      }
      const comments = await backend.api(token, `/issues/${pull.number}/comments?limit=50`);
      const receipt = Array.isArray(comments) && comments.some((comment) => typeof comment?.body === "string"
        && B3_RECEIPT.test(comment.body.split("\n")[0]) && comment.body.includes(pull.head.sha));
      if (!receipt) refuse("b3_receipt_missing", entry.version);
      const packageJson = JSON.parse(await backend.showFile(entry.commit, "package.json"));
      if (packageJson.version !== entry.version) refuse("version_mismatch", entry.version);
      const rpc = parseRemoteRpc(await backend.showFile(entry.commit, "src/outbound-pairer.mjs"));
      if (JSON.stringify(rpc) !== JSON.stringify(entry.legacyRpc)) refuse("legacy_rpc_mismatch", entry.version);
      const keys = parsePinnedKeys(await backend.showFile(entry.commit, "src/updater/pinned.mjs"));
      if (keys.length !== 2 || new Set(keys).size !== 2) refuse("pinned_keys_not_configured", entry.version);
      pinnedAt.set(entry.version, keys);
      if ((await backend.rebuildSha256(entry.commit)) !== entry.sha256) refuse("rebuild_sha_mismatch", entry.version);
      if ((await backend.releaseAssetSha256(token, entry.version)) !== entry.sha256) refuse("release_asset_sha_mismatch", entry.version);
    }

    let keysChanged = false;
    if (previous) {
      const baseline = previousEntries.get(previous.manifest.recommended);
      const baseKeys = parsePinnedKeys(await backend.showFile(baseline.commit, "src/updater/pinned.mjs"));
      keysChanged = [...pinnedAt.values()].some((keys) => JSON.stringify(keys) !== JSON.stringify(baseKeys));
    } else {
      const sets = new Set([...pinnedAt.values()].map((keys) => JSON.stringify(keys)));
      keysChanged = sets.size > 1;
    }
    const rules = founderRules(previous?.manifest ?? null, draft, keysChanged);
    if (rules.length && founderOk === null) refuse("founder_ok_required", rules.join(","));

    // Every check passed: only now is the private key fetched.
    keyBytes = await fetchSecret(spawnImpl, keySource, SIGNING_ITEM);
    let privateKey;
    try { privateKey = createPrivateKey({ key: keyBytes, format: "pem" }); } catch { refuse("signing_key_invalid"); }
    finally { keyBytes.fill(0); }
    const publicRaw = rawPublicKey(privateKey);
    const currentPinned = Buffer.from(publicRaw).toString("base64");
    for (const [version, keys] of pinnedAt) if (keys[0] !== currentPinned) refuse("signing_key_not_pinned_current", version);
    if (previous && !rules.includes("pinned_keys_changed")) {
      // The previous manifest must verify under the same key, so a forged
      // "previous" cannot be used to justify a serial or policy baseline.
      const id = keyId(publicRaw);
      const publicKey = createPublicKey(privateKey);
      const ours = Array.isArray(previous.envelope.signatures) && previous.envelope.signatures.some((entry) => entry?.keyId === id
        && typeof entry.sig === "string" && verify(null, previous.payload, publicKey, Buffer.from(entry.sig, "base64")));
      if (!ours) refuse("previous_manifest_not_ours");
    }
    const payload = Buffer.from(JSON.stringify(draft));
    const signature = sign(null, payload, privateKey);
    const envelope = { schema: ENVELOPE_SCHEMA, payload: payload.toString("base64"), signatures: [{ keyId: keyId(publicRaw), sig: signature.toString("base64") }] };
    fs.writeFileSync(outFile, `${JSON.stringify(envelope)}\n`, { flag: "wx", mode: 0o644 });

    const record = {
      at: new Date(now).toISOString(), serial: draft.serial, expires: draft.expires,
      securityFloor: draft.securityFloor, recommended: draft.recommended,
      versions: draft.versions.map(({ version, commit, sha256: digest }) => ({ version, commit, sha256: digest })),
      newVersions: fresh.map((entry) => entry.version), keyId: keyId(publicRaw), payloadSha256: sha256(payload),
      founderOk, founderRules: rules, prevLineSha256: logTail.hash,
    };
    fs.writeFileSync(logFile, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
    return { record, linearComment: linearComment(record) };
  } finally {
    token = null;
    keyBytes?.fill(0);
    if (ownsWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function linearComment(record) {
  const lines = [
    `Tentacles manifest signed: serial ${record.serial}, recommended ${record.recommended}, floor ${record.securityFloor}, expires ${record.expires}.`,
    ...record.versions.map((entry) => `- ${entry.version} ${entry.commit} sha256 ${entry.sha256}${record.newVersions.includes(entry.version) ? " (new)" : ""}`),
    `Key ${record.keyId}; payload sha256 ${record.payloadSha256}; log chain ${record.prevLineSha256 ?? "first entry"}.`,
  ];
  if (record.founderRules.length) lines.push(`Founder OK ${record.founderOk} for: ${record.founderRules.join(", ")}.`);
  return lines.join("\n");
}

function parseCli(argv) {
  const allowed = new Set(["draft", "previous", "log", "out", "founder-ok"]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!argv[index]?.startsWith("--") || !allowed.has(key) || argv[index + 1] === undefined || options[key] !== undefined) {
      throw new Error("usage: sign-manifest --draft FILE [--previous SIGNED_FILE] --log FILE --out FILE [--founder-ok REF]");
    }
    options[key] = argv[index + 1];
  }
  for (const key of ["draft", "log", "out"]) if (!options[key]) throw new Error(`missing --${key}`);
  return { draftFile: options.draft, previousFile: options.previous ?? null, logFile: options.log, outFile: options.out, founderOk: options["founder-ok"] ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const { linearComment: body } = await signManifest(parseCli(process.argv.slice(2)));
    console.log(body);
  } catch (error) {
    console.error(error instanceof SignerRefusal ? `sign-manifest: ${error.message}` : "sign-manifest: failed (no secret or response body is logged)");
    process.exitCode = 1;
  }
}
