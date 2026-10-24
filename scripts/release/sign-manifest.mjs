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
import { fileURLToPath, pathToFileURL } from "node:url";
import { B3_REVIEWERS } from "./b3-reviewers.mjs";
import { releaseAssetUrl, RELEASE_SERVER } from "../../src/updater/release-source.mjs";
import {
  compareVersions, ENVELOPE_SCHEMA, keyId, validateManifest,
} from "../../src/updater/manifest.mjs";

export { RELEASE_DOWNLOAD } from "../../src/updater/release-source.mjs";
export const REPOSITORY = "m-check1B/t3-code-tentacles-private";
export const PROTECTED_BRANCH = "jack/0.4.1-maintenance";
export const SIGNING_ITEM = "tentacles-manifest-signing-key-current";
export const NEXT_SIGNING_ITEM = "tentacles-manifest-signing-key-next"; // never fetched here
// Execute verified source bytes on stdin, so replacing the path after hashing
// cannot substitute a different program. Secrets use fd 3, never helper stdout.
export const KEY_SOURCE = fileURLToPath(new URL("./signer-key-source.mjs", import.meta.url));
export const KEY_SOURCE_SHA256 = "bacdb830730c868bd7a1cc5300844e8d4d799ea2d7f82f5ffe07704ac57ed1cf";
export const MAX_EXPIRY_DAYS = 45;
const B3_RECEIPT = /^APPROVE tentacles-private#([1-9][0-9]*) ([0-9a-f]{40}) P1=0 P2=0$/;
const THREAD = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const FOUNDER_REF = /^[A-Za-z0-9._:#/-]{3,160}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class SignerRefusal extends Error {
  constructor(code, detail = code) { super(`refused: ${code}${detail === code ? "" : ` (${detail})`}`); this.code = code; }
}

function refuse(code, detail) { throw new SignerRefusal(code, detail); }

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

/** Clear JS-owned pipe Buffers, including rejected/late chunks. The returned
 * copy belongs to the consumer (fetchSecret clears it in finally). This does
 * not erase immutable JS strings, OS pipe buffers or native KeyObject memory.
 */
export function runChild(spawnImpl, command, args, {
  cwd, input = null, maxBytes = 64 * 1024 * 1024, timeoutMs = 300_000, secret = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), LANG: "C" };
    let child;
    let done = false;
    let size = 0;
    const chunks = [];
    const wipe = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const kill = () => {
      if (secret && child?.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* already exited */ }
      }
      child?.kill("SIGKILL");
    };
    const cleanup = () => {
      clearTimeout(deadline);
      process.removeListener("exit", onExit);
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    };
    const fail = () => {
      if (done) return;
      done = true;
      wipe();
      kill();
      cleanup();
      reject(new SignerRefusal("subprocess_failed", path.basename(command)));
    };
    const onExit = () => { wipe(); kill(); };
    const signalHandlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => {
      fail();
      // Restore the normal signal disposition after clearing and killing.
      process.kill(process.pid, signal);
    }]);
    const deadline = setTimeout(fail, timeoutMs);
    process.once("exit", onExit);
    for (const [signal, handler] of signalHandlers) process.once(signal, handler);
    try {
      child = spawnImpl(command, args, {
        cwd, env, detached: secret,
        stdio: [input === null ? "ignore" : "pipe", "pipe", secret ? "pipe" : "ignore", ...(secret ? ["pipe"] : [])],
      });
      const output = secret ? child.stdio[3] : child.stdout;
      output.on("error", fail);
      output.on("data", (chunk) => {
        if (done || (size += chunk.length) > maxBytes) { chunk.fill(0); fail(); return; }
        chunks.push(chunk);
      });
      if (secret) {
        for (const stream of [child.stdout, child.stderr]) {
          stream.on("error", fail);
          stream.on("data", (chunk) => { chunk.fill(0); fail(); });
        }
      }
      child.on("error", fail);
      child.stdin?.on("error", fail);
      child.on("close", (code, signal) => {
        if (done) return;
        if (code !== 0 || signal || (secret && size === 0)) { fail(); return; }
        const stdout = Buffer.concat(chunks);
        wipe();
        done = true;
        cleanup();
        resolve(stdout);
      });
      if (input !== null) child.stdin.end(input);
    } catch { fail(); }
  });
}

/** Thread ids are self-attestations under one pinned GitHub account. They
 * provide weaker separation than independent authenticated accounts. */
export function writerThread(body) {
  if (typeof body !== "string") return null;
  const lines = body.split("\n").filter((line) => line.startsWith("writer-thread="));
  if (lines.length !== 1) return null;
  const id = lines[0].slice("writer-thread=".length);
  return THREAD.test(id) ? id : null;
}

