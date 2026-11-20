import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DEFAULT_TOKEN_FILE, readToken, resolveExecutable, tokenFileUnset } from "./config.mjs";
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
// KRA-10852: Node >= 22 refuses to spawn a .cmd/.bat without a shell (EINVAL), and
// T3 Code (Beta) on Windows ships its CLI only as bin\t3.cmd. Windows is not supported yet.
export const WINDOWS_LAUNCHER_UNSUPPORTED = "Windows is not supported yet: the T3 Code (Beta) CLI there is a .cmd launcher that Tentacles cannot run";
const WINDOWS_ACTION = `${WINDOWS_LAUNCHER_UNSUPPORTED}; run Tentacles on macOS or Linux.`;
const windowsLauncher = (file, platform) => platform === "win32" && /\.(?:cmd|bat)$/i.test(file);

export function reauthenticate(options = {}) {
  return issueSession(options).commit();
}

// KRA-10860: issues a session into a private temporary file without storing it,
// so a caller can check it against the running T3 first. commit() stores it with
// the same race checks; discard() drops it. reauthenticate commits at once.
// The token file as it was before issuance; a caller trying several launchers takes it once (KRA-10860 B3 P1-1).
export function snapshotTokenFile(tokenFile) {
  let original = null;
  let originalToken = null;
  try {
    original = fs.lstatSync(tokenFile);
    // Same symlink, ownership, permission and bounds gate as runtime reads; a first-run empty file has no bearer to keep.
    originalToken = tokenFileUnset(tokenFile) ? "" : readToken(tokenFile);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { original, originalToken };
}

export const TOKEN_FILE_CHANGED = "The token file changed during reauthentication; the newer file was preserved";

export function tokenFileUnchanged(tokenFile, { original, originalToken }) {
  let current = null;
  try { current = fs.lstatSync(tokenFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (original ? !current || current.ino !== original.ino || current.dev !== original.dev || current.mtimeMs !== original.mtimeMs || current.size !== original.size : current) {
    return false;
  }
  // ext4 reuses a freed inode and mtime is tick-coarse, so a same-size
  // replacement can match every stat field; the content cannot.
  return !current || (tokenFileUnset(tokenFile) ? "" : readToken(tokenFile)) === originalToken;
}

export function issueSession({ t3Bin, t3Home, tokenFile = process.env.T3_HERMES_TOKEN_FILE || DEFAULT_TOKEN_FILE, spawnImpl = spawnSync, remote = false, platform = process.platform, snapshot = null } = {}) {
  const absolute = remote ? path.posix.isAbsolute : path.isAbsolute;
  if (![t3Bin, t3Home].every(value => typeof value === "string" && absolute(value)) || typeof tokenFile !== "string" || !path.isAbsolute(tokenFile)) {
    throw new Error("reauth requires absolute --t3-bin, --t3-home and token-file paths");
  }
  if (!remote) {
    if (windowsLauncher(t3Bin, platform)) throw new Error(`${WINDOWS_LAUNCHER_UNSUPPORTED} (${t3Bin})`);
    fs.accessSync(t3Bin, fs.constants.X_OK);
    if (!fs.statSync(t3Bin).isFile()) throw new Error("T3 CLI must be an executable file");
    if (!fs.statSync(t3Home).isDirectory()) throw new Error("T3 home must already exist");
  }
  const directory = path.dirname(tokenFile);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  ownedDirectory(directory);
  const before = snapshot ?? snapshotTokenFile(tokenFile);
  const temporary = path.join(directory, `.t3-token-${randomUUID()}.tmp`);
  const discard = () => { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } };
  let token;
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
    try { token = readToken(temporary); } catch { throw new Error("T3 returned an invalid bearer; the existing bearer was preserved"); }
  } catch (error) {
    discard();
    throw error;
  }
  const commit = () => {
    try {
      ownedDirectory(directory);
      if (!tokenFileUnchanged(tokenFile, before)) throw new Error(TOKEN_FILE_CHANGED);
      fs.renameSync(temporary, tokenFile);
      return { authenticated: true, tokenStored: true, mechanism: remote ? "t3-auth-session-issue-over-ssh" : "t3-auth-session-issue" };
    } finally { discard(); }
  };
  return { token, commit, discard };
}

export const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function compareVersions(a, b) {
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

// Resolution order: explicit path, PATH, the newest semver under
// <t3Home>/runtime/versions/*/t3, then <t3Home>/bin/t3 (t3.cmd on Windows), the
// launcher stock T3 Code (Beta) v0.1.11 writes (DesktopCliShim.launcherPath).
// The launcher is last so hosts that already resolve keep their binary (KRA-10852);
// automatic sign-in tries the others in order when T3 rejects a session (KRA-10860).
// Every T3-home candidate must keep its real path inside the T3 home.
// An explicit path is the only candidate: it is never replaced.
export function t3BinCandidates({ t3Bin, t3Home, pathEnv = process.env.PATH || "", platform = process.platform } = {}) {
  if (t3Bin) return path.isAbsolute(t3Bin) && executableFile(t3Bin) ? [t3Bin] : [];
  const found = [];
  try {
    const onPath = resolveExecutable("t3", pathEnv);
    if (executableFile(onPath)) found.push(onPath);
  } catch { /* not on PATH */ }
  let home;
  try { home = fs.realpathSync(t3Home); } catch { return found; }
  let entries = [];
  try { entries = fs.readdirSync(path.join(t3Home, "runtime", "versions")); } catch { /* fresh stock home */ }
  const versions = entries.map(name => SEMVER.exec(name)).filter(Boolean).sort((a, b) => compareVersions(b, a));
  const candidates = [...versions.map(version => path.join(t3Home, "runtime", "versions", version[0], "t3")),
    path.join(t3Home, "bin", platform === "win32" ? "t3.cmd" : "t3")];
  for (const candidate of candidates) {
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    // Return what was checked: executing the candidate would re-resolve a swappable symlink.
    if (real.startsWith(home + path.sep) && executableFile(real) && !found.includes(real)) found.push(real);
  }
  return found;
}

export function resolveT3Bin(options = {}) {
  return t3BinCandidates(options)[0] ?? null;
}

const realOr = file => { try { return fs.realpathSync(file); } catch { return file; } };

// KRA-10860 B3 P3-3: the CLI whose `policy show` doctor reads. With several launchers, the
// official bin/t3 the running T3 Code (Beta) wrote, never a leftover first candidate.
export function policyT3Bin(options = {}) {
  const candidates = t3BinCandidates(options);
  const stock = realOr(path.join(options.t3Home ?? "", "bin", "t3"));
  return candidates.find(bin => bin === stock) ?? candidates[0] ?? null;
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
  platform = process.platform,
} = {}) {
  if (["0", "false", "off", "no"].includes(String(env.TENTACLES_T3_AUTO_REAUTH ?? "").toLowerCase())) return null;
  // accepts(token): optional async check against the running T3 (T3Client.accepts); false = T3 rejects it (KRA-10860).
  return async ({ tokenFile, cause = "401", accepts = null }) => {
    const candidates = t3BinCandidates({ t3Bin, t3Home, pathEnv: env.PATH || "", platform });
    const resolved = candidates[0] ?? null;
    if (resolved && windowsLauncher(resolved, platform)) {
      // Never offer a reauth command that cannot work; the action is the one-line truth.
      throw Object.assign(new Error(`automatic reauthentication found ${resolved}, but ${WINDOWS_LAUNCHER_UNSUPPORTED}`),
        { action: WINDOWS_ACTION });
    }
    const stock = path.join(t3Home, "bin", "t3");
    const commandFor = bin => ["tentacles reauth --t3-bin", shellQuote(bin), "--t3-home", shellQuote(t3Home),
      ...(tokenFile === DEFAULT_TOKEN_FILE ? [] : ["--token-file", shellQuote(tokenFile)])].join(" ");
    // P3-2: with several launchers, a hint names the official bin/t3 when it is one of them, never a stale one.
    const official = candidates.length > 1 ? candidates.find(bin => bin === realOr(stock)) : null;
    const shown = official ?? resolved ?? t3Bin;
    // Nothing found: name the launcher stock T3 Code (Beta) installs when it first opens (KRA-10852).
    const action = shown ? commandFor(shown) : platform === "win32" ? WINDOWS_ACTION
      : `Open T3 Code (Beta) once, then run: ${commandFor(stock)}`;
    const fail = (reason, hint = action) => Object.assign(new Error(reason), { action: hint });
    if (!resolved && t3Bin) {
      throw fail(`automatic reauthentication rejected TENTACLES_T3_BIN ${t3Bin}: ${path.isAbsolute(t3Bin) ? "not an executable file" : "not an absolute path"}`);
    }
    if (!resolved) throw fail(`automatic reauthentication found no executable T3 CLI (TENTACLES_T3_BIN, PATH, ${path.join(t3Home, "runtime", "versions")} or ${path.join(t3Home, "bin")}); open T3 Code (Beta) once so it installs its t3 launcher`);
    const REJECTED = "the running T3 rejected the session it issued";
    const changed = () => fail(`automatic reauthentication failed: ${TOKEN_FILE_CHANGED} (${tokenFile})`, `Rerun the command; Tentacles now uses ${tokenFile}`);
    // One snapshot for every launcher: a writer that replaces the file while one is probed is never overwritten (B3 P1-1).
    let snapshot;
    try { snapshot = snapshotTokenFile(tokenFile); } catch (error) { throw fail(`automatic reauthentication failed: ${error.message}`); }
    const failures = [];
    for (const bin of candidates) {
      if (failures.length && !tokenFileUnchanged(tokenFile, snapshot)) throw changed();
      let session;
      try {
        session = issueSession({ t3Bin: bin, t3Home, tokenFile, spawnImpl, platform, snapshot });
      } catch (error) { failures.push([bin, error.message]); continue; }
      try {
        // A rejected session is dropped, never stored: the next launcher is tried (a stale runtime/versions/*/t3).
        if (accepts && !(await accepts(session.token))) { failures.push([bin, REJECTED]); continue; }
        // A commit error (the token file changed meanwhile) stops here: trying on would overwrite the newer file.
        try { session.commit(); } catch (error) {
          throw error.message === TOKEN_FILE_CHANGED ? changed() : fail(`automatic reauthentication failed: ${error.message}`, commandFor(bin));
        }
      } finally { session.discard(); }
      for (const [skipped, why] of failures) log(`Tentacles: skipped T3 CLI ${skipped}: ${why}`);
      log(cause === "first-run" ? `Tentacles: no T3 bearer yet; issued a new session with ${bin}`
        : `Tentacles: T3 rejected the bearer (401); issued a new session with ${bin}`);
      return { action: commandFor(bin) };
    }
    const reason = failures.length === 1 ? failures[0][1] : failures.map(([bin, why]) => `${bin}: ${why}`).join("; ");
    if (!failures.some(([, why]) => why === REJECTED)) throw fail(`automatic reauthentication failed: ${reason}`);
    if (t3Bin) {
      // Explicit stays explicit: say so and name the next step instead of falling back.
      throw fail(`automatic reauthentication with TENTACLES_T3_BIN ${t3Bin} failed: ${reason}; TENTACLES_T3_BIN is never replaced automatically`,
        `Point TENTACLES_T3_BIN at the launcher of the running T3 Code (Beta) (usually ${stock}) or unset it, then run: ${commandFor(stock)}`);
    }
    throw fail(`automatic reauthentication failed: ${reason}`,
      `Check that ${t3Home} is the home of the running T3 Code (Beta) (set TENTACLES_T3_HOME), open T3 Code (Beta) once, then run: ${commandFor(stock)}`);
  };
}
