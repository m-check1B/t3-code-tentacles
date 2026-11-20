import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { test } from "node:test";
import { T3Client, T3AuthError } from "../src/t3-client.mjs";
import { createAutoReauth, reauthenticate, resolveT3Bin } from "../src/t3-auth.mjs";

// Synthetic T3 homes only: nothing here reads or issues against the real ~/.t3.
const OLD = "synthetic-expired-bearer-1111";
const NEW = "synthetic-current-bearer-2222";
const tokens = text => [OLD, NEW].filter(token => String(text).includes(token));

function fixture(t, versions = ["0.0.46"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-auto-reauth-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const tokenFile = path.join(state, "t3.token");
  fs.writeFileSync(tokenFile, OLD, { mode: 0o600 });
  const t3Home = path.join(dir, "t3home");
  for (const version of versions) addBin(t3Home, version);
  return { dir, tokenFile, t3Home };
}

function addBin(t3Home, version, { mode = 0o755, body = `#!/bin/sh\necho ${NEW}\n` } = {}) {
  const directory = path.join(t3Home, "runtime", "versions", version);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "t3"), body, { mode });
  return path.join(directory, "t3");
}

function harness(t, { versions, responses }) {
  const f = fixture(t, versions);
  const spawned = [], logs = [], calls = [];
  const reauth = createAutoReauth({
    env: { PATH: "" }, t3Home: f.t3Home, log: line => logs.push(line),
    spawnImpl: (bin, args) => { spawned.push({ bin, args }); return { status: 0, stdout: `${NEW}\n`, stderr: OLD }; },
  });
  const client = new T3Client({ orchestrationProtocol: 1, tokenFile: f.tokenFile, reauth, fetchImpl: async (url, init) => {
    calls.push(init);
    return responses(init);
  } });
  return { ...f, client, spawned, logs, calls };
}

const byBearer = init => init.headers.authorization === `Bearer ${NEW}` ? new Response('{"accepted":true}') : new Response(OLD, { status: 401 });

test("401 reauthenticates through the newest colocated T3 CLI and retries the command once", async t => {
  const h = harness(t, { versions: ["0.0.42", "0.0.46"], responses: byBearer });
  const command = { type: "thread.archive", commandId: "same-id", threadId: "throwaway" };
  assert.deepEqual(await h.client.dispatch(command), { accepted: true });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].body, h.calls[1].body);
  assert.equal(h.calls[1].headers.authorization, `Bearer ${NEW}`);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].bin, fs.realpathSync(path.join(h.t3Home, "runtime", "versions", "0.0.46", "t3")));
  assert.deepEqual(h.spawned[0].args.slice(0, 5), ["auth", "session", "issue", "--base-dir", h.t3Home]);
  assert.equal(fs.readFileSync(h.tokenFile, "utf8"), `${NEW}\n`);
  assert.equal(h.logs.length, 1);
  assert.deepEqual(tokens(h.logs.join("\n")), []);
});

test("a second 401 after reauth fails with the exact manual command and no further issuance", async t => {
  const h = harness(t, { responses: () => new Response(OLD, { status: 401 }) });
  const bin = fs.realpathSync(path.join(h.t3Home, "runtime", "versions", "0.0.46", "t3"));
  await assert.rejects(h.client.snapshot(), error => {
    assert.ok(error instanceof T3AuthError);
    assert.equal(error.action, `tentacles reauth --t3-bin '${bin}' --t3-home '${h.t3Home}' --token-file '${h.tokenFile}'`);
    assert.match(error.message, /A newly issued session was also rejected/);
    assert.ok(error.message.includes(error.action));
    assert.deepEqual(tokens(error.message + JSON.stringify(error)), []);
    return true;
  });
  assert.equal(h.calls.length, 2);
  // An operator rotation retried after the shared attempt is reported as such (PR 40 P3-3).
  fs.writeFileSync(h.tokenFile, "synthetic-operator-bearer-3333\n", { mode: 0o600 });
  await assert.rejects(h.client.snapshot(), error => error instanceof T3AuthError
    && /The replaced bearer in the token file was also rejected/.test(error.message) && !/newly issued/.test(error.message));
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[3].headers.authorization, "Bearer synthetic-operator-bearer-3333");
  assert.equal(h.spawned.length, 1, "a client never issues a second session");
  assert.deepEqual(tokens(h.logs.join("\n")), []);
});

