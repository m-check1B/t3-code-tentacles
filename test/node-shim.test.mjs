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

function runShim(dir, PATH = "/usr/bin:/bin") {
  return spawnSync(path.join(dir, "bin", "t3-agent-bridge"), ["--version"], { env: { PATH, HOME: path.join(dir, "home") }, encoding: "utf8" });
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
    fakeNode(path.join(dir, "home", ".local", "node", "bin", "node"), "home", 'echo "v16.20.2"; exit 9');
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
    fakeNode(path.join(dir, "home", ".local", "node", "bin", "node"), "home", 'echo "v16.20.2"; exit 9');
    fakeNode(path.join(dir, "path", "node"), "path", 'echo "v18.20.4"; exit 9');
    const result = runShim(dir, `${path.join(dir, "path")}:/usr/bin:/bin`);
    assert.equal(result.status, 127, result.stdout);
    assert.match(result.stderr, /Node\.js 22\+ is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
