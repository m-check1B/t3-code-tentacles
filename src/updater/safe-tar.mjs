// KRA-8371 (U4): extract an already sha256-verified npm-pack tarball without
// trusting its entries. Absolute paths, `..`, out-of-tree symlinks or
// hardlinks, writes through a symlink, device files, FIFOs and unknown entry
// types are refused before anything outside the destination can change.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { UpdateError } from "./manifest.mjs";

export const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;
const BLOCK = 512;

function cString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(buffer, start, length) {
  if (buffer[start] & 0x80) throw new UpdateError("artifact_unsafe", "base-256 tar numbers are not accepted");
  const text = cString(buffer, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new UpdateError("artifact_unsafe", "invalid tar number");
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumOk(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum === octal(header, 148, 8);
}

function parsePax(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new UpdateError("artifact_unsafe", "invalid pax record");
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) {
      throw new UpdateError("artifact_unsafe", "invalid pax record");
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 1) throw new UpdateError("artifact_unsafe", "invalid pax record");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Map an archive name to a relative path inside the package, or refuse it. */
export function safeRelativePath(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 1024 || /[\u0000\\]/.test(name)) {
    throw new UpdateError("artifact_unsafe", "invalid entry name");
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new UpdateError("artifact_unsafe", "absolute entry path");
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new UpdateError("artifact_unsafe", "parent traversal in entry path");
  if (parts[0] !== "package") throw new UpdateError("artifact_unsafe", "entry outside the package root");
  return parts.slice(1).join("/");
}

function insideRoot(relative) {
  const normalized = path.posix.normalize(relative);
  return normalized !== ".." && !normalized.startsWith("../") && !path.posix.isAbsolute(normalized);
}

function fsyncPath(target, directory = false) {
  const descriptor = fs.openSync(target, directory ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function readTarEntries(gzipBytes) {
  let tar;
  try { tar = gunzipSync(gzipBytes, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch { throw new UpdateError("artifact_unsafe", "artifact is not a bounded gzip stream"); }
  const entries = [];
  let offset = 0;
  let pax = null;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return entries;
    if (!checksumOk(header)) throw new UpdateError("artifact_unsafe", "tar header checksum mismatch");
    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header, 124, 12);
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) throw new UpdateError("artifact_unsafe", "truncated tar entry");
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") { pax = parsePax(data); continue; }
    const magic = cString(header, 257, 6);
    const prefix = magic === "ustar" ? cString(header, 345, 155) : "";
    const rawName = pax?.path ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
    const linkName = pax?.linkpath ?? cString(header, 157, 100);
    pax = null;
    if (!["0", "5", "2", "1"].includes(type)) {
      // 3/4 = devices, 6 = FIFO, g/L/K/7 and anything else: never accepted.
      throw new UpdateError("artifact_unsafe", `refused tar entry type ${JSON.stringify(type)}`);
    }
    if (entries.length >= MAX_ENTRIES) throw new UpdateError("artifact_unsafe", "too many entries");
    entries.push({ type, name: rawName, relative: safeRelativePath(rawName), linkName, mode: octal(header, 100, 8), data });
  }
  throw new UpdateError("artifact_unsafe", "tar archive has no end marker");
}

/**
 * Extract into `destination`, which must be a new empty directory on the same
 * filesystem as the final version directory. Every file and directory is
 * fsynced before this returns; the caller renames and switches afterwards.
 */
export function extractPackage(gzipBytes, destination) {
  const entries = readTarEntries(gzipBytes);
  const root = path.resolve(destination);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(root).length !== 0) {
    throw new UpdateError("artifact_unsafe", "extraction directory must be a new empty directory");
  }
  const seen = new Set();
  const symlinks = new Set();
  const regularFiles = new Set();
  const directories = new Set([""]);
  const throughSymlink = (relative) => {
    const parts = relative.split("/");
    for (let index = 1; index < parts.length; index += 1) if (symlinks.has(parts.slice(0, index).join("/"))) return true;
    return false;
  };
  const ensureParents = (relative) => {
    const parts = relative.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      if (directories.has(directory)) continue;
      if (seen.has(directory)) throw new UpdateError("artifact_unsafe", "entry nested under a non-directory");
      fs.mkdirSync(path.join(root, directory), { mode: 0o755 });
      directories.add(directory);
    }
  };
  for (const entry of entries) {
    const relative = entry.relative;
    if (relative === "") {
      if (entry.type !== "5") throw new UpdateError("artifact_unsafe", "package root must be a directory");
      continue;
    }
    if (seen.has(relative) && !(entry.type === "5" && directories.has(relative))) {
      throw new UpdateError("artifact_unsafe", "duplicate tar entry");
    }
    if (throughSymlink(relative)) throw new UpdateError("artifact_unsafe", "entry path passes through a symlink");
    ensureParents(relative);
    const target = path.join(root, relative);
    if (entry.type === "5") {
      if (!directories.has(relative)) fs.mkdirSync(target, { mode: 0o755 });
      directories.add(relative);
    } else if (entry.type === "0") {
      // Never keep setuid/setgid/sticky or group/other write bits.
      const mode = entry.mode & 0o111 ? 0o755 : 0o644;
      const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
      try {
        fs.writeSync(descriptor, entry.data);
        fs.fchmodSync(descriptor, mode);
        fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      regularFiles.add(relative);
    } else if (entry.type === "2") {
      const link = entry.linkName;
      if (!link || link.startsWith("/") || /[\u0000\\]/.test(link)) throw new UpdateError("artifact_unsafe", "absolute or invalid symlink target");
      // A relative target with no `..` can only descend from its own directory,
      // so no chain of such links can leave the package root.
      if (link.split("/").includes("..") || !insideRoot(path.posix.join(path.posix.dirname(relative), link))) {
        throw new UpdateError("artifact_unsafe", "symlink points outside the package");
      }
      fs.symlinkSync(link, target);
      symlinks.add(relative);
    } else if (entry.type === "1") {
      const linked = safeRelativePath(entry.linkName);
      if (!regularFiles.has(linked)) throw new UpdateError("artifact_unsafe", "hardlink target is not an extracted file in the package");
      fs.linkSync(path.join(root, linked), target);
      regularFiles.add(relative);
    }
    seen.add(relative);
  }
  if (!regularFiles.has("package.json")) throw new UpdateError("artifact_unsafe", "package.json missing from artifact");
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) fsyncPath(path.join(root, directory), true);
  return { files: regularFiles.size };
}

export { fsyncPath };
