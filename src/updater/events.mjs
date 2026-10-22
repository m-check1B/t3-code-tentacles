// KRA-8371 (U7): update events carry versions, codes and the computer id only.
// No filesystem path, user name, hold text or changelog ever enters an event,
// so the same events are safe on customer computers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isVersion } from "./manifest.mjs";

export const EVENT_SCHEMA = "tentacles-update-event/v1";
export const MAX_STORED_EVENTS = 50;
export const EVENT_CODES = Object.freeze([
  "tentacles_updated", // notice with Undo
  "tentacles_update_undone",
  "tentacles_update_rolled_back",
  "tentacles_update_needs_consent", // card: new permission or unit
  "tentacles_update_held",
  "tentacles_update_failed",
  "tentacles_crash_guard_hold",
]);
export const REASON_CODES = Object.freeze([
  "manifest_expired", "manifest_replay", "manifest_signature_invalid", "manifest_invalid", "manifest_unavailable",
  "updater_unconfigured", "artifact_unavailable", "artifact_sha_mismatch", "artifact_unsafe", "artifact_version_mismatch",
  "busy", "held", "needs_consent", "health_doctor_failed", "health_pair_failed", "health_seats_failed", "health_timeout",
  "start_failed", "crash_loop", "undo_unavailable", "below_floor", "not_listed", "install_failed",
]);
const COMPUTER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function localUserNames() {
  const names = new Set();
  try { names.add(os.userInfo().username); } catch { /* no passwd entry */ }
  for (const key of ["USER", "LOGNAME"]) if (process.env[key]) names.add(process.env[key]);
  return [...names].filter((name) => name.length >= 3).map((name) => name.toLowerCase());
}

/** Refuse a computer id that could leak the local account name. */
export function requireComputerId(value, { userNames = localUserNames() } = {}) {
  if (typeof value !== "string" || !COMPUTER_ID.test(value)) throw new Error("computer id must be a safe identifier");
  const lower = value.toLowerCase();
  if (userNames.some((name) => lower.includes(name))) throw new Error("computer id must not contain the local user name");
  return value;
}

export function buildEvent({ code, computerId, from = null, to = null, reason = null, undoAvailable = false, now = Date.now() }) {
  if (!EVENT_CODES.includes(code)) throw new Error("unknown update event code");
  if (reason !== null && !REASON_CODES.includes(reason)) throw new Error("unknown update reason code");
  for (const version of [from, to]) if (version !== null && !isVersion(version)) throw new Error("event version is invalid");
  if (typeof computerId !== "string" || !COMPUTER_ID.test(computerId)) throw new Error("event computer id is invalid");
  return Object.freeze({
    schema: EVENT_SCHEMA, code, computerId, from, to, reason, undoAvailable: undoAvailable === true,
    at: new Date(now).toISOString(),
  });
}

function isEvent(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["schema", "code", "computerId", "from", "to", "reason", "undoAvailable", "at"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return false;
  try { buildEvent({ ...value, now: Date.parse(value.at) }); } catch { return false; }
  return value.schema === EVENT_SCHEMA && typeof value.undoAvailable === "boolean" && Number.isFinite(Date.parse(value.at));
}

function readPrivateText(file, maxBytes) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
  return fs.readFileSync(file, "utf8");
}

export function readEvents(file) {
  const text = readPrivateText(file, 256 * 1024);
  if (!text) return [];
  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { const value = JSON.parse(line); if (isEvent(value)) events.push(value); } catch { /* skip a torn line */ }
  }
  return events.slice(-MAX_STORED_EVENTS);
}

export function appendEvent(file, event) {
  if (!isEvent(event)) throw new Error("refusing to store an invalid update event");
  const events = [...readEvents(file), event].slice(-MAX_STORED_EVENTS);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, events.map((value) => `${JSON.stringify(value)}\n`).join(""), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return event;
}

/**
 * The block the pairer adds to `doctor-status` (an existing 0.4.1 RPC; the
 * legacy RPC list is unchanged). Hold text is never forwarded, only a ticket
 * id and a version token parsed from it.
 */
export function readSelfUpdateSummary(home = path.join(os.homedir(), ".tentacles")) {
  const stateDir = path.join(home, "state");
  let stateText;
  try { stateText = readPrivateText(path.join(stateDir, "updater.json"), 64 * 1024); } catch { return null; }
  if (stateText === null) return null;
  let state = {};
  try { state = JSON.parse(stateText); } catch { state = {}; }
  let holdText = null;
  try { holdText = readPrivateText(path.join(home, "hold"), 4096); } catch { holdText = ""; }
  let held = holdText !== null;
  if (!held) { try { held = fs.lstatSync(path.join(home, "hold")) !== null; } catch { held = false; } }
  const holdVersion = holdText?.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-jack\.\d+)?)(?=\s|$)/)?.[1] ?? null;
  const holdTicket = holdText?.match(/\bKRA-\d{1,6}\b/)?.[0] ?? null;
  return {
    schema: "tentacles-self-update/v1",
    current: isVersion(state.current) ? state.current : null,
    previous: isVersion(state.previous) ? state.previous : null,
    held,
    holdVersion,
    holdTicket,
    events: readEvents(path.join(stateDir, "events.jsonl")).slice(-10),
  };
}
