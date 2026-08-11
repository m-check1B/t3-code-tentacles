import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_T3_URL = "http://127.0.0.1:3773";
export const DEFAULT_HERMES_URL = "http://127.0.0.1:8642";
export const DEFAULT_INSTANCE_ID = "hermes";
export const DEFAULT_MODEL = process.env.T3_HERMES_MODEL || "openai-codex:gpt-5.6-sol";
export const DEFAULT_PI_INSTANCE_ID = "pi";
export const DEFAULT_PI_PROVIDER = process.env.T3_PI_PROVIDER || "openai-codex";
export const DEFAULT_PI_MODEL = process.env.T3_PI_MODEL || "gpt-5.6-terra";
export const DEFAULT_HERMES_PROFILE = process.env.HERMES_PROFILE || "default";
export const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "state", "t3-hermes-bridge");
export const DEFAULT_TOKEN_FILE = path.join(DEFAULT_STATE_DIR, "t3.token");
export const DEFAULT_BRIDGE_STATE_FILE = path.join(DEFAULT_STATE_DIR, "bridge-state.json");

export function readToken(tokenFile = process.env.T3_HERMES_TOKEN_FILE || DEFAULT_TOKEN_FILE) {
  const linkStat = fs.lstatSync(tokenFile);
  if (linkStat.isSymbolicLink()) throw new Error(`Token file must not be a symlink: ${tokenFile}`);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(tokenFile, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Token path is not a regular file: ${tokenFile}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Token file is not owned by the current user: ${tokenFile}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Token file permissions are too broad: ${tokenFile}; expected mode 0600`);
    }
    if (stat.size < 16 || stat.size > 16_384) {
      throw new Error(`Token file size is outside the accepted range: ${tokenFile}`);
    }
    const token = fs.readFileSync(descriptor, "utf8").trim();
    if (!/^[^\s\u0000-\u001f\u007f]{16,16384}$/.test(token)) {
      throw new Error(`T3 bearer token has an invalid format: ${tokenFile}`);
    }
    return token;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function ensurePrivateDirectory(directory = DEFAULT_STATE_DIR) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function resolveExecutable(name, searchPath = process.env.PATH || "") {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error(`Executable not found on PATH: ${name}`);
}

export function requireLoopbackUrl(value, label) {
  const url = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(`${label} must use a loopback host; received ${url.hostname}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an origin URL without credentials, path, query, or fragment`);
  }
  return url.origin;
}
