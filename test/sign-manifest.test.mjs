// KRA-8371 (U1, U2): the no-AI signer. Provenance backends are fixtures; the
// key-source pipe is stubbed with EPHEMERAL bytes; no vault or key file is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, verify } from "node:crypto";
import {
  KEY_SOURCE, NEXT_SIGNING_ITEM, PROTECTED_BRANCH, signManifest, SIGNING_ITEM,
} from "../scripts/release/sign-manifest.mjs";
import { verifyManifest } from "../src/updater/manifest.mjs";
import { entryFor, ephemeralKey, manifestOf, packageTgz, RPC, signEnvelope } from "./helpers/self-update-fixtures.mjs";

const NOW = Date.parse("2026-10-22T08:00:00.000Z");
const EXPIRES = "2026-11-20T00:00:00.000Z";

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-signer-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stub the inherited fd, with no real helper/vault invocation or PEM on disk. */
function recordingSpawn(key, { keyFinalNewline = true } = {}) {
  const calls = [];
  const buffers = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args: [...args], env: { ...options.env } });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
    child.kill = () => true;
    child.stdin.on("finish", () => {
      assert.equal(args.at(-1), SIGNING_ITEM);
      let bytes = Buffer.from(key.privateKey.export({ format: "pem", type: "pkcs8" }));
      if (!keyFinalNewline && args.at(-1) === SIGNING_ITEM) bytes = bytes.subarray(0, -1);
      buffers.push(bytes);
      child.stdio[3].emit("data", bytes);
      child.emit("close", 0);
    });
    return child;
  };
  return { calls, spawnImpl, buffers };
}

function pinnedSource(keys) {
  return `export const PINNED_PUBLIC_KEYS = Object.freeze([${keys.map((key) => JSON.stringify(key)).join(", ")}]);\n`;
}

/** Provenance fixtures: everything is fine unless a test overrides one fact. */
function backends({ keys, entries, overrides = {} }) {
  const byCommit = new Map(entries.map((entry) => [entry.commit, entry]));
  let activeHead;
  const facts = {
    protected: true, ancestor: true, merged: true, b3: true, approval: {}, writer: { id: 127414494, login: "m-check1B" }, rebuild: null, asset: null, version: null, rpc: RPC, pinned: keys,
    ...overrides,
  };
  return {
    async syncMirror() {},
    async isAncestor() { return facts.ancestor; },
    async showFile(commit, file) {
      const entry = byCommit.get(commit);
      if (file === "package.json") return JSON.stringify({ version: facts.version ?? entry.version });
      if (file === "src/outbound-pairer.mjs") return `export const REMOTE_RPC_METHODS = Object.freeze([${facts.rpc.map((name) => `"${name}"`).join(", ")}]);\n`;
      // The baseline (previously recommended) commit keeps the original keys.
      if (file === "src/updater/pinned.mjs") return pinnedSource(commit === entries[0].commit ? keys : facts.pinned);
      throw new Error("unexpected file");
    },
    async rebuildSha256(commit) { return facts.rebuild ?? byCommit.get(commit).sha256; },
    async releaseAssetSha256(version) {
      return facts.asset ?? entries.find((entry) => entry.version === version).sha256;
    },
    async api(suffix) {
      if (suffix === `/branches/${encodeURIComponent(PROTECTED_BRANCH)}`) return { protected: facts.protected };
      if (suffix === "/pulls/71") return { number: 71, merged: facts.merged, base: { ref: PROTECTED_BRANCH, repo: { full_name: "m-check1B/t3-code-tentacles-private" } }, merge_commit_sha: activeHead, user: facts.writer,
        head: { sha: activeHead, repo: { full_name: "m-check1B/t3-code-tentacles-private" } }, body: "writer-thread=synthetic-writer", merged_at: "2026-10-22T07:30:00Z" };
      throw new Error(`unexpected api ${suffix}`);
    },
    async list(suffix) {
      const pull = /^\/commits\/([0-9a-f]{40})\/pulls\?per_page=100$/.exec(suffix);
      if (pull) { activeHead = pull[1]; return [{ number: 71, base: { ref: PROTECTED_BRANCH, repo: { full_name: "m-check1B/t3-code-tentacles-private" } }, head: { sha: activeHead } }]; }
      if (suffix.includes("/check-suites?")) return [{ head_sha: activeHead, repository: { full_name: "m-check1B/t3-code-tentacles-private" }, app: { id: 15368, slug: "github-actions" }, created_at: "2026-10-22T07:00:00Z" }];
      if (suffix.startsWith("/issues/71/comments")) return facts.b3 ? [{
        body: `APPROVE tentacles-private#71 ${activeHead} P1=0 P2=0\nwriter-thread=synthetic-writer reviewer-thread=synthetic-reviewer`, user: { id: 127414494, login: "m-check1B" },
        created_at: "2026-10-22T07:10:00.000Z", updated_at: "2026-10-22T07:10:00.000Z", ...facts.approval,
      }] : [{ body: "looks fine" }];
      throw new Error(`unexpected list ${suffix}`);
    },
  };
}

