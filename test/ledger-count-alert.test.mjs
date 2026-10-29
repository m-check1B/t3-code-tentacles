import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCheck, WAKE_EXIT } from "../scripts/ledger-count-alert.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "ledger-count-alert.mjs");
const SECRET = "zz-secret-origination-value";
const T0 = Date.parse("2026-10-29T09:00:00.000Z");

// Synthetic home with a synthetic state file only; never the real one.
function harness(count, { raw } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-home-"));
  const stateFile = path.join(home, ".local/state/t3-hermes-bridge/bridge-state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  if (raw != null) fs.writeFileSync(stateFile, raw, { mode: 0o600 });
  else if (count != null) {
    const originations = Object.fromEntries(Array.from({ length: count }, (_, i) => [`key-${i}-${SECRET}`, { title: SECRET, threadId: `t-${i}` }]));
    fs.writeFileSync(stateFile, JSON.stringify({ version: 2, originations }), { mode: 0o600 });
  }
  const lines = [];
  const run = ({ argv = [], env = {} } = {}) => {
    const code = runCheck({ argv, env, home, hostname: "host-a", now: () => T0, out: (line) => lines.push(line), err: (line) => lines.push(line) });
    return { code, lines: lines.splice(0) };
  };
  return { home, stateFile, run };
}

const noSecret = (lines) => assert.ok(lines.every((line) => !line.includes(SECRET) && !line.includes("key-")), lines.join("\n"));

test("below the warn threshold prints the count and exits 0", () => {
  const { run } = harness(799);
  const result = run();
  assert.deepEqual(result, { code: 0, lines: ["LEDGER 799/1000 host-a"] });
});

test("at the warn threshold wakes with exit 3", () => {
  const { run } = harness(800);
  const result = run({ argv: ["--label", "mini"] });
  assert.equal(result.code, WAKE_EXIT);
  assert.deepEqual(result.lines, ["LEDGER 800/1000 mini", "WAKE ledger count=800 limit=1000 host=mini"]);
});

test("at and above the critical threshold the wake line is CRITICAL", () => {
  for (const count of [950, 1000]) {
    const result = harness(count).run();
    assert.equal(result.code, WAKE_EXIT);
    assert.equal(result.lines[1], `WAKE ledger count=${count} limit=1000 host=host-a CRITICAL`);
    noSecret(result.lines);
  }
  assert.equal(harness(949).run().lines[1], "WAKE ledger count=949 limit=1000 host=host-a");
});

test("env overrides the thresholds and rejects junk", () => {
  const { run } = harness(10);
  assert.equal(run({ env: { LEDGER_ALERT_WARN: "5", LEDGER_ALERT_CRITICAL: "10" } }).lines[1], "WAKE ledger count=10 limit=1000 host=host-a CRITICAL");
  assert.equal(run({ env: { LEDGER_ALERT_WARN: "five" } }).code, 1);
});

test("a missing state file exits 0", () => {
  assert.deepEqual(harness().run(), { code: 0, lines: ["LEDGER missing"] });
});

test("a corrupt state file exits 1 with a one-line reason and no content", () => {
  for (const raw of [`{"originations": {"${SECRET}": `, JSON.stringify({ originations: [SECRET] }), "[]"]) {
    const result = harness(null, { raw }).run();
    assert.equal(result.code, 1);
    assert.equal(result.lines.length, 1);
    assert.match(result.lines[0], /^ledger-count-alert: state file is corrupt/);
    noSecret(result.lines);
  }
});

test("a path outside home is refused, including through a symlink", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-outside-"));
  const file = path.join(outside, "bridge-state.json");
  fs.writeFileSync(file, JSON.stringify({ originations: {} }));
  const { home, run } = harness(1);
  for (const target of [file, path.join(home, "..", path.basename(outside), "bridge-state.json")]) {
    assert.deepEqual(run({ argv: ["--state-file", target] }), { code: 1, lines: ["ledger-count-alert: state file is outside the home directory"] });
  }
  const link = path.join(home, "link.json");
  fs.symlinkSync(file, link);
  assert.equal(run({ argv: ["--state-file", link] }).code, 1);
});

test("the alert file is 0600 with only count, limit, host and time; none without the env var", () => {
  const { home, stateFile, run } = harness(900);
  const before = fs.readFileSync(stateFile);
  const alertDir = path.join(home, "alerts");
  fs.mkdirSync(alertDir);
  assert.equal(run().code, WAKE_EXIT);
  assert.deepEqual(fs.readdirSync(alertDir), []);
  assert.equal(run({ env: { LEDGER_ALERT_DIR: alertDir } }).code, WAKE_EXIT);
  const [name] = fs.readdirSync(alertDir);
  assert.equal(name, `${T0 / 1000}-ledger.json`);
  assert.equal(fs.statSync(path.join(alertDir, name)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(alertDir, name), "utf8")), { count: 900, limit: 1000, host: "host-a", at: new Date(T0).toISOString() });
  // A missing alert directory is never created; the wake still stands.
  const missing = path.join(home, "no-such-dir");
  const result = run({ env: { LEDGER_ALERT_DIR: missing } });
  assert.equal(result.code, WAKE_EXIT);
  assert.equal(fs.existsSync(missing), false);
  // Read-only: the state file is byte-identical and no lock appeared.
  assert.deepEqual(fs.readFileSync(stateFile), before);
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ["bridge-state.json"]);
});

test("the CLI uses HOME for its default path and prints no key or value", () => {
  const { home } = harness(820);
  const result = spawnSync(process.execPath, [SCRIPT, "--label", "dev"], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, WAKE_EXIT);
  assert.equal(result.stdout, "LEDGER 820/1000 dev\nWAKE ledger count=820 limit=1000 host=dev\n");
  assert.equal(result.stderr, "");
});

test("a version-1 state without an originations key counts as 0", () => {
  const raw = JSON.stringify({ version: 1, startedAt: null, processedMessageIds: [] });
  assert.deepEqual(harness(null, { raw }).run(), { code: 0, lines: ["LEDGER 0/1000 host-a"] });
});

test("a non-version-1 state without an originations key exits 1, as the bridge refuses it", () => {
  for (const raw of ["{}", JSON.stringify({ version: 2, mode: "watcher" })]) {
    assert.deepEqual(harness(null, { raw }).run(), { code: 1, lines: ["ledger-count-alert: state file is corrupt: originations is missing"] });
  }
  assert.deepEqual(harness(3).run(), { code: 0, lines: ["LEDGER 3/1000 host-a"] });
});

test("an in-home name starting with .. is not mistaken for a parent path", () => {
  const { home, run } = harness();
  const file = path.join(home, "..cache", "bridge-state.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ originations: { a: {}, b: {} } }));
  assert.deepEqual(run({ argv: ["--state-file", file] }), { code: 0, lines: ["LEDGER 2/1000 host-a"] });
});

test("misordered thresholds take the stricter reading", () => {
  const env = { LEDGER_ALERT_WARN: "900", LEDGER_ALERT_CRITICAL: "800" };
  const result = harness(850).run({ env });
  assert.equal(result.code, WAKE_EXIT);
  assert.equal(result.lines[1], "WAKE ledger count=850 limit=1000 host=host-a CRITICAL");
  assert.equal(harness(799).run({ env }).code, 0);
});
