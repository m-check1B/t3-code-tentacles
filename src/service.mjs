import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DEFAULT_STATE_DIR, ensurePrivateDirectory } from "./config.mjs";

export const LAUNCH_AGENT_LABEL = "com.mcheck1b.t3-hermes-bridge";
export const LAUNCH_AGENT_OWNER_KEY = "T3HermesBridgeOwner";
export const LAUNCH_AGENT_OWNER_VALUE = "t3-hermes-bridge/v1";
const MAX_LAUNCH_AGENT_BYTES = 64 * 1024;

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export function isBridgeOwnedLaunchAgent(content) {
  if (typeof content !== "string") return false;
  return content.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`)
    && content.includes(`<key>${LAUNCH_AGENT_OWNER_KEY}</key>`)
    && content.includes(`<string>${LAUNCH_AGENT_OWNER_VALUE}</string>`);
}

export function assertBridgeOwnedLaunchAgentFile(plist) {
  const stat = fs.lstatSync(plist);
  if (stat.isSymbolicLink()) throw new Error(`LaunchAgent must not be a symlink: ${plist}`);
  if (!stat.isFile()) throw new Error(`LaunchAgent path is not a regular file: ${plist}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`LaunchAgent is not owned by the current user: ${plist}`);
  }
  if (stat.size > MAX_LAUNCH_AGENT_BYTES) {
    throw new Error(`LaunchAgent is larger than ${MAX_LAUNCH_AGENT_BYTES} bytes: ${plist}`);
  }
  const content = fs.readFileSync(plist, "utf8");
  if (!isBridgeOwnedLaunchAgent(content)) {
    throw new Error(`Refusing to replace or remove LaunchAgent not owned by t3-hermes-bridge: ${plist}`);
  }
  return content;
}

function fileExists(pathname) {
  try {
    fs.lstatSync(pathname);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function renderLaunchAgent({ nodePath, cliPath, interval = 2000 }) {
  const stdoutPath = path.join(DEFAULT_STATE_DIR, "watch.stdout.log");
  const stderrPath = path.join(DEFAULT_STATE_DIR, "watch.stderr.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>${LAUNCH_AGENT_OWNER_KEY}</key>
  <string>${LAUNCH_AGENT_OWNER_VALUE}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliPath)}</string>
    <string>watch</string>
    <string>--interval</string>
    <string>${interval}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

export function serviceStatus() {
  const result = spawnSync("launchctl", ["print", `${domain()}/${LAUNCH_AGENT_LABEL}`], {
    encoding: "utf8",
  });
  return { loaded: result.status === 0, label: LAUNCH_AGENT_LABEL, plist: launchAgentPath() };
}

export function installService({ cliPath, interval = 2000 }) {
  if (process.platform !== "darwin") throw new Error("install-service currently supports macOS only");
  if (!path.isAbsolute(cliPath)) throw new Error("Service CLI path must be absolute");
  ensurePrivateDirectory(DEFAULT_STATE_DIR);
  const plist = launchAgentPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const existingFile = fileExists(plist);
  if (existingFile) assertBridgeOwnedLaunchAgentFile(plist);
  const currentStatus = serviceStatus();
  if (currentStatus.loaded && !existingFile) {
    throw new Error(`Refusing to replace loaded LaunchAgent without an owned plist: ${LAUNCH_AGENT_LABEL}`);
  }
  const content = renderLaunchAgent({ nodePath: process.execPath, cliPath, interval });
  const temporary = `${plist}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o644, flag: "wx" });

  if (currentStatus.loaded) {
    execFileSync("launchctl", ["bootout", domain(), plist], { stdio: "ignore" });
  }
  fs.renameSync(temporary, plist);
  fs.chmodSync(plist, 0o644);
  execFileSync("launchctl", ["bootstrap", domain(), plist], { stdio: "ignore" });
  return serviceStatus();
}

export function uninstallService() {
  const plist = launchAgentPath();
  const existingFile = fileExists(plist);
  if (existingFile) assertBridgeOwnedLaunchAgentFile(plist);
  const currentStatus = serviceStatus();
  if (currentStatus.loaded && !existingFile) {
    throw new Error(`Refusing to remove loaded LaunchAgent without an owned plist: ${LAUNCH_AGENT_LABEL}`);
  }
  if (currentStatus.loaded) {
    execFileSync("launchctl", ["bootout", domain(), plist], { stdio: "ignore" });
  }
  if (existingFile) {
    fs.unlinkSync(plist);
  }
  return { loaded: false, label: LAUNCH_AGENT_LABEL, plist, removed: currentStatus.loaded || existingFile };
}
