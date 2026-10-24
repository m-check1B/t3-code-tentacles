// KRA-8371 (KRA-8367 A3): user-space self-update for standalone Tentacles.
//
// Layout (all under ~/.tentacles, user space only, no sudo, no new unit):
//   versions/<v>/   verified, extracted package trees
//   current         symlink -> versions/<v>, switched atomically
//   hold            any file here blocks every version change (U6)
//   state/          updater.json, events.jsonl, starts.json, restart-request/ack
//   updater/        this module, installed outside the swapped tree
//   tmp/            same-filesystem staging for extraction
//
// Never touched: T3 itself (`t3 update` is never run), ~/.claude, ~/.codex, ~/.t3.
// Node builtins only, so a broken version tree cannot break rollback.
import fs from "node:fs";
import { requireReleaseBase, releaseAssetUrl } from "./release-source.mjs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  artifactName, compareVersions, isVersion, manifestEntry, selectTarget, UpdateError, verifyManifest,
} from "./manifest.mjs";
import { extractPackage, fsyncPath } from "./safe-tar.mjs";
import { appendEvent, buildEvent, readEvents, REASON_CODES } from "./events.mjs";
import {
  MANIFEST_ASSET, MANIFEST_TAG, MIN_MANIFEST_SERIAL, PINNED_PUBLIC_KEYS, UPDATE_BASE_URL,
} from "./pinned.mjs";

export const DEFAULT_HOME = path.join(os.homedir(), ".tentacles");
export const HEALTH_BUDGET_MS = 60_000;
export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASH_LIMIT = 3;
export const EARLY_EXIT_MS = 60_000;
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const STATE_SCHEMA = "tentacles-updater-state/v1";

function reasonOf(error, fallback = "install_failed") {
  return error instanceof UpdateError && REASON_CODES.includes(error.code) ? error.code : fallback;
}

function writeAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "wx", mode);
    try { fs.writeSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    fsyncPath(path.dirname(file), true);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new UpdateError("artifact_unavailable");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new UpdateError("artifact_unavailable");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class SelfUpdater {
  constructor({
    home = DEFAULT_HOME,
    publicKeys = PINNED_PUBLIC_KEYS,
    minSerial = MIN_MANIFEST_SERIAL,
    baseUrl = UPDATE_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    computerId = null,
    isIdle = null,
    restart = null,
    health = null,
    nodePath = process.execPath,
  } = {}) {
    this.home = path.resolve(home);
    this.publicKeys = publicKeys;
    this.minSerial = minSerial;
    this.baseUrl = requireReleaseBase(baseUrl);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.nodePath = nodePath;
    this.paths = {
      versions: path.join(this.home, "versions"),
      current: path.join(this.home, "current"),
      hold: path.join(this.home, "hold"),
      state: path.join(this.home, "state", "updater.json"),
      events: path.join(this.home, "state", "events.jsonl"),
      starts: path.join(this.home, "state", "starts.json"),
      restartRequest: path.join(this.home, "state", "restart-request"),
      restartAck: path.join(this.home, "state", "restart-ack"),
      tmp: path.join(this.home, "tmp"),
    };
    this.computerIdOverride = computerId;
    this.isIdle = isIdle ?? (() => defaultIsIdle(this));
    this.restart = restart ?? (() => signalLauncher(this));
    this.health = health ?? ((context) => defaultHealth(this, context));
  }

  // --- state -------------------------------------------------------------

  readState() {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(this.paths.state, "utf8")); } catch { state = {}; }
    const versionOrNull = (value) => (isVersion(value) ? value : null);
    return {
      schema: STATE_SCHEMA,
      lastSerial: Number.isSafeInteger(state.lastSerial) && state.lastSerial > 0 ? state.lastSerial : 0,
      lastDigest: typeof state.lastDigest === "string" && /^[0-9a-f]{64}$/.test(state.lastDigest) ? state.lastDigest : null,
      lastFloor: versionOrNull(state.lastFloor),
      lastListed: Array.isArray(state.lastListed) ? state.lastListed.filter(isVersion) : [],
      current: versionOrNull(state.current),
      previous: versionOrNull(state.previous),
      computerId: typeof state.computerId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(state.computerId) ? state.computerId : null,
    };
  }

  writeState(patch) {
    const next = { ...this.readState(), ...patch, schema: STATE_SCHEMA };
    writeAtomic(this.paths.state, `${JSON.stringify(next)}\n`);
    return next;
  }

  get computerId() {
    return this.computerIdOverride ?? this.readState().computerId ?? "unknown";
  }

  emit(code, fields = {}) {
    return appendEvent(this.paths.events, buildEvent({ code, computerId: this.computerId, now: this.now(), ...fields }));
  }

  events() {
    return readEvents(this.paths.events);
  }

  isHeld() {
    try { fs.lstatSync(this.paths.hold); return true; } catch (error) { return error.code !== "ENOENT"; }
  }

  /** The crash guard may ADD a hold. No code path in the updater removes one (U6). */
  addHold(reasonLine) {
    try {
      fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.paths.hold, `${reasonLine}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false; // an existing hold is left exactly as it is
      throw error;
    }
  }

  currentVersion() {
    let link;
    try { link = fs.readlinkSync(this.paths.current); } catch { return this.readState().current; }
    const match = /^versions\/(.+)$/.exec(link);
    return match && isVersion(match[1]) ? match[1] : null;
  }

  versionDir(version) {
    if (!isVersion(version)) throw new UpdateError("version_invalid");
    return path.join(this.paths.versions, version);
  }

  versionOnDisk(version) {
    try {
      const dir = this.versionDir(version);
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version === version;
    } catch { return false; }
  }

  // --- manifest ----------------------------------------------------------

  async fetchBytes(url, maxBytes, failCode) {
    let response;
    try {
      response = await this.fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    } catch { throw new UpdateError(failCode); }
    if (!response.ok || !response.body) { await response.body?.cancel?.(); throw new UpdateError(failCode); }
    try { return await readBounded(response, maxBytes); } catch { throw new UpdateError(failCode); }
  }

  async verifiedManifest() {
    if (!Array.isArray(this.publicKeys) || this.publicKeys.length === 0) throw new UpdateError("updater_unconfigured");
    const bytes = await this.fetchBytes(releaseAssetUrl(MANIFEST_TAG, MANIFEST_ASSET), 256 * 1024, "manifest_unavailable");
    const state = this.readState();
    const { manifest, digest } = verifyManifest(bytes, {
      publicKeys: this.publicKeys, now: this.now(), minSerial: this.minSerial,
      lastSerial: state.lastSerial, lastDigest: state.lastDigest,
    });
    this.writeState({
      lastSerial: manifest.serial, lastDigest: digest, lastFloor: manifest.securityFloor,
      lastListed: manifest.versions.map((entry) => entry.version),
    });
    return manifest;
  }

  // --- install -----------------------------------------------------------

  async install(entry) {
    const url = releaseAssetUrl(`v${entry.version}`, artifactName(entry.version));
    const bytes = await this.fetchBytes(url, MAX_ARTIFACT_BYTES, "artifact_unavailable");
    // U4: the signed sha256 is checked before a single entry is parsed.
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new UpdateError("artifact_sha_mismatch");
    fs.mkdirSync(this.paths.tmp, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.versions, { recursive: true, mode: 0o700 });
    const staging = fs.mkdtempSync(path.join(this.paths.tmp, `stage-${entry.version}-`));
    const tree = path.join(staging, "tree");
    fs.mkdirSync(tree, { mode: 0o755 });
    try {
      extractPackage(bytes, tree);
      const packageJson = JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8"));
      if (packageJson.version !== entry.version) throw new UpdateError("artifact_version_mismatch");
      writeAtomic(path.join(tree, "bin", "node-path"), `${this.nodePath}\n`, 0o644);
      fsyncPath(tree, true);
      const destination = this.versionDir(entry.version);
      if (fs.existsSync(destination)) {
        // A same-named tree on disk is not trusted; the fresh verified copy replaces it.
        fs.renameSync(destination, path.join(staging, "replaced"));
      }
      fs.renameSync(tree, destination);
      fsyncPath(this.paths.versions, true);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Atomic `current` switch: a new symlink is renamed over the old one. */
  switchTo(version) {
    if (!this.versionOnDisk(version)) throw new UpdateError("install_failed");
    const temporary = path.join(this.home, `.current.${process.pid}.${randomUUID()}`);
    fs.symlinkSync(`versions/${version}`, temporary);
    try { fs.renameSync(temporary, this.paths.current); }
    catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    fsyncPath(this.home, true);
  }

  undoTarget(manifest, from) {
    const previous = this.readState().previous;
    if (!previous || previous === from) return null;
    if (!this.versionOnDisk(previous)) return null;
    if (compareVersions(previous, manifest.securityFloor) < 0) return null;
    if (!manifestEntry(manifest, previous)) return null;
    return previous;
  }

  /**
   * Switch, restart, health-check within 60 s; on any failure switch back
   * and restart the previous version (tentacles_update_rolled_back).
   */
  async switchWithHealth(from, to) {
    const switchedAt = this.now();
    this.switchTo(to);
    let failure = null;
    try {
      await this.restart();
      const result = await this.health({ version: to, switchedAt, budgetMs: HEALTH_BUDGET_MS });
      if (!result?.ok) failure = REASON_CODES.includes(result?.reason) ? result.reason : "health_timeout";
    } catch (error) {
      failure = reasonOf(error, "health_timeout");
    }
    if (failure === null) return { ok: true };
    if (from && this.versionOnDisk(from)) {
      this.switchTo(from);
      try { await this.restart(); } catch { /* the crash guard covers a failing restart */ }
    }
    this.emit("tentacles_update_rolled_back", { from: to, to: from, reason: failure });
    return { ok: false, reason: failure };
  }

  // --- entry points --------------------------------------------------------

  /**
   * trigger "auto" (launcher timer) or "now" (Update now). Neither takes a
   * version, URL or hash: the device applies `recommended` only (U5).
   */
  async run({ trigger = "auto" } = {}) {
    if (!["auto", "now"].includes(trigger)) throw new Error("trigger must be auto or now");
    const from = this.currentVersion();
    if (this.isHeld()) {
      if (trigger === "now") this.emit("tentacles_update_held", { from, reason: "held" });
      return { status: "held" };
    }
    let manifest;
    try { manifest = await this.verifiedManifest(); }
    catch (error) {
      const reason = reasonOf(error, "manifest_unavailable");
      this.emit("tentacles_update_failed", { from, reason });
      return { status: "failed", reason };
    }
    const selection = selectTarget(manifest, from);
    if (selection.action !== "install") return { status: "up_to_date" };
    const to = selection.version;
    if (selection.entry.needs.length > 0) {
      this.emit("tentacles_update_needs_consent", { from, to, reason: "needs_consent" });
      return { status: "needs_consent", to };
    }
    if (!(await this.isIdle())) {
      if (trigger === "now") this.emit("tentacles_update_failed", { from, to, reason: "busy" });
      return { status: "busy" };
    }
    // Always a fresh verified copy: an on-disk tree of the same name is not trusted.
    try { await this.install(selection.entry); }
    catch (error) {
      const reason = reasonOf(error);
      this.emit("tentacles_update_failed", { from, to, reason });
      return { status: "failed", reason };
    }
    // Re-check after the download: a hold or a new turn may have appeared.
    if (this.isHeld()) return { status: "held" };
    if (!(await this.isIdle())) return { status: "busy" };
    const outcome = await this.switchWithHealth(from, to);
    if (!outcome.ok) return { status: "rolled_back", reason: outcome.reason };
    this.writeState({ current: to, previous: from });
    const undoAvailable = this.undoTarget(manifest, to) !== null;
    this.emit("tentacles_updated", { from, to, undoAvailable });
    return { status: "updated", from, to, undoAvailable };
  }

  /** Undo: only the previous on-disk version, still >= floor and listed (U5). */
  async undo() {
    const from = this.currentVersion();
    if (this.isHeld()) {
      this.emit("tentacles_update_held", { from, reason: "held" });
      return { status: "held" };
    }
    let manifest;
    try { manifest = await this.verifiedManifest(); }
    catch (error) {
      const reason = reasonOf(error, "manifest_unavailable");
      this.emit("tentacles_update_failed", { from, reason });
      return { status: "failed", reason };
    }
    const to = this.undoTarget(manifest, from);
    if (!to) {
      this.emit("tentacles_update_failed", { from, reason: "undo_unavailable" });
      return { status: "failed", reason: "undo_unavailable" };
    }
    if (!(await this.isIdle())) return { status: "busy" };
    const outcome = await this.switchWithHealth(from, to);
    if (!outcome.ok) return { status: "rolled_back", reason: outcome.reason };
    this.writeState({ current: to, previous: from });
    this.emit("tentacles_update_undone", { from, to });
    return { status: "undone", from, to };
  }

  // --- crash guard ---------------------------------------------------------

  readStarts() {
    try {
      const value = JSON.parse(fs.readFileSync(this.paths.starts, "utf8"));
      return Array.isArray(value.failures) ? value.failures.filter(Number.isFinite) : [];
    } catch { return []; }
  }

  /** Record a start that died within EARLY_EXIT_MS; returns the guard outcome. */
  recordFailedStart() {
    const now = this.now();
    const failures = [...this.readStarts(), now].filter((at) => now - at <= CRASH_WINDOW_MS).slice(-20);
    writeAtomic(this.paths.starts, `${JSON.stringify({ failures })}\n`);
    if (failures.length < CRASH_LIMIT) return { status: "recorded", failures: failures.length };
    return this.crashGuard();
  }

  /**
   * Three failed starts in ten minutes: pin the previous version (only when it
   * is on disk, >= the last verified floor and listed) and ADD a hold. An
   * existing hold is honoured: the version is not changed and the hold text is
   * left untouched.
   */
  crashGuard() {
    const from = this.currentVersion();
    const state = this.readState();
    writeAtomic(this.paths.starts, `${JSON.stringify({ failures: [] })}\n`);
    if (this.isHeld()) {
      this.emit("tentacles_crash_guard_hold", { from, reason: "held" });
      return { status: "held" };
    }
    let to = null;
    const previous = state.previous;
    if (previous && previous !== from && this.versionOnDisk(previous) && state.lastFloor
      && compareVersions(previous, state.lastFloor) >= 0 && state.lastListed.includes(previous)) {
      this.switchTo(previous);
      this.writeState({ current: previous, previous: from });
      to = previous;
    }
    this.addHold(`crash-guard ${from ?? "unknown"} ${new Date(this.now()).toISOString()}`);
    this.emit("tentacles_crash_guard_hold", { from, to, reason: "crash_loop" });
    return { status: to ? "pinned" : "held_without_pin", to };
  }
}

// --- defaults used on a real device ------------------------------------------

function runCurrent(updater, args, { timeoutMs }) {
  const bin = path.join(updater.paths.current, "bin", "t3-agent-bridge");
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), Math.max(1, timeoutMs));
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= 8 * 1024 * 1024) chunks.push(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: "" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }); });
  });
}

/** Idle = the local seats projection reports no active turn. Unknown = busy. */
export async function defaultIsIdle(updater) {
  const result = await runCurrent(updater, ["observe"], { timeoutMs: 20_000 });
  if (result.code !== 0) return false;
  try {
    const observed = JSON.parse(result.stdout);
    return Array.isArray(observed.activeTurns) && observed.activeTurns.length === 0;
  } catch { return false; }
}

function pairPresenceFile() {
  return path.join(os.homedir(), ".local", "state", "t3-hermes-bridge", "pair-presence.json");
}

/**
 * Health after a switch, inside one 60 s budget:
 *   1. `doctor --json` exits 0 (the doctor-status source),
 *   2. the pairer wrote `paired` presence after the switch (pair handshake),
 *   3. `observe` answers (the local source of the `seats` RPC).
 */
export async function defaultHealth(updater, { switchedAt, budgetMs }) {
  const deadline = switchedAt + budgetMs;
  const left = () => deadline - Date.now();
  const doctorRun = await runCurrent(updater, ["doctor", "--json"], { timeoutMs: left() });
  if (doctorRun.code !== 0) return { ok: false, reason: left() <= 0 ? "health_timeout" : "health_doctor_failed" };
  let paired = false;
  while (left() > 0 && !paired) {
    try {
      const presence = JSON.parse(fs.readFileSync(pairPresenceFile(), "utf8"));
      paired = presence.status === "paired" && Date.parse(presence.updatedAt) >= switchedAt;
    } catch { paired = false; }
    if (!paired) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!paired) return { ok: false, reason: "health_pair_failed" };
  const seats = await runCurrent(updater, ["observe"], { timeoutMs: left() });
  if (seats.code !== 0) return { ok: false, reason: left() <= 0 ? "health_timeout" : "health_seats_failed" };
  try { JSON.parse(seats.stdout); } catch { return { ok: false, reason: "health_seats_failed" }; }
  return { ok: true };
}

/**
 * Out-of-process callers (Update now, Undo) ask the launcher to restart its
 * child through a request file it polls. No signal is ever sent to a pid read
 * from disk, so a stale pid file cannot hit an unrelated process.
 */
export async function signalLauncher(updater, { timeoutMs = 15_000, pollMs = 250 } = {}) {
  const nonce = randomUUID();
  const ack = updater.paths.restartAck;
  writeAtomic(updater.paths.restartRequest, `${nonce}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fs.readFileSync(ack, "utf8").trim() === nonce) return; } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new UpdateError("start_failed", "no Tentacles launcher acknowledged the restart");
}

export { writeAtomic };