test("concurrent 401s share one issuance", async t => {
  const h = harness(t, { responses: byBearer });
  const results = await Promise.all([h.client.snapshot(), h.client.snapshot(), h.client.snapshot()]);
  assert.deepEqual(results, Array(3).fill({ accepted: true }));
  assert.equal(h.spawned.length, 1);
});

test("no T3 CLI found fails closed without issuing and names the T3 home", async t => {
  const h = harness(t, { versions: [], responses: byBearer });
  await assert.rejects(h.client.snapshot(), error => {
    assert.ok(error instanceof T3AuthError);
    assert.match(error.message, /found no executable T3 CLI/);
    assert.ok(error.message.includes(path.join(h.t3Home, "bin")), "names the stock launcher directory");
    assert.match(error.message, /open T3 Code \(Beta\) once/);
    assert.equal(error.action, `Open T3 Code (Beta) once, then run: tentacles reauth --t3-bin '${path.join(h.t3Home, "bin", "t3")}' --t3-home '${h.t3Home}' --token-file '${h.tokenFile}'`);
    assert.deepEqual(tokens(error.message), []);
    return true;
  });
  assert.equal(h.spawned.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(fs.readFileSync(h.tokenFile, "utf8"), OLD);
});

test("failed issuance preserves the bearer and reports the resolved manual command", async t => {
  const f = fixture(t);
  const reauth = createAutoReauth({ env: { PATH: "" }, t3Home: f.t3Home, log: () => assert.fail("no success log"),
    spawnImpl: () => ({ status: 1, stdout: NEW, stderr: OLD }) });
  let calls = 0;
  const client = new T3Client({ orchestrationProtocol: 1, tokenFile: f.tokenFile, reauth, fetchImpl: async () => { calls++; return new Response(OLD, { status: 401 }); } });
  await assert.rejects(client.snapshot(), error => /Automatic reauthentication failed: T3 session issuance failed/.test(error.message)
    && error.action.includes(`--t3-bin '${fs.realpathSync(path.join(f.t3Home, "runtime", "versions", "0.0.46", "t3"))}'`) && tokens(error.message).length === 0);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.tokenFile, "utf8"), OLD);
});

test("version ordering is semantic: newest release, prereleases below it, junk and non-executables ignored", t => {
  const f = fixture(t, ["0.0.9", "0.0.10", "0.0.46-nightly.20261003.2610", "0.0.46", "not-a-version", "0.1.0-beta.2", "0.1.0-beta.10"]);
  addBin(f.t3Home, "1.0.0", { mode: 0o644 });
  const pick = () => path.basename(path.dirname(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" })));
  assert.equal(pick(), "0.1.0-beta.10");
  fs.rmSync(path.join(f.t3Home, "runtime", "versions", "0.1.0-beta.10"), { recursive: true });
  fs.rmSync(path.join(f.t3Home, "runtime", "versions", "0.1.0-beta.2"), { recursive: true });
  assert.equal(pick(), "0.0.46");
  fs.rmSync(path.join(f.t3Home, "runtime", "versions", "0.0.46"), { recursive: true });
  assert.equal(pick(), "0.0.46-nightly.20261003.2610");
});

test("symlinks escaping the T3 home are ignored; explicit and PATH binaries win in order", t => {
  const f = fixture(t, ["0.0.40"]);
  const outside = path.join(f.dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "t3"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(f.t3Home, "runtime", "versions", "9.9.9"));
  fs.symlinkSync(path.join(outside, "t3"), path.join(f.t3Home, "runtime", "versions", "9.9.9", "t3"));
  fs.symlinkSync(outside, path.join(f.t3Home, "runtime", "versions", "9.9.8"));
  const inHome = fs.realpathSync(path.join(f.t3Home, "runtime", "versions", "0.0.40", "t3"));
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" }), inHome);
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: outside }), fs.realpathSync(path.join(outside, "t3")));
  assert.equal(resolveT3Bin({ t3Bin: inHome, t3Home: f.t3Home, pathEnv: outside }), inHome);
  assert.equal(resolveT3Bin({ t3Bin: path.join(f.dir, "missing"), t3Home: f.t3Home, pathEnv: outside }), null, "a bad explicit path never falls through");
});

