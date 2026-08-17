import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  DEFAULT_BRIDGE_STATE_FILE,
  DEFAULT_HERMES_PROFILE,
  DEFAULT_HERMES_URL,
  DEFAULT_INSTANCE_ID,
  DEFAULT_MODEL,
  DEFAULT_STATE_DIR,
  DEFAULT_T3_URL,
  requireLoopbackUrl,
} from "./config.mjs";

export const LAUNCH_AGENT_LABEL = "com.mcheck1b.t3-hermes-bridge";
export const LAUNCH_AGENT_OWNER_KEY = "T3HermesBridgeOwner";
export const LAUNCH_AGENT_OWNER_VALUE = "t3-hermes-bridge/v1";
export const LEGACY_LAUNCH_AGENT_OWNER_VALUE = LAUNCH_AGENT_OWNER_VALUE;
const MAX_LAUNCH_AGENT_BYTES = 64 * 1024;
const MAX_RUNTIME_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_BYTES = 16_384;
const SERVICE_SOURCE_FILES = ["cli.mjs", "bridge.mjs", "config.mjs", "service.mjs", "t3-client.mjs"];
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SYSTEMD_USER_DIR = path.join(".config", "systemd", "user");
const SYSTEMD_DEFAULT_TARGET_WANTS = path.join(SYSTEMD_USER_DIR, "default.target.wants");
const LINUX_SUPPORT_DIR = path.join(".local", "share", "t3-hermes-bridge");

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function defaultDeps(overrides = {}) {
  return {
    fs,
    homeDir: os.homedir(),
    platform: process.platform,
    legacyStateFile: DEFAULT_BRIDGE_STATE_FILE,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    nodePath: process.execPath,
    launchctl: {
      print: (target) => spawnSync("launchctl", ["print", target], { encoding: "utf8" }),
      bootout: (domain, plist) => execFileSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" }),
      bootstrap: (domain, plist) => execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "ignore" }),
      kickstart: (target) => execFileSync("launchctl", ["kickstart", "-k", target], { stdio: "ignore" }),
    },
    plutilLint: (plist) => execFileSync("plutil", ["-lint", plist], { stdio: "ignore" }),
    systemctl: {
      status: (target) => spawnSync("systemctl", ["--user", "status", target, "--no-pager"], { encoding: "utf8" }),
      show: (target) => spawnSync("systemctl", ["--user", "show", target, "--property=NRestarts,ExecMainStatus", "--value"], { encoding: "utf8" }),
      load: (target) => spawnSync("systemctl", ["--user", "show", target, "--property=LoadState", "--value"], { encoding: "utf8" }),
      start: (target) => execFileSync("systemctl", ["--user", "start", target], { stdio: "ignore" }),
      stop: (target) => execFileSync("systemctl", ["--user", "stop", target], { stdio: "ignore" }),
      restart: (target) => execFileSync("systemctl", ["--user", "restart", target], { stdio: "ignore" }),
      daemonReload: () => execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }),
    },
    ...overrides,
  };
}

function assertIdentity(value, label) {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
    throw new Error(`${label} must be a filesystem-safe identity (1-64 letters, digits, '.', '_' or '-')`);
  }
  return value;
}

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

function ensurePrivateDirectory(directory, deps) {
  deps.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  deps.fs.chmodSync(directory, 0o700);
}