function scenario(t, { previousFloor = "0.4.1-jack.1", draftFloor = "0.4.1-jack.1", overrides = {}, previous = true, keyFinalNewline = true } = {}) {
  const dir = workspace(t);
  const current = ephemeralKey();
  const next = ephemeralKey();
  const v1 = entryFor("0.4.1-jack.1", packageTgz("0.4.1-jack.1"));
  const v2 = entryFor("0.4.1-jack.2", packageTgz("0.4.1-jack.2"));
  const previousFile = path.join(dir, "previous.json");
  fs.writeFileSync(previousFile, signEnvelope(manifestOf({ serial: 4, expires: EXPIRES, securityFloor: previousFloor, recommended: "0.4.1-jack.1", versions: [v1] }), current));
  const draftFile = path.join(dir, "draft.json");
  fs.writeFileSync(draftFile, JSON.stringify(manifestOf({ serial: previous ? 5 : 1, expires: EXPIRES, securityFloor: draftFloor, recommended: "0.4.1-jack.2", versions: [v1, v2] })));
  const recorder = recordingSpawn(current, { keyFinalNewline });
  const run = (founderOk = null) => signManifest({
    draftFile, previousFile: previous ? previousFile : null, logFile: path.join(dir, "signing.log"), outFile: path.join(dir, `signed-${Math.random()}.json`), founderOk, now: NOW,
  }, {
    spawnImpl: recorder.spawnImpl, keySource: KEY_SOURCE,
    backends: backends({ keys: [current.raw, next.raw], entries: [v1, v2], overrides }),
  });
  return { dir, current, next, run, recorder, v2 };
}

async function refusal(promise) {
  try { await promise; } catch (error) { return error.code; }
  return null;
}

const fetchedItems = (recorder) => recorder.calls.map((call) => call.args.at(-1));

test("the signer still refuses explicit empty pins before requesting any key", async (t) => {
  const s = scenario(t, { overrides: { pinned: [] } });
  assert.equal(await refusal(s.run()), "pinned_keys_not_configured");
  assert.equal(s.recorder.calls.length, 0);
  assert.equal(fs.readdirSync(s.dir).some(name => name.startsWith("signed-") || name === "signing.log"), false);
});

