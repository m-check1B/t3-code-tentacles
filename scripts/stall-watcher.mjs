#!/usr/bin/env node
// KRA-9494 no-AI stall watcher. One pass per run (schedule it, e.g. launchd
// StartInterval). It reads only T3 provider log metadata and tails, calls only
// the local tentacles CLI, and never prints or logs provider text.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const NUDGE_TEXT = "Your stream disconnected; check state read-only, then resume from the first undone step, never repeat a write.";
export const IDLE_MS = 10 * 60 * 1000;
export const STAGGER_MS = 60 * 1000;
export const BACKOFF_MS = 10 * 60 * 1000;
export const MAX_NUDGES = 2;
export const WAKE_EXIT = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_EVENT = /^\[[^\]]*\]\s+(NTIVE|CANON):\s+(\{.*\})\s*$/;
const STALL_TEXT = /Reconnecting\.\.\.\s*\d+\/\d+|exceeded retry limit|429 Too Many Requests/;
// KRA-9702: a dead Codex login and an exhausted 429 retry both end a turn that no nudge can resume.
const AUTH_TEXT = /refresh token was already used|Please log out and sign in again|unauthori[sz]ed|\b401\b|token[ _-]?expired/i;
const RETRY_429 = /exceeded retry limit.*last status:?\s*429/i;
// Turn activity: turn and item events (tool, command, assistant message), raw or canonical.
const NTIVE_ACTIVITY = /^(turn|item)\//;
const CANON_ACTIVITY = /^(turn|item|content|tool)\./;
const TAIL_BYTES = 64 * 1024;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * True only for a real error event: a NTIVE "error" notification or a CANON
 * runtime.warning/runtime.error whose error fields show a disconnect, reconnect
 * or 429. The same text inside commands, output or assistant text never counts.
 */
export function stallEvent(line) {
  const kind = lineKind(line);
  return kind != null && kind !== "activity";
}

/** "activity", a stall cause ("NONE", "AUTH_DEAD", "RETRY_EXHAUSTED_429") or null (anything else, including unparseable lines). */
function lineKind(line) {
  const match = LOG_EVENT.exec(line);
  if (!match) return null;
  let event;
  try { event = JSON.parse(match[2]); } catch { return null; }
  if (!isRecord(event)) return null;
  const name = match[1] === "NTIVE" ? event.method : event.type;
  if (typeof name === "string" && (match[1] === "NTIVE" ? NTIVE_ACTIVITY : CANON_ACTIVITY).test(name)) return "activity";
  return errorCause(match[1], event);
}

/** Stall cause of an error event, or null when it is no disconnect, reconnect, 429 or auth error. */
function errorCause(tag, event) {
  if (tag === "NTIVE" ? event.method !== "error" : !["runtime.warning", "runtime.error"].includes(event.type)) return null;
  const body = [event.payload, event.params].find(isRecord) ?? {};
  const error = [body.detail?.error, body.error, event.error].find(isRecord) ?? {};
  const texts = [event.message, body.message, error.message, error.additionalDetails].filter((text) => typeof text === "string");
  const disconnect = isRecord(error.codexErrorInfo) ? error.codexErrorInfo.responseStreamDisconnected : null;
  if (texts.some((text) => AUTH_TEXT.test(text)) || (isRecord(disconnect) && disconnect.httpStatusCode === 401)) return "AUTH_DEAD";
  if (disconnect == null && !texts.some((text) => STALL_TEXT.test(text))) return null;
  return typeof error.additionalDetails === "string" && RETRY_429.test(error.additionalDetails) ? "RETRY_EXHAUSTED_429" : "NONE";
}

/**
 * Like threadStreamStall: the newest stall error or turn activity line decides.
 * A stall error with only other lines (e.g. a plain runtime.warning) after it is
 * a stall; any turn activity after it (a recovered stream) is not.
 */
export function stalledTail(text) {
  return tailCause(text) != null;
}

/**
 * KRA-9702: the cause of the newest stall error ("NONE" for an ordinary stall,
 * "AUTH_DEAD", "RETRY_EXHAUSTED_429"), or null when the tail is no stall. Only
 * the newest error counts; turn activity after any error clears it.
 */
