import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { publishRelease } from "../scripts/publish-github-release.mjs";

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-publish-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const filename = "tentacles-0.4.1-jack.2.tgz";
  const payload = Buffer.from("synthetic release package");
  const digest = createHash("sha256").update(payload).digest("hex");
  fs.writeFileSync(path.join(cwd, filename), payload);
  fs.writeFileSync(path.join(cwd, `${filename}.sha256`), `${digest}  ${filename}\n`);
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "tentacles", version: "0.4.1-jack.2" }));
  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\nCandidate notes.\n\n## [0.4.1-jack.2] - 2026-10-24\n\nExact release notes.\n\n## [0.4.1]\n\nOlder notes.\n");
  return { cwd, filename, digest, environment: { GITHUB_SERVER_URL: "https://github.com", GITHUB_API_URL: "https://api.github.com", GITHUB_REPOSITORY: "m-check1B/t3-code-tentacles-private", GITHUB_REF_NAME: "v0.4.1-jack.2", BRIDGE_PACKAGE_FILE: filename } };
}

test("publication uses existing gh auth, verifies the existing tag and uploads both checksummed assets with CHANGELOG notes", async (t) => {
  const f = fixture(t);
  const calls = [];
  const result = await publishRelease({ ...f, runGh: async (args, options) => {
    calls.push(args);
    assert.equal(options.cwd, f.cwd);
    const notes = fs.readFileSync(args[args.indexOf("--notes-file") + 1], "utf8");
    assert.match(notes, /Exact release notes/);
    assert.doesNotMatch(notes, /Candidate notes|Older notes/);
  } });
  assert.equal(result.sha256, f.digest);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["release", "create", "v0.4.1-jack.2", f.filename, `${f.filename}.sha256`]);
  assert.equal(calls[0][calls[0].indexOf("--repo") + 1], "https://github.com/m-check1B/t3-code-tentacles-private");
  assert.ok(calls[0].includes("--verify-tag"));
});

test("wrong hosts, repos, tags and traversal fail before gh runs", async (t) => {
  const f = fixture(t);
  for (const overrides of [
    { GITHUB_SERVER_URL: "http://192.168.0.21:3000" }, { GITHUB_SERVER_URL: "https://ocelotnas" },
    { GITHUB_SERVER_URL: "https://github.com.evil.invalid" }, { GITHUB_API_URL: "https://api.github.com.evil.invalid" },
    { GITHUB_REPOSITORY: "matej/t3-code-tentacles" }, { GITHUB_REPOSITORY: "m-check1B/t3-code-tentacles" },
    { GITHUB_REF_NAME: "v0.4.1" }, { BRIDGE_PACKAGE_FILE: "../tentacles-0.4.1-jack.2.tgz" },
    { GH_HOST: "ocelotnas" },
  ]) await assert.rejects(publishRelease({ ...f, environment: { ...f.environment, ...overrides }, runGh: async () => assert.fail("must not publish") }), /configuration/);
});

test("checksum mismatch and missing CHANGELOG entry fail before publication", async (t) => {
  const f = fixture(t);
  const runGh = async () => assert.fail("must not publish");
  fs.writeFileSync(path.join(f.cwd, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\nCandidate notes.\n");
  await assert.rejects(publishRelease({ ...f, runGh }), /CHANGELOG/);
  fs.writeFileSync(path.join(f.cwd, `${f.filename}.sha256`), "wrong");
  await assert.rejects(publishRelease({ ...f, runGh }), /checksum/);
});

test("gh errors are suppressed and temporary notes are removed", async (t) => {
  const f = fixture(t);
  let notesFile;
  await assert.rejects(publishRelease({ ...f, runGh: async (args) => {
    notesFile = args[args.indexOf("--notes-file") + 1];
    throw new Error("synthetic upstream diagnostic");
  } }), error => error.message === "GitHub release publication failed");
  assert.equal(fs.existsSync(notesFile), false);
});

test("the workflow publish command runs end-to-end against a local fake gh only", async (t) => {
  const f = fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fake = path.join(f.cwd, "gh");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync('gh-call.json', JSON.stringify({ args, notes: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') }));\n`, { mode: 0o700 });
  const workflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const command = /run: (node scripts\/publish-github-release\.mjs)/.exec(workflow)?.[1];
  assert.ok(command, "must exercise the workflow's actual publish script");
  const script = new URL(`../${command.slice(5)}`, import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [script.pathname], { cwd: f.cwd, env: { ...f.environment, PATH: f.cwd } });
  const call = JSON.parse(fs.readFileSync(path.join(f.cwd, "gh-call.json"), "utf8"));
  assert.equal(call.args[0], "release");
  assert.equal(call.args[1], "create");
  assert.ok(call.args.includes("--verify-tag"));
  assert.ok(call.args.includes(f.filename));
  assert.ok(call.args.includes(`${f.filename}.sha256`));
  assert.match(call.notes, /Exact release notes/);
  assert.equal(JSON.parse(stdout).sha256, f.digest);
});
