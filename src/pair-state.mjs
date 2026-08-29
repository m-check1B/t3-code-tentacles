import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_STATE_DIR } from "./config.mjs";

export const DEFAULT_PAIR_STATE_FILE = path.join(DEFAULT_STATE_DIR, "pair-presence.json");
export const PAIR_PRESENCE_STATUSES = Object.freeze(["paired", "unpaired", "expired"]);

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
  if ((stat.mode & 0o077) !== 0) throw new Error("Pair state directory must have mode 0700");
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
  if ((stat.mode & 0o077) !== 0) throw new Error("Pair presence state must have mode 0600");
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
    if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must have mode 0600`);
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
} = {}) {
  if (!PAIR_PRESENCE_STATUSES.includes(status)) throw new Error("Invalid pair presence status");
  if (!Number.isFinite(now)) throw new Error("Pair presence time must be finite");
  if (status === "paired" && (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000)) {
    throw new Error("Pair presence lease must be between 1000ms and 300000ms");
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

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export function acquirePairStateLock(file = DEFAULT_PAIR_STATE_FILE) {
  const destination = path.resolve(file);
  ensurePrivatePairDirectory(path.dirname(destination));
  const lockFile = `${destination}.lock`;
  const owner = randomUUID();
  const create = () => {
    const descriptor = fs.openSync(lockFile, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, owner, pid: process.pid })}\n`);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  try {
    create();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readPairLock(lockFile);
    if (!existing || pidIsAlive(existing.pid)) return null;
    const current = fs.lstatSync(lockFile);
    if (current.isSymbolicLink() || current.dev !== existing.identity.dev || current.ino !== existing.identity.ino) return null;
    const staleFile = `${lockFile}.stale.${owner}`;
    try { fs.renameSync(lockFile, staleFile); }
    catch (renameError) { if (renameError.code === "ENOENT") return null; throw renameError; }
    try {
      try { create(); } catch (createError) { if (createError.code === "EEXIST") return null; throw createError; }
    } finally {
      try { fs.unlinkSync(staleFile); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    }
  }
  return () => {
    const current = readPairLock(lockFile);
    if (current?.owner === owner) fs.unlinkSync(lockFile);
  };
}