export function approvedB3(receipt, { head, number, writerThread: writer, headAvailableAt, mergedAt, now }) {
  const author = receipt?.user;
  if (!B3_REVIEWERS.some((account) => account.id === author?.id && account.login === author?.login)) return false;
  if (typeof receipt?.body !== "string" || !THREAD.test(writer ?? "")) return false;
  const lines = receipt.body.split("\n");
  const match = B3_RECEIPT.exec(lines[0]);
  if (!match || Number(match[1]) !== number || match[2] !== head) return false;
  const markers = lines.filter((line) => /(?:writer|reviewer)-thread=/.test(line));
  if (markers.length !== 1) return false;
  const threads = /^writer-thread=([^ ]+) reviewer-thread=([^ ]+)$/.exec(markers[0]);
  if (!threads || threads[1] !== writer || !THREAD.test(threads[2]) || threads[1] === threads[2]) return false;
  const at = Date.parse(receipt.created_at);
  const updated = Date.parse(receipt.updated_at);
  const available = Date.parse(headAvailableAt);
  const merged = Date.parse(mergedAt);
  return Number.isFinite(at) && Number.isFinite(available) && Number.isFinite(merged)
    && updated === at && at > available && at <= merged && merged <= now;
}

/** GitHub exposes no reliable pushedDate for every commit. A GitHub Actions
 * suite created for this exact head is authenticated evidence that the head
 * already existed on GitHub; requiring the comment AFTER it is conservative.
 * No client-authored commit date or PR-wide updated_at can substitute. */
