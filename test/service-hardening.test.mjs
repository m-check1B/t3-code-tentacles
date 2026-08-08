import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertBridgeOwnedLaunchAgentFile,
  installService,
  parseLaunchctlPrint,
  renderLaunchAgent,
  restartService,
  serviceLabel,
  servicePaths,
  serviceStatus,
  uninstallService,
} from "../src/service.mjs";

const cliPath = path.resolve("src/cli.mjs");

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hermes-service-hardening-"));
  const tokenFile = path.join(homeDir, "token");
  fs.writeFileSync(tokenFile, "x".repeat(32), { mode: 0o600 });
  const loaded = new Set();
  const calls = [];
  let failBootstrap = 0;
  const launchctl = {
    print(target) {
      const loadedHere = loaded.has(target);
      return { status: loadedHere ? 0 : 113, stdout: loadedHere ? `\n\tpid = 4242\n\truns = 3\n\tlast exit code = 0\n` : "" };
    },
    bootout(_domain, plist) { calls.push(["bootout", plist]); loaded.delete(`gui/${process.getuid()}/${path.basename(plist, ".plist")}`); },
    bootstrap(_domain, plist) {
      calls.push(["bootstrap", plist]);
      if (failBootstrap > 0) { failBootstrap -= 1; throw new Error("injected bootstrap failure"); }
      loaded.add(`gui/${process.getuid()}/${path.basename(plist, ".plist")}`);
    },
    kickstart(target) { calls.push(["kickstart", target]); if (!loaded.has(target)) throw new Error("not loaded"); },
  };
  const linted = [];
  const deps = { homeDir, platform: "darwin", legacyStateFile: path.join(homeDir, "legacy-state.json"), launchctl, plutilLint: (plist) => linted.push(plist) };
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
  return { homeDir, tokenFile, deps, config, calls, linted, failNextBootstrap: () => { failBootstrap += 1; } };
}

test("LaunchAgent rendering persists exact non-secret configuration", () => {
  const setup = fixture();
  const plist = renderLaunchAgent({ ...setup.config, runtimeCli: "/Applications/T3 Hermes/runtime/src/cli.mjs", statusFile: "/private/status.json", deps: setup.deps });
  assert.match(plist, new RegExp(serviceLabel(setup.config).replaceAll(".", "\\.")));
  for (const value of [setup.config.profile, setup.config.instance, setup.config.model, setup.config.tokenFile, setup.config.stateFile, "http://127.0.0.1:3773", "http://127.0.0.1:8642"]) assert.match(plist, new RegExp(value.replaceAll(".", "\\.")));
  assert.match(plist, /<string>7<\/string>/);
  assert.match(plist, /<string>--allow-all-projects<\/string>/);
  assert.doesNotMatch(plist, /Bearer|authorization|x{32}/i);
});

test("rendered plist passes macOS plutil lint when available", { skip: process.platform !== "darwin" }, () => {
  const setup = fixture();
  const plist = path.join(setup.homeDir, "rendered.plist");
  fs.writeFileSync(plist, renderLaunchAgent({ ...setup.config, runtimeCli: "/opt/t3-hermes/src/cli.mjs", statusFile: path.join(setup.homeDir, "status.json"), deps: setup.deps }), { mode: 0o600 });
  execFileSync("plutil", ["-lint", plist], { stdio: "ignore" });
});

test("CLI documents namespaced service commands and fails closed without identity", () => {
  const help = execFileSync(process.execPath, [cliPath, "help"], { encoding: "utf8" });
  assert.match(help, /restart-service --profile PROFILE --instance INSTANCE/);
  const missing = spawnSync(process.execPath, [cliPath, "service-status"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing required option --profile/);
});

test("profile and instance paths are isolated and reject unsafe identities", () => {
  const setup = fixture();
  const a = servicePaths(setup.config, setup.deps);
  const b = servicePaths({ ...setup.config, instance: "hermes-b" }, setup.deps);
  assert.notEqual(a.plist, b.plist);
  assert.notEqual(a.serviceDir, b.serviceDir);
  assert.throws(() => servicePaths({ ...setup.config, profile: "../escape" }, setup.deps), /filesystem-safe/);
});

test("owned plist checks refuse foreign files and symlinks", () => {
  const setup = fixture();
  const paths = servicePaths(setup.config, setup.deps);
  fs.mkdirSync(path.dirname(paths.plist), { recursive: true });
  fs.writeFileSync(paths.plist, "foreign", { mode: 0o600 });
  assert.throws(() => assertBridgeOwnedLaunchAgentFile(paths.plist, { ...setup.deps, label: paths.label }), /not owned/);
  assert.throws(() => installService(setup.config, setup.deps), /not owned/);
  const link = `${paths.plist}.link`;
  fs.symlinkSync(paths.plist, link);
  assert.throws(() => assertBridgeOwnedLaunchAgentFile(link, { ...setup.deps, label: paths.label }), /must not be a symlink/);
});

test("launchctl parser reports runtime counters when present", () => {
  assert.deepEqual(parseLaunchctlPrint("\n\tpid = 88\n\truns = 14\n\tlast exit code = -9\n"), { running: true, pid: 88, runCount: 14, lastExitCode: -9 });
  assert.deepEqual(parseLaunchctlPrint("service = x"), { running: false, pid: null, runCount: null, lastExitCode: null });
});

test("install stages/lints then rolls back the old owned plist on activation failure", () => {
  const setup = fixture();
  installService(setup.config, setup.deps);
  const paths = servicePaths(setup.config, setup.deps);
  const oldPlist = fs.readFileSync(paths.plist, "utf8");
  setup.failNextBootstrap();
  assert.throws(() => installService({ ...setup.config, model: "replacement-model" }, setup.deps), /injected bootstrap failure/);
  assert.equal(fs.readFileSync(paths.plist, "utf8"), oldPlist);
  assert.equal(serviceStatus(setup.config, setup.deps).loaded, true);
  assert.ok(setup.linted.length >= 2);
  assert.equal(fs.readdirSync(path.dirname(paths.plist)).some((name) => name.endsWith(".tmp")), false);
});

test("restart and uninstall operate only on the owned namespaced job and preserve recovery data", () => {
  const setup = fixture();
  installService(setup.config, setup.deps);
  const paths = servicePaths(setup.config, setup.deps);
  fs.mkdirSync(path.dirname(setup.config.stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(setup.config.stateFile, "{}\n", { mode: 0o600 });
  const restarted = restartService(setup.config, setup.deps);
  assert.equal(restarted.running, true);
  assert.ok(setup.calls.some(([name]) => name === "kickstart"));
  const result = uninstallService(setup.config, setup.deps);
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(paths.plist), false);
  assert.equal(fs.existsSync(setup.tokenFile), true);
  assert.equal(fs.existsSync(setup.config.stateFile), true);
});
