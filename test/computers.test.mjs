import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureForward, forwardArgs, loadComputer, remoteIssueSpawn } from "../src/computers.mjs";
import { reauthenticate } from "../src/t3-auth.mjs";
import { parseArgs } from "../src/cli.mjs";

function registry(t, computers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-computers-test-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "computers.json");
  fs.writeFileSync(file, JSON.stringify({ computers }), { mode: 0o600 });
  return { dir, file };
}

const JUPITER = { ssh: "dev-workers", localPort: 3783, t3Bin: "/home/matej/.local/node/bin/t3", t3Home: "/home/matej/.t3" };

test("a registered computer resolves to a loopback origin and per-computer token and state files", t => {
  const { dir, file } = registry(t, { jupiter: JUPITER });
  const computer = loadComputer("jupiter", { file, stateDir: dir });
  assert.equal(computer.t3Url, "http://127.0.0.1:3783");
  assert.equal(computer.remotePort, 3773);
  assert.equal(computer.tokenFile, path.join(dir, "computers", "jupiter.token"));
  assert.equal(computer.stateFile, path.join(dir, "bridge-state-jupiter.json"));
});

test("unknown computers, option-shaped ssh targets and unsafe paths are rejected", t => {
  const { dir, file } = registry(t, {
    jupiter: JUPITER,
    evil: { ssh: "-oProxyCommand=touch /tmp/x", localPort: 3790 },
    spaced: { ssh: "dev workers", localPort: 3791 },
    lowport: { ssh: "dev-workers", localPort: 22 },
    badbin: { ssh: "dev-workers", localPort: 3792, t3Bin: "t3; rm -rf ~" },
  });
  assert.throws(() => loadComputer("mars", { file, stateDir: dir }), /Unknown computer mars/);
  assert.throws(() => loadComputer("evil", { file, stateDir: dir }), /ssh alias/);
  assert.throws(() => loadComputer("spaced", { file, stateDir: dir }), /ssh alias/);
  assert.throws(() => loadComputer("lowport", { file, stateDir: dir }), /localPort/);
  assert.throws(() => loadComputer("badbin", { file, stateDir: dir }), /t3Bin/);
  assert.throws(() => loadComputer("../x", { file, stateDir: dir }), /lowercase name/);
  assert.throws(() => loadComputer("jupiter", { file: path.join(dir, "missing.json"), stateDir: dir }), /No computers registry/);
});

test("a live forward is reused without spawning ssh", async t => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { dir, file } = registry(t, { jupiter: { ...JUPITER, localPort: server.address().port } });
  const computer = loadComputer("jupiter", { file, stateDir: dir });
  let spawned = 0;
  const result = await ensureForward(computer, { spawnImpl: () => { spawned++; return { status: 0 }; } });
  assert.deepEqual(result, { forward: "reused", localPort: computer.localPort });
  assert.equal(spawned, 0);
});

test("a missing forward starts ssh -f -N -L on loopback and waits for the port", async t => {
  const { dir, file } = registry(t, { jupiter: JUPITER });
  const computer = loadComputer("jupiter", { file, stateDir: dir });
  const calls = [];
  let open = false;
  const result = await ensureForward(computer, {
    probe: async () => open,
    spawnImpl: (command, args) => { calls.push([command, args]); open = true; return { status: 0 }; },
  });
  assert.equal(result.forward, "started");
  assert.deepEqual(calls, [["ssh", forwardArgs(computer)]]);
  assert.ok(calls[0][1].includes("127.0.0.1:3783:127.0.0.1:3773"));
  assert.equal(calls[0][1].at(-1), "dev-workers");
});

test("a failed ssh forward reports the computer without leaking anything else", async t => {
  const { dir, file } = registry(t, { jupiter: JUPITER });
  const computer = loadComputer("jupiter", { file, stateDir: dir });
  await assert.rejects(
    ensureForward(computer, { probe: async () => false, spawnImpl: () => ({ status: 255, stderr: "Permission denied" }) }),
    /Could not open the SSH forward to computer jupiter/,
  );
});

test("remote reauth issues over ssh and stores the bearer 0600 in the computer token file", t => {
  const { dir, file } = registry(t, { jupiter: JUPITER });
  const computer = loadComputer("jupiter", { file, stateDir: dir });
  const calls = [];
  const spawnImpl = remoteIssueSpawn(computer, (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: "synthetic-remote-bearer-4444\n" };
  });
  const result = reauthenticate({ t3Bin: computer.t3Bin, t3Home: computer.t3Home, tokenFile: computer.tokenFile, spawnImpl, remote: true });
  assert.equal(result.mechanism, "t3-auth-session-issue-over-ssh");
  assert.equal(calls[0][0], "ssh");
  assert.deepEqual(calls[0][1].slice(0, 5), ["-o", "BatchMode=yes", "dev-workers", JUPITER.t3Bin, "auth"]);
  assert.ok(calls[0][1].includes(JUPITER.t3Home));
  assert.equal(fs.readFileSync(computer.tokenFile, "utf8"), "synthetic-remote-bearer-4444\n");
  assert.equal(fs.statSync(computer.tokenFile).mode & 0o777, 0o600);
});

test("remote reauth refuses arguments that would need shell quoting on the remote side", t => {
  const { dir, file } = registry(t, { jupiter: JUPITER });
  const computer = loadComputer("jupiter", { file, stateDir: dir });
  const spawnImpl = remoteIssueSpawn(computer, () => ({ status: 0, stdout: "synthetic-remote-bearer-4444\n" }));
  assert.throws(() => spawnImpl(JUPITER.t3Bin, ["--label", "a b"]), /shell quoting/);
  assert.throws(() => spawnImpl("t3", []), /safe absolute path/);
});

test("originate accepts --computer", () => {
  const { options } = parseArgs(["originate", "--computer", "jupiter", "--workspace", "/home/matej/Developer-artifacts"]);
  assert.equal(options.computer, "jupiter");
});