export function tailCause(text) {
  for (const line of text.split("\n").reverse()) {
    const kind = lineKind(line);
    if (kind) return kind === "activity" ? null : kind;
  }
  return null;
}

function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { fs.closeSync(fd); }
}

const isTime = (value) => typeof value === "number" && Number.isFinite(value);
const validNudge = (nudge) => isRecord(nudge) && isTime(nudge.at) && isTime(nudge.size) && isTime(nudge.mtimeMs) && typeof nudge.ok === "boolean";
const validEntry = (entry) => isRecord(entry) && Array.isArray(entry.nudges) && entry.nudges.every(validNudge)
  && (entry.wokeAt == null || isTime(entry.wokeAt));
const validState = (state) => isRecord(state) && (state.lastNudgeAt == null || isTime(state.lastNudgeAt))
  && isRecord(state.threads) && Object.values(state.threads).every(validEntry);

// A corrupt state file is moved aside and logged, so one bad write cannot fail every later pass.
function readState(file, { t, dryRun, log }) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { lastNudgeAt: null, threads: {} }; if (!(error instanceof SyntaxError)) throw error; }
  if (validState(state)) return state;
  const aside = `${file}.corrupt-${Math.floor(t / 1000)}`;
  if (!dryRun) fs.renameSync(file, aside);
  log("state-corrupt", { movedTo: path.basename(aside) });
  return { lastNudgeAt: null, threads: {} };
}

const INSTANCE_LABEL = /^[A-Za-z0-9._:-]{1,80}$/;

/** Visibility only (KRA-9494 addendum): generating Codex turns per provider instance. */
export function codexConcurrency(activeTurns) {
  const counts = new Map();
  for (const turn of activeTurns) {
    if (typeof turn?.providerName !== "string" || turn.providerName.toLowerCase() !== "codex") continue;
    const instance = typeof turn.providerInstanceId === "string" && INSTANCE_LABEL.test(turn.providerInstanceId) ? turn.providerInstanceId : "unknown";
    counts.set(instance, (counts.get(instance) ?? 0) + 1);
  }
  // fromEntries defines own properties, so prototype-named ids stay plain counts.
  return Object.fromEntries(counts);
}

// Owner alert without AI: one small file per wake. Never creates the directory.
function writeAlert(dir, t, alert, log) {
  try {
    fs.writeFileSync(path.join(dir, `${Math.floor(t / 1000)}-${alert.threadId}.json`), JSON.stringify(alert) + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) { log("alert-failed", { threadId: alert.threadId, code: typeof error.code === "string" ? error.code : "error" }); }
}

function writeState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Runs the local tentacles CLI; resolves { code, stdout }, never rejects. */
export function tentaclesCli(bin = "tentacles") {
  return (args) => new Promise((resolve) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? "") });
    });
  });
}

/**
 * One watcher pass. Returns the exit code: WAKE_EXIT when a thread's log tail is a
 * stall idle past `idleMs` and either its newest error is a dead login or an
 * exhausted 429 retry (no nudge) or its last allowed nudge did not help;
 * 1 when observe fails, else 0.
 */
