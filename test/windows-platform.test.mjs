import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultStateDir,
  executableCandidates,
  executableFileNames,
  privateModeOk,
  processTreeKillPlan,
  readEnvPath,
  redactHomePaths,
  windowsExecutableExtensions,
  windowsUserDirectories,
  withEnvPath,
} from "../src/platform.mjs";
import { resolveExecutable } from "../src/config.mjs";
import { isDirectCliInvocation } from "../src/cli.mjs";
import { ensureLocalTalkWorkspace } from "../src/local-talk-workspace.mjs";

const WIN_ENV = {
  USERPROFILE: "C:\\Users\\Ada Lovelace",
  LOCALAPPDATA: "C:\\Users\\Ada Lovelace\\AppData\\Local",
  APPDATA: "C:\\Users\\Ada Lovelace\\AppData\\Roaming",
  SystemRoot: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1",
  Path: "C:\\Windows\\system32;C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm",
};

test("Windows state directory lives under per-user LOCALAPPDATA; POSIX is unchanged", () => {
  assert.equal(
    defaultStateDir({ platform: "win32", env: WIN_ENV, home: WIN_ENV.USERPROFILE }),
    "C:\\Users\\Ada Lovelace\\AppData\\Local\\t3-hermes-bridge",
  );
  assert.equal(
    defaultStateDir({ platform: "win32", env: { USERPROFILE: "D:\\home\\ada" }, home: "D:\\home\\ada" }),
    "D:\\home\\ada\\AppData\\Local\\t3-hermes-bridge",
  );
  assert.equal(defaultStateDir({ platform: "darwin", env: {}, home: "/Users/ada" }), "/Users/ada/.local/state/t3-hermes-bridge");
  assert.equal(defaultStateDir({ platform: "linux", env: {}, home: "/home/ada" }), "/home/ada/.local/state/t3-hermes-bridge");
});

test("Windows user directories refuse relative, UNC and control-character values", () => {
  assert.throws(() => windowsUserDirectories({ USERPROFILE: "Users\\ada" }), /USERPROFILE/);
  assert.throws(() => windowsUserDirectories({ USERPROFILE: "\\\\server\\share\\ada" }), /USERPROFILE/);
  assert.throws(() => windowsUserDirectories({ USERPROFILE: "C:\\Users\\ada\n" }), /USERPROFILE/);
  // A hostile LOCALAPPDATA falls back to the profile instead of a share.
  assert.equal(
    windowsUserDirectories({ USERPROFILE: "C:\\Users\\ada", LOCALAPPDATA: "\\\\evil\\share" }).localAppData,
    "C:\\Users\\ada\\AppData\\Local",
  );
});

test("PATHEXT selects only .exe/.cmd/.bat in PATHEXT order", () => {
  assert.deepEqual(windowsExecutableExtensions(WIN_ENV), [".exe", ".bat", ".cmd"]);
  assert.deepEqual(windowsExecutableExtensions({}), [".exe", ".bat", ".cmd"]);
  assert.deepEqual(windowsExecutableExtensions({ PATHEXT: ".JS;.VBS" }), [".exe", ".cmd", ".bat"]);
  assert.deepEqual(executableFileNames("grok", { platform: "win32", env: WIN_ENV }), ["grok.exe", "grok.bat", "grok.cmd"]);
  assert.deepEqual(executableFileNames("grok.cmd", { platform: "win32", env: WIN_ENV }), ["grok.cmd"]);
  assert.deepEqual(executableFileNames("grok", { platform: "darwin", env: WIN_ENV }), ["grok"]);
});

test("Windows candidates use ; delimiters, strip quotes and skip relative PATH entries", () => {
  const candidates = executableCandidates(
    "codex",
    'C:\\Windows\\system32;;"C:\\Program Files\\nodejs";relative\\bin;\\\\server\\share',
    { platform: "win32", env: { PATHEXT: ".EXE;.CMD" } },
  );
  assert.deepEqual(candidates, [
    "C:\\Windows\\system32\\codex.exe",
    "C:\\Windows\\system32\\codex.cmd",
    "C:\\Program Files\\nodejs\\codex.exe",
    "C:\\Program Files\\nodejs\\codex.cmd",
  ]);
  assert.deepEqual(executableCandidates("codex", "/usr/bin:relative:/opt/bin", { platform: "linux", env: {} }), [
    "/usr/bin/codex",
    "/opt/bin/codex",
  ]);
});

