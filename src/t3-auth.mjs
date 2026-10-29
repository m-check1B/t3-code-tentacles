import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DEFAULT_TOKEN_FILE, readToken, resolveExecutable } from "./config.mjs";
import { privateModeOk } from "./platform.mjs";

function ownedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || !privateModeOk(stat.mode)) {
    throw new Error("Reauthentication requires an owner-controlled private token directory (0700)");
  }
}

// Explicit operator action only. The supported T3 CLI owns issuance; Tentacles
// never edits T3's database or guesses a new credential from local secrets.
// remote: t3Bin and t3Home live on another computer and spawnImpl reaches it
// (computers.mjs remoteIssueSpawn), so the local file checks do not apply.
export function reauthenticate({ t3Bin, t3Home, tokenFile = process.env.T3_HERMES_TOKEN_FILE || DEFAULT_TOKEN_FILE, spawnImpl = spawnSync, remote = false } = {}) {
  const absolute = remote ? path.posix.isAbsolute : path.isAbsolute;
  if (![t3Bin, t3Home].every(value => typeof value === "string" && absolute(value)) || typeof tokenFile !== "string" || !path.isAbsolute(tokenFile)) {
    throw new Error("reauth requires absolute --t3-bin, --t3-home and token-file paths");
  }
  if (!remote) {
    fs.accessSync(t3Bin, fs.constants.X_OK);
    if (!fs.statSync(t3Bin).isFile()) throw new Error("T3 CLI must be an executable file");
    if (!fs.statSync(t3Home).isDirectory()) throw new Error("T3 home must already exist");
  }
  const directory = path.dirname(tokenFile);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  ownedDirectory(directory);
  let original = null;
  let originalToken = null;
  try {
    original = fs.lstatSync(tokenFile);
    originalToken = readToken(tokenFile); // Same symlink, ownership, permission and bounds gate as runtime reads.
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path.join(directory, `.t3-token-${randomUUID()}.tmp`);
  try {
    // Never stream stdout/stderr: both may contain bearer material.
    let result;
    try {
      result = spawnImpl(t3Bin, ["auth", "session", "issue", "--base-dir", t3Home,
        "--ttl", "30d", "--label", "t3-hermes-bridge", "--subject", "local:t3-hermes-bridge", "--token-only"],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch { throw new Error("T3 session issuance failed; the existing bearer was preserved"); }
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      throw new Error("T3 session issuance failed; the existing bearer was preserved");
    }
    fs.writeFileSync(temporary, result.stdout.trim() + "\n", { mode: 0o600, flag: "wx" });
    try { readToken(temporary); } catch { throw new Error("T3 returned an invalid bearer; the existing bearer was preserved"); }
    ownedDirectory(directory);
    let current = null;
    try { current = fs.lstatSync(tokenFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (original ? !current || current.ino !== original.ino || current.dev !== original.dev || current.mtimeMs !== original.mtimeMs || current.size !== original.size : current) {
      throw new Error("The token file changed during reauthentication; the newer file was preserved");
    }
    // ext4 reuses a freed inode and mtime is tick-coarse, so a same-size
    // replacement can match every stat field; the content cannot.
    if (current && readToken(tokenFile) !== originalToken) {
      throw new Error("The token file changed during reauthentication; the newer file was preserved");
    }
    fs.renameSync(temporary, tokenFile);
    return { authenticated: true, tokenStored: true, mechanism: remote ? "t3-auth-session-issue-over-ssh" : "t3-auth-session-issue" };
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function compareVersions(a, b) {
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta) return delta;
  }
  if (!a[4] || !b[4]) return (a[4] ? -1 : 0) + (b[4] ? 1 : 0); // A release outranks its prereleases.
  const left = a[4].split("."), right = b[4].split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const x = /^\d+$/.test(left[index]) ? Number(left[index]) : left[index];
    const y = /^\d+$/.test(right[index]) ? Number(right[index]) : right[index];
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function executableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

// Resolution order: explicit path, PATH, then the newest semver under
// <t3Home>/runtime/versions/*/t3 whose real path stays inside the T3 home.
export function resolveT3Bin({ t3Bin, t3Home, pathEnv = process.env.PATH || "" } = {}) {
  if (t3Bin) return path.isAbsolute(t3Bin) && executableFile(t3Bin) ? t3Bin : null;
  try {
    const onPath = resolveExecutable("t3", pathEnv);
    if (executableFile(onPath)) return onPath;
  } catch { /* not on PATH */ }
  let home, entries;
  try {
    home = fs.realpathSync(t3Home);
    entries = fs.readdirSync(path.join(t3Home, "runtime", "versions"));
  } catch { return null; }
  const versions = entries.map(name => SEMVER.exec(name)).filter(Boolean).sort((a, b) => compareVersions(b, a));
  for (const version of versions) {
    const candidate = path.join(t3Home, "runtime", "versions", version[0], "t3");
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    // Return what was checked: executing the candidate would re-resolve a swappable symlink.
    if (real.startsWith(home + path.sep) && executableFile(real)) return real;
  }
  return null;
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// KRA-8199: the CLI's opt-out-able 401 recovery. Returns null when disabled;
// otherwise a hook T3Client runs at most once that issues a session through
// the colocated T3 CLI. Errors and results carry the exact manual command.
export function createAutoReauth({
  env = process.env,
  t3Bin = env.TENTACLES_T3_BIN || null,
  t3Home = env.TENTACLES_T3_HOME || path.join(os.homedir(), ".t3"),
  spawnImpl = spawnSync,
  log = message => process.stderr.write(`${message}\n`),
} = {}) {
  if (["0", "false", "off", "no"].includes(String(env.TENTACLES_T3_AUTO_REAUTH ?? "").toLowerCase())) return null;
  return ({ tokenFile }) => {
    const resolved = resolveT3Bin({ t3Bin, t3Home, pathEnv: env.PATH || "" });
    const shown = resolved ?? t3Bin;
    const action = ["tentacles reauth --t3-bin", shown ? shellQuote(shown) : '"$(command -v t3)"', "--t3-home", shellQuote(t3Home),
      ...(tokenFile === DEFAULT_TOKEN_FILE ? [] : ["--token-file", shellQuote(tokenFile)])].join(" ");
    const fail = reason => Object.assign(new Error(reason), { action });
    if (!resolved && t3Bin) {
      throw fail(`automatic reauthentication rejected TENTACLES_T3_BIN ${t3Bin}: ${path.isAbsolute(t3Bin) ? "not an executable file" : "not an absolute path"}`);
    }
    if (!resolved) throw fail(`automatic reauthentication found no executable T3 CLI (TENTACLES_T3_BIN, PATH or ${path.join(t3Home, "runtime", "versions")})`);
    try {
      reauthenticate({ t3Bin: resolved, t3Home, tokenFile, spawnImpl });
    } catch (error) {
      throw fail(`automatic reauthentication failed: ${error.message}`);
    }
    log(`Tentacles: T3 rejected the bearer (401); issued a new session with ${resolved}`);
    return { action };
  };
}
