import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DEFAULT_TOKEN_FILE, readToken } from "./config.mjs";
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