test("a home symlink resolves to the checked real path, which is what runs (PR 40 P3-1)", t => {
  const f = fixture(t, ["0.0.40"]);
  fs.mkdirSync(path.join(f.t3Home, "runtime", "versions", "0.0.50"));
  const link = path.join(f.t3Home, "runtime", "versions", "0.0.50", "t3");
  fs.symlinkSync(path.join(f.t3Home, "runtime", "versions", "0.0.40", "t3"), link);
  const resolved = resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" });
  assert.equal(resolved, fs.realpathSync(path.join(f.t3Home, "runtime", "versions", "0.0.40", "t3")));
  assert.notEqual(resolved, link);
  const spawned = [];
  const reauth = createAutoReauth({ env: { PATH: "" }, t3Home: f.t3Home, log: () => {},
    spawnImpl: bin => { spawned.push(bin); return { status: 0, stdout: `${NEW}\n` }; } });
  reauth({ tokenFile: f.tokenFile });
  assert.deepEqual(spawned, [resolved]);
});

test("an invalid explicit TENTACLES_T3_BIN is named as rejected and kept in the manual command (PR 40 P3-4)", t => {
  const f = fixture(t);
  for (const [t3Bin, why] of [["relative/t3", "not an absolute path"], [path.join(f.dir, "missing"), "not an executable file"]]) {
    const reauth = createAutoReauth({ env: { PATH: "" }, t3Bin, t3Home: f.t3Home, log: () => assert.fail("no success log"),
      spawnImpl: () => assert.fail("never issues") });
    assert.throws(() => reauth({ tokenFile: f.tokenFile }), error => {
      assert.equal(error.message, `automatic reauthentication rejected TENTACLES_T3_BIN ${t3Bin}: ${why}`);
      assert.ok(error.action.startsWith(`tentacles reauth --t3-bin '${t3Bin}' --t3-home`));
      assert.ok(!error.action.includes("command -v"));
      return true;
    });
  }
  assert.equal(fs.readFileSync(f.tokenFile, "utf8"), OLD);
});

test("opt-out disables automatic reauthentication", async t => {
  for (const value of ["0", "false", "off", "no", "OFF"]) assert.equal(createAutoReauth({ env: { TENTACLES_T3_AUTO_REAUTH: value } }), null);
  assert.equal(typeof createAutoReauth({ env: { PATH: "" }, t3Home: "/nonexistent" }), "function");
  const f = fixture(t);
  let calls = 0;
  const client = new T3Client({ orchestrationProtocol: 1, tokenFile: f.tokenFile, reauth: createAutoReauth({ env: { TENTACLES_T3_AUTO_REAUTH: "0" } }),
    fetchImpl: async () => { calls++; return new Response(OLD, { status: 401 }); } });
  await assert.rejects(client.snapshot(), error => error instanceof T3AuthError && error.action.includes('"$(command -v t3)"'));
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.tokenFile, "utf8"), OLD);
});

test("CLI doctor reauthenticates through a synthetic T3 home and never prints a bearer", async t => {
  const f = fixture(t, []);
  const marker = path.join(f.dir, "issued");
  const bin = addBin(f.t3Home, "0.0.46", { body: `#!/bin/sh\necho "$@" > '${marker}'\necho ${NEW}\n` });
  const real = fs.realpathSync(bin);
  // The environment descriptor is public in T3; every authenticated route rejects.
  const server = createServer((req, res) => { res.writeHead(req.url.startsWith("/.well-known/") ? 404 : 401); res.end(OLD); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = { ...process.env, PATH: "", T3_URL: `http://127.0.0.1:${server.address().port}`, T3_HERMES_TOKEN_FILE: f.tokenFile, TENTACLES_T3_HOME: f.t3Home };
  delete env.TENTACLES_T3_BIN; delete env.TENTACLES_T3_AUTO_REAUTH;
  try {
    await promisify(execFile)(process.execPath, ["src/cli.mjs", "doctor", "--json"], { env });
    assert.fail("expected nonzero exit");
  } catch (error) {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.t3.auth.status, "invalid");
    assert.ok(report.t3.auth.action.startsWith(`tentacles reauth --t3-bin '${real}' --t3-home '${f.t3Home}'`));
    assert.match(error.stderr, /issued a new session with/);
    assert.deepEqual(tokens(error.stdout + error.stderr), []);
  }
  assert.match(fs.readFileSync(marker, "utf8"), /^auth session issue --base-dir /);
  assert.equal(fs.readFileSync(f.tokenFile, "utf8"), `${NEW}\n`);
});

// KRA-10852: stock T3 Code (Beta) v0.1.11 writes its CLI launcher to <T3 home>/bin/t3
// (bin/t3.cmd on Windows) and has no runtime/versions directory.
function addLauncher(t3Home, name = "t3", mode = 0o755) {
  fs.mkdirSync(path.join(t3Home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(t3Home, "bin", name), `#!/bin/sh\necho ${NEW}\n`, { mode });
  return fs.realpathSync(path.join(t3Home, "bin", name));
}

test("a fresh stock T3 home with only bin/t3 reauthenticates on 401 with no flag (KRA-10852)", async t => {
  const h = harness(t, { versions: [], responses: byBearer });
  const launcher = addLauncher(h.t3Home);
  assert.equal(resolveT3Bin({ t3Home: h.t3Home, pathEnv: "" }), launcher);
  assert.deepEqual(await h.client.snapshot(), { accepted: true });
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].bin, launcher);
  assert.deepEqual(h.spawned[0].args.slice(0, 5), ["auth", "session", "issue", "--base-dir", h.t3Home]);
  assert.equal(fs.readFileSync(h.tokenFile, "utf8"), `${NEW}\n`);
  assert.deepEqual(tokens(h.logs.join("\n")), []);
});