export async function runPass({ logDir, stateDir, dryRun = false, idleMs = IDLE_MS, now = Date.now,
  cli = tentaclesCli(), out = (line) => process.stdout.write(`${line}\n`),
  alertDir = process.env.TENTACLES_STALL_ALERT_DIR || null }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, "stall-watcher.state.json");
  const t = now();
  const log = (action, fields = {}) => fs.appendFileSync(path.join(stateDir, "stall-watcher.log"),
    JSON.stringify({ at: new Date(t).toISOString(), action, ...(dryRun ? { dryRun } : {}), ...fields }) + "\n", { mode: 0o600 });
  const observed = await cli(["observe"]);
  let activeTurns;
  try { activeTurns = observed.code === 0 ? JSON.parse(observed.stdout).activeTurns : null; } catch { activeTurns = null; }
  if (!Array.isArray(activeTurns)) { log("observe-failed", { code: observed.code }); return 1; }
  // Logged only; nothing below reads it, so it can never throttle, delay or reorder a thread.
  log("concurrency", { codex: codexConcurrency(activeTurns) });
  const state = readState(stateFile, { t, dryRun, log });
  const wake = [];
  for (const turn of activeTurns.filter((turn) => typeof turn?.threadId === "string" && UUID.test(turn.threadId))) {
    const { threadId } = turn;
    const file = path.join(logDir, `events.${threadId}.log`);
    let stat;
    try { stat = fs.statSync(file); } catch (error) { if (error.code === "ENOENT") { log("no-log", { threadId }); continue; } throw error; }
    if (t - stat.mtimeMs <= idleMs) continue;
    const cause = tailCause(readTail(file));
    if (!cause) continue;
    const entry = state.threads[threadId] ??= { nudges: [] };
    const last = entry.nudges.at(-1);
    const wakeOwner = (wakeCause) => {
      entry.wokeAt = t; wake.push({ threadId, cause: wakeCause }); log("wake", { threadId, cause: wakeCause });
      if (alertDir && !dryRun) writeAlert(alertDir, t, { threadId, cause: wakeCause, nudges: entry.nudges.length,
        lastEventAt: new Date(stat.mtimeMs).toISOString(), ...(typeof turn.title === "string" ? { title: turn.title } : {}) }, log);
    };
    // A dead login or an exhausted 429 retry only answers a nudge with another 429 (KRA-9702).
    if (cause !== "NONE") { if (entry.wokeAt == null) wakeOwner(cause); continue; }
    if (entry.nudges.length >= MAX_NUDGES) {
      // Reaching here means the tail is a stall and idle past the window, whether or
      // not the log moved since the last nudge (a nudged turn that disconnected again).
      if (t - last.at >= idleMs && entry.wokeAt == null) wakeOwner("STALLED_AFTER_NUDGES");
      continue;
    }
    // After a 429 the provider needs time; never nudge one thread sooner than BACKOFF_MS.
    if (last && t - last.at < BACKOFF_MS) { log("backoff", { threadId }); continue; }
    if (state.lastNudgeAt != null && t - state.lastNudgeAt < STAGGER_MS) { log("stagger", { threadId }); continue; }
    if (dryRun) { log("nudge", { threadId, nudge: entry.nudges.length + 1 }); continue; }
    const intent = { action: "thread.continue", threadId, text: NUDGE_TEXT, runtimeMode: "full-access" };
    const result = await cli(["act", "--no-wait", "--intent", JSON.stringify(intent)]);
    // A failed send still counts, so a broken CLI cannot cause unbounded retries.
    entry.nudges.push({ at: t, size: stat.size, mtimeMs: stat.mtimeMs, ok: result.code === 0 });
    state.lastNudgeAt = t;
    log(result.code === 0 ? "nudge" : "nudge-failed", { threadId, nudge: entry.nudges.length, code: result.code });
  }
  if (!dryRun) writeState(stateFile, state);
  // Ordinary wakes keep the bare "WAKE <threadId>" line; classified ones append the cause.
  for (const { threadId, cause } of wake) out(cause === "STALLED_AFTER_NUDGES" ? `WAKE ${threadId}` : `WAKE ${threadId} cause=${cause}`);
  return wake.length ? WAKE_EXIT : 0;
}

export function parseArgs(argv) {
  const options = { stateDir: path.join(os.homedir(), ".local/state/tentacles-stall-watcher"), tentacles: "tentacles",
    dryRun: false, idleMs: IDLE_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    const value = argv[index += 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--log-dir") options.logDir = value;
    else if (flag === "--state-dir") options.stateDir = value;
    else if (flag === "--tentacles") options.tentacles = value;
    else if (flag === "--idle-minutes" && Number(value) > 0) options.idleMs = Number(value) * 60 * 1000;
    else throw new Error(`Unknown or invalid option ${flag}`);
  }
  if (!options.logDir) throw new Error("Usage: stall-watcher.mjs --log-dir T3_PROVIDER_LOG_DIR [--state-dir DIR] [--tentacles BIN] [--idle-minutes 10] [--dry-run]");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = await runPass({ ...options, cli: tentaclesCli(options.tentacles) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
