#!/usr/bin/env node
// KRA-9690 no-AI origination-ledger counter. Read-only: it never writes the
// bridge state file or takes its lock, and never prints ledger keys or values.
// Hosts on the 0.4.1 line refuse every hire at 1000 keys, so run it beside them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LIMIT = 1000;
export const WAKE_EXIT = 3;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const LABEL = /^[A-Za-z0-9._-]{1,80}$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const inside = (home, file) => {
  const relative = path.relative(home, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function threshold(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

export function parseArgs(argv, { home = os.homedir(), hostname = os.hostname() } = {}) {
  const options = { stateFile: path.join(home, ".local/state/t3-hermes-bridge/bridge-state.json"),
    label: LABEL.test(hostname) ? hostname : "unknown" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index += 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--state-file") options.stateFile = path.resolve(value);
    else if (flag === "--label" && LABEL.test(value)) options.label = value;
    else throw new Error("Usage: ledger-count-alert.mjs [--state-file FILE] [--label HOST]");
  }
  return options;
}

/** Key count of the ledger, or null when the file is missing. Errors carry a fixed reason, never file content. */
export function countOriginations(stateFile, home = os.homedir()) {
  if (!inside(home, stateFile)) throw new Error("state file is outside the home directory");
  let real;
  try { real = fs.realpathSync(stateFile); } catch (error) { if (error.code === "ENOENT") return null; throw new Error("state file is unreadable"); }
  if (!inside(fs.realpathSync(home), real)) throw new Error("state file is outside the home directory");
  let text;
  try {
    const fd = fs.openSync(real, fs.constants.O_RDONLY);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("state file is unreadable");
      if (stat.size > MAX_STATE_BYTES) throw new Error("state file is corrupt: too large");
      text = fs.readFileSync(fd, "utf8");
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error.code ? new Error("state file is unreadable") : error;
  }
  let state;
  // JSON.parse messages quote file content, so the reason stays fixed.
  try { state = JSON.parse(text); } catch { throw new Error("state file is corrupt: invalid JSON"); }
  if (!isRecord(state)) throw new Error("state file is corrupt: not an object");
  // A version-1 state has no ledger yet; the bridge migrates it to an empty one.
  if (state.originations === undefined) return 0;
  if (!isRecord(state.originations)) throw new Error("state file is corrupt: originations is not an object");
  return Object.keys(state.originations).length;
}

// Owner alert without AI: one small file per wake. Never creates the directory.
function writeAlert(dir, t, alert) {
  fs.writeFileSync(path.join(dir, `${Math.floor(t / 1000)}-ledger.json`), `${JSON.stringify(alert)}\n`, { mode: 0o600, flag: "wx" });
}

/** One read-only pass. Returns 0 below the warn threshold or when the file is missing, WAKE_EXIT at or above it, 1 on error. */
export function runCheck({ argv = [], env = process.env, home = os.homedir(), hostname = os.hostname(), now = Date.now,
  out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  let options, warnAt, criticalAt, count;
  try {
    options = parseArgs(argv, { home, hostname });
    criticalAt = threshold(env, "LEDGER_ALERT_CRITICAL", 950);
    // Misordered overrides take the stricter reading: WARN drops to CRITICAL.
    warnAt = Math.min(threshold(env, "LEDGER_ALERT_WARN", 800), criticalAt);
    count = countOriginations(options.stateFile, home);
  } catch (error) { err(`ledger-count-alert: ${error.message}`); return 1; }
  if (count == null) { out("LEDGER missing"); return 0; }
  out(`LEDGER ${count}/${LIMIT} ${options.label}`);
  if (count < warnAt) return 0;
  out(`WAKE ledger count=${count} limit=${LIMIT} host=${options.label}${count >= criticalAt ? " CRITICAL" : ""}`);
  if (env.LEDGER_ALERT_DIR) {
    const t = now();
    try { writeAlert(env.LEDGER_ALERT_DIR, t, { count, limit: LIMIT, host: options.label, at: new Date(t).toISOString() }); }
    catch (error) { err(`ledger-count-alert: alert not written (${typeof error.code === "string" ? error.code : "error"})`); }
  }
  return WAKE_EXIT;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runCheck({ argv: process.argv.slice(2) });
}
