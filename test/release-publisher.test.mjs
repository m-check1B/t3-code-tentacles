import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { publishRelease } from "../scripts/publish-github-release.mjs";
import { PINNED_PUBLIC_KEYS, MANIFEST_TAG, MANIFEST_ASSET } from "../src/updater/pinned.mjs";
import { ephemeralKey } from "./helpers/self-update-fixtures.mjs";

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

test("tgz plus sha256 with shipped pins publishes and reports the gate skipped", async (t) => {
  const f = fixture(t);
  const messages = [];
  let calls = 0;
  assert.equal(PINNED_PUBLIC_KEYS.length, 2);
  await publishRelease({ ...f, log: message => messages.push(message), runGh: async () => { calls += 1; } });
  assert.equal(calls, 1);
  assert.deepEqual(messages, ["pinned-keys gate: skipped, release publishes no signed manifest, feed or signature (KRA-8371)"]);
});

test("tgz plus sha256 with explicit empty keys still skips the gate", async (t) => {
  const f = fixture(t);
  const messages = [];
  let calls = 0;
  await publishRelease({ ...f, publicKeys: [], log: message => messages.push(message), runGh: async () => { calls += 1; } });
  assert.equal(calls, 1);
  assert.deepEqual(messages, ["pinned-keys gate: skipped, release publishes no signed manifest, feed or signature (KRA-8371)"]);
});

test("every extra manifest, feed, signature or unknown asset with empty keys is refused before gh", async (t) => {
  const f = fixture(t);
  for (const extra of [MANIFEST_ASSET, `${f.filename}.sig`, `${f.filename}.sign`, `${f.filename}.minisig`, `${f.filename}.asc`, "latest.yml", "self-update.json", "unknown.bin"]) {
    await t.test(extra, async () => {
      fs.writeFileSync(path.join(f.cwd, extra), "synthetic extra asset");
      let calls = 0;
      await assert.rejects(publishRelease({ ...f, publicKeys: [], assets: [f.filename, `${f.filename}.sha256`, extra],
        log: () => {}, runGh: async () => { calls += 1; } }), /two pinned Ed25519 public keys/);
      assert.equal(calls, 0);
    });
  }
});

test("the manifest tag with empty keys is refused even with only tgz plus sha256", async (t) => {
  const f = fixture(t);
  await assert.rejects(publishRelease({ ...f, publicKeys: [], environment: { ...f.environment, GITHUB_REF_NAME: MANIFEST_TAG },
    log: () => {}, runGh: async () => assert.fail("must refuse before gh") }), /two pinned Ed25519 public keys/);
});

test("shipped pins allow the publisher's manifest gate using only a fake gh", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, MANIFEST_ASSET), "synthetic manifest");
  const assets = [f.filename, `${f.filename}.sha256`, MANIFEST_ASSET];
  const messages = [];
  let calls = 0;
  await publishRelease({ ...f, environment: { ...f.environment, GITHUB_REF_NAME: MANIFEST_TAG }, assets,
    log: message => messages.push(message), runGh: async args => {
      calls += 1;
      assert.deepEqual(args.slice(0, 6), ["release", "create", MANIFEST_TAG, ...assets]);
    } });
  assert.equal(calls, 1);
  assert.deepEqual(messages, ["pinned-keys gate: required, 2 configured (KRA-8371)"]);
});

test("two valid distinct keys allow manifest publication with exactly the checked assets", async (t) => {
  const f = fixture(t);
  const publicKeys = [ephemeralKey().raw, ephemeralKey().raw];
  fs.writeFileSync(path.join(f.cwd, MANIFEST_ASSET), "synthetic manifest");
  let calls = 0;
  for (const tag of [f.environment.GITHUB_REF_NAME, MANIFEST_TAG]) {
    const assets = [f.filename, `${f.filename}.sha256`, MANIFEST_ASSET];
    const checkedAssets = [...assets];
    const messages = [];
    await publishRelease({ ...f, environment: { ...f.environment, GITHUB_REF_NAME: tag }, assets, publicKeys,
      log: message => { messages.push(message); assets.push("unchecked.sig"); }, runGh: async args => {
        calls += 1;
        assert.deepEqual(args.slice(0, 6), ["release", "create", tag, ...checkedAssets]);
        assert.equal(args.includes("unchecked.sig"), false);
      } });
    assert.deepEqual(messages, ["pinned-keys gate: required, 2 configured (KRA-8371)"]);
  }
  assert.equal(calls, 2);
});

