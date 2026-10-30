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
const shimCandidates = SHIM.match(/for CANDIDATE in ([^;]+);/)[1].split(/\s+/);
const fixedNode = [...shimCandidates.filter((file) => file.startsWith("/")), "/usr/bin/node", "/bin/node"].find((file) => fs.existsSync(file));
// A host with one of these cannot prove the cases below; CI must never skip them.
function needsNoFixedNode(t) {
  if (!fixedNode) return true;
  if (process.env.CI) assert.fail(`${fixedNode} exists on this CI host, so the shim fallback tests cannot run`);
  t.skip(`${fixedNode} exists`);
  return false;
}

function shimDir(recordedNode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles shim "));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.copyFileSync(new URL("../bin/t3-agent-bridge", import.meta.url), path.join(dir, "bin", "t3-agent-bridge"));
  fs.chmodSync(path.join(dir, "bin", "t3-agent-bridge"), 0o755);
  fs.writeFileSync(path.join(dir, "bin", "node-path"), `${recordedNode}\n`);
  return dir;
}

test("shim candidates include the user-local Node after the system paths", () => {
  assert.deepEqual(shimCandidates, ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\"${HOME:-}/.local/node/bin/node\""]);
});

test("stale recorded path falls back to $HOME/.local/node/bin/node", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir("/nonexistent/node");
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "cli.mjs"), 'console.log(JSON.stringify(process.argv.slice(2)))');
    fs.mkdirSync(path.join(dir, "home", ".local", "node", "bin"), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(dir, "home", ".local", "node", "bin", "node"));
    const result = spawnSync(path.join(dir, "bin", "t3-agent-bridge"), ["--version"], { env: { PATH: "/usr/bin:/bin", HOME: path.join(dir, "home") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["--version"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("missing Node exits 127 with a clear error when the recorded path is stale", (t) => {
  if (!needsNoFixedNode(t)) return;
  const dir = shimDir(path.join(os.tmpdir(), "gone", "node"));
  try {
    const result = spawnSync(path.join(dir, "bin", "t3-agent-bridge"), ["--version"], { env: { PATH: "/usr/bin:/bin", HOME: path.join(dir, "home") }, encoding: "utf8" });
    assert.equal(result.status, 127);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Node\.js 22\+ is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
