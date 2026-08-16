import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertBridgeOwnedSystemdUnitFile,
  installService,
  launchAgentPath,
  parseSystemctlLoadState,
  parseSystemctlShow,
  parseSystemctlStatus,
  renderSystemdUnit,
  restartService,
  serviceLabel,
  servicePaths,
  serviceStatus,
  uninstallService,
} from "../src/service.mjs";

const cliPath = path.resolve("src/cli.mjs");

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-systemd-hardening-"));
  const tokenFile = path.join(homeDir, "token");
  fs.writeFileSync(tokenFile, "x".repeat(32), { mode: 0o600 });
  const loaded = new Set();   // units known to systemd (LoadState=loaded), running or not
  const running = new Set();  // units currently active (ActiveState=active)
  const calls = [];
  let failStart = 0;
  const systemctl = {
    load(target) {
      return { status: loaded.has(target) ? 0 : 1, stdout: loaded.has(target) ? "loaded\n" : "" };
    },
    status(target) {
      const active = running.has(target);
      return { status: active ? 0 : 3, stdout: active ? `\u25cf ${target}\n   Active: active (running) since Thu 2026-01-01 00:00:00 UTC; 1h ago\n Main PID: 4242 (node)\n` : "" };
    },
    show(target) {
      return { status: running.has(target) ? 0 : 1, stdout: running.has(target) ? "3\n0\n" : "" };
    },
    start(target) {
      calls.push(["start", target]);
      if (failStart > 0) { failStart -= 1; throw new Error("injected start failure"); }
      loaded.add(target);
      running.add(target);
    },
    stop(target) { calls.push(["stop", target]); running.delete(target); },
    restart(target) {
      calls.push(["restart", target]);
      if (!loaded.has(target)) throw new Error("not loaded");
      running.add(target);
    },
    daemonReload() { calls.push(["daemon-reload"]); },
  };
  const deps = { homeDir, platform: "linux", legacyStateFile: path.join(homeDir, "legacy-state.json"), systemctl };
  const config = {
    cliPath,
    profile: "prod.one",
    instance: "hermes-a",
    model: "openai-codex:gpt-5.6-sol",
    interval: 2500,
    t3Url: "http://127.0.0.1:3773",
    hermesUrl: "http://127.0.0.1:8642",
    tokenFile,
    stateFile: path.join(homeDir, "state", "bridge-state.json"),
    maxMessages: 7,
    allowAllProjects: true,
  };
  return {
    homeDir, tokenFile, deps, config, calls,
    markLoaded: (target) => { loaded.add(target); },
    stopUnit: (target) => { running.delete(target); },
    failNextStart: () => { failStart += 1; },
  };
}

function enableLinkPath(setup) {
  return path.join(setup.homeDir, ".config", "systemd", "user", "default.target.wants", `${serviceLabel(setup.config)}.service`);
}