export function headAvailableAt(suites, head, now) {
  const times = suites.filter((suite) => suite?.head_sha === head
    && suite?.repository?.full_name === REPOSITORY
    && suite?.app?.id === 15368 && suite?.app?.slug === "github-actions")
    .map((suite) => Date.parse(suite.created_at)).filter((at) => Number.isFinite(at) && at <= now);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export async function verifyGithubProvenance(backend, entry, now) {
  const candidates = await backend.list(`/commits/${entry.commit}/pulls?per_page=100`);
  const merged = candidates.filter((pull) => pull?.base?.ref === PROTECTED_BRANCH
    && pull?.base?.repo?.full_name === REPOSITORY && pull?.head?.sha === entry.commit);
  // Ambiguity cannot select whichever PR happens to have an approval.
  if (merged.length !== 1 || !Number.isSafeInteger(merged[0].number) || merged[0].number <= 0) refuse("pr_not_merged", entry.version);
  const pull = await backend.api(`/pulls/${merged[0].number}`);
  if (pull?.number !== merged[0].number || pull?.merged !== true || pull?.base?.ref !== PROTECTED_BRANCH
    || pull?.base?.repo?.full_name !== REPOSITORY || pull?.head?.repo?.full_name !== REPOSITORY
    || pull?.merge_commit_sha !== entry.commit || !HEX40.test(pull?.head?.sha ?? "")) refuse("pr_not_merged", entry.version);
  if (pull.head.sha !== entry.commit) refuse("b3_head_not_signed_commit", entry.version);
  const suites = await backend.list(`/commits/${entry.commit}/check-suites?per_page=100`, "check_suites");
  const binding = { head: entry.commit, number: pull.number, writerThread: writerThread(pull.body),
    headAvailableAt: headAvailableAt(suites, entry.commit, now), mergedAt: pull.merged_at, now };
  const comments = await backend.list(`/issues/${pull.number}/comments?per_page=100`);
  if (!comments.some((comment) => approvedB3(comment, binding))) refuse("b3_receipt_missing", entry.version);
  return { pull, binding };
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

/** The legacy provenance backend always refuses; GitHub uses a separate port. */
export function defaultBackends() {
  refuse("github_provenance_unavailable");
}

/** GitHub is the only live provenance backend; tests use isolated fixtures. */
export function githubBackends({ spawnImpl = spawn, workDir }) {
  const mirror = path.join(workDir, "mirror.git");
  const git = (args) => runChild(spawnImpl, "git", ["--git-dir", mirror, ...args]);
  let fetched = false;
  return {
    async syncMirror() {
      if (!fs.existsSync(mirror)) await runChild(spawnImpl, "git", ["init", "--bare", "--quiet", mirror]);
      await git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "--quiet", "--prune", `${RELEASE_SERVER}/${REPOSITORY}.git`, `+refs/heads/${PROTECTED_BRANCH}:refs/heads/${PROTECTED_BRANCH}`]);
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
    async api(suffix) {
      const bytes = await runChild(spawnImpl, "gh", ["api", "--hostname", "github.com", `repos/${REPOSITORY}${suffix}`]);
      try { return JSON.parse(bytes.toString("utf8")); } catch { refuse("github_response_invalid"); }
    },
    async list(suffix, field = null) {
      const bytes = await runChild(spawnImpl, "gh", ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${REPOSITORY}${suffix}`]);
      let pages;
      try { pages = JSON.parse(bytes.toString("utf8")); } catch { refuse("github_response_invalid"); }
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(field ? page?.[field] : page))) refuse("github_response_invalid");
      return pages.flatMap((page) => field ? page[field] : page);
    },
    async releaseAssetSha256(version) {
      const release = await this.api(`/releases/tags/v${version}`);
      if (!Number.isSafeInteger(release?.id) || release.id <= 0 || release.tag_name !== `v${version}` || release.draft !== false) refuse("release_asset_unavailable", version);
      const assets = await this.list(`/releases/${release.id}/assets?per_page=100`);
      const matching = assets.filter((asset) => asset?.name === `tentacles-${version}.tgz`);
      if (matching.length !== 1 || !Number.isSafeInteger(matching[0].id) || matching[0].id <= 0
        || matching[0].browser_download_url !== releaseAssetUrl(`v${version}`, `tentacles-${version}.tgz`)) refuse("release_asset_unavailable", version);
      const bytes = await runChild(spawnImpl, "gh", ["api", "--hostname", "github.com", "-H", "Accept: application/octet-stream", `repos/${REPOSITORY}/releases/assets/${matching[0].id}`]);
      return sha256(bytes);
    },
  };
}

/** Read pinned bytes, not a mutable home-directory executable. */
export function keySourceBytes(keySource = KEY_SOURCE) {
  let fd;
  try {
    fd = fs.openSync(keySource, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022) || stat.size > 32 * 1024) refuse("key_source_unsafe");
    const source = fs.readFileSync(fd);
    if (sha256(source) !== KEY_SOURCE_SHA256) refuse("key_source_hash_mismatch");
    return source;
  } catch (error) {
    if (error instanceof SignerRefusal) throw error;
    refuse("key_source_missing_or_unsafe");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Fetch a value via fd only and clear its concatenated copy after consumption. */
export async function fetchSecret(spawnImpl, keySource, item, consume) {
  if (item !== SIGNING_ITEM) refuse("vault_item_not_allowed");
  const source = keySourceBytes(keySource);
  const bytes = await runChild(spawnImpl, process.execPath, ["--input-type=module", "-", item], {
    input: source, maxBytes: 16 * 1024, timeoutMs: 30_000, secret: true,
  });
  try { return await consume(bytes); }
  finally { bytes.fill(0); }
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
  spawnImpl = spawn, keySource = KEY_SOURCE, backends = null,
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-signer-")),
} = {}) {
  const ownsWorkDir = backends === null;
  let backend;
  try {
    backend = backends ?? githubBackends({ spawnImpl, workDir });
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

    const branch = await backend.api(`/branches/${encodeURIComponent(PROTECTED_BRANCH)}`);
    if (branch?.protected !== true) refuse("branch_not_protected");
    await backend.syncMirror();

    const pinnedAt = new Map();
    for (const entry of fresh) {
      if (!HEX40.test(entry.commit) || !(await backend.isAncestor(entry.commit))) refuse("commit_not_on_protected_branch", entry.version);
      await verifyGithubProvenance(backend, entry, now);
      const packageJson = JSON.parse(await backend.showFile(entry.commit, "package.json"));
      if (packageJson.version !== entry.version) refuse("version_mismatch", entry.version);
      const rpc = parseRemoteRpc(await backend.showFile(entry.commit, "src/outbound-pairer.mjs"));
      if (JSON.stringify(rpc) !== JSON.stringify(entry.legacyRpc)) refuse("legacy_rpc_mismatch", entry.version);
      const keys = parsePinnedKeys(await backend.showFile(entry.commit, "src/updater/pinned.mjs"));
      if (keys.length !== 2 || new Set(keys).size !== 2) refuse("pinned_keys_not_configured", entry.version);
      pinnedAt.set(entry.version, keys);
      if ((await backend.rebuildSha256(entry.commit)) !== entry.sha256) refuse("rebuild_sha_mismatch", entry.version);
      if ((await backend.releaseAssetSha256(entry.version)) !== entry.sha256) refuse("release_asset_sha_mismatch", entry.version);
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
    const privateKey = await fetchSecret(spawnImpl, keySource, SIGNING_ITEM, (bytes) => {
      // A single PKCS8 PEM only: parsers may otherwise ignore appended output.
      const begin = Buffer.from("-----BEGIN PRIVATE KEY-----\n");
      const end = Buffer.from("\n-----END PRIVATE KEY-----");
      // nasvault set-password strips trailing newlines. Permit exactly the
      // standard optional final LF, without accepting appended diagnostics.
      const pem = bytes.at(-1) === 10 ? bytes.subarray(0, -1) : bytes;
      if (!pem.subarray(0, begin.length).equals(begin) || !pem.subarray(-end.length).equals(end)) refuse("signing_key_invalid");
      for (const byte of pem.subarray(begin.length, -end.length)) {
        if (!(byte >= 65 && byte <= 90) && !(byte >= 97 && byte <= 122) && !(byte >= 48 && byte <= 57)
          && ![43, 47, 61, 10].includes(byte)) refuse("signing_key_invalid");
      }
      try { return createPrivateKey({ key: bytes, format: "pem" }); } catch { refuse("signing_key_invalid"); }
    });
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
    if (process.argv.length === 3 && process.argv[2] === "--check-key-source") {
      keySourceBytes();
      console.log(`key-source pinned sha256=${KEY_SOURCE_SHA256}; custody audit still required`);
    } else {
      const { linearComment: body } = await signManifest(parseCli(process.argv.slice(2)));
      console.log(body);
    }
  } catch (error) {
    console.error(error instanceof SignerRefusal ? `sign-manifest: ${error.message}` : "sign-manifest: failed (no secret or response body is logged)");
    process.exitCode = 1;
  }
}
