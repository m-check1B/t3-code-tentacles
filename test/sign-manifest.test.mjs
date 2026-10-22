// KRA-8371 (U1, U2): the no-AI signer. Provenance backends are fixtures; the
// key source is a real child process serving an EPHEMERAL key, so the spawn
// recorder sees exactly what a real run would pass.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, verify } from "node:crypto";
import {
  FORGEJO_READ_ITEM, NEXT_SIGNING_ITEM, PROTECTED_BRANCH, signManifest, SIGNING_ITEM,
} from "../scripts/release/sign-manifest.mjs";
import { verifyManifest } from "../src/updater/manifest.mjs";
import { entryFor, ephemeralKey, manifestOf, packageTgz, RPC, signEnvelope } from "./helpers/self-update-fixtures.mjs";

const NOW = Date.parse("2026-10-22T08:00:00.000Z");
const EXPIRES = "2026-11-20T00:00:00.000Z";
const TOKEN = "syntheticreadtoken0123456789";

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-signer-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A real executable key source: prints the ephemeral PEM or the token for the exact item name. */
function keySource(dir, key) {
  const pem = path.join(dir, "ephemeral-key.pem");
  fs.writeFileSync(pem, key.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const script = path.join(dir, "key-source.mjs");
  fs.writeFileSync(script, `#!${process.execPath}
import fs from "node:fs";
const item = process.argv[2];
if (item === ${JSON.stringify(SIGNING_ITEM)}) process.stdout.write(fs.readFileSync(${JSON.stringify(pem)}));
else if (item === ${JSON.stringify(FORGEJO_READ_ITEM)}) process.stdout.write(${JSON.stringify(TOKEN)});
else process.exit(3);
`, { mode: 0o700 });
  return script;
}

function recordingSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args: [...args], env: { ...options.env } });
    return spawn(command, args, options);
  };
  return { calls, spawnImpl };
}

function pinnedSource(keys) {
  return `export const PINNED_PUBLIC_KEYS = Object.freeze([${keys.map((key) => JSON.stringify(key)).join(", ")}]);\n`;
}

/** Provenance fixtures: everything is fine unless a test overrides one fact. */
function backends({ keys, entries, overrides = {} }) {
  const byCommit = new Map(entries.map((entry) => [entry.commit, entry]));
  const facts = {
    protected: true, ancestor: true, merged: true, b3: true, rebuild: null, asset: null, version: null, rpc: RPC, pinned: keys,
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
    async releaseAssetSha256(token, version) {
      assert.equal(token, TOKEN);
      return facts.asset ?? entries.find((entry) => entry.version === version).sha256;
    },
    async api(token, suffix) {
      assert.equal(token, TOKEN);
      if (suffix === `/branches/${encodeURIComponent(PROTECTED_BRANCH)}`) return { protected: facts.protected };
      const pull = /^\/commits\/([0-9a-f]{40})\/pull$/.exec(suffix);
      if (pull) return { number: 71, merged: facts.merged, base: { ref: PROTECTED_BRANCH }, merge_commit_sha: pull[1], head: { sha: "a".repeat(40) } };
      if (suffix.startsWith("/issues/71/comments")) return facts.b3 ? [{ body: `B3 APPROVE ${"a".repeat(40)}\nchecked` }] : [{ body: "looks fine" }];
      throw new Error(`unexpected api ${suffix}`);
    },
  };
}

function scenario(t, { previousFloor = "0.4.1-jack.1", draftFloor = "0.4.1-jack.1", overrides = {}, previous = true } = {}) {
  const dir = workspace(t);
  const current = ephemeralKey();
  const next = ephemeralKey();
  const v1 = entryFor("0.4.1-jack.1", packageTgz("0.4.1-jack.1"));
  const v2 = entryFor("0.4.1-jack.2", packageTgz("0.4.1-jack.2"));
  const previousFile = path.join(dir, "previous.json");
  fs.writeFileSync(previousFile, signEnvelope(manifestOf({ serial: 4, expires: EXPIRES, securityFloor: previousFloor, recommended: "0.4.1-jack.1", versions: [v1] }), current));
  const draftFile = path.join(dir, "draft.json");
  fs.writeFileSync(draftFile, JSON.stringify(manifestOf({ serial: previous ? 5 : 1, expires: EXPIRES, securityFloor: draftFloor, recommended: "0.4.1-jack.2", versions: [v1, v2] })));
  const recorder = recordingSpawn();
  const run = (founderOk = null) => signManifest({
    draftFile, previousFile: previous ? previousFile : null, logFile: path.join(dir, "signing.log"), outFile: path.join(dir, `signed-${Math.random()}.json`), founderOk, now: NOW,
  }, {
    spawnImpl: recorder.spawnImpl, keySource: keySource(dir, current),
    backends: backends({ keys: [current.raw, next.raw], entries: [v1, v2], overrides }),
  });
  return { dir, current, next, run, recorder, v2 };
}

async function refusal(promise) {
  try { await promise; } catch (error) { return error.code; }
  return null;
}

const fetchedItems = (recorder) => recorder.calls.map((call) => call.args[0]);

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
  const needles = [body, seed.toString("base64"), seed.toString("hex"), TOKEN];
  for (const call of s.recorder.calls) {
    const surface = JSON.stringify(call);
    for (const needle of needles) assert.equal(surface.includes(needle), false, `${path.basename(call.command)} saw secret material`);
  }
  assert.deepEqual(fetchedItems(s.recorder), [FORGEJO_READ_ITEM, SIGNING_ITEM], "exact item names only; the next key is never fetched");
  assert.equal(fetchedItems(s.recorder).includes(NEXT_SIGNING_ITEM), false);
  const artifacts = fs.readdirSync(s.dir).filter((name) => !["ephemeral-key.pem", "key-source.mjs"].includes(name)).map((name) => fs.readFileSync(path.join(s.dir, name), "utf8")).join("\n");
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
