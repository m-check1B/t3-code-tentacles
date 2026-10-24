// Repository-owned no-AI reader. Do not run against a real vault until GUARDIAN
// pins this reader, nasvault and its parent/host/output contract in the manifest.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ITEMS = new Set(["tentacles-manifest-signing-key-current", "tentacles-signer-forgejo-read-token"]);
const FD_PATH = "/dev/fd/3";
const STATUS = Buffer.from(`nasvault: wrote value to ${FD_PATH} (0600)\n`);
export const NASVAULT = path.join(os.homedir(), "bin", "nasvault");

/** nasvault metadata only; secret bytes bypass JS and go straight to fd 3. */
export async function runKeySource(item, { spawnImpl = spawn, nasvault = NASVAULT, outputFd = 3 } = {}) {
  if (!ITEMS.has(item)) throw new Error("vault_item_not_allowed");
  const fd = fs.fstatSync(outputFd);
  if (!fd.isFIFO() && !fd.isSocket()) throw new Error("key_fd_not_pipe");
  const parent = process.ppid;
  let child;
  const terminate = () => {
    // The signer starts this reader as a process-group leader. Its nasvault
    // descendants share the group, including if the signer itself is SIGKILLed.
    try { process.kill(-process.pid, "SIGKILL"); } catch { child?.kill("SIGKILL"); }
  };
  const watchdog = setInterval(() => {
    if (process.ppid !== parent || parent <= 1) terminate();
  }, 100);
  const deadline = setTimeout(terminate, 25_000);
  const call = (args, passKeyFd = false) => new Promise((resolve, reject) => {
    let done = false;
    let size = 0;
    const chunks = [];
    const wipe = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const fail = () => {
      if (done) return;
      done = true;
      wipe();
      child?.kill("SIGKILL");
      reject(new Error("nasvault_failed"));
    };
    try {
      child = spawnImpl(nasvault, args, {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), LANG: "C" },
        stdio: ["ignore", "pipe", "pipe", passKeyFd ? outputFd : "ignore"],
      });
      child.stdout.on("data", (chunk) => {
        if (done || (size += chunk.length) > 8192) { chunk.fill(0); fail(); return; }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => { chunk.fill(0); fail(); });
      child.on("error", fail);
      child.on("close", (code, signal) => {
        if (done) return;
        if (code !== 0 || signal) { fail(); return; }
        done = true;
        const output = Buffer.concat(chunks);
        wipe();
        resolve(output);
      });
    } catch { fail(); }
  });
  try {
    // nasvault list emits names + ids, never values. Require exactly one full
    // name. The names here cannot be UUID prefixes (the Pro resolver's fallback).
    const listing = await call(["list", item]);
    try {
      const lines = listing.toString("utf8").trimEnd().split("\n");
      const names = lines.map((line) => /^[0-9a-f-]{8,36} \| (.+)$/.exec(line)?.[1]);
      if (names.some((name) => name === undefined) || names.filter((name) => name === item).length !== 1) {
        throw new Error("vault_item_missing_or_ambiguous");
      }
    } finally { listing.fill(0); }
    // /dev/fd/3 opens the inherited pipe, never a disk file. The canonical Pro
    // nasvault redirects its value pipeline there and emits only this status on
    // stdout. Scoped hosts that cannot write an existing fd must fail closed.
    const status = await call(["to-file", item, FD_PATH, "--password"], true);
    try { if (!status.equals(STATUS)) throw new Error("nasvault_extra_output"); }
    finally { status.fill(0); }
  } finally {
    clearInterval(watchdog);
    clearTimeout(deadline);
  }
}

if (process.argv[1] === "-" || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  try {
    if (process.argv.length !== 3) throw new Error("reader_arguments_invalid");
    await runKeySource(process.argv[2]);
  } catch {
    // Neither nasvault output nor exception bodies are printed.
    process.exitCode = 1;
  }
}
