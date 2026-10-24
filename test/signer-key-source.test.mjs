// Real processes, synthetic bytes and a task-owned nasvault stub only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { SIGNING_ITEM, FORGEJO_READ_ITEM, NEXT_SIGNING_ITEM } from "../scripts/release/sign-manifest.mjs";

const HELPER = new URL("../scripts/release/signer-key-source.mjs", import.meta.url).href;
const VALUE = "SYNTHETIC-ONLY";

function fixture(t, mode = "ok") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-nasvault-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, "synthetic-vault.mjs");
  const calls = path.join(dir, "calls.jsonl");
  const pidFile = path.join(dir, "pid");
  fs.writeFileSync(stub, `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "hang") {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
} else if (args[0] === "list") {
  const line = "1234abcd | " + args[1] + "\\n";
  process.stdout.write(mode === "missing" ? "1234abcd | other-item\\n" : mode === "duplicate" ? line + line : line);
} else if (JSON.stringify(args) === JSON.stringify(["to-file", args[1], "/dev/fd/3", "--password"])) {
  fs.writeSync(3, ${JSON.stringify(VALUE)});
  process.stdout.write("nasvault: wrote value to /dev/fd/3 (0600)\\n" + (mode === "extra stdout" ? "extra\\n" : ""));
  if (mode === "extra stderr") process.stderr.write("unexpected synthetic diagnostic");
  if (mode === "failure") process.exitCode = 1;
} else process.exitCode = 2;
`, { mode: 0o700 });
  const runner = (item) => `import { runKeySource } from ${JSON.stringify(HELPER)};
try { await runKeySource(${JSON.stringify(item)}, { nasvault: ${JSON.stringify(stub)} }); }
catch { process.exitCode = 1; }`;
  return { dir, stub, calls, pidFile, runner };
}

function launch(t, code) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } });
  const outputs = [[], [], []];
  for (const [index, stream] of [child.stdout, child.stderr, child.stdio[3]].entries()) stream.on("data", (bytes) => outputs[index].push(bytes));
  const closed = once(child, "close");
  return { child, outputs, closed };
}

for (const item of [SIGNING_ITEM, FORGEJO_READ_ITEM]) {
  test(`helper resolves exact ${item} and writes to inherited fd only`, async (t) => {
    const f = fixture(t);
    const run = launch(t, f.runner(item));
    const [code] = await run.closed;
    assert.equal(code, 0);
    assert.equal(Buffer.concat(run.outputs[0]).length, 0);
    assert.equal(Buffer.concat(run.outputs[1]).length, 0);
    assert.equal(Buffer.concat(run.outputs[2]).toString(), VALUE);
    assert.deepEqual(fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse), [
      ["list", item], ["to-file", item, "/dev/fd/3", "--password"],
    ]);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ["calls.jsonl", "synthetic-vault.mjs"]);
  });
}

for (const mode of ["missing", "duplicate", "extra stdout", "extra stderr", "failure"]) {
  test(`helper fails closed on nasvault ${mode}`, async (t) => {
    const f = fixture(t, mode);
    const run = launch(t, f.runner(SIGNING_ITEM));
    const [code] = await run.closed;
    assert.equal(code, 1);
    assert.equal(Buffer.concat(run.outputs[0]).length, 0);
    assert.equal(Buffer.concat(run.outputs[1]).length, 0);
    if (["missing", "duplicate"].includes(mode)) {
      assert.equal(Buffer.concat(run.outputs[2]).length, 0);
      assert.equal(fs.readFileSync(f.calls, "utf8").trim().split("\n").length, 1);
    }
  });
}

test("helper refuses the next-key item before invoking nasvault", async (t) => {
  const f = fixture(t);
  const run = launch(t, f.runner(NEXT_SIGNING_ITEM));
  const [code] = await run.closed;
  assert.equal(code, 1);
  assert.equal(fs.existsSync(f.calls), false);
});

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("synthetic process cleanup timeout");
    await delay(20);
  }
}

function gone(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code === "ESRCH"; }
  // An orphaned, killed grandchild may remain a zombie until the OS reaps it.
  // It is already dead; kill(pid, 0) alone would misreport it as a live orphan.
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return state.startsWith("Z");
  } catch { return true; }
}

test("reader kills its nasvault process group when its signer parent is SIGKILLed", async (t) => {
  const f = fixture(t, "hang");
  const readerPidFile = path.join(f.dir, "reader-pid");
  const intermediary = `import fs from "node:fs"; import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(f.runner(SIGNING_ITEM))}], { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
child.stdio[3].resume(); fs.writeFileSync(${JSON.stringify(readerPidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
  const run = launch(t, intermediary);
  await until(() => fs.existsSync(readerPidFile) && fs.existsSync(f.pidFile));
  const readerPid = Number(fs.readFileSync(readerPidFile, "utf8"));
  const vaultPid = Number(fs.readFileSync(f.pidFile, "utf8"));
  t.after(() => { try { process.kill(-readerPid, "SIGKILL"); } catch { /* exited */ } });
  run.child.kill("SIGKILL");
  await run.closed;
  await until(() => gone(readerPid) && gone(vaultPid));
});

for (const outcome of ["timeout", "SIGTERM"]) {
  test(`signer kills a secret child process group on ${outcome}`, async (t) => {
    const f = fixture(t);
    const childPidFile = path.join(f.dir, "child-pid");
    const grandchildPidFile = path.join(f.dir, "grandchild-pid");
    const grandchild = `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const child = `import fs from "node:fs"; import { spawn } from "node:child_process";
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
fs.writeSync(3, "SYNTHETIC"); setInterval(() => {}, 1000);`;
    const signerModule = new URL("../scripts/release/sign-manifest.mjs", import.meta.url).href;
    const parent = `import { runChild } from ${JSON.stringify(signerModule)}; import { spawn } from "node:child_process";
try { await runChild(spawn, process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}], { secret: true, timeoutMs: ${outcome === "timeout" ? 500 : 5000} }); process.exitCode = 2; }
catch (error) { if (error.code !== "subprocess_failed") process.exitCode = 3; }`;
    const run = launch(t, parent);
    await until(() => fs.existsSync(childPidFile) && fs.existsSync(grandchildPidFile));
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8"));
    t.after(() => { try { process.kill(-childPid, "SIGKILL"); } catch { /* exited */ } });
    if (outcome === "SIGTERM") run.child.kill("SIGTERM");
    const [code, signal] = await run.closed;
    if (outcome === "timeout") assert.equal(code, 0);
    else assert.equal(signal, "SIGTERM");
    await until(() => gone(childPid) && gone(grandchildPid));
  });
}
