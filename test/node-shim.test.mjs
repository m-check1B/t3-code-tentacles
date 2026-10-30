import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("recorded absolute Node works for both aliases with a non-interactive PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles shim "));
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.copyFileSync(new URL("../bin/t3-agent-bridge", import.meta.url), path.join(dir, "bin", "t3-agent-bridge"));
    fs.chmodSync(path.join(dir, "bin", "t3-agent-bridge"), 0o755);
    fs.symlinkSync("t3-agent-bridge", path.join(dir, "bin", "tentacles"));
    fs.writeFileSync(path.join(dir, "bin", "node-path"), `${process.execPath}\n`);
    fs.writeFileSync(path.join(dir, "src", "cli.mjs"), 'console.log(JSON.stringify(process.argv.slice(2)))');
    for (const alias of ["tentacles", "t3-agent-bridge"]) {
      const result = spawnSync(path.join(dir, "bin", alias), ["--version", "argument with spaces"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["--version", "argument with spaces"]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Derived from the shim so this list cannot drift: its fixed candidates plus PATH /usr/bin:/bin.
const SHIM = fs.readFileSync(new URL("../bin/t3-agent-bridge", import.meta.url), "utf8");
const candidateLoop = SHIM.match(/for CANDIDATE in ([^;]+);/);
const shimCandidates = candidateLoop ? candidateLoop[1].trim().split(/\s+/) : [];
const fixedNode = [...shimCandidates.filter((file) => file.startsWith("/")), "/usr/bin/node", "/bin/node"].find((file) => fs.existsSync(file));
// A host with one of these cannot prove the cases below; CI must never skip them.
function needsNoFixedNode(t) {
  if (!fixedNode) return true;
  if (process.env.CI) assert.fail(`${fixedNode} exists on this CI host, so the shim fallback tests cannot run`);
  t.skip(`${fixedNode} exists`);
  return false;
}

// Every case starts from a stale recorded path inside its own temp dir.
function shimDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles shim "));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.copyFileSync(new URL("../bin/t3-agent-bridge", import.meta.url), path.join(dir, "bin", "t3-agent-bridge"));
  fs.chmodSync(path.join(dir, "bin", "t3-agent-bridge"), 0o755);
  fs.writeFileSync(path.join(dir, "bin", "node-path"), `${path.join(dir, "gone", "node")}\n`);
  fs.writeFileSync(path.join(dir, "src", "cli.mjs"), 'console.log(JSON.stringify({ argv: process.argv.slice(2), via: process.env.TENTACLES_TEST_VIA }))');
  return dir;
}

// A Node wrapper that marks which candidate the shim chose; `script` replaces it (e.g. a too-old Node).
function fakeNode(file, via, script = `TENTACLES_TEST_VIA=${via} exec ${JSON.stringify(process.execPath)} "$@"`) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
}

// A real Node that reports v16.20.2, so it runs the shim's own probe and fails only on its version.
function oldNode(file, via) {
  const preload = path.join(path.dirname(file), "old.cjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(preload, 'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "16.20.2" } })');
  fakeNode(file, via, `TENTACLES_TEST_VIA=${via} exec ${JSON.stringify(process.execPath)} --require ${JSON.stringify(preload)} "$@"`);
}

// `env` overrides the default env; an undefined value removes that variable.
function runShim(dir, PATH = "/usr/bin:/bin", { env = {}, shell, input } = {}) {
  const merged = Object.fromEntries(Object.entries({ PATH, HOME: path.join(dir, "home"), ...env }).filter(([, value]) => value !== undefined));
  const shim = path.join(dir, "bin", "t3-agent-bridge");
  return spawnSync(shell ?? shim, shell ? [shim, "--version"] : ["--version"], { env: merged, encoding: "utf8", input });
}

test("shim candidates include the user-local Node after the system paths", () => {
  assert.ok(candidateLoop, "shim candidate loop `for CANDIDATE in ...;` not found");
  assert.deepEqual(shimCandidates, ["/opt/homebrew/bin/node", "/usr/local/bin/node", "${HOME:+\"$HOME/.local/node/bin/node\"}"]);
});

test("stale recorded path falls back to $HOME/.local/node/bin/node before PATH", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir();
  try {
    fakeNode(path.join(dir, "home", ".local", "node", "bin", "node"), "home");
    fakeNode(path.join(dir, "path", "node"), "path");
    const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv: ["--version"], via: "home" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a Node older than 22 at $HOME/.local/node/bin/node is skipped for PATH Node", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir();
  try {
    oldNode(path.join(dir, "home", ".local", "node", "bin", "node"), "home");
    fakeNode(path.join(dir, "path", "node"), "path");
    const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv: ["--version"], via: "path" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("missing Node exits 127 with a clear error when the recorded path is stale", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir();
  try {
    const result = runShim(dir);
    assert.equal(result.status, 127);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Node\.js 22\+ is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only Nodes older than 22 exits 127", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir();
  try {
    oldNode(path.join(dir, "home", ".local", "node", "bin", "node"), "home");
    oldNode(path.join(dir, "path", "node"), "path");
    const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`);
    assert.equal(result.status, 127, result.stdout);
    assert.match(result.stderr, /Node\.js 22\+ is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a recorded node-path older than 22 falls through to PATH Node", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir();
  try {
    oldNode(path.join(dir, "old", "node"), "recorded");
    fs.writeFileSync(path.join(dir, "bin", "node-path"), `${path.join(dir, "old", "node")}\n`);
    fakeNode(path.join(dir, "path", "node"), "path");
    const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv: ["--version"], via: "path" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("HOME absent from the environment skips the user-local candidate", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir();
  try {
    for (const shell of [undefined, "/bin/sh"]) {
      const missing = runShim(dir, "/usr/bin:/bin", { env: { HOME: undefined }, shell });
      assert.equal(missing.status, 127, missing.stderr);
      assert.match(missing.stderr, /Node\.js 22\+ is missing/);
    }
    fakeNode(path.join(dir, "path", "node"), "path");
    const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`, { env: { HOME: undefined } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv: ["--version"], via: "path" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a non-Node that exits 0 or echoes stdin is rejected by the probe token", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir();
  try {
    fakeNode(path.join(dir, "bogus", "node"), "bogus", "exit 0");
    fs.writeFileSync(path.join(dir, "bin", "node-path"), `${path.join(dir, "bogus", "node")}\n`);
    // Echoes stdin: it only passes if the probe inherits stdin instead of reading /dev/null.
    fakeNode(path.join(dir, "home", ".local", "node", "bin", "node"), "home", "exec cat");
    fakeNode(path.join(dir, "path", "node"), "path");
    const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`, { input: "tentacles-node-ok" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv: ["--version"], via: "path" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// bash (macOS /bin/sh) prints a job-status line for a signal-killed command unless it runs in a subshell.
test("a signal-killed candidate leaks nothing to stderr under bash", (t) => {
  if (!needsNoFixedNode(t)) return;
  if (!fs.existsSync("/bin/bash")) {
    if (process.env.CI) assert.fail("/bin/bash is missing on this CI host");
    return t.skip("/bin/bash is missing");
  }
  const dir = shimDir();
  try {
    fakeNode(path.join(dir, "home", ".local", "node", "bin", "node"), "home", "kill -KILL $$");
    fakeNode(path.join(dir, "path", "node"), "path");
    for (const shell of ["/bin/bash", "/bin/sh"]) {
      const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`, { shell });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { argv: ["--version"], via: "path" });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
