// KRA-8371: the launcher the existing user service runs instead of the version
// tree. It lives in ~/.tentacles/updater (outside the swapped tree), starts
// ~/.tentacles/current, applies updates only through SelfUpdater, and feeds the
// crash guard. It never changes a unit, a permission or a hold it did not add.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EARLY_EXIT_MS, writeAtomic } from "./updater.mjs";

export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
export const FIRST_CHECK_DELAY_MS = 2 * 60_000;

export class Launcher {
  constructor({
    updater, args, spawnImpl = spawn, now = Date.now, pollMs = 2_000,
    checkIntervalMs = AUTO_CHECK_INTERVAL_MS, firstCheckMs = FIRST_CHECK_DELAY_MS, stopGraceMs = 10_000,
  }) {
    this.updater = updater;
    this.args = args;
    this.spawnImpl = spawnImpl;
    this.now = now;
    this.pollMs = pollMs;
    this.checkIntervalMs = checkIntervalMs;
    this.firstCheckMs = firstCheckMs;
    this.stopGraceMs = stopGraceMs;
    this.child = null;
    this.expectedExit = false;
    this.applying = false;
    this.lastRequest = null;
    // In-process restarts for the auto path; Update now / Undo use the request file.
    updater.restart = () => this.restartChild();
  }

  start() {
    const root = fs.realpathSync(this.updater.paths.current);
    // Resolve once per start so a later `current` switch never mixes two trees.
    const bin = path.join(root, "bin", "t3-agent-bridge");
    this.startedAt = this.now();
    this.expectedExit = false;
    this.child = this.spawnImpl(bin, this.args, { stdio: "inherit" });
    return this.child;
  }

  async stopChild() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.expectedExit = true;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), this.stopGraceMs);
    await exited;
    clearTimeout(timer);
  }

  async restartChild() {
    await this.stopChild();
    this.attach(this.start());
  }

  pollRestartRequest() {
    let nonce;
    try { nonce = fs.readFileSync(this.updater.paths.restartRequest, "utf8").trim(); } catch { return false; }
    if (!/^[0-9a-f-]{36}$/.test(nonce) || nonce === this.lastRequest) return false;
    this.lastRequest = nonce;
    return this.restartChild().then(() => writeAtomic(this.updater.paths.restartAck, `${nonce}\n`), () => {});
  }

  async autoCheck() {
    if (this.applying) return;
    this.applying = true;
    try { await this.updater.run({ trigger: "auto" }); } catch { /* reported through events */ }
    finally { this.applying = false; }
  }

  attach(child) {
    child.once("exit", (code, signal) => {
      if (child !== this.child || this.expectedExit) return;
      // A start that dies within a minute counts towards the crash guard.
      if (this.now() - this.startedAt < EARLY_EXIT_MS) this.updater.recordFailedStart();
      this.finish(code ?? (signal ? 1 : 0));
    });
  }

  /** Run until the child exits on its own; the existing service restarts us. */
  run() {
    try { this.lastRequest = fs.readFileSync(this.updater.paths.restartRequest, "utf8").trim(); } catch { this.lastRequest = null; }
    return new Promise((resolve) => {
      const stop = async () => { await this.stopChild(); this.finish(0); };
      this.finish = (code) => {
        clearInterval(this.poller); clearTimeout(this.first); clearInterval(this.checker);
        process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
        resolve(code);
      };
      this.attach(this.start());
      this.poller = setInterval(() => this.pollRestartRequest(), this.pollMs);
      this.first = setTimeout(() => this.autoCheck(), this.firstCheckMs);
      this.checker = setInterval(() => this.autoCheck(), this.checkIntervalMs);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
  }
}
