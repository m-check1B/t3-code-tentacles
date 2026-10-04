import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { test } from "node:test";
import { T3Client, T3AuthError, T3HttpError } from "../src/t3-client.mjs";
import { reauthenticate } from "../src/t3-auth.mjs";
import { doctor, formatDoctor } from "../src/bridge.mjs";
import { applyIntent } from "../src/orchestrate.mjs";

const OLD = "synthetic-expired-bearer-1111";
const NEW = "synthetic-current-bearer-2222";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-auth-test-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "t3.token");
  fs.writeFileSync(tokenFile, OLD, { mode: 0o600 });
  return { dir, tokenFile, t3Bin: process.execPath, t3Home: dir };
}
const rejected = () => new Response(OLD, { status: 401 });

test("rotation reloads the private file once and preserves a dispatched command", async t => {
  const f = fixture(t), calls = [];
  const client = new T3Client({ tokenFile: f.tokenFile, fetchImpl: async (url, init) => {
    calls.push(init);
    if (calls.length === 1) { fs.writeFileSync(f.tokenFile, NEW); return rejected(); }
    return new Response('{"accepted":true}');
  } });
  const command = { type: "thread.archive", commandId: "same-id", threadId: "throwaway" };
  assert.deepEqual(await client.dispatch(command), { accepted: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, `Bearer ${OLD}`);
  assert.equal(calls[1].headers.authorization, `Bearer ${NEW}`);
  assert.equal(calls[0].body, calls[1].body);
});

test("persistent rejection is bounded and never exposes credential/server body", async t => {
  const f = fixture(t); let calls = 0;
  const client = new T3Client({ tokenFile: f.tokenFile, fetchImpl: async () => {
    calls++; fs.writeFileSync(f.tokenFile, calls === 1 ? NEW : "third-synthetic-bearer-3333"); return rejected();
  } });
  await assert.rejects(client.snapshot(), error => error instanceof T3AuthError && error.status === 401 && error.action.includes("tentacles reauth") && !error.message.includes(OLD));
  assert.equal(calls, 2);
});

test("explicit bearer never reloads a file; 500/transport failures never replay", async () => {
  let calls = 0;
  const client = new T3Client({ token: OLD, tokenFile: "/never/read", fetchImpl: async () => { calls++; return rejected(); } });
  await assert.rejects(client.shell(), T3AuthError);
  assert.equal(calls, 1);
  for (const failure of [() => new Response(OLD, { status: 500 }), () => { throw new Error("offline"); }]) {
    calls = 0;
    const c = new T3Client({ token: OLD, fetchImpl: async () => { calls++; return failure(); } });
    await assert.rejects(c.dispatch({ commandId: "same-id" })); assert.equal(calls, 1);
  }
});

test("unsafe rotated token is rejected without sending it", async t => {
  const f = fixture(t); let calls = 0;
  const client = new T3Client({ tokenFile: f.tokenFile, fetchImpl: async () => {
    calls++; fs.chmodSync(f.tokenFile, 0o644); return rejected();
  } });
  await assert.rejects(client.snapshot(), T3AuthError); assert.equal(calls, 1);
});

test("doctor reports invalid auth instead of a ready matrix, including RPC ticket failures", async () => {
  for (const point of ["snapshot", "getSettings"]) {
    const client = { snapshot: async () => ({ threads: [] }), getSettings: async () => ({}) };
    client[point] = async () => { throw new T3HttpError({ method: "GET", pathname: "/api/auth", status: 401, body: OLD }); };
    const result = await doctor(client);
    assert.equal(result.t3.auth.status, "invalid"); assert.deepEqual(result.labs, []);
    assert.match(formatDoctor(result), /re-authentication required/);
    assert.equal(JSON.stringify(result).includes(OLD), false);
  }
});

test("doctor positively reports validated transport credentials", async () => {
  const result = await doctor({ snapshot: async () => ({ threads: [] }), getSettings: async () => ({}), rpc: async () => ({ providers: [] }) }, { fetchImpl: async () => new Response('{}') });
  assert.equal(result.t3.auth.status, "valid");
});

test("no-wait rejection receipt carries a safe auth recovery action", async () => {
  const c = new T3Client({ token: OLD, fetchImpl: async () => rejected() });
  await assert.rejects(applyIntent(c, { action: "thread.rename", threadId: "throwaway", title: "synthetic" }, { wait: false }), error => error.receipt.accepted === false && error.receipt.code === "t3_reauth_required" && error.receipt.action.includes("tentacles reauth"));
});

test("supported issuance stores only a validated private bearer atomically", t => {
  const f = fixture(t);
  const result = reauthenticate({ ...f, spawnImpl: (bin, args, options) => {
    assert.equal(bin, process.execPath); assert.deepEqual(args.slice(0, 3), ["auth", "session", "issue"]);
    assert.ok(args.includes("--token-only")); assert.equal(options.shell, undefined);
    assert.equal(fs.readFileSync(f.tokenFile, "utf8"), OLD);
    return { status: 0, stdout: NEW + "\n", stderr: OLD };
  } });
  assert.deepEqual(result, { authenticated: true, tokenStored: true, mechanism: "t3-auth-session-issue" });
  assert.equal(fs.readFileSync(f.tokenFile, "utf8"), NEW + "\n");
  assert.equal(fs.statSync(f.tokenFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.dir), ["t3.token"]);
});

test("issuer errors, malformed output and concurrent rotation preserve existing credentials", t => {
  for (const result of [{ status: 1, stdout: NEW, stderr: OLD }, { status: 0, stdout: "not a token", stderr: OLD }, { status: null, error: new Error(OLD) }]) {
    const f = fixture(t);
    assert.throws(() => reauthenticate({ ...f, spawnImpl: () => result }), error => !error.message.includes(OLD) && !error.message.includes(NEW));
    assert.equal(fs.readFileSync(f.tokenFile, "utf8"), OLD); assert.deepEqual(fs.readdirSync(f.dir), ["t3.token"]);
  }
  const f = fixture(t);
  assert.throws(() => reauthenticate({ ...f, spawnImpl: () => { fs.unlinkSync(f.tokenFile); fs.writeFileSync(f.tokenFile, NEW, { mode: 0o600 }); return { status: 0, stdout: OLD }; } }), /changed/);
  assert.equal(fs.readFileSync(f.tokenFile, "utf8"), NEW);
});

test("reauth refuses symlinks and broad permissions before issuing anything", t => {
  const f = fixture(t); let issued = false;
  const spawnImpl = () => { issued = true; return { status: 0, stdout: NEW }; };
  fs.chmodSync(f.tokenFile, 0o644);
  assert.throws(() => reauthenticate({ ...f, spawnImpl }));
  fs.unlinkSync(f.tokenFile); fs.symlinkSync(path.join(f.dir, "missing"), f.tokenFile);
  assert.throws(() => reauthenticate({ ...f, spawnImpl })); assert.equal(issued, false);
});

test("doctor CLI emits structured invalid auth and a nonzero exit", async t => {
  const f = fixture(t);
  const server = createServer((req, res) => { res.writeHead(401); res.end(OLD); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  try {
    await promisify(execFile)(process.execPath, ["src/cli.mjs", "doctor", "--json"], { env: { ...process.env, T3_URL: `http://127.0.0.1:${address.port}`, T3_HERMES_TOKEN_FILE: f.tokenFile } });
    assert.fail("expected nonzero exit");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).t3.auth.status, "invalid");
    assert.equal((error.stdout + error.stderr).includes(OLD), false);
  }
});
