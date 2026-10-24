#!/usr/bin/env node
// KRA-8371: `tentacles-updater <status|now|undo|launch>`. Installed copy runs
// from ~/.tentacles/updater, outside the swapped version tree.
//
// No subcommand accepts a version, URL, hash or key (U5).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SelfUpdater, DEFAULT_HOME, writeAtomic } from "./updater.mjs";
import { Launcher } from "./launcher.mjs";
import { readSelfUpdateSummary, requireComputerId } from "./events.mjs";
import { fsyncPath } from "./safe-tar.mjs";

export const UPDATER_FILES = Object.freeze(["cli.mjs", "events.mjs", "launcher.mjs", "manifest.mjs", "pinned.mjs", "release-source.mjs", "safe-tar.mjs", "updater.mjs"]);
const USAGE = "usage: tentacles-updater status | now | undo | launch [--computer-id ID] -- <tentacles args...>";

/** Copy the updater out of a verified tree into <home>/updater (explicit operator step). */
export function installUpdater({ home = DEFAULT_HOME, from = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const target = path.join(home, "updater");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(home, ".updater-"));
  try {
    for (const name of UPDATER_FILES) writeAtomic(path.join(staging, name), fs.readFileSync(path.join(from, name)), 0o644);
    fs.writeFileSync(path.join(staging, "package.json"), "{\"type\":\"module\"}\n", { mode: 0o644 });
    fsyncPath(staging, true);
    if (fs.existsSync(target)) fs.renameSync(target, path.join(staging, "replaced"));
    fs.renameSync(staging, target);
    fsyncPath(home, true);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(path.join(target, "replaced"), { recursive: true, force: true });
  return { installed: true, files: UPDATER_FILES.length };
}

function computerIdFrom(args, explicit) {
  const index = args.indexOf("--machine-id");
  const candidate = explicit ?? (index >= 0 ? args[index + 1] : null);
  if (!candidate) return null;
  try { return requireComputerId(candidate); } catch { return null; }
}

export async function main(argv, { home = DEFAULT_HOME, out = (value) => console.log(JSON.stringify(value)) } = {}) {
  const [command, ...rest] = argv;
  if (command === "status") return out(readSelfUpdateSummary(home) ?? { schema: "tentacles-self-update/v1", current: null, held: false, events: [] });
  if (command === "now" || command === "undo") {
    if (rest.length) throw new Error(`${command} takes no arguments; the device applies the signed manifest's recommended version`);
    const updater = new SelfUpdater({ home });
    return out(command === "now" ? await updater.run({ trigger: "now" }) : await updater.undo());
  }
  if (command === "launch") {
    const separator = rest.indexOf("--");
    if (separator < 0) throw new Error(USAGE);
    const own = rest.slice(0, separator);
    const args = rest.slice(separator + 1);
    let explicit = null;
    if (own.length === 2 && own[0] === "--computer-id") explicit = own[1];
    else if (own.length) throw new Error(USAGE);
    const updater = new SelfUpdater({ home });
    const computerId = computerIdFrom(args, explicit);
    if (computerId) updater.writeState({ computerId });
    process.exitCode = await new Launcher({ updater, args }).run();
    return undefined;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`tentacles-updater: ${error.code ?? error.message}`);
    process.exitCode = 1;
  });
}