test("signs a fully proven manifest; the envelope verifies on a device pinned to the same keys", async (t) => {
  const s = scenario(t);
  const { record, linearComment } = await s.run();
  assert.equal(record.serial, 5);
  assert.deepEqual(record.newVersions, ["0.4.1-jack.2"]);
  assert.equal(record.prevLineSha256, null);
  const out = fs.readdirSync(s.dir).find((name) => name.startsWith("signed-"));
  const envelope = fs.readFileSync(path.join(s.dir, out));
  const { manifest } = verifyManifest(envelope, { publicKeys: [s.current.raw, s.next.raw], now: NOW, minSerial: 1, lastSerial: 4 });
  assert.equal(manifest.recommended, "0.4.1-jack.2");
  assert.match(linearComment, /serial 5, recommended 0\.4\.1-jack\.2/);
  // Append-only, hash-chained log.
  const second = await s.run().catch((error) => error.code);
  assert.equal(second, "serial_already_signed", "the append-only log refuses re-signing a serial");
  const lines = fs.readFileSync(path.join(s.dir, "signing.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});

test("key bytes never appear in argv, env, the log, the output or the Linear comment", async (t) => {
  const s = scenario(t);
  const { linearComment } = await s.run();
  const pem = s.current.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const body = pem.split("\n").filter((line) => line && !line.startsWith("-----")).join("");
  const der = s.current.privateKey.export({ format: "der", type: "pkcs8" });
  const seed = der.subarray(-32);
  const needles = [body, seed.toString("base64"), seed.toString("hex")];
  for (const call of s.recorder.calls) {
    const surface = JSON.stringify(call);
    for (const needle of needles) assert.equal(surface.includes(needle), false, `${path.basename(call.command)} saw secret material`);
  }
  assert.deepEqual(fetchedItems(s.recorder), [SIGNING_ITEM], "exact item names only; the next key is never fetched");
  assert.equal(fetchedItems(s.recorder).includes(NEXT_SIGNING_ITEM), false);
  assert.ok(s.recorder.buffers.every((buffer) => buffer.every((byte) => byte === 0)), "every original secret chunk was cleared");
  const artifacts = fs.readdirSync(s.dir).map((name) => fs.readFileSync(path.join(s.dir, name), "utf8")).join("\n");
  for (const needle of needles) {
    assert.equal(artifacts.includes(needle), false);
    assert.equal(linearComment.includes(needle), false);
  }
});

test("refuses an unmerged PR, a commit off the protected branch, an unprotected branch and a missing B3", async (t) => {
  for (const [overrides, code] of [
    [{ merged: false }, "pr_not_merged"],
    [{ ancestor: false }, "commit_not_on_protected_branch"],
    [{ protected: false }, "branch_not_protected"],
    [{ b3: false }, "b3_receipt_missing"],
    [{ rebuild: "0".repeat(64) }, "rebuild_sha_mismatch"],
    [{ asset: "1".repeat(64) }, "release_asset_sha_mismatch"],
    [{ version: "0.4.1-jack.3" }, "version_mismatch"],
    [{ rpc: [...RPC, "interrupt"] }, "legacy_rpc_mismatch"],
    [{ pinned: [] }, "pinned_keys_not_configured"],
  ]) {
    const s = scenario(t, { overrides });
    assert.equal(await refusal(s.run()), code, JSON.stringify(overrides));
    assert.equal(fetchedItems(s.recorder).includes(SIGNING_ITEM), false, `${code}: the signing key is not fetched after a refusal`);
  }
});

test("lowering the security floor needs the Founder-OK flag with a reference", async (t) => {
  const lowered = scenario(t, { previousFloor: "0.4.1-jack.1", draftFloor: "0.4.1-jack.1" });
  assert.notEqual(await refusal(lowered.run()), "founder_ok_required");
  const s = scenario(t, { previousFloor: "0.4.1-jack.1", draftFloor: "0.4.0" });
  assert.equal(await refusal(s.run()), "founder_ok_required");
  assert.equal(fetchedItems(s.recorder).includes(SIGNING_ITEM), false);
  assert.equal(await refusal(s.run("bad ref with spaces")), "founder_ok_reference_invalid");
  const { record } = await s.run("KRA-8371:founder-ok-synthetic");
  assert.deepEqual(record.founderRules, ["security_floor_lowered"]);
  assert.equal(record.founderOk, "KRA-8371:founder-ok-synthetic");
});

test("a key rotation and the first manifest both need the Founder-OK flag", async (t) => {
  const rotated = scenario(t, { overrides: { pinned: [ephemeralKey().raw, ephemeralKey().raw] } });
  assert.equal(await refusal(rotated.run()), "founder_ok_required");
  const first = scenario(t, { previous: false });
  assert.equal(await refusal(first.run()), "founder_ok_required");
  const { record } = await first.run("KRA-8371:first-sign");
  assert.deepEqual(record.founderRules, ["first_manifest"]);
});

test("refuses an expiry beyond 45 days, a changed signed entry, and a forged previous manifest", async (t) => {
  const s = scenario(t);
  const draft = JSON.parse(fs.readFileSync(path.join(s.dir, "draft.json"), "utf8"));
  fs.writeFileSync(path.join(s.dir, "draft.json"), JSON.stringify({ ...draft, expires: "2027-06-01T00:00:00.000Z" }));
  assert.equal(await refusal(s.run()), "expiry_out_of_range");
  fs.writeFileSync(path.join(s.dir, "draft.json"), JSON.stringify({ ...draft, versions: [{ ...draft.versions[0], sha256: "2".repeat(64) }, draft.versions[1]] }));
  assert.equal(await refusal(s.run()), "signed_entry_changed");
  fs.writeFileSync(path.join(s.dir, "draft.json"), JSON.stringify(draft));
  const previous = JSON.parse(fs.readFileSync(path.join(s.dir, "previous.json"), "utf8"));
  fs.writeFileSync(path.join(s.dir, "previous.json"), JSON.stringify(signEnvelopeWith(previous, ephemeralKey())));
  assert.equal(await refusal(s.run()), "previous_manifest_not_ours");
});

function signEnvelopeWith(envelope, key) {
  return JSON.parse(signEnvelope(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")), key).toString());
}

test("the signed payload is exactly the validated draft", async (t) => {
  const s = scenario(t);
  await s.run();
  const out = fs.readdirSync(s.dir).find((name) => name.startsWith("signed-"));
  const envelope = JSON.parse(fs.readFileSync(path.join(s.dir, out), "utf8"));
  const payload = Buffer.from(envelope.payload, "base64");
  assert.deepEqual(JSON.parse(payload.toString()), JSON.parse(fs.readFileSync(path.join(s.dir, "draft.json"), "utf8")));
  assert.equal(verify(null, payload, s.current.publicKey, Buffer.from(envelope.signatures[0].sig, "base64")), true);
  assert.equal(createHash("sha256").update(payload).digest("hex").length, 64);
});

for (const [label, overrides] of [
  ["unauthorized author", { approval: { user: { id: 99, login: "untrusted" } } }],
  ["forged allowlisted login", { approval: { user: { id: 99, login: "m-check1B" } } }],
  ["writer same-thread approval", { approval: { body: `APPROVE tentacles-private#71 ${"2".repeat(40)} P1=0 P2=0\nwriter-thread=synthetic-writer reviewer-thread=synthetic-writer` } }],
  ["other head", { approval: { body: `B3 APPROVE head=${"f".repeat(40)}` } }],
  ["edited approval", { approval: { updated_at: "2026-10-22T07:20:00.000Z" } }],
  ["old approval", { approval: { created_at: "2026-10-21T07:10:00.000Z", updated_at: "2026-10-21T07:10:00.000Z" } }],
]) {
  test(`B3 refuses ${label} before fetching the signing key`, async (t) => {
    const s = scenario(t, { overrides });
    assert.equal(await refusal(s.run()), "b3_receipt_missing");
    assert.equal(fetchedItems(s.recorder).includes(SIGNING_ITEM), false);
  });
}

test("accepts a PKCS8 vault value without a trailing newline (nasvault set-password contract)", async (t) => {
  const s = scenario(t, { keyFinalNewline: false });
  const { record } = await s.run();
  assert.equal(record.serial, 5);
  assert.ok(s.recorder.buffers.every((bytes) => bytes.every((byte) => byte === 0)));
});