test("runtime/versions keeps priority over bin/t3; PATH and an explicit flag win over both (KRA-10852)", t => {
  const f = fixture(t, ["0.0.46"]);
  const launcher = addLauncher(f.t3Home);
  const versioned = fs.realpathSync(path.join(f.t3Home, "runtime", "versions", "0.0.46", "t3"));
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" }), versioned);
  const onPath = path.join(f.dir, "onpath");
  fs.mkdirSync(onPath);
  fs.writeFileSync(path.join(onPath, "t3"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: onPath }), fs.realpathSync(path.join(onPath, "t3")));
  assert.equal(resolveT3Bin({ t3Bin: launcher, t3Home: f.t3Home, pathEnv: onPath }), launcher);
  fs.rmSync(path.join(f.t3Home, "runtime"), { recursive: true });
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" }), launcher);
});

test("bin/t3 that is not executable or escapes the T3 home is ignored; Windows looks for bin/t3.cmd (KRA-10852)", t => {
  const f = fixture(t, []);
  fs.mkdirSync(f.t3Home);
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" }), null, "an empty fresh home finds nothing");
  addLauncher(f.t3Home, "t3", 0o644);
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" }), null);
  fs.rmSync(path.join(f.t3Home, "bin", "t3"));
  const outside = path.join(f.dir, "outside-t3");
  fs.writeFileSync(outside, "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(outside, path.join(f.t3Home, "bin", "t3"));
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "" }), null);
  const cmd = addLauncher(f.t3Home, "t3.cmd");
  assert.equal(resolveT3Bin({ t3Home: f.t3Home, pathEnv: "", platform: "win32" }), cmd);
});

// KRA-10852: a brand-new machine has no token file at all; the first request issues one.
function firstRun(t, { launcher = true, tokenFile: state = "missing", serve } = {}) {
  const h = harness(t, { versions: [], responses: serve ?? byBearer });
  fs.rmSync(h.tokenFile);
  if (state === "empty") fs.writeFileSync(h.tokenFile, "", { mode: 0o600 });
  if (launcher) addLauncher(h.t3Home);
  else fs.mkdirSync(h.t3Home, { recursive: true });
  const reauth = createAutoReauth({ env: { PATH: "" }, t3Home: h.t3Home, log: line => h.logs.push(line),
    spawnImpl: (bin, args) => { h.spawned.push({ bin, args }); return { status: 0, stdout: `${NEW}\n`, stderr: OLD }; } });
  const client = new T3Client({ orchestrationProtocol: 1, tokenFile: h.tokenFile, reauth,
    fetchImpl: async (url, init) => { h.calls.push(init); return (serve ?? byBearer)(init); } });
  return { ...h, client };
}

for (const state of ["missing", "empty"]) {
  test(`${state} token file + launcher: the first request issues a session once and signs in with no flag (KRA-10852)`, async t => {
    const h = firstRun(t, { tokenFile: state });
    const results = await Promise.all([h.client.snapshot(), h.client.snapshot()]);
    assert.deepEqual(results, [{ accepted: true }, { accepted: true }]);
    assert.equal(h.spawned.length, 1, "concurrent first requests share one issuance");
    assert.equal(h.spawned[0].bin, fs.realpathSync(path.join(h.t3Home, "bin", "t3")));
    assert.ok(h.calls.every(init => init.headers.authorization === `Bearer ${NEW}`), "no request goes out without a bearer");
    assert.equal(fs.readFileSync(h.tokenFile, "utf8"), `${NEW}\n`);
    assert.equal(fs.statSync(h.tokenFile).mode & 0o777, 0o600);
    assert.deepEqual(tokens(h.logs.join("\n")), []);
    assert.deepEqual(h.logs, [`Tentacles: no T3 bearer yet; issued a new session with ${h.spawned[0].bin}`], "no request was sent, so no 401 is claimed");
  });
}