test("extra assets still require exactly two valid distinct keys", async (t) => {
  const f = fixture(t);
  const key = ephemeralKey().raw;
  for (const publicKeys of [[key], [key, key], [key, "bm90LWEta2V5"]]) {
    let calls = 0;
    await assert.rejects(publishRelease({ ...f, assets: [f.filename, `${f.filename}.sha256`, MANIFEST_ASSET], publicKeys,
      log: () => {}, runGh: async () => { calls += 1; } }));
    assert.equal(calls, 0);
  }
});

test("asset names cannot inject gh options, labels or paths even with valid keys", async (t) => {
  const f = fixture(t);
  const publicKeys = [ephemeralKey().raw, ephemeralKey().raw];
  for (const asset of ["--notes-file", "../manifest.json", "manifest.json#label", "subdir/manifest.json"]) {
    let calls = 0;
    await assert.rejects(publishRelease({ ...f, assets: [f.filename, `${f.filename}.sha256`, asset], publicKeys,
      log: () => {}, runGh: async () => { calls += 1; } }), /Invalid release assets/);
    assert.equal(calls, 0);
  }
});

test("the workflow gate checks the publisher's packed asset plan and reports skipped without gh", async (t) => {
  const f = fixture(t);
  const { execFileSync } = await import("node:child_process");
  const workflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const command = /run: (node scripts\/publish-github-release\.mjs --check-pinned-keys)\s*$/m.exec(workflow)?.[1];
  assert.ok(command, "workflow must check the publisher's actual asset plan");
  assert.ok(workflow.indexOf(command) > workflow.indexOf("package_file=$(npm pack --silent)"));
  assert.doesNotMatch(workflow, /run: node scripts\/release\/assert-pinned-keys\.mjs/);
  assert.match(workflow.slice(0, workflow.indexOf(command)), /BRIDGE_PACKAGE_FILE: \$\{\{ steps\.pack\.outputs\.package_file \}\}/);
  const script = new URL("../scripts/publish-github-release.mjs", import.meta.url).pathname;
  const stdout = execFileSync(process.execPath, [script, "--check-pinned-keys"], { cwd: f.cwd, env: f.environment, encoding: "utf8" });
  assert.equal(stdout.trim(), "pinned-keys gate: skipped, release publishes no signed manifest, feed or signature (KRA-8371)");
  const required = execFileSync(process.execPath, [script, "--check-pinned-keys"], {
    cwd: f.cwd, env: { ...f.environment, GITHUB_REF_NAME: MANIFEST_TAG }, encoding: "utf8",
  });
  assert.equal(required.trim(), "pinned-keys gate: required, 2 configured (KRA-8371)");
  // Keep the old unconfigured CLI refusal on an isolated empty-pins fixture.
  for (const name of ["scripts/publish-github-release.mjs", "scripts/release/assert-pinned-keys.mjs", "src/updater/manifest.mjs", "src/updater/release-source.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(f.cwd, name)), { recursive: true });
    fs.copyFileSync(new URL(`../${name}`, import.meta.url), path.join(f.cwd, name));
  }
  fs.writeFileSync(path.join(f.cwd, "src/updater/pinned.mjs"), [
    "export const PINNED_PUBLIC_KEYS = Object.freeze([]);",
    `export const MANIFEST_TAG = ${JSON.stringify(MANIFEST_TAG)};`,
    'export const MANIFEST_SCHEMA = "tentacles-manifest/v1";',
  ].join("\n"));
  const emptyPinsScript = fs.realpathSync(path.join(f.cwd, "scripts/publish-github-release.mjs"));
  assert.throws(() => execFileSync(process.execPath, [emptyPinsScript, "--check-pinned-keys"], {
    cwd: f.cwd, env: { ...f.environment, GITHUB_REF_NAME: MANIFEST_TAG }, stdio: "pipe",
  }));
});

test("the workflow publish command runs end-to-end against a local fake gh only", async (t) => {
  const f = fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fake = path.join(f.cwd, "gh");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync('gh-call.json', JSON.stringify({ args, notes: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') }));\n`, { mode: 0o700 });
  const workflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const command = /run: (node scripts\/publish-github-release\.mjs)\s*$/m.exec(workflow)?.[1];
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