function assertPrivateDirectory(directory, deps) {
  const stat = deps.fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Directory must be a non-symlink directory: ${directory}`);
  if (deps.uid !== null && stat.uid !== deps.uid) throw new Error(`Directory is not owned by the current user: ${directory}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Directory permissions are too broad: ${directory}`);
  return stat;
}

function lstatOrNull(pathname, deps) {
  try {
    return deps.fs.lstatSync(pathname);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertPrivateRegularFile(pathname, deps, { maxBytes = MAX_LAUNCH_AGENT_BYTES, owner = true } = {}) {
  const stat = deps.fs.lstatSync(pathname);
  if (stat.isSymbolicLink()) throw new Error(`Path must not be a symlink: ${pathname}`);
  if (!stat.isFile()) throw new Error(`Path is not a regular file: ${pathname}`);
  if (owner && deps.uid !== null && stat.uid !== deps.uid) throw new Error(`Path is not owned by the current user: ${pathname}`);
  if (stat.size > maxBytes) throw new Error(`Path is larger than ${maxBytes} bytes: ${pathname}`);
  return stat;
}

export function serviceIdentity({ profile, instance } = {}) {
  return { profile: assertIdentity(profile, "--profile"), instance: assertIdentity(instance, "--instance") };
}

export function serviceLabel(identity) {
  const { profile, instance } = serviceIdentity(identity);
  return `${LAUNCH_AGENT_LABEL}.${profile}.${instance}`;
}

export function servicePaths(identity, overrides = {}) {
  const deps = defaultDeps(overrides);
  const { profile, instance } = serviceIdentity(identity);
  const label = serviceLabel({ profile, instance });
  if (deps.platform === "linux") {
    const supportRoot = path.join(deps.homeDir, LINUX_SUPPORT_DIR);
    const serviceDir = path.join(supportRoot, "services", profile, instance);
    return {
      profile,
      instance,
      label,
      supportRoot,
      serviceDir,
      runtimeRoot: path.join(supportRoot, "runtime"),
      unit: path.join(deps.homeDir, SYSTEMD_USER_DIR, `${label}.service`),
      config: path.join(serviceDir, "service-config.json"),
      status: path.join(serviceDir, "watch-status.json"),
    };
  }
  if (deps.platform !== "darwin") {
    throw new Error(`service packaging is unsupported on platform: ${deps.platform} (supported: darwin, linux)`);
  }
  const supportRoot = path.join(deps.homeDir, "Library", "Application Support", "t3-hermes-bridge");
  const serviceDir = path.join(supportRoot, "services", profile, instance);
  return {
    profile,
    instance,
    label,
    supportRoot,
    serviceDir,
    runtimeRoot: path.join(supportRoot, "runtime"),
    plist: path.join(deps.homeDir, "Library", "LaunchAgents", `${label}.plist`),
    config: path.join(serviceDir, "service-config.json"),
    status: path.join(serviceDir, "watch-status.json"),
    legacyPlist: path.join(deps.homeDir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
  };
}

// Kept for callers migrating from v1. New mutating commands require an identity.
// The optional overrides argument is for tests; callers on non-darwin get a
// loud error instead of an undefined plist path.
export function launchAgentPath(identity, overrides = {}) {
  if (!identity) return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const deps = defaultDeps(overrides);
  if (deps.platform !== "darwin") throw new Error(`launchAgentPath is only supported on darwin (current platform: ${deps.platform})`);
  return servicePaths(identity, deps).plist;
}

export function isBridgeOwnedLaunchAgent(content, { label, ownerValue = LAUNCH_AGENT_OWNER_VALUE } = {}) {
  if (typeof content !== "string") return false;
  const labelMatches = label
    ? content.includes(`<string>${label}</string>`)
    : new RegExp(`<string>${LAUNCH_AGENT_LABEL.replaceAll(".", "\\.")}(?:\\.[A-Za-z0-9._-]+){0,2}</string>`).test(content);
  return labelMatches
    && content.includes(`<key>${LAUNCH_AGENT_OWNER_KEY}</key>`)
    && content.includes(`<string>${ownerValue}</string>`);
}

export function assertBridgeOwnedLaunchAgentFile(plist, options = {}) {
  const deps = defaultDeps(options);
  assertPrivateRegularFile(plist, deps);
  const content = deps.fs.readFileSync(plist, "utf8");
  if (!isBridgeOwnedLaunchAgent(content, options)) {
    throw new Error(`Refusing to replace or remove LaunchAgent not owned by t3-hermes-bridge: ${plist}`);
  }
  return content;
}

export function isBridgeOwnedSystemdUnit(content, { label, ownerValue = LAUNCH_AGENT_OWNER_VALUE } = {}) {
  if (typeof content !== "string") return false;
  const labelMatches = label
    ? content.includes(`# ${label}`)
    : new RegExp(`# ${LAUNCH_AGENT_LABEL.replaceAll(".", "\\.")}(?:\\.[A-Za-z0-9._-]+){0,2}`).test(content);
  return labelMatches
    && content.includes(`# ${LAUNCH_AGENT_OWNER_KEY}: ${ownerValue}`);
}

export function assertBridgeOwnedSystemdUnitFile(unit, options = {}) {
  const deps = defaultDeps(options);
  assertPrivateRegularFile(unit, deps);
  const content = deps.fs.readFileSync(unit, "utf8");
  if (!isBridgeOwnedSystemdUnit(content, options)) {
    throw new Error(`Refusing to replace or remove systemd unit not owned by t3-hermes-bridge: ${unit}`);
  }
  return content;
}

function normalizeInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 250 || interval > 3_600_000) {
    throw new Error("--interval must be between 250ms and 3600000ms");
  }
  return Math.floor(interval);
}

function normalizeMaxMessages(value) {
  const maxMessages = Number(value);
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
    throw new Error("--max-messages must be an integer between 1 and 100");
  }
  return maxMessages;
}

function sourceDigest(sourceDir, deps) {
  const hash = crypto.createHash("sha256");
  for (const name of SERVICE_SOURCE_FILES) {
    const source = path.join(sourceDir, name);
    assertPrivateRegularFile(source, deps, { maxBytes: MAX_RUNTIME_SOURCE_BYTES, owner: false });
    hash.update(name).update("\0").update(deps.fs.readFileSync(source));
  }
  return hash.digest("hex");
}

function packageVersion(sourceRoot, deps) {
  const packageFile = path.join(sourceRoot, "package.json");
  assertPrivateRegularFile(packageFile, deps, { maxBytes: MAX_RUNTIME_SOURCE_BYTES, owner: false });
  const version = JSON.parse(deps.fs.readFileSync(packageFile, "utf8")).version;
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("package.json has an invalid version");
  return version;
}