test("resolveExecutable keeps exact POSIX names (a .cmd shim is not `grok` there)", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-win-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "grok.cmd"), "@echo off\r\n", { mode: 0o700 });
  assert.throws(() => resolveExecutable("grok", directory, { platform: "linux", env: {} }), /not found/);
  assert.equal(resolveExecutable("grok.cmd", directory, { platform: "linux", env: {} }), fs.realpathSync(path.join(directory, "grok.cmd")));
});

test("PATH helpers read case-insensitively and leave exactly one PATH key on win32", () => {
  assert.equal(readEnvPath(WIN_ENV, "win32"), WIN_ENV.Path);
  assert.equal(readEnvPath(WIN_ENV, "linux"), "");
  const env = withEnvPath({ ...WIN_ENV, path: "dup" }, "C:\\bin", "win32");
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase() === "PATH"), ["PATH"]);
  assert.equal(env.PATH, "C:\\bin");
  assert.equal(withEnvPath({ Path: "keep" }, "/bin", "linux").Path, "keep");
});

test("private mode policy keeps POSIX 0600/0700 and defers to profile ACLs on win32", () => {
  assert.equal(privateModeOk(0o100600, { platform: "linux" }), true);
  assert.equal(privateModeOk(0o100644, { platform: "darwin" }), false);
  // Windows stat reports 0o666 for every writable file.
  assert.equal(privateModeOk(0o100666, { platform: "win32" }), true);
});

test("Stop uses taskkill /T /F from System32 on win32 and signals elsewhere", () => {
  assert.deepEqual(processTreeKillPlan(4242, { platform: "win32", env: { SystemRoot: "D:\\WINNT" } }), {
    file: "D:\\WINNT\\System32\\taskkill.exe",
    args: ["/PID", "4242", "/T", "/F"],
    options: { shell: false, stdio: "ignore", windowsHide: true },
  });
  // A relative SystemRoot never redirects to a planted taskkill.exe.
  assert.equal(processTreeKillPlan(1, { platform: "win32", env: { SystemRoot: "evil" } }).file, "C:\\Windows\\System32\\taskkill.exe");
  assert.equal(processTreeKillPlan(4242, { platform: "linux" }), null);
  assert.throws(() => processTreeKillPlan(0, { platform: "win32" }), /positive integer/);
  assert.throws(() => processTreeKillPlan("4242", { platform: "win32" }), /positive integer/);
});

test("diagnostics redact Windows and POSIX profile paths", () => {
  assert.equal(
    redactHomePaths("missing C:\\Users\\ada\\AppData\\x and /Users/bob/y", "/nowhere"),
    "missing ~\\AppData\\x and ~/y",
  );
});

test("CLI direct-invocation guard ignores drive-letter case only on win32", () => {
  const realpath = (value) => value;
  assert.equal(isDirectCliInvocation("file:///C:/t/src/cli.mjs", "/C:/t/src/cli.mjs", { platform: "win32", realpath }), true);
  assert.equal(isDirectCliInvocation("file:///c:/t/src/cli.mjs", "/C:/t/src/cli.mjs", { platform: "win32", realpath }), true);
  assert.equal(isDirectCliInvocation("file:///c:/t/src/cli.mjs", "/C:/t/src/cli.mjs", { platform: "linux", realpath }), false);
  assert.equal(isDirectCliInvocation("file:///t/src/cli.mjs", undefined, { platform: "linux", realpath }), false);
});

test("win32 Local Talk custody skips uid/mode bits but still refuses symlinked scratch", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-win-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // A group-writable home is refused on POSIX and accepted on win32 (no mode bits there).
  fs.chmodSync(home, 0o775);
  const canonical = fs.realpathSync(home);
  const workspace = path.join(canonical, ".jack-local-scratch", "jack-talk", "a".repeat(32), "b".repeat(32));
  assert.throws(() => ensureLocalTalkWorkspace(workspace, { home, platform: "linux" }), /refused/);
  assert.equal(ensureLocalTalkWorkspace(workspace, { home, platform: "win32" }), true);
  assert.equal(fs.statSync(workspace).isDirectory(), true);

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-win-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.rmSync(path.join(canonical, ".jack-local-scratch"), { recursive: true });
  fs.symlinkSync(other, path.join(canonical, ".jack-local-scratch"));
  assert.throws(() => ensureLocalTalkWorkspace(workspace, { home, platform: "win32" }), /refused/);
});
