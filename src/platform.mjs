import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

// KRA-6491: platform-aware helpers. Every function takes the platform and
// environment as inputs so the Windows branches are unit-tested on POSIX CI.

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\/;
// Only these launchable extensions are honoured from PATHEXT. Scripting hosts
// (.js, .vbs, .wsf, .ps1, .msc) are never selected as a lab or helper binary.
const WINDOWS_LAUNCHABLE = new Set([".exe", ".cmd", ".bat"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function pathFor(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Reads PATH case-insensitively on Windows, where copied env objects keep `Path`. */
export function readEnvPath(env = process.env, platform = process.platform) {
  if (platform !== "win32") return env.PATH ?? "";
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key === undefined ? "" : env[key] ?? "";
}

/** Returns a copy of env with exactly one PATH key (Windows rejects duplicate case variants). */
export function withEnvPath(env, value, platform = process.platform) {
  const copy = { ...env };
  if (platform === "win32") {
    for (const name of Object.keys(copy)) if (name.toUpperCase() === "PATH") delete copy[name];
  }
  copy.PATH = value;
  return copy;
}

export function isWindowsAbsolute(value) {
  return typeof value === "string" && WINDOWS_ABSOLUTE.test(value) && !/[\u0000-\u001f]/.test(value);
}

function windowsDirectory(env, name, fallback) {
  const value = env[name];
  if (isWindowsAbsolute(value)) return path.win32.normalize(value);
  if (fallback !== undefined) return fallback;
  throw new Error(`%${name}% must be an absolute drive path`);
}

/** Per-user Windows directories, validated as drive-rooted absolute paths. */
export function windowsUserDirectories(env = process.env) {
  const home = windowsDirectory(env, "USERPROFILE");
  return {
    home,
    localAppData: windowsDirectory(env, "LOCALAPPDATA", path.win32.join(home, "AppData", "Local")),
    appData: windowsDirectory(env, "APPDATA", path.win32.join(home, "AppData", "Roaming")),
    systemRoot: windowsDirectory(env, "SystemRoot", "C:\\Windows"),
  };
}

/**
 * Bridge state directory. macOS/Linux keep ~/.local/state; Windows uses the
 * per-user, non-roaming %LOCALAPPDATA%, whose default ACL is owner + SYSTEM +
 * Administrators. TODO-WINVM: `icacls "%LOCALAPPDATA%\t3-hermes-bridge"` lists
 * no Users/Everyone/Authenticated Users grant after the first `tentacles pair`.
 */
export function defaultStateDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "win32") {
    return path.win32.join(windowsUserDirectories({ USERPROFILE: home, ...env }).localAppData, "t3-hermes-bridge");
  }
  return path.posix.join(home, ".local", "state", "t3-hermes-bridge");
}

/** Launchable Windows extensions in PATHEXT order (defaults when PATHEXT is unset). */
export function windowsExecutableExtensions(env = process.env) {
  const raw = typeof env.PATHEXT === "string" && env.PATHEXT.trim() ? env.PATHEXT : DEFAULT_PATHEXT;
  const ordered = [];
  for (const entry of raw.split(";")) {
    const extension = entry.trim().toLowerCase();
    if (WINDOWS_LAUNCHABLE.has(extension) && !ordered.includes(extension)) ordered.push(extension);
  }
  return ordered.length ? ordered : [".exe", ".cmd", ".bat"];
}

/** File names to try for one command; an explicit launchable extension is kept as-is. */
export function executableFileNames(name, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return [name];
  const extension = path.win32.extname(name).toLowerCase();
  if (WINDOWS_LAUNCHABLE.has(extension)) return [name];
  return windowsExecutableExtensions(env).map((suffix) => `${name}${suffix}`);
}

/** Candidate absolute paths for `name` across a PATH string, in lookup order. */
export function executableCandidates(name, searchPath, { platform = process.platform, env = process.env } = {}) {
  const paths = pathFor(platform);
  const candidates = [];
  for (const directory of String(searchPath ?? "").split(paths.delimiter)) {
    const trimmed = platform === "win32" ? directory.trim().replace(/^"(.*)"$/, "$1") : directory;
    if (!trimmed) continue;
    if (platform === "win32" ? !isWindowsAbsolute(trimmed) : !paths.isAbsolute(trimmed)) continue;
    for (const file of executableFileNames(name, { platform, env })) candidates.push(paths.join(trimmed, file));
  }
  return candidates;
}

/**
 * POSIX owner-only check. Windows has no meaningful mode bits (stat reports
 * 0o666/0o444), so custody there rests on the per-user profile ACL instead.
 */
export function privateModeOk(mode, { mask = 0o077, platform = process.platform } = {}) {
  if (platform === "win32") return true;
  return (mode & mask) === 0;
}

/**
 * Stop must take the whole process tree on Windows: TerminateProcess (what
 * child.kill() does there) leaves grandchildren such as a lab CLI running.
 * Returns null on POSIX, where callers keep their signal semantics.
 */
export function processTreeKillPlan(pid, { platform = process.platform, env = process.env } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("process tree kill requires a positive integer pid");
  if (platform !== "win32") return null;
  const { systemRoot } = windowsUserDirectories({ USERPROFILE: "C:\\", ...env });
  return {
    file: path.win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
    options: { shell: false, stdio: "ignore", windowsHide: true },
  };
}

/**
 * KRA-6573: the one Stop path for every launcher. POSIX signals the child's
 * process group. Windows runs the absolute System32 taskkill plan (/T /F) for
 * both the grace and the force signal, so lab CLIs and their grandchildren
 * stop too; a bare "taskkill" from PATH is never spawned.
 */
export function signalProcessTree(child, signal, {
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  killProcess = process.kill.bind(process),
} = {}) {
  const killDirect = () => { try { child.kill(signal); } catch {} };
  if (!Number.isInteger(child.pid) || child.pid < 1) return killDirect();
  if (platform !== "win32") {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
    return killDirect();
  }
  const plan = processTreeKillPlan(child.pid, { platform, env });
  try {
    const killer = spawnImpl(plan.file, plan.args, plan.options);
    // A missing or failing taskkill must never crash the launcher.
    killer.on?.("error", killDirect);
    killer.unref?.();
  } catch {
    killDirect();
  }
}

/** Replaces the user's home and well-known profile roots in diagnostics. */
export function redactHomePaths(message, home = os.homedir()) {
  let text = String(message ?? "");
  if (home) text = text.split(home).join("~");
  return text
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gi, "~");
}