function atomicWrite(pathname, content, mode, deps) {
  const temporary = `${pathname}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    deps.fs.writeFileSync(temporary, content, { mode, flag: "wx" });
    deps.fs.chmodSync(temporary, mode);
    assertPrivateRegularFile(temporary, deps, { maxBytes: MAX_RUNTIME_SOURCE_BYTES });
    deps.fs.renameSync(temporary, pathname);
    deps.fs.chmodSync(pathname, mode);
  } finally {
    try { deps.fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function createRuntimeSnapshot({ cliPath }, overrides = {}) {
  const deps = defaultDeps(overrides);
  const absoluteCli = assertAbsolute(cliPath, "Service CLI path");
  const sourceDir = path.dirname(absoluteCli);
  const sourceRoot = path.dirname(sourceDir);
  if (path.basename(sourceDir) !== "src" || path.basename(absoluteCli) !== "cli.mjs") {
    throw new Error("Service CLI path must point to src/cli.mjs");
  }
  const digest = sourceDigest(sourceDir, deps);
  const version = packageVersion(sourceRoot, deps);
  const snapshotId = `v${version}-${digest.slice(0, 16)}`;
  const paths = servicePaths({ profile: "runtime", instance: "store" }, deps);
  const runtimeRoot = paths.runtimeRoot;
  const runtimePath = path.join(runtimeRoot, snapshotId);
  const runtimeCli = path.join(runtimePath, "src", "cli.mjs");
  if (lstatOrNull(runtimePath, deps)) {
    assertPrivateDirectory(runtimePath, deps);
    assertPrivateDirectory(path.join(runtimePath, "src"), deps);
    assertPrivateRegularFile(runtimeCli, deps, { maxBytes: MAX_RUNTIME_SOURCE_BYTES });
    if (sourceDigest(path.join(runtimePath, "src"), deps) !== digest) throw new Error(`Runtime snapshot digest mismatch: ${runtimePath}`);
    return { id: snapshotId, hash: digest, path: runtimePath, cliPath: runtimeCli, version };
  }
  ensurePrivateDirectory(runtimeRoot, deps);
  assertPrivateDirectory(runtimeRoot, deps);
  const staging = path.join(runtimeRoot, `.${snapshotId}.${process.pid}.${crypto.randomUUID()}.staging`);
  try {
    ensurePrivateDirectory(staging, deps);
    const stagedSource = path.join(staging, "src");
    ensurePrivateDirectory(stagedSource, deps);
    for (const name of SERVICE_SOURCE_FILES) {
      const from = path.join(sourceDir, name);
      const to = path.join(stagedSource, name);
      deps.fs.copyFileSync(from, to, deps.fs.constants.COPYFILE_EXCL);
      deps.fs.chmodSync(to, 0o500);
      assertPrivateRegularFile(to, deps, { maxBytes: MAX_RUNTIME_SOURCE_BYTES });
    }
    atomicWrite(path.join(staging, "manifest.json"), JSON.stringify({ version, hash: digest, files: SERVICE_SOURCE_FILES }, null, 2) + "\n", 0o600, deps);
    if (sourceDigest(stagedSource, deps) !== digest) throw new Error("Staged runtime snapshot verification failed");
    deps.fs.renameSync(staging, runtimePath);
    deps.fs.chmodSync(runtimePath, 0o700);
  } catch (error) {
    try { deps.fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw error;
  }
  return { id: snapshotId, hash: digest, path: runtimePath, cliPath: runtimeCli, version };
}

export function normalizeServiceConfig(input = {}, overrides = {}) {
  const deps = defaultDeps(overrides);
  const { profile, instance } = serviceIdentity(input);
  const stateFile = assertAbsolute(input.stateFile || path.join(DEFAULT_STATE_DIR, "profiles", profile, "instances", instance, "bridge-state.json"), "--state-file");
  const tokenFile = assertAbsolute(input.tokenFile || path.join(DEFAULT_STATE_DIR, "profiles", profile, "t3.token"), "--token-file");
  const config = {
    profile,
    instance,
    model: String(input.model || DEFAULT_MODEL),
    interval: normalizeInterval(input.interval ?? 2000),
    t3Url: requireLoopbackUrl(input.t3Url || DEFAULT_T3_URL, "T3_URL"),
    hermesUrl: requireLoopbackUrl(input.hermesUrl || DEFAULT_HERMES_URL, "HERMES_URL"),
    tokenFile,
    stateFile,
    maxMessages: normalizeMaxMessages(input.maxMessages ?? 10),
    allowAllProjects: input.allowAllProjects === true,
    nodePath: assertAbsolute(input.nodePath || deps.nodePath, "Node path"),
  };
  if (!config.model || config.model.length > 256 || /[\u0000-\u001f]/.test(config.model)) throw new Error("--model is invalid");
  return config;
}

export function renderLaunchAgent(input) {
  const config = normalizeServiceConfig({
    ...input,
    profile: input.profile || DEFAULT_HERMES_PROFILE,
    instance: input.instance || DEFAULT_INSTANCE_ID,
  }, input.deps);
  const label = serviceLabel(config);
  const runtimeCli = assertAbsolute(input.runtimeCli || input.cliPath, "Runtime CLI path");
  const statusFile = assertAbsolute(input.statusFile || servicePaths(config, input.deps).status, "Status file path");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>${LAUNCH_AGENT_OWNER_KEY}</key>
  <string>${LAUNCH_AGENT_OWNER_VALUE}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.nodePath)}</string>
    <string>${escapeXml(runtimeCli)}</string>
    <string>watch</string>
    <string>--profile</string><string>${escapeXml(config.profile)}</string>
    <string>--instance</string><string>${escapeXml(config.instance)}</string>
    <string>--model</string><string>${escapeXml(config.model)}</string>
    <string>--interval</string><string>${config.interval}</string>
    <string>--state-file</string><string>${escapeXml(config.stateFile)}</string>
    <string>--max-messages</string><string>${config.maxMessages}</string>
    <string>--status-file</string><string>${escapeXml(statusFile)}</string>
    ${config.allowAllProjects ? "<string>--allow-all-projects</string>" : ""}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>T3_URL</key><string>${escapeXml(config.t3Url)}</string>
    <key>HERMES_URL</key><string>${escapeXml(config.hermesUrl)}</string>
    <key>T3_HERMES_TOKEN_FILE</key><string>${escapeXml(config.tokenFile)}</string>
    <key>HERMES_PROFILE</key><string>${escapeXml(config.profile)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

// systemd quotes every ExecStart/Environment value itself; no shell is involved.
// We still escape the characters systemd expands (specifiers "%", variables "$")
// and its quoting/escape syntax so values survive verbatim: "%%" and "$$" are
// systemd's documented literal escapes, "\\" and '\"' are C-style escapes valid
// inside double-quoted words, and control characters are rejected outright.
function systemdToken(value, label) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} contains control characters`);
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

