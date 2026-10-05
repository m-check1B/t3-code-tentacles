import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_STATE_DIR } from "./config.mjs";
import { privateModeOk } from "./platform.mjs";

export const DEFAULT_PAIR_STATE_FILE = path.join(DEFAULT_STATE_DIR, "pair-presence.json");
export const PAIR_PRESENCE_STATUSES = Object.freeze(["paired", "unpaired", "expired"]);
export const PAIR_STALE_REASONS = Object.freeze([
  "authorization_denied",
  "authorization_expired",
  "authorization_revoked",
  "relay_connecting",
  "relay_connection_closed",
  "relay_connection_error",
  "relay_handshake_timeout",
  "relay_heartbeat_timeout",
  "relay_protocol_error",
  "stopped",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensurePrivatePairDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Pair state directory must be a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Pair state directory must be owned by the current user");
  }
  if (!privateModeOk(stat.mode)) throw new Error("Pair state directory must have mode 0700");
}

function validateExistingStateFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("Pair presence state must not be a symlink");
  if (!stat.isFile()) throw new Error("Pair presence state must be a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Pair presence state must be owned by the current user");
  }
  if (!privateModeOk(stat.mode)) throw new Error("Pair presence state must have mode 0600");
  if (stat.size > 16_384) throw new Error("Pair presence state exceeds 16384 bytes");
  return stat;
}

