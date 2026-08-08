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
export function launchAgentPath(identity) {
  return identity ? servicePaths(identity).plist : path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
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

function stagePlist(plist, content, deps) {
  const temporary = `${plist}.${process.pid}.${crypto.randomUUID()}.tmp`;
  deps.fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  deps.fs.chmodSync(temporary, 0o600);
  assertPrivateRegularFile(temporary, deps);
  if (deps.platform === "darwin") deps.plutilLint(temporary);
  return temporary;
}

export function installService(input, overrides = {}) {
  const deps = defaultDeps(overrides);
  if (deps.platform !== "darwin") throw new Error("install-service currently supports macOS only");
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

export function restartService(identity, overrides = {}) {
  const deps = defaultDeps(overrides);
  if (deps.platform !== "darwin") throw new Error("restart-service currently supports macOS only");
  const paths = servicePaths(identity, deps);
  assertBridgeOwnedLaunchAgentFile(paths.plist, { ...deps, label: paths.label });
  const status = serviceStatus(identity, deps);
  if (!status.loaded) throw new Error(`LaunchAgent is not loaded: ${paths.label}`);
  deps.launchctl.kickstart(`${domain(deps)}/${paths.label}`);
  return serviceStatus(identity, deps);
}

export function uninstallService(identity, overrides = {}) {
  const deps = defaultDeps(overrides);
  if (deps.platform !== "darwin") throw new Error("uninstall-service currently supports macOS only");
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
