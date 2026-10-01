import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PRIVATE_ROOT = ".jack-local-scratch";
const HEX_ID = /^[a-f0-9]{32}$/;
const SOURCE_COMPONENTS = new Set(["github", ".git", "agent-jack-3", "agentjack"]);

function refuse() { throw new Error("Local Talk workspace custody or scope refused"); }

function requireHome(home) {
  const info = fs.lstatSync(home);
  if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid !== "function"
      || info.uid !== process.getuid() || (info.mode & 0o7022) !== 0) refuse();
}

function privateDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const before = fs.lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) refuse();
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.uid !== process.getuid()
        || opened.ino !== before.ino || opened.dev !== before.dev) refuse();
    fs.fchmodSync(fd, 0o700);
    const after = fs.lstatSync(directory);
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev) refuse();
  } finally { fs.closeSync(fd); }
}

/** Machine-side only. Remote callers cannot select a root or supply a home. */
export function ensureLocalTalkWorkspace(workspace, { home = os.homedir() } = {}) {
  // Ordinary hire/chair and legacy workspaces keep their existing behaviour.
  if (typeof workspace !== "string" || !workspace.split(/[\\/]/).includes(PRIVATE_ROOT)) return false;
  const canonicalHome = fs.realpathSync(home);
  const root = path.join(canonicalHome, PRIVATE_ROOT);
  requireHome(canonicalHome);
  if (!path.isAbsolute(workspace) || path.normalize(workspace) !== workspace
      || workspace.length > 1024 || /[\u0000-\u001f\u007f]/.test(workspace)
      || !workspace.startsWith(`${root}${path.sep}`)
      || root.split(path.sep).some(part => SOURCE_COMPONENTS.has(part.toLowerCase()))) refuse();
  const parts = path.relative(root, workspace).split(path.sep);
  if (parts.length !== 3 || parts[0] !== "jack-talk"
      || !HEX_ID.test(parts[1]) || !HEX_ID.test(parts[2])) refuse();
  // Build each directory from the machine's own root and validated IDs.
  let directory = root;
  privateDirectory(directory);
  for (const part of parts) {
    directory = path.join(directory, part);
    privateDirectory(directory);
  }
  return true;
}