function readPrivateFile(file, { maxBytes, missing = null, label }) {
  let linkStat;
  try { linkStat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return missing; throw error; }
  if (linkStat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) {
      throw new Error(`${label} must be an unchanged regular file`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the current user`);
    }
    if (!privateModeOk(stat.mode)) throw new Error(`${label} must have mode 0600`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    return { text: fs.readFileSync(descriptor, "utf8"), identity: { dev: stat.dev, ino: stat.ino } };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPairPresence(file = DEFAULT_PAIR_STATE_FILE, { now = Date.now() } = {}) {
  const loaded = readPrivateFile(file, { maxBytes: 16_384, missing: null, label: "Pair presence state" });
  if (!loaded) return { status: "unpaired" };
  let state;
  try {
    state = JSON.parse(loaded.text);
  } catch {
    return { status: "unpaired" };
  }
  if (!isRecord(state) || state.version !== 1 || !PAIR_PRESENCE_STATUSES.includes(state.status)) {
    return { status: "unpaired" };
  }
  if (state.status !== "paired") return { status: state.status };
  const leaseExpiresAt = Date.parse(state.leaseExpiresAt);
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now) return { status: "unpaired" };
  return { status: "paired" };
}

export function writePairPresence(status, {
  file = DEFAULT_PAIR_STATE_FILE,
  now = Date.now(),
  leaseMs = 30_000,
  staleReason = null,
} = {}) {
  if (!PAIR_PRESENCE_STATUSES.includes(status)) throw new Error("Invalid pair presence status");
  if (!Number.isFinite(now)) throw new Error("Pair presence time must be finite");
  if (status === "paired" && (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000)) {
    throw new Error("Pair presence lease must be between 1000ms and 300000ms");
  }
  if (staleReason !== null && !PAIR_STALE_REASONS.includes(staleReason)) {
    throw new Error("Invalid pair presence stale reason");
  }
  if (status === "paired" && staleReason !== null) {
    throw new Error("Paired presence cannot carry a stale reason");
  }
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  ensurePrivatePairDirectory(directory);
  validateExistingStateFile(destination);
  const state = {
    version: 1,
    status,
    updatedAt: new Date(now).toISOString(),
    ...(status === "paired" ? { leaseExpiresAt: new Date(now + leaseMs).toISOString() } : {}),
    ...(staleReason !== null ? { staleReason } : {}),
  };
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { status };
}

function readPairLock(lockFile) {
  const loaded = readPrivateFile(lockFile, { maxBytes: 4_096, missing: null, label: "Pair state lock" });
  if (!loaded) return null;
  let lock;
  try { lock = JSON.parse(loaded.text); }
  catch { throw new Error("Pair state lock is invalid JSON"); }
  if (!isRecord(lock) || lock.version !== 1 || !/^[0-9a-f-]{36}$/.test(lock.owner)
    || !Number.isInteger(lock.pid) || lock.pid < 1) {
    throw new Error("Pair state lock is invalid");
  }
  return { ...lock, identity: loaded.identity };
}

/**
 * KRA-6572: publish a lock file only with its whole body. The body is written
 * and fsynced to a private temp file, then hard-linked into place (EEXIST when
 * held), so a crash can never leave an empty or partial lock behind.
 * Returns an open read descriptor on the published lock.
 */
export function publishLockFile(lockFile, body) {
  const temporary = `${lockFile}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.linkSync(temporary, lockFile);
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
  }
}

const PAIR_LOCK_STALE_MS = 60_000;

function partialPairLock(lockFile, readError) {
  if (!/invalid/.test(String(readError?.message))) throw readError;
  const stat = fs.lstatSync(lockFile);
  if (stat.isSymbolicLink() || Date.now() - stat.mtimeMs <= PAIR_LOCK_STALE_MS) return null;
  return { pid: null, identity: { dev: stat.dev, ino: stat.ino } };
}

/** A recovery guard left by a crashed recoverer must not block recovery forever. */
function clearDeadPairGuard(guardFile) {
  let stat;
  try { stat = fs.lstatSync(guardFile); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(guardFile, "utf8")); } catch { /* partial marker */ }
  const dead = Number.isInteger(marker?.pid) ? !pidIsAlive(marker.pid) : Date.now() - stat.mtimeMs > PAIR_LOCK_STALE_MS;
  if (!dead) return;
  try { if (fs.lstatSync(guardFile).ino === stat.ino) fs.unlinkSync(guardFile); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export function acquirePairStateLock(file = DEFAULT_PAIR_STATE_FILE) {
  const destination = path.resolve(file);
  ensurePrivatePairDirectory(path.dirname(destination));
  const lockFile = `${destination}.lock`;
  const owner = randomUUID();
  // KRA-6572: the body is durable before the lock name exists (temp + link).
  const create = () => fs.closeSync(publishLockFile(lockFile, `${JSON.stringify({ version: 1, owner, pid: process.pid })}\n`));
  const staleLock = () => {
    let existing;
    try { existing = readPairLock(lockFile); }
    catch (readError) {
      // A partial body from a crash has no owner to ask: reclaim it after the stale window.
      existing = partialPairLock(lockFile, readError);
    }
    if (!existing || (existing.pid !== null && pidIsAlive(existing.pid))) return null;
    return existing;
  };
  try {
    create();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!staleLock()) return null;
    // KRA-6572: only one recoverer at a time. Without this guard, B could
    // recover and hold a fresh lock between A's staleness check and A's
    // rename, and A would rename B's live lock away (two live owners).
    const guardFile = `${lockFile}.recovery`;
    clearDeadPairGuard(guardFile);
    let guard;
    try { guard = publishLockFile(guardFile, `${JSON.stringify({ version: 1, owner, pid: process.pid })}\n`); }
    catch (guardError) { if (guardError.code === "EEXIST") return null; throw guardError; }
    try {
      // Re-validate identity and liveness under the guard.
      const confirmed = staleLock();
      if (!confirmed) return null;
      const current = fs.lstatSync(lockFile);
      if (current.isSymbolicLink() || current.dev !== confirmed.identity.dev || current.ino !== confirmed.identity.ino) return null;
      const staleFile = `${lockFile}.stale.${owner}`;
      try { fs.renameSync(lockFile, staleFile); }
      catch (renameError) { if (renameError.code === "ENOENT") return null; throw renameError; }
      try {
        try { create(); } catch (createError) { if (createError.code === "EEXIST") return null; throw createError; }
      } finally {
        try { fs.unlinkSync(staleFile); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
      }
    } catch (recoveryError) {
      if (recoveryError.code === "ENOENT") return null;
      throw recoveryError;
    } finally {
      fs.closeSync(guard);
      try {
        const marker = JSON.parse(fs.readFileSync(guardFile, "utf8"));
        if (marker.owner === owner) fs.unlinkSync(guardFile);
      } catch (unlinkError) { if (unlinkError.code !== "ENOENT" && !(unlinkError instanceof SyntaxError)) throw unlinkError; }
    }
  }
  return () => {
    const current = readPairLock(lockFile);
    if (current?.owner === owner) fs.unlinkSync(lockFile);
  };
}
