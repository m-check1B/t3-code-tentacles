import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardTalkWorkspace } from "./talk-instruction-guard.mjs";

const PRIVATE_ROOT = ".jack-local-scratch";
const HEX_ID = /^[a-f0-9]{32}$/;
const SEAT_ID = /^[a-f0-9]{64}$/;
const BOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SOURCE_COMPONENTS = new Set(["github", ".git", "agent-jack-3", "agentjack"]);

export const REMOTE_WORKSPACE_REFUSAL = "Remote turn refused: workspace is outside the Bot workspace root";

function refuse() { throw new Error("Local Talk workspace custody or scope refused"); }

// Windows has no uid or meaningful mode bits; custody there is the per-user
// profile ACL. Symlinks and junctions (lstat reports both) stay refused.
// TODO-WINVM: `icacls "%USERPROFILE%\.jack-local-scratch"` shows only the user,
// SYSTEM and Administrators after the first paired Local Talk turn.
function requireHome(home, platform) {
  const info = fs.lstatSync(home);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse();
  if (platform === "win32") return;
  if (typeof process.getuid !== "function" || info.uid !== process.getuid() || (info.mode & 0o7022) !== 0) refuse();
}

function privateDirectory(directory, platform) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const before = fs.lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) refuse();
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || (platform !== "win32" && opened.uid !== process.getuid())
        || opened.ino !== before.ino || opened.dev !== before.dev) refuse();
    fs.fchmodSync(fd, 0o700);
    const after = fs.lstatSync(directory);
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev) refuse();
  } finally { fs.closeSync(fd); }
}

/** Machine-side only. Remote callers cannot select a root or supply a home. */
export function ensureLocalTalkWorkspace(workspace, { home = os.homedir(), platform = process.platform } = {}) {
  // Ordinary hire/chair and legacy workspaces keep their existing behaviour.
  if (typeof workspace !== "string" || !workspace.split(/[\\/]/).includes(PRIVATE_ROOT)) return false;
  const canonicalHome = fs.realpathSync(home);
  const root = path.join(canonicalHome, PRIVATE_ROOT);
  requireHome(canonicalHome, platform);
  if (!path.isAbsolute(workspace) || path.normalize(workspace) !== workspace
      || workspace.length > 1024 || /[\u0000-\u001f\u007f]/.test(workspace)
      || !workspace.startsWith(`${root}${path.sep}`)
      || root.split(path.sep).some(part => SOURCE_COMPONENTS.has(part.toLowerCase()))) refuse();
  const parts = path.relative(root, workspace).split(path.sep);
  // Jack moves a Bot that has connectors to seats/<owner digest>/agents/<bot id>
  // (paired_mcp_workspace); the start-up sweep already guards that shape.
  const talk = parts.length === 3 && parts[0] === "jack-talk" && HEX_ID.test(parts[1]) && HEX_ID.test(parts[2]);
  const seat = parts.length === 4 && parts[0] === "seats" && SEAT_ID.test(parts[1]) && parts[2] === "agents" && BOT_ID.test(parts[3]);
  if (!talk && !seat) refuse();
  // Build each directory from the machine's own root and validated IDs.
  let directory = root;
  privateDirectory(directory, platform);
  for (const part of parts) {
    directory = path.join(directory, part);
    privateDirectory(directory, platform);
  }
  // KRA-7500/KRA-7502: Claude Code loads CLAUDE.md, AGENTS.md and user memory from
  // every ancestor; the Bot must obey only its own instructions. Same file as Jack's.
  guardTalkWorkspace(directory, platform);
  return true;
}

/**
 * Read-only check: true iff `workspace` is a valid Bot workspace path under
 * this machine's canonical `<home>/.jack-local-scratch/` root, with no symlink
 * along the existing prefix. Never creates directories on disk.
 */
export function isBotWorkspacePath(workspace, { home = os.homedir(), platform = process.platform } = {}) {
  if (typeof workspace !== "string" || !workspace.split(/[\\/]/).includes(PRIVATE_ROOT)) return false;
  let canonicalHome;
  try {
    canonicalHome = fs.realpathSync(home);
    requireHome(canonicalHome, platform);
  } catch {
    return false;
  }
  const root = path.join(canonicalHome, PRIVATE_ROOT);
  if (!path.isAbsolute(workspace) || path.normalize(workspace) !== workspace
      || /[\\/]$/.test(workspace)
      || workspace.length > 1024 || /[\u0000-\u001f\u007f]/.test(workspace)
      || !workspace.startsWith(`${root}${path.sep}`)
      || root.split(path.sep).some(part => SOURCE_COMPONENTS.has(part.toLowerCase()))) return false;
  const parts = path.relative(root, workspace).split(path.sep);
  const talk = parts.length === 3 && parts[0] === "jack-talk" && HEX_ID.test(parts[1]) && HEX_ID.test(parts[2]);
  const seat = parts.length === 4 && parts[0] === "seats" && SEAT_ID.test(parts[1]) && parts[2] === "agents" && BOT_ID.test(parts[3]);
  if (!talk && !seat) return false;
  let current = root;
  for (const segment of [null, ...parts]) {
    if (segment !== null) current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      if (platform !== "win32" && (typeof process.getuid !== "function" || stat.uid !== process.getuid())) return false;
    } catch (error) {
      if (error.code === "ENOENT") break;
      return false;
    }
  }
  return true;
}

function validAbsoluteWorkspace(workspace) {
  return typeof workspace === "string"
    && workspace.length > 0
    && workspace.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(workspace)
    && path.isAbsolute(workspace)
    && path.normalize(workspace) === workspace
    && (workspace.length === 1 || !/[\\/]$/.test(workspace));
}

/**
 * Shared KRA-10939 / KRA-10940 scope check: true iff `workspace` is under this
 * computer's own Bot root, or explicitly listed in the owner's local allowlist.
 */
export function isAllowedRemoteWorkspace(workspace, {
  home = os.homedir(),
  platform = process.platform,
  allowedWorkspaces = [],
} = {}) {
  if (!validAbsoluteWorkspace(workspace)) return false;
  if (isBotWorkspacePath(workspace, { home, platform })) return true;
  if (!Array.isArray(allowedWorkspaces) || allowedWorkspaces.length === 0) return false;
  for (const entry of allowedWorkspaces) {
    if (!validAbsoluteWorkspace(entry)) continue;
    if (workspace === entry) {
      try {
        const stat = fs.lstatSync(workspace);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        fs.realpathSync(workspace);
        return true;
      } catch (error) {
        return error.code === "ENOENT";
      }
    }
  }
  return false;
}