export function renderSystemdUnit(input) {
  const config = normalizeServiceConfig({
    ...input,
    profile: input.profile || DEFAULT_HERMES_PROFILE,
    instance: input.instance || DEFAULT_INSTANCE_ID,
  }, input.deps);
  const label = serviceLabel(config);
  const runtimeCli = assertAbsolute(input.runtimeCli || input.cliPath, "Runtime CLI path");
  const statusFile = assertAbsolute(input.statusFile || servicePaths(config, input.deps).status, "Status file path");
  const unitName = `${label}.service`;
  const program = [
    config.nodePath, runtimeCli, "watch",
    "--profile", config.profile,
    "--instance", config.instance,
    "--model", config.model,
    "--interval", String(config.interval),
    "--state-file", config.stateFile,
    "--max-messages", String(config.maxMessages),
    "--status-file", statusFile,
    ...(config.allowAllProjects ? ["--allow-all-projects"] : []),
  ].map((value) => systemdToken(value, "unit argument")).join(" ");
  const environment = [
    `T3_URL=${config.t3Url}`,
    `HERMES_URL=${config.hermesUrl}`,
    `T3_HERMES_TOKEN_FILE=${config.tokenFile}`,
    `HERMES_PROFILE=${config.profile}`,
  ].map((value) => systemdToken(value, "unit environment")).join(" ");
  return `# ${unitName}
# ${LAUNCH_AGENT_OWNER_KEY}: ${LAUNCH_AGENT_OWNER_VALUE}
# Generated by t3-agent-bridge install-service; do not edit by hand.

[Unit]
Description=T3 Agent Bridge watcher for profile ${config.profile} instance ${config.instance}
# launchd has no start-burst limit; disable systemd's default burst stop
# (5 starts / 10s). StartLimit* is only honored in [Unit] since systemd v230.
StartLimitIntervalSec=0
StartLimitBurst=0

[Service]
Type=simple
ExecStart=${program}
Environment=${environment}
# KeepAlive=true (restart regardless of exit status) -> Restart=always
# ThrottleInterval=10 (seconds between relaunches) -> RestartSec=10
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function domain(deps) { return `gui/${deps.uid}`; }

export function parseLaunchctlPrint(output) {
  const text = String(output || "");
  const read = (pattern) => {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const pid = read(/^\s*pid\s*=\s*(\d+)/m);
  return { running: Number.isInteger(pid) && pid > 0, pid, runCount: read(/^\s*runs\s*=\s*(\d+)/m), lastExitCode: read(/^\s*last exit code\s*=\s*(-?\d+)/m) };
}

export function parseSystemctlStatus(output) {
  const text = String(output || "");
  const active = text.match(/^\s*Active:\s*(\S+)(?:\s*\(([^)]+)\))?/m);
  const state = active ? active[1] : null;
  const substate = active ? active[2] || null : null;
  const pidMatch = text.match(/^\s*Main PID:\s*(\d+)/m);
  const pid = pidMatch ? Number(pidMatch[1]) : null;
  const running = state === "active" && Number.isInteger(pid) && pid > 0;
  return { running, pid, state, substate };
}

// Parses `systemctl --user show <unit> --property=LoadState --value`. Unlike
// `systemctl status`, whose exit code reflects the *active* state (a
// loaded-but-inactive unit exits 3), LoadState tells whether systemd knows the
// unit at all, matching launchd's "loaded" meaning on macOS.
export function parseSystemctlLoadState(output, status) {
  return status === 0 && String(output || "").trim() === "loaded";
}

// Parses `systemctl --user show <unit> --property=NRestarts,ExecMainStatus --value`,
// which prints one value per line in property order. runCount maps systemd's
// NRestarts (restarts since the unit was started) onto launchd's "runs" counter;
// lastExitCode maps ExecMainStatus onto launchd's "last exit code".
export function parseSystemctlShow(output) {
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const runCount = /^\d+$/.test(lines[0] || "") ? Number(lines[0]) : null;
  const lastExitCode = /^-?\d+$/.test(lines[1] || "") ? Number(lines[1]) : null;
  return { runCount, lastExitCode };
}

function safeMetadata(pathname, deps, { token = false } = {}) {
  const stat = lstatOrNull(pathname, deps);
  if (!stat) return { exists: false, valid: false };
  const base = { exists: true, regular: stat.isFile(), symlink: stat.isSymbolicLink(), private: (stat.mode & 0o077) === 0, size: stat.size, modifiedAt: stat.mtime.toISOString(), ageSeconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)) };
  const owned = deps.uid === null || stat.uid === deps.uid;
  return { ...base, owned, valid: base.regular && !base.symlink && base.private && owned && (!token || (stat.size >= 16 && stat.size <= MAX_TOKEN_BYTES)) };
}

function readServiceConfig(paths, deps) {
  const metadata = safeMetadata(paths.config, deps);
  if (!metadata.valid) return { metadata, value: null };
  try { return { metadata, value: JSON.parse(deps.fs.readFileSync(paths.config, "utf8")) }; } catch { return { metadata, value: null }; }
}

function legacyMigration(paths, deps) {
  const stat = lstatOrNull(paths.legacyPlist, deps);
  const legacyState = safeMetadata(deps.legacyStateFile, deps);
  if (!stat) return { exists: false, loaded: false, state: { path: deps.legacyStateFile, ...legacyState }, action: legacyState.exists ? "legacy routing state is preserved; pass it explicitly with --state-file when migrating" : "none" };
  let owned = false;
  try { owned = Boolean(assertBridgeOwnedLaunchAgentFile(paths.legacyPlist, { ...deps, label: LAUNCH_AGENT_LABEL, ownerValue: LEGACY_LAUNCH_AGENT_OWNER_VALUE })); } catch {}
  const printed = deps.launchctl.print(`${domain(deps)}/${LAUNCH_AGENT_LABEL}`);
  return { exists: true, owned, loaded: printed.status === 0, state: { path: deps.legacyStateFile, ...legacyState }, action: owned ? "legacy service/state are preserved; install a namespaced service, then remove the legacy job explicitly if desired" : "foreign legacy path preserved" };
}

export function serviceStatus(identity, overrides = {}) {
  const deps = defaultDeps(overrides);
  if (deps.platform === "darwin") return launchAgentStatus(identity, deps);
  if (deps.platform === "linux") return systemdUnitStatus(identity, deps);
  throw new Error(`service-status is unsupported on platform: ${deps.platform} (supported: darwin, linux)`);
}

function launchAgentStatus(identity, deps) {
  const paths = servicePaths(identity, deps);
  const loadedResult = deps.launchctl.print(`${domain(deps)}/${paths.label}`);
  const launchd = loadedResult.status === 0 ? parseLaunchctlPrint(loadedResult.stdout) : { running: false, pid: null, runCount: null, lastExitCode: null };
  const config = readServiceConfig(paths, deps);
  const effective = config.value;
  return {
    label: paths.label,
    profile: paths.profile,
    instance: paths.instance,
    plist: { path: paths.plist, ...safeMetadata(paths.plist, deps) },
    loaded: loadedResult.status === 0,
    ...launchd,
    runtime: effective?.runtime || null,
    config: { path: paths.config, metadata: config.metadata, identity: effective ? { profile: effective.profile, instance: effective.instance, model: effective.model, interval: effective.interval, t3Url: effective.t3Url, hermesUrl: effective.hermesUrl, stateFile: effective.stateFile, maxMessages: effective.maxMessages, allowAllProjects: effective.allowAllProjects === true } : null },
    token: effective ? { path: effective.tokenFile, ...safeMetadata(effective.tokenFile, deps, { token: true }) } : { exists: false, valid: false },
    state: effective ? { path: effective.stateFile, ...safeMetadata(effective.stateFile, deps) } : { exists: false, valid: false },
    heartbeat: { path: paths.status, ...safeMetadata(paths.status, deps) },
    logs: { mode: "structured-status", publicLogFiles: false, statusFile: paths.status },
    migration: legacyMigration(paths, deps),
  };
}

function systemdUnitStatus(identity, deps) {
  const paths = servicePaths(identity, deps);
  const unitName = `${paths.label}.service`;
  const loadResult = deps.systemctl.load(unitName);
  const loaded = parseSystemctlLoadState(loadResult.stdout, loadResult.status);
  const activeResult = deps.systemctl.status(unitName);
  const active = activeResult.status === 0
    ? parseSystemctlStatus(activeResult.stdout)
    : { running: false, pid: null, state: null, substate: null };
  const counters = activeResult.status === 0 ? parseSystemctlShow(deps.systemctl.show(unitName).stdout) : { runCount: null, lastExitCode: null };
  const config = readServiceConfig(paths, deps);
  const effective = config.value;
  return {
    label: paths.label,
    profile: paths.profile,
    instance: paths.instance,
    unit: { path: paths.unit, ...safeMetadata(paths.unit, deps) },
    loaded,
    running: active.running,
    pid: active.pid,
    state: active.state,
    substate: active.substate,
    runCount: counters.runCount,
    lastExitCode: counters.lastExitCode,
    runtime: effective?.runtime || null,
    config: { path: paths.config, metadata: config.metadata, identity: effective ? { profile: effective.profile, instance: effective.instance, model: effective.model, interval: effective.interval, t3Url: effective.t3Url, hermesUrl: effective.hermesUrl, stateFile: effective.stateFile, maxMessages: effective.maxMessages, allowAllProjects: effective.allowAllProjects === true } : null },
    token: effective ? { path: effective.tokenFile, ...safeMetadata(effective.tokenFile, deps, { token: true }) } : { exists: false, valid: false },
    state: effective ? { path: effective.stateFile, ...safeMetadata(effective.stateFile, deps) } : { exists: false, valid: false },
    heartbeat: { path: paths.status, ...safeMetadata(paths.status, deps) },
    logs: { mode: "structured-status", publicLogFiles: false, statusFile: paths.status },
    migration: { exists: false, action: "none" },
  };
}

function stagePlist(plist, content, deps) {
  const temporary = `${plist}.${process.pid}.${crypto.randomUUID()}.tmp`;
  deps.fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  deps.fs.chmodSync(temporary, 0o600);
  assertPrivateRegularFile(temporary, deps);
  if (deps.platform === "darwin") deps.plutilLint(temporary);
  return temporary;
}

function stageSystemdUnit(unit, content, deps) {
  const temporary = `${unit}.${process.pid}.${crypto.randomUUID()}.tmp`;
  deps.fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  deps.fs.chmodSync(temporary, 0o600);
  assertPrivateRegularFile(temporary, deps);
  return temporary;
}

// `systemctl --user enable` creates a symlink in default.target.wants; we manage
// that link explicitly so install/uninstall keep the same ownership posture as
// the unit file itself and never touch a foreign or non-symlink path.
function systemdEnableLink(paths, deps) {
  return path.join(deps.homeDir, SYSTEMD_DEFAULT_TARGET_WANTS, `${paths.label}.service`);
}

function assertSystemdEnableLinkOwned(linkPath, unitPath, deps) {
  const stat = lstatOrNull(linkPath, deps);
  if (!stat) return false;
  if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink enable link: ${linkPath}`);
  const target = deps.fs.readlinkSync(linkPath);
  if (path.resolve(path.dirname(linkPath), target) !== path.resolve(unitPath)) {
    throw new Error(`Refusing to replace enable link not owned by t3-hermes-bridge: ${linkPath}`);
  }
  return true;
}