test("missing token file + no launcher: named code and one-line action, nothing issued, no request sent (KRA-10852)", async t => {
  const h = firstRun(t, { launcher: false });
  await assert.rejects(h.client.snapshot(), error => {
    assert.ok(error instanceof T3AuthError);
    assert.equal(error.code, "t3_reauth_required");
    assert.match(error.message, /^No T3 bearer yet \(token file missing or empty: /);
    assert.match(error.action, /^Open T3 Code \(Beta\) once, then run: tentacles reauth --t3-bin '[^']*\/bin\/t3' /);
    assert.equal(error.action.includes("\n"), false);
    assert.deepEqual(tokens(`${error.message} ${error.action}`), []);
    return true;
  });
  assert.equal(h.spawned.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(h.tokenFile), false);
});

test("an existing valid token file is used as-is and never re-issued (KRA-10852)", async t => {
  const h = harness(t, { versions: [], responses: () => new Response('{"accepted":true}') });
  addLauncher(h.t3Home);
  assert.deepEqual(await h.client.snapshot(), { accepted: true });
  assert.equal(h.spawned.length, 0);
  assert.equal(h.calls[0].headers.authorization, `Bearer ${OLD}`);
  assert.equal(fs.readFileSync(h.tokenFile, "utf8"), OLD);
});

test("without a reauth hook a missing or empty token file still fails in the constructor (KRA-10852)", t => {
  const f = fixture(t, []);
  fs.rmSync(f.tokenFile);
  assert.throws(() => new T3Client({ tokenFile: f.tokenFile }), /T3 bearer token file is missing/);
  fs.writeFileSync(f.tokenFile, "", { mode: 0o600 });
  assert.throws(() => new T3Client({ tokenFile: f.tokenFile }), /size is outside the accepted range/);
  fs.rmSync(f.tokenFile);
  const target = path.join(f.dir, "empty-target");
  fs.writeFileSync(target, "", { mode: 0o600 });
  fs.symlinkSync(target, f.tokenFile);
  assert.throws(() => new T3Client({ tokenFile: f.tokenFile, reauth: () => assert.fail("never") }), /must not be a symlink/, "a symlinked token file is never a first run");
});

test("a 401 reissue still logs the 401 (KRA-10852 P3-2)", async t => {
  const h = harness(t, { versions: [], responses: byBearer });
  addLauncher(h.t3Home);
  await h.client.snapshot();
  assert.deepEqual(h.logs, [`Tentacles: T3 rejected the bearer (401); issued a new session with ${h.spawned[0].bin}`]);
});

test("Windows: the bin\\t3.cmd launcher is named as unsupported, never offered or spawned (KRA-10852 P3-1)", async t => {
  const h = harness(t, { versions: [], responses: byBearer });
  const cmd = addLauncher(h.t3Home, "t3.cmd");
  const reauth = createAutoReauth({ env: { PATH: "" }, t3Home: h.t3Home, platform: "win32", log: line => h.logs.push(line),
    spawnImpl: () => assert.fail("a .cmd is never spawned") });
  assert.throws(() => reauth({ tokenFile: h.tokenFile }), error => {
    assert.match(error.message, /found .*t3\.cmd, but Windows is not supported yet: the T3 Code \(Beta\) CLI there is a \.cmd launcher/);
    assert.equal(error.action, "Windows is not supported yet: the T3 Code (Beta) CLI there is a .cmd launcher that Tentacles cannot run; run Tentacles on macOS or Linux.");
    return true;
  });
  fs.rmSync(cmd);
  assert.throws(() => reauth({ tokenFile: h.tokenFile }), error => /^Windows is not supported yet/.test(error.action), "nothing found on Windows offers no reauth command");
  assert.throws(() => reauthenticate({ t3Bin: cmd, t3Home: h.t3Home, tokenFile: h.tokenFile, platform: "win32", spawnImpl: () => assert.fail("never") }),
    /Windows is not supported yet/);
  assert.equal(fs.readFileSync(h.tokenFile, "utf8"), OLD);
});
