import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { T3Client } from "../src/t3-client.mjs";
import { doctor as doctorReport } from "../src/bridge.mjs";

// KRA-10852: a brand-new machine runs `tentacles doctor --json` with no token file.
// Synthetic HOME and T3 home only; nothing touches the real ~/.t3 or token file.
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-first-run-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".t3"));
  // PATH holds node only, so a t3 installed beside node on the test host is never found or run.
  fs.mkdirSync(path.join(dir, "path"));
  fs.symlinkSync(process.execPath, path.join(dir, "path", "node"));
  return dir;
}

function doctor(dir, t3Url, args = ["doctor", "--json"]) {
  const tokenFile = path.join(dir, "state", "t3.token");
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: {
      HOME: dir, PATH: path.join(dir, "path"), T3_URL: t3Url, T3_HERMES_TOKEN_FILE: tokenFile,
      TENTACLES_T3_HOME: path.join(dir, ".t3"), HERMES_URL: "http://127.0.0.1:9",
    } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr, tokenFile }));
  });
}

test("doctor --json with no token file and no T3 CLI prints the named code and one-line action, exits 1, issues nothing", async t => {
  const dir = home(t);
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? null);
    response.writeHead(request.url === "/.well-known/t3/environment" ? 404 : 401).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const result = await doctor(dir, `http://127.0.0.1:${server.address().port}`);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.t3.auth.status, "invalid");
  assert.equal(report.t3.auth.code, "t3_reauth_required");
  assert.match(report.t3.auth.action, /^Open T3 Code \(Beta\) once, then run: tentacles reauth --t3-bin '.*\/\.t3\/bin\/t3' /);
  assert.equal(report.t3.auth.action.includes("\n"), false);
  assert.equal(fs.existsSync(result.tokenFile), false, "nothing issued");
  assert.ok(seen.every(header => header === null), "no bearer request was sent");
});

test("doctor --json with no token file and T3 not running prints t3_unreachable JSON and exits 1", async t => {
  const dir = home(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const result = await doctor(dir, `http://127.0.0.1:${port}`);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.t3.reachable, false);
  assert.equal(report.t3.auth.code, "t3_unreachable");
  assert.equal(report.t3.auth.action, "Open T3 Code (Beta), then rerun tentacles doctor.");
  assert.equal(fs.existsSync(result.tokenFile), false);
});

async function closedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function rejectingT3(t) {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/.well-known/t3/environment" ? 404 : 401).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// P2-1: the capabilities contract says labsState "unavailable" when T3 is unreachable or not authorized.
for (const [name, t3Url] of [["T3 down", closedPort], ["a first run with no T3 CLI", rejectingT3]]) {
  test(`capabilities scan reports labsState unavailable and labs null with ${name} (KRA-10852 P2-1)`, async t => {
    const dir = home(t);
    const file = path.join(dir, "state", "capabilities.v1.json");
    const result = await doctor(dir, await t3Url(t), ["capabilities", "scan", "--json", "--capabilities-file", file]);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assert.equal(document.labsState, "unavailable");
    assert.equal(document.labs, null);
    assert.equal(fs.existsSync(result.tokenFile), false, "nothing issued");
  });
}

// P3-3: only ECONNREFUSED means T3 is not running; other network failures keep their error.
for (const [code, unreachable] of [["ECONNREFUSED", true], ["ECONNRESET", false], [undefined, false]]) {
  test(`doctor maps a fetch failure with cause ${code ?? "none"} ${unreachable ? "to t3_unreachable" : "to the existing error"} (KRA-10852 P3-3)`, async t => {
    const dir = home(t);
    const client = new T3Client({ token: "synthetic-bearer-for-network-test", fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), code ? { cause: Object.assign(new Error(code), { code }) } : {});
    } });
    const run = doctorReport(client, { pairStateFile: path.join(dir, "pair.json"), hermesUrl: "http://127.0.0.1:9" });
    if (unreachable) assert.equal((await run).t3.auth.code, "t3_unreachable");
    else await assert.rejects(run, /fetch failed/);
  });
}