test("systemd unit rendering persists exact non-secret configuration", () => {
  const setup = fixture();
  const unit = renderSystemdUnit({ ...setup.config, runtimeCli: "/opt/t3-hermes/runtime/src/cli.mjs", statusFile: "/private/status.json", deps: setup.deps });
  assert.match(unit, new RegExp(escapeRegExp(serviceLabel(setup.config))));
  for (const value of [setup.config.profile, setup.config.instance, setup.config.model, setup.config.tokenFile, setup.config.stateFile, "http://127.0.0.1:3773", "http://127.0.0.1:8642"]) {
    assert.match(unit, new RegExp(escapeRegExp(value)));
  }
  assert.match(unit, /"watch" "--profile" "prod\.one" "--instance" "hermes-a"/);
  assert.match(unit, /"--max-messages" "7"/);
  assert.match(unit, /"--allow-all-projects"/);
  assert.match(unit, /"--status-file"/);
  assert.match(unit, /Type=simple/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartSec=10/);
  // StartLimit* is only honored in [Unit] (systemd >= 230); pin the placement.
  assert.ok(unit.indexOf("[Unit]") < unit.indexOf("StartLimitIntervalSec=0"));
  assert.ok(unit.indexOf("StartLimitIntervalSec=0") < unit.indexOf("[Service]"));
  assert.match(unit, /StartLimitBurst=0/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Environment="T3_URL=http:\/\/127\.0\.0\.1:3773"/);
  assert.match(unit, /# T3HermesBridgeOwner: t3-hermes-bridge\/v1/);
  assert.doesNotMatch(unit, /Bearer|authorization|x{32}/i);
});

test("systemd rendering escapes specifiers, variables, quotes and rejects control characters", () => {
  const setup = fixture();
  const unit = renderSystemdUnit({
    ...setup.config,
    tokenFile: path.join(setup.homeDir, "My $tuff/100% token"),
    stateFile: path.join(setup.homeDir, 'quo"te/state.json'),
    runtimeCli: "/opt/t3/runtime/src/cli.mjs",
    statusFile: path.join(setup.homeDir, "status.json"),
    deps: setup.deps,
  });
  assert.match(unit, /My \$\$tuff/);
  assert.match(unit, /100%% token/);
  assert.match(unit, /quo\\"te/);
  assert.doesNotMatch(unit, /(^|[^$])\$(?!\$)/);
  assert.doesNotMatch(unit, /(^|[^%])%(?!%)/);
  assert.throws(
    () => renderSystemdUnit({ ...setup.config, stateFile: "/tmp/bad\nstate", deps: setup.deps }),
    /control characters/,
  );
});

test("systemd unit paths are isolated per identity and unsupported platforms fail loud", () => {
  const setup = fixture();
  const a = servicePaths(setup.config, setup.deps);
  const b = servicePaths({ ...setup.config, instance: "hermes-b" }, setup.deps);
  assert.notEqual(a.unit, b.unit);
  assert.notEqual(a.serviceDir, b.serviceDir);
  assert.equal(path.basename(a.unit), `${serviceLabel(setup.config)}.service`);
  assert.ok(a.unit.startsWith(path.join(setup.homeDir, ".config", "systemd", "user")));
  assert.ok(a.serviceDir.startsWith(path.join(setup.homeDir, ".local", "share", "t3-hermes-bridge")));
  assert.throws(() => servicePaths({ ...setup.config, profile: "../escape" }, setup.deps), /filesystem-safe/);
  for (const operation of [installService, restartService, serviceStatus, uninstallService]) {
    assert.throws(() => operation(setup.config, { ...setup.deps, platform: "win32" }), /unsupported on platform: win32/);
  }
  assert.throws(() => servicePaths(setup.config, { ...setup.deps, platform: "win32" }), /unsupported on platform: win32/);
});

test("owned systemd unit checks refuse foreign files and symlinks", () => {
  const setup = fixture();
  const paths = servicePaths(setup.config, setup.deps);
  fs.mkdirSync(path.dirname(paths.unit), { recursive: true });
  fs.writeFileSync(paths.unit, "foreign", { mode: 0o600 });
  assert.throws(() => assertBridgeOwnedSystemdUnitFile(paths.unit, { ...setup.deps, label: paths.label }), /not owned/);
  assert.throws(() => installService(setup.config, setup.deps), /not owned/);
  const link = `${paths.unit}.link`;
  fs.symlinkSync(paths.unit, link);
  assert.throws(() => assertBridgeOwnedSystemdUnitFile(link, { ...setup.deps, label: paths.label }), /must not be a symlink/);
});

test("systemctl parsers report active/inactive/failed states, load state and counters", () => {
  assert.deepEqual(parseSystemctlStatus("\u25cf x.service\n   Active: active (running) since Thu 2026-01-01 00:00:00 UTC; 1h ago\n Main PID: 88 (node)\n"), { running: true, pid: 88, state: "active", substate: "running" });
  assert.deepEqual(parseSystemctlStatus("   Active: inactive (dead)\n"), { running: false, pid: null, state: "inactive", substate: "dead" });
  assert.deepEqual(parseSystemctlStatus("   Active: failed (Result: exit-code)\n"), { running: false, pid: null, state: "failed", substate: "Result: exit-code" });
  assert.deepEqual(parseSystemctlStatus(""), { running: false, pid: null, state: null, substate: null });
  assert.deepEqual(parseSystemctlLoadState("loaded\n", 0), true);
  assert.deepEqual(parseSystemctlLoadState("not-found\n", 0), false);
  assert.deepEqual(parseSystemctlLoadState("", 1), false);
  assert.deepEqual(parseSystemctlShow("3\n0\n"), { runCount: 3, lastExitCode: 0 });
  assert.deepEqual(parseSystemctlShow(""), { runCount: null, lastExitCode: null });
  assert.deepEqual(parseSystemctlShow("junk\n"), { runCount: null, lastExitCode: null });
});

test("install writes the owned unit, enables it, starts it and verifies activation", () => {
  const setup = fixture();
  const status = installService(setup.config, setup.deps);
  const paths = servicePaths(setup.config, setup.deps);
  assert.equal(status.loaded, true);
  assert.equal(status.running, true);
  assert.equal(status.pid, 4242);
  assert.equal(status.runCount, 3);
  assert.equal(status.lastExitCode, 0);
  assert.equal(status.unit.exists, true);
  const unitContent = fs.readFileSync(paths.unit, "utf8");
  assert.equal(assertBridgeOwnedSystemdUnitFile(paths.unit, { ...setup.deps, label: paths.label }), unitContent);
  assert.equal((fs.statSync(paths.unit).mode & 0o077), 0);
  assert.doesNotMatch(unitContent, /x{32}/);
  const link = enableLinkPath(setup);
  assert.equal(fs.readlinkSync(link), path.relative(path.dirname(link), paths.unit));
  assert.ok(setup.calls.some(([name, target]) => name === "start" && target === `${serviceLabel(setup.config)}.service`));
  assert.ok(setup.calls.some(([name]) => name === "daemon-reload"));
});

test("install refuses a foreign or non-symlink enable link", () => {
  const setup = fixture();
  const paths = servicePaths(setup.config, setup.deps);
  const link = enableLinkPath(setup);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(link, "foreign", { mode: 0o600 });
  assert.throws(() => installService(setup.config, setup.deps), /non-symlink enable link/);
  assert.equal(fs.existsSync(paths.unit), false);
  fs.unlinkSync(link);
  fs.symlinkSync("/somewhere/else.service", link);
  assert.throws(() => installService(setup.config, setup.deps), /enable link not owned/);
  assert.equal(fs.existsSync(paths.unit), false);
});

test("install stages then rolls back the old owned unit on activation failure", () => {
  const setup = fixture();
  installService(setup.config, setup.deps);
  const paths = servicePaths(setup.config, setup.deps);
  const oldUnit = fs.readFileSync(paths.unit, "utf8");
  setup.failNextStart();
  assert.throws(() => installService({ ...setup.config, model: "replacement-model" }, setup.deps), /injected start failure/);
  assert.equal(fs.readFileSync(paths.unit, "utf8"), oldUnit);
  assert.equal(serviceStatus(setup.config, setup.deps).loaded, true);
  assert.equal(fs.readdirSync(path.dirname(paths.unit)).some((name) => name.endsWith(".tmp")), false);
});

test("restart and uninstall operate only on the owned namespaced unit and preserve recovery data", () => {
  const setup = fixture();
  installService(setup.config, setup.deps);
  const paths = servicePaths(setup.config, setup.deps);
  fs.mkdirSync(path.dirname(setup.config.stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(setup.config.stateFile, "{}\n", { mode: 0o600 });
  const restarted = restartService(setup.config, setup.deps);
  assert.equal(restarted.running, true);
  assert.ok(setup.calls.some(([name]) => name === "restart"));
  const result = uninstallService(setup.config, setup.deps);
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(paths.unit), false);
  assert.equal(fs.existsSync(enableLinkPath(setup)), false);
  assert.equal(fs.existsSync(setup.tokenFile), true);
  assert.equal(fs.existsSync(setup.config.stateFile), true);
});

test("platform dispatch keeps launchctl and systemctl runners isolated", () => {
  const setup = fixture();
  const poisonedLaunchctl = {
    print() { throw new Error("launchctl must not run on linux"); },
    bootout() { throw new Error("launchctl must not run on linux"); },
    bootstrap() { throw new Error("launchctl must not run on linux"); },
    kickstart() { throw new Error("launchctl must not run on linux"); },
  };
  const installed = installService(setup.config, { ...setup.deps, launchctl: poisonedLaunchctl });
  assert.equal(installed.loaded, true);
  const darwinDeps = {
    homeDir: setup.homeDir,
    platform: "darwin",
    legacyStateFile: setup.deps.legacyStateFile,
    launchctl: { print: () => ({ status: 113, stdout: "" }), bootout() {}, bootstrap() {}, kickstart() {} },
    systemctl: {
      load() { throw new Error("systemctl must not run on darwin"); },
      status() { throw new Error("systemctl must not run on darwin"); },
      show() { throw new Error("systemctl must not run on darwin"); },
      start() { throw new Error("systemctl must not run on darwin"); },
      stop() { throw new Error("systemctl must not run on darwin"); },
      restart() { throw new Error("systemctl must not run on darwin"); },
      daemonReload() { throw new Error("systemctl must not run on darwin"); },
    },
  };
  const darwinStatus = serviceStatus(setup.config, darwinDeps);
  assert.equal(darwinStatus.loaded, false);
  assert.equal(darwinStatus.plist.path, path.join(setup.homeDir, "Library", "LaunchAgents", `${serviceLabel(setup.config)}.plist`));
});
