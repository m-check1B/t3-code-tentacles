import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_STATE_DIR } from "./config.mjs";

// A "computer" is another machine running a T3 environment (T3 multi-computer
// support). Tentacles keeps talking to a loopback origin only: it reaches the
// remote environment through an SSH local forward, with a bearer issued by that
// environment's own T3 CLI and stored per computer.
export const DEFAULT_COMPUTERS_FILE = path.join(DEFAULT_STATE_DIR, "computers.json");
export const COMPUTER_COMMANDS = new Set(["doctor", "observe", "report", "act", "orchestrate", "originate", "reauth"]);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
// An ssh_config alias or user@host; never an option, never a shell metacharacter.
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,252}$/;
const REMOTE_PATH = /^\/[A-Za-z0-9._/-]{1,1023}$/;

function port(value, label) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${label} must be an integer port between 1024 and 65535`);
  return value;
}

export function loadComputer(name, { file = process.env.TENTACLES_COMPUTERS_FILE || DEFAULT_COMPUTERS_FILE, stateDir = DEFAULT_STATE_DIR } = {}) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("--computer must be a lowercase name (a-z, 0-9, -)");
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`No computers registry at ${file}; add {"computers":{"${name}":{"ssh":"<alias>","localPort":<port>}}}`);
    throw new Error(`Computers registry is not valid JSON: ${file}`);
  }
  const entry = registry?.computers?.[name];
  if (!entry || typeof entry !== "object") throw new Error(`Unknown computer ${name}; add it to ${file}`);
  if (typeof entry.ssh !== "string" || !SSH_TARGET.test(entry.ssh)) throw new Error(`Computer ${name}: ssh must be an ssh alias or user@host`);
  const t3Bin = entry.t3Bin ?? null;
  const t3Home = entry.t3Home ?? null;
  for (const [label, value] of [["t3Bin", t3Bin], ["t3Home", t3Home]]) {
    if (value !== null && (typeof value !== "string" || !REMOTE_PATH.test(value))) throw new Error(`Computer ${name}: ${label} must be an absolute remote path`);
  }
  const localPort = port(entry.localPort, `Computer ${name}: localPort`);
  return {
    name,
    ssh: entry.ssh,
    localPort,
    remotePort: port(entry.remotePort ?? 3773, `Computer ${name}: remotePort`),
    t3Bin,
    t3Home,
    t3Url: `http://127.0.0.1:${localPort}`,
    tokenFile: path.join(stateDir, "computers", `${name}.token`),
    stateFile: path.join(stateDir, `bridge-state-${name}.json`),
  };
}

export function probePort(localPort, { timeoutMs = 1_000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: localPort });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function forwardArgs(computer) {
  return [
    "-f", "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${computer.localPort}:127.0.0.1:${computer.remotePort}`,
    computer.ssh,
  ];
}

// Reuse a live forward; otherwise start a backgrounded `ssh -f -N -L` that
// outlives this CLI run, so the next command reuses it.
export async function ensureForward(computer, { spawnImpl = spawnSync, probe = probePort, waitMs = 5_000 } = {}) {
  if (await probe(computer.localPort)) return { forward: "reused", localPort: computer.localPort };
  const result = spawnImpl("ssh", forwardArgs(computer), { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not open the SSH forward to computer ${computer.name} (${computer.ssh}); check \`ssh ${computer.ssh} true\``);
  }
  const deadline = Date.now() + waitMs;
  do {
    if (await probe(computer.localPort)) return { forward: "started", localPort: computer.localPort };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`SSH forward to computer ${computer.name} started but 127.0.0.1:${computer.localPort} does not answer`);
}

// The remote T3 CLI issues the bearer; it travels over ssh stdout straight
// into the per-computer token file (see reauthenticate's remote mode).
export function remoteIssueSpawn(computer, spawnImpl = spawnSync) {
  return (t3Bin, args, options) => {
    if (!REMOTE_PATH.test(t3Bin)) throw new Error("remote t3 path is not a safe absolute path");
    for (const arg of args) {
      if (!/^[A-Za-z0-9._/:=-]+$/.test(arg)) throw new Error("remote T3 arguments must not need shell quoting");
    }
    return spawnImpl("ssh", ["-o", "BatchMode=yes", computer.ssh, t3Bin, ...args], options);
  };
}