function createSystemdEnableLink(linkPath, unitPath, deps) {
  ensurePrivateDirectory(path.dirname(linkPath), deps);
  assertPrivateDirectory(path.dirname(linkPath), deps);
  deps.fs.symlinkSync(path.relative(path.dirname(linkPath), unitPath), linkPath);
}

function removeSystemdEnableLink(linkPath, unitPath, deps) {
  if (assertSystemdEnableLinkOwned(linkPath, unitPath, deps)) deps.fs.unlinkSync(linkPath);
}

export function installService(input, overrides = {}) {
  const deps = defaultDeps(overrides);
  if (deps.platform === "darwin") return installLaunchAgent(input, deps);
  if (deps.platform === "linux") return installSystemdUnit(input, deps);
  throw new Error(`install-service is unsupported on platform: ${deps.platform} (supported: darwin, linux)`);
}

function installLaunchAgent(input, deps) {
  const config = normalizeServiceConfig(input, deps);
  if (!config.allowAllProjects) {
    throw new Error("install-service requires an explicit routing policy; pass --allow-all-projects to authorise all non-Hermes T3 projects");
  }
  if (!safeMetadata(config.tokenFile, deps, { token: true }).valid) {
    throw new Error(`Token file is not a private, current-user regular file with a valid size: ${config.tokenFile}`);
  }
  const paths = servicePaths(config, deps);
  ensurePrivateDirectory(paths.supportRoot, deps);
  assertPrivateDirectory(paths.supportRoot, deps);
  ensurePrivateDirectory(path.join(paths.supportRoot, "services"), deps);
  assertPrivateDirectory(path.join(paths.supportRoot, "services"), deps);
  ensurePrivateDirectory(path.dirname(paths.serviceDir), deps);
  assertPrivateDirectory(path.dirname(paths.serviceDir), deps);
  ensurePrivateDirectory(paths.serviceDir, deps);
  assertPrivateDirectory(paths.serviceDir, deps);
  ensurePrivateDirectory(path.dirname(paths.plist), deps);
  assertPrivateDirectory(path.dirname(paths.plist), deps);
  const snapshot = createRuntimeSnapshot({ cliPath: input.cliPath }, deps);
  const effective = { ...config, runtime: snapshot, installedAt: new Date().toISOString() };
  const existing = lstatOrNull(paths.plist, deps);
  const oldContent = existing ? assertBridgeOwnedLaunchAgentFile(paths.plist, { ...deps, label: paths.label }) : null;
  const previousStatus = serviceStatus(config, deps);
  if (previousStatus.loaded && !existing) throw new Error(`Refusing to replace loaded LaunchAgent without an owned plist: ${paths.label}`);
  const content = renderLaunchAgent({ ...config, runtimeCli: snapshot.cliPath, statusFile: paths.status, deps });
  let staged;
  let replaced = false;
  try {
    staged = stagePlist(paths.plist, content, deps);
    if (previousStatus.loaded) deps.launchctl.bootout(domain(deps), paths.plist);
    deps.fs.renameSync(staged, paths.plist);
    staged = null;
    replaced = true;
    deps.fs.chmodSync(paths.plist, 0o600);
    deps.launchctl.bootstrap(domain(deps), paths.plist);
    const verified = serviceStatus(config, deps);
    if (!verified.loaded) throw new Error(`launchctl did not load ${paths.label}`);
    atomicWrite(paths.config, JSON.stringify(effective, null, 2) + "\n", 0o600, deps);
    return serviceStatus(config, deps);
  } catch (error) {
    let rollbackError = null;
    try {
      if (replaced) {
        try { deps.launchctl.bootout(domain(deps), paths.plist); } catch {}
        if (oldContent !== null) {
          atomicWrite(paths.plist, oldContent, 0o600, deps);
          if (previousStatus.loaded) deps.launchctl.bootstrap(domain(deps), paths.plist);
        } else {
          try { deps.fs.unlinkSync(paths.plist); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
        }
      }
    } catch (rollbackFailure) { rollbackError = rollbackFailure; }
    if (rollbackError) throw new Error(`Service install failed (${error.message}); rollback failed (${rollbackError.message})`);
    throw error;
  } finally {
    if (staged) try { deps.fs.unlinkSync(staged); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function installSystemdUnit(input, deps) {
  const config = normalizeServiceConfig(input, deps);
  if (!config.allowAllProjects) {
    throw new Error("install-service requires an explicit routing policy; pass --allow-all-projects to authorise all non-Hermes T3 projects");
  }
  if (!safeMetadata(config.tokenFile, deps, { token: true }).valid) {
    throw new Error(`Token file is not a private, current-user regular file with a valid size: ${config.tokenFile}`);
  }
  const paths = servicePaths(config, deps);
  ensurePrivateDirectory(paths.supportRoot, deps);
  assertPrivateDirectory(paths.supportRoot, deps);
  ensurePrivateDirectory(path.join(paths.supportRoot, "services"), deps);
  assertPrivateDirectory(path.join(paths.supportRoot, "services"), deps);
  ensurePrivateDirectory(path.dirname(paths.serviceDir), deps);
  assertPrivateDirectory(path.dirname(paths.serviceDir), deps);
  ensurePrivateDirectory(paths.serviceDir, deps);
  assertPrivateDirectory(paths.serviceDir, deps);
  ensurePrivateDirectory(path.dirname(paths.unit), deps);
  assertPrivateDirectory(path.dirname(paths.unit), deps);
  const snapshot = createRuntimeSnapshot({ cliPath: input.cliPath }, deps);
  const effective = { ...config, runtime: snapshot, installedAt: new Date().toISOString() };
  const unitName = `${paths.label}.service`;
  const enableLink = systemdEnableLink(paths, deps);
  const existing = lstatOrNull(paths.unit, deps);
  const oldContent = existing ? assertBridgeOwnedSystemdUnitFile(paths.unit, { ...deps, label: paths.label }) : null;
  const wasEnabled = assertSystemdEnableLinkOwned(enableLink, paths.unit, deps);
  const previousStatus = systemdUnitStatus(config, deps);
  if (previousStatus.loaded && !existing) throw new Error(`Refusing to replace loaded systemd unit without an owned unit file: ${paths.label}`);
  const content = renderSystemdUnit({ ...config, runtimeCli: snapshot.cliPath, statusFile: paths.status, deps });
  let staged;
  let replaced = false;
  try {
    staged = stageSystemdUnit(paths.unit, content, deps);
    if (previousStatus.loaded) deps.systemctl.stop(unitName);
    deps.fs.renameSync(staged, paths.unit);
    staged = null;
    replaced = true;
    deps.fs.chmodSync(paths.unit, 0o600);
    deps.systemctl.daemonReload();
    if (!wasEnabled) createSystemdEnableLink(enableLink, paths.unit, deps);
    deps.systemctl.start(unitName);
    const verified = systemdUnitStatus(config, deps);
    if (!verified.loaded) throw new Error(`systemd did not start ${unitName}`);
    atomicWrite(paths.config, JSON.stringify(effective, null, 2) + "\n", 0o600, deps);
    return systemdUnitStatus(config, deps);
  } catch (error) {
    let rollbackError = null;
    try {
      if (replaced) {
        try { deps.systemctl.stop(unitName); } catch {}
        if (oldContent !== null) {
          atomicWrite(paths.unit, oldContent, 0o600, deps);
        } else {
          try { deps.fs.unlinkSync(paths.unit); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
        }
        deps.systemctl.daemonReload();
        if (!wasEnabled) removeSystemdEnableLink(enableLink, paths.unit, deps);
        if (oldContent !== null && previousStatus.loaded) deps.systemctl.start(unitName);
      }
    } catch (rollbackFailure) { rollbackError = rollbackFailure; }
    if (rollbackError) throw new Error(`Service install failed (${error.message}); rollback failed (${rollbackError.message})`);
    throw error;
  } finally {
    if (staged) try { deps.fs.unlinkSync(staged); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function restartService(identity, overrides = {}) {
  const deps = defaultDeps(overrides);
  if (deps.platform === "darwin") return restartLaunchAgent(identity, deps);
  if (deps.platform === "linux") return restartSystemdUnit(identity, deps);
  throw new Error(`restart-service is unsupported on platform: ${deps.platform} (supported: darwin, linux)`);
}

function restartLaunchAgent(identity, deps) {
  const paths = servicePaths(identity, deps);
  assertBridgeOwnedLaunchAgentFile(paths.plist, { ...deps, label: paths.label });
  const status = serviceStatus(identity, deps);
  if (!status.loaded) throw new Error(`LaunchAgent is not loaded: ${paths.label}`);
  deps.launchctl.kickstart(`${domain(deps)}/${paths.label}`);
  return serviceStatus(identity, deps);
}

function restartSystemdUnit(identity, deps) {
  const paths = servicePaths(identity, deps);
  assertBridgeOwnedSystemdUnitFile(paths.unit, { ...deps, label: paths.label });
  const status = systemdUnitStatus(identity, deps);
  if (!status.loaded) throw new Error(`systemd unit is not loaded: ${paths.label}`);
  deps.systemctl.restart(`${paths.label}.service`);
  return systemdUnitStatus(identity, deps);
}

export function uninstallService(identity, overrides = {}) {
  const deps = defaultDeps(overrides);
  if (deps.platform === "darwin") return uninstallLaunchAgent(identity, deps);
  if (deps.platform === "linux") return uninstallSystemdUnit(identity, deps);
  throw new Error(`uninstall-service is unsupported on platform: ${deps.platform} (supported: darwin, linux)`);
}

function uninstallLaunchAgent(identity, deps) {
  const paths = servicePaths(identity, deps);
  const existing = lstatOrNull(paths.plist, deps);
  if (existing) assertBridgeOwnedLaunchAgentFile(paths.plist, { ...deps, label: paths.label });
  const currentStatus = serviceStatus(identity, deps);
  if (currentStatus.loaded && !existing) throw new Error(`Refusing to remove loaded LaunchAgent without an owned plist: ${paths.label}`);
  if (currentStatus.loaded) deps.launchctl.bootout(domain(deps), paths.plist);
  if (existing) deps.fs.unlinkSync(paths.plist);
  // State, token, heartbeat and shared immutable snapshots intentionally remain for recovery/audit.
  return { loaded: false, label: paths.label, plist: paths.plist, removed: currentStatus.loaded || Boolean(existing), preserved: { token: currentStatus.token?.path || null, state: currentStatus.state?.path || null, runtime: currentStatus.runtime?.path || null } };
}

function uninstallSystemdUnit(identity, deps) {
  const paths = servicePaths(identity, deps);
  const unitName = `${paths.label}.service`;
  const enableLink = systemdEnableLink(paths, deps);
  const existing = lstatOrNull(paths.unit, deps);
  if (existing) assertBridgeOwnedSystemdUnitFile(paths.unit, { ...deps, label: paths.label });
  const currentStatus = systemdUnitStatus(identity, deps);
  if (currentStatus.loaded && !existing) throw new Error(`Refusing to remove loaded systemd unit without an owned unit file: ${paths.label}`);
  const wasEnabled = assertSystemdEnableLinkOwned(enableLink, paths.unit, deps);
  if (currentStatus.loaded) deps.systemctl.stop(unitName);
  if (wasEnabled) deps.fs.unlinkSync(enableLink);
  if (existing) deps.fs.unlinkSync(paths.unit);
  // Only reload the user manager when something actually changed, so a no-op
  // uninstall stays silent even if the user bus is unreachable.
  if (existing || wasEnabled || currentStatus.loaded) deps.systemctl.daemonReload();
  // State, token, heartbeat and shared immutable snapshots intentionally remain for recovery/audit.
  return { loaded: false, label: paths.label, unit: paths.unit, removed: currentStatus.loaded || Boolean(existing), preserved: { token: currentStatus.token?.path || null, state: currentStatus.state?.path || null, runtime: currentStatus.runtime?.path || null } };
}
