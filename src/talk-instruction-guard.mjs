/**
 * KRA-7500: a Local Bot obeys only Jack's own instructions.
 *
 * Claude Code loads CLAUDE.md, AGENTS.md, `.claude/rules` and user memory from
 * every ancestor of its cwd, and the Bot workspace sits under the Mac owner's
 * home. T3 launches Claude with `--setting-sources=user,project,local`, so the
 * workspace's own `.claude/settings.local.json` is read for every Bot thread
 * and never for an operator seat. It lists every ancestor's files as
 * `claudeMdExcludes` and turns auto memory off. Workspaces stay where they are,
 * so Claude sessions keyed by cwd keep resuming (KRA-7389).
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const GUARD_FILE = path.join('.claude', 'settings.local.json');
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// picomatch syntax. A backslash escape is unusable: Claude Code turns every
// `\` in a pattern into `/`, so each special character becomes a class.
const GLOB_SPECIAL = /[*?[\]{}()!+@,]/g;

function literal(value) {
  return value.replace(GLOB_SPECIAL, char => (char === ']' ? '[]]' : `[${char}]`));
}

/** Patterns for every instruction file outside the Bot's own workspace. */
export function instructionExcludes(workspace, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const patterns = [];
  let directory = paths.dirname(workspace);
  for (;;) {
    const base = literal(directory.replaceAll('\\', '/').replace(/\/+$/, ''));
    patterns.push(`${base}/*`, `${base}/.claude/**`);
    const parent = paths.dirname(directory);
    if (parent === directory) return patterns;
    directory = parent;
  }
}

function realDirectory(directory) {
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Talk instruction guard needs a real directory');
}

function readExisting(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Idempotent; keeps any other local settings a Bot session wrote. */
export function guardTalkWorkspace(workspace, platform = process.platform) {
  realDirectory(workspace);
  const settingsDirectory = path.join(workspace, '.claude');
  try { mkdirSync(settingsDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  realDirectory(settingsDirectory);
  const file = path.join(workspace, GUARD_FILE);
  const existing = readExisting(file);
  const text = `${JSON.stringify({ ...existing, claudeMdExcludes: instructionExcludes(workspace, platform), autoMemoryEnabled: false }, null, 2)}\n`;
  try {
    if (!lstatSync(file).isSymbolicLink() && readFileSync(file, 'utf8') === text) return file;
  } catch { /* missing: write below */ }
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    if (platform !== 'win32') fchmodSync(fd, 0o600);
    writeSync(fd, text);
    if (!fstatSync(fd).isFile()) throw new Error('Talk instruction guard must be a file');
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  // rename replaces a planted symlink itself, never its target.
  renameSync(temporary, file);
  return file;
}

function childDirectories(directory, pattern) {
  try {
    realDirectory(directory); // never descend through a planted link
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && pattern.test(entry.name))
      .map(entry => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

/** One-time-per-start migration of existing Bot workspaces; never fails pairing. */
export function sweepTalkWorkspaces(root, platform = process.platform) {
  const workspaces = [];
  for (const tenant of childDirectories(path.join(root, 'jack-talk'), HEX32)) workspaces.push(...childDirectories(tenant, HEX32));
  for (const seat of childDirectories(path.join(root, 'seats'), HEX64)) workspaces.push(...childDirectories(path.join(seat, 'agents'), UUID));
  let guarded = 0;
  for (const workspace of workspaces) {
    try { guardTalkWorkspace(workspace, platform); guarded++; } catch { /* custody refused: the next prepare fails closed */ }
  }
  return guarded;
}
