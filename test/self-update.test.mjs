// KRA-8371 (KRA-8367 A3): signed standalone self-update. Test signing keys
// are ephemeral; every path is a fresh temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyManifest, selectTarget, compareVersions, UpdateError } from "../src/updater/manifest.mjs";
import { extractPackage } from "../src/updater/safe-tar.mjs";
import { SelfUpdater } from "../src/updater/updater.mjs";
import { buildEvent, readSelfUpdateSummary, requireComputerId } from "../src/updater/events.mjs";
import { PINNED_PUBLIC_KEYS } from "../src/updater/pinned.mjs";
import { main as updaterMain } from "../src/updater/cli.mjs";
import { assertPinnedKeys } from "../scripts/release/assert-pinned-keys.mjs";
import { REMOTE_RPC_METHODS, LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import {
  entryFor, ephemeralKey, manifestOf, packageTgz, releaseServer, RPC, signEnvelope, tgz,
} from "./helpers/self-update-fixtures.mjs";

const BASE = "https://github.com/m-check1B/t3-code-tentacles-private/releases/download";
const NOW = Date.parse("2026-10-22T08:00:00.000Z");
const LATER = "2026-11-20T00:00:00.000Z";

test("shipped pins match the audited U6 public keys in current/next order", () => {
  assert.deepEqual(PINNED_PUBLIC_KEYS, [
    "1IWLY3JieS1Jdof2xsZ5huJW8ATUwq9iAbo695+NhEM=",
    "smwpxtGQXv9HpsEosMC9obOZLAFaA70cfrdtkSNiFHM=",
  ]);
  assert.equal(Object.isFrozen(PINNED_PUBLIC_KEYS), true);
  assert.equal(new Set(PINNED_PUBLIC_KEYS).size, 2);
  const ids = PINNED_PUBLIC_KEYS.map((key) => {
    const raw = Buffer.from(key, "base64");
    assert.equal(raw.length, 32);
    assert.equal(raw.toString("base64"), key);
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  });
  assert.deepEqual(ids, ["106d3ab825e5e6b7", "9e6656980133bd7a"]);
});

test("the release pinned-key gate accepts the shipped pins", () => {
  assert.equal(assertPinnedKeys(), true);
});

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-su-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "home");
}

function codeOf(fn) {
  try { fn(); } catch (error) { return error.code; }
  return null;
}

/** A device with v1 installed and current, a server offering v2. */
function device(t, { serial = 2, expires = LATER, floor = "0.4.1-jack.1", recommended = "0.4.1-jack.2", needs = [], idle = true, health = { ok: true }, keys } = {}) {
  const home = tempHome(t);
  const key = keys?.signer ?? ephemeralKey();
  const v1 = packageTgz("0.4.1-jack.1");
  const v2 = packageTgz("0.4.1-jack.2");
  const server = releaseServer(BASE);
  server.artifact("0.4.1-jack.1", v1);
  server.artifact("0.4.1-jack.2", v2);
  const manifest = manifestOf({
    serial, expires, securityFloor: floor, recommended,
    versions: [entryFor("0.4.1-jack.1", v1), entryFor("0.4.1-jack.2", v2, { needs })],
  });
  server.manifest(signEnvelope(manifest, key));
  const calls = { restart: 0, health: [] };
  const updater = new SelfUpdater({
    home, publicKeys: keys?.pinned ?? [key.raw], minSerial: 1, baseUrl: BASE, fetchImpl: server.fetchImpl,
    now: () => NOW, computerId: "computer-a1", nodePath: "/usr/bin/node",
    isIdle: async () => (typeof idle === "function" ? idle() : idle),
    restart: async () => { calls.restart += 1; },
    health: async (context) => { calls.health.push(context); return typeof health === "function" ? health(context) : health; },
  });
  return { home, key, server, manifest, updater, calls, v1, v2 };
}

async function installV1(d) {
  await d.updater.install(entryFor("0.4.1-jack.1", d.v1));
  d.updater.switchTo("0.4.1-jack.1");
  d.updater.writeState({ current: "0.4.1-jack.1" });
}

// --- manifest ----------------------------------------------------------------

test("a manifest signed by an unpinned key is refused before anything is read", () => {
  const pinned = ephemeralKey();
  const attacker = ephemeralKey();
  const v = packageTgz("0.4.1-jack.2");
  const manifest = manifestOf({ expires: LATER, securityFloor: "0.4.1-jack.1", recommended: "0.4.1-jack.2", versions: [entryFor("0.4.1-jack.2", v)] });
  assert.equal(codeOf(() => verifyManifest(signEnvelope(manifest, attacker), { publicKeys: [pinned.raw], now: NOW, minSerial: 1 })), "manifest_signature_invalid");
  // A pinned keyId with a signature over different bytes is refused too.
  const forged = JSON.parse(signEnvelope(manifest, pinned).toString());
  forged.payload = Buffer.from(JSON.stringify({ ...manifest, securityFloor: "0.0.1" })).toString("base64");
  assert.equal(codeOf(() => verifyManifest(Buffer.from(JSON.stringify(forged)), { publicKeys: [pinned.raw], now: NOW, minSerial: 1 })), "manifest_signature_invalid");
});

test("the next pinned key verifies too (rotation), and no pinned key fails closed", () => {
  const current = ephemeralKey();
  const next = ephemeralKey();
  const v = packageTgz("0.4.1-jack.2");
  const envelope = signEnvelope(manifestOf({ expires: LATER, securityFloor: "0.4.1-jack.2", recommended: "0.4.1-jack.2", versions: [entryFor("0.4.1-jack.2", v)] }), next);
  assert.equal(verifyManifest(envelope, { publicKeys: [current.raw, next.raw], now: NOW, minSerial: 1 }).manifest.serial, 2);
  assert.equal(codeOf(() => verifyManifest(envelope, { publicKeys: [], now: NOW, minSerial: 1 })), "updater_unconfigured");
});

test("explicit empty pins refuse signed-looking and unsigned manifests before any install or fetch", async (t) => {
  const emptyKeys = Object.freeze([]);
  const key = ephemeralKey();
  const v = packageTgz("0.4.1-jack.2");
  const manifest = manifestOf({ expires: LATER, securityFloor: "0.4.1-jack.2", recommended: "0.4.1-jack.2", versions: [entryFor("0.4.1-jack.2", v)] });
  for (const bytes of [signEnvelope(manifest, key), Buffer.from(JSON.stringify(manifest))]) {
    assert.equal(codeOf(() => verifyManifest(bytes, { publicKeys: emptyKeys, now: NOW, minSerial: 1 })), "updater_unconfigured");
    const home = tempHome(t);
    let fetches = 0;
    const updater = new SelfUpdater({ home, publicKeys: emptyKeys, computerId: "computer-a1", now: () => NOW,
      fetchImpl: async () => { fetches += 1; return new Response(bytes); },
      isIdle: async () => true, restart: async () => assert.fail("must not restart"),
    });
    assert.strictEqual(updater.publicKeys, emptyKeys);
    assert.deepEqual(await updater.run({ trigger: "now" }), { status: "failed", reason: "updater_unconfigured" });
    assert.equal(fetches, 0);
    assert.equal(fs.existsSync(path.join(home, "versions")), false);
  }
});

test("shipped pins refuse unsigned manifests and unpinned throwaway signatures without installing", async (t) => {
  const key = ephemeralKey();
  assert.equal(PINNED_PUBLIC_KEYS.includes(key.raw), false);
  const manifest = manifestOf({ expires: LATER, securityFloor: "0.4.1-jack.2", recommended: "0.4.1-jack.2", versions: [entryFor("0.4.1-jack.2", packageTgz("0.4.1-jack.2"))] });
  const signed = signEnvelope(manifest, key);
  const unsigned = { ...JSON.parse(signed), signatures: [] };
  const cases = [
    [Buffer.from(JSON.stringify(manifest)), "manifest_invalid"],
    [Buffer.from(JSON.stringify(unsigned)), "manifest_invalid"],
    [signed, "manifest_signature_invalid"],
    ...["106d3ab825e5e6b7", "9e6656980133bd7a"].map((id) => {
      const forged = JSON.parse(signed);
      forged.signatures[0].keyId = id;
      return [Buffer.from(JSON.stringify(forged)), "manifest_signature_invalid"];
    }),
  ];
  for (const [bytes, reason] of cases) {
    const home = tempHome(t);
    let fetches = 0;
    const updater = new SelfUpdater({ home, computerId: "computer-a1", now: () => NOW,
      fetchImpl: async () => { fetches += 1; return new Response(bytes); },
      isIdle: async () => assert.fail("must not reach install selection"),
      restart: async () => assert.fail("must not restart"),
    });
    assert.strictEqual(updater.publicKeys, PINNED_PUBLIC_KEYS);
    assert.deepEqual(await updater.run({ trigger: "now" }), { status: "failed", reason });
    assert.equal(fetches, 1, "only the manifest is requested");
    assert.equal(updater.events().length, 1);
    assert.equal(fs.existsSync(path.join(home, "versions")), false);
    assert.equal(fs.existsSync(path.join(home, "current")), false);
    assert.equal(updater.readState().lastSerial, 0);
  }
});

test("replay: a lower serial, a same-serial different manifest and a serial below the compiled minimum are refused", () => {
  const key = ephemeralKey();
  const v = packageTgz("0.4.1-jack.2");
  const make = (serial, changelog = "a") => signEnvelope(manifestOf({ serial, expires: LATER, securityFloor: "0.4.1-jack.2", recommended: "0.4.1-jack.2", versions: [entryFor("0.4.1-jack.2", v, { changelog })] }), key);
  const accepted = verifyManifest(make(5), { publicKeys: [key.raw], now: NOW, minSerial: 1 });
  const options = { publicKeys: [key.raw], now: NOW, minSerial: 1, lastSerial: 5, lastDigest: accepted.digest };
  assert.equal(codeOf(() => verifyManifest(make(4), options)), "manifest_replay");
  assert.equal(codeOf(() => verifyManifest(make(5, "b"), options)), "manifest_replay");
  assert.equal(verifyManifest(make(5), options).manifest.serial, 5, "a byte-identical re-read is fine");
  assert.equal(verifyManifest(make(6), options).manifest.serial, 6);
  // Lost local state: the compiled-in minimum still applies.
  assert.equal(codeOf(() => verifyManifest(make(3), { publicKeys: [key.raw], now: NOW, minSerial: 4 })), "manifest_replay");
});

test("an expired manifest means no install and no downgrade (manifest_expired)", async (t) => {
  const d = device(t, { expires: "2026-10-21T00:00:00.000Z" });
  await installV1(d);
  const result = await d.updater.run({ trigger: "now" });
  assert.deepEqual(result, { status: "failed", reason: "manifest_expired" });
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
  assert.equal(d.calls.restart, 0);
  assert.equal(fs.existsSync(path.join(d.home, "versions", "0.4.1-jack.2")), false);
  d.updater.writeState({ previous: "0.4.1-jack.1" });
  assert.deepEqual(await d.updater.undo(), { status: "failed", reason: "manifest_expired" });
  assert.equal(d.updater.events().at(-1).reason, "manifest_expired");
});

test("below floor: never installed, never an Undo target; recommended below floor is invalid", () => {
  const v1 = packageTgz("0.4.1-jack.1");
  const v2 = packageTgz("0.4.1-jack.2");
  const manifest = manifestOf({ expires: LATER, securityFloor: "0.4.1-jack.2", recommended: "0.4.1-jack.2", versions: [entryFor("0.4.1-jack.1", v1), entryFor("0.4.1-jack.2", v2)] });
  assert.equal(selectTarget(manifest, "0.4.1-jack.1").version, "0.4.1-jack.2", "a below-floor device moves up");
  assert.equal(selectTarget(manifest, "0.4.1-jack.2").action, "none");
  const key = ephemeralKey();
  const bad = signEnvelope({ ...manifest, securityFloor: "0.4.1-jack.2", recommended: "0.4.1-jack.1" }, key);
  assert.equal(codeOf(() => verifyManifest(bad, { publicKeys: [key.raw], now: NOW, minSerial: 1 })), "manifest_invalid");
  assert.equal(compareVersions("0.4.1-jack.9", "0.4.1"), -1);
  assert.equal(compareVersions("0.4.1-jack.10", "0.4.1-jack.9"), 1);
});

test("U5: a listed, safe current version is never moved down to a lower recommended", () => {
  const v1 = packageTgz("0.4.1-jack.1");
  const v2 = packageTgz("0.4.1-jack.2");
  const manifest = manifestOf({ expires: LATER, securityFloor: "0.4.1-jack.1", recommended: "0.4.1-jack.1", versions: [entryFor("0.4.1-jack.1", v1), entryFor("0.4.1-jack.2", v2)] });
  assert.equal(selectTarget(manifest, "0.4.1-jack.2").action, "none");
});

// --- safe extraction (U4) ------------------------------------------------------

function extractCode(t, entries) {
  const home = tempHome(t);
  const dest = path.join(home, "tree");
  fs.mkdirSync(dest, { recursive: true });
  const outside = path.join(home, "outside");
  try { extractPackage(tgz(entries), dest); }
  catch (error) {
    assert.equal(fs.existsSync(outside), false, "nothing was written outside the destination");
    return error.code;
  }
  return null;
}

const root = [{ name: "package/", type: "5", mode: 0o755 }, { name: "package/package.json", data: "{\"version\":\"0.4.1-jack.2\"}" }];

test("tar: traversal, absolute, out-of-tree symlink/hardlink, write-through-symlink and device entries are refused", (t) => {
  assert.equal(extractCode(t, [...root, { name: "package/../outside", data: "x" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "/tmp/outside", data: "x" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "elsewhere/file", data: "x" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/link", type: "2", linkname: "/etc" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/link", type: "2", linkname: "../outside" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/a/link", type: "2", linkname: "b/../../.." }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/hard", type: "1", linkname: "package/../outside" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/hard", type: "1", linkname: "package/missing" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/dir", type: "2", linkname: "sub" }, { name: "package/dir/file", data: "x" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/char", type: "3" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/block", type: "4" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/fifo", type: "6" }]), "artifact_unsafe");
  assert.equal(extractCode(t, [...root, { name: "package/package.json", data: "dup" }]), "artifact_unsafe");
});

test("tar: an in-tree symlink and hardlink are kept; setuid and group-write bits are dropped", (t) => {
  const home = tempHome(t);
  const dest = path.join(home, "tree");
  fs.mkdirSync(dest, { recursive: true });
  extractPackage(tgz([...root,
    { name: "package/bin/", type: "5", mode: 0o755 },
    { name: "package/bin/run", data: "#!/bin/sh\n", mode: 0o4777 },
    { name: "package/bin/alias", type: "2", linkname: "run" },
    { name: "package/copy.json", type: "1", linkname: "package/package.json" },
  ]), dest);
  assert.equal(fs.readlinkSync(path.join(dest, "bin", "alias")), "run");
  assert.equal(fs.statSync(path.join(dest, "bin", "run")).mode & 0o7777, 0o755);
  assert.equal(fs.readFileSync(path.join(dest, "copy.json"), "utf8"), "{\"version\":\"0.4.1-jack.2\"}");
});

test("the artifact sha256 is checked before a single tar entry is parsed", async (t) => {
  const d = device(t);
  await installV1(d);
  d.server.artifact("0.4.1-jack.2", tgz([{ name: "/tmp/outside", data: "x" }])); // wrong bytes for the signed sha
  assert.deepEqual(await d.updater.run({ trigger: "now" }), { status: "failed", reason: "artifact_sha_mismatch" });
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
});

// --- apply, hold, idle, health ----------------------------------------------------

test("auto-apply installs recommended when idle, switches current atomically and posts a notice with Undo", async (t) => {
  const d = device(t);
  await installV1(d);
  const result = await d.updater.run({ trigger: "auto" });
  assert.deepEqual(result, { status: "updated", from: "0.4.1-jack.1", to: "0.4.1-jack.2", undoAvailable: true });
  assert.equal(fs.readlinkSync(path.join(d.home, "current")), "versions/0.4.1-jack.2");
  assert.equal(fs.readFileSync(path.join(d.home, "versions", "0.4.1-jack.2", "bin", "node-path"), "utf8"), "/usr/bin/node\n");
  assert.equal(d.calls.restart, 1);
  assert.equal(d.calls.health[0].budgetMs, 60_000);
  const notice = d.updater.events().at(-1);
  assert.equal(notice.code, "tentacles_updated");
  assert.equal(notice.undoAvailable, true);
  assert.deepEqual(fs.readdirSync(path.join(d.home, "tmp")), [], "staging is cleaned up");
});

test("idle-only: a busy computer is not switched", async (t) => {
  const d = device(t, { idle: false });
  await installV1(d);
  assert.deepEqual(await d.updater.run({ trigger: "auto" }), { status: "busy" });
  assert.deepEqual(await d.updater.run({ trigger: "now" }), { status: "busy" });
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
  assert.equal(d.calls.restart, 0);
});

test("hold blocks auto-apply, Update now and Undo; the hold file is never changed", async (t) => {
  const d = device(t);
  await installV1(d);
  fs.writeFileSync(path.join(d.home, "hold"), "0.4.1 KRA-6911\n", { mode: 0o600 });
  const before = d.server.requests.length;
  assert.deepEqual(await d.updater.run({ trigger: "auto" }), { status: "held" });
  assert.deepEqual(await d.updater.run({ trigger: "now" }), { status: "held" });
  assert.deepEqual(await d.updater.undo(), { status: "held" });
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
  assert.equal(d.server.requests.length, before, "a held computer does not even fetch the manifest");
  assert.equal(fs.readFileSync(path.join(d.home, "hold"), "utf8"), "0.4.1 KRA-6911\n");
  const summary = readSelfUpdateSummary(d.home);
  assert.equal(summary.held, true);
  assert.equal(summary.holdTicket, "KRA-6911");
  assert.equal(summary.holdVersion, "0.4.1");
});

test("a version that needs a new permission or unit becomes a consent card, never auto-applied", async (t) => {
  const d = device(t, { needs: ["macos-accessibility"] });
  await installV1(d);
  assert.deepEqual(await d.updater.run({ trigger: "auto" }), { status: "needs_consent", to: "0.4.1-jack.2" });
  assert.deepEqual(await d.updater.run({ trigger: "now" }), { status: "needs_consent", to: "0.4.1-jack.2" });
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
  assert.equal(d.updater.events().at(-1).code, "tentacles_update_needs_consent");
});

test("health failure rolls back automatically and reports tentacles_update_rolled_back", async (t) => {
  const d = device(t, { health: { ok: false, reason: "health_pair_failed" } });
  await installV1(d);
  assert.deepEqual(await d.updater.run({ trigger: "auto" }), { status: "rolled_back", reason: "health_pair_failed" });
  assert.equal(fs.readlinkSync(path.join(d.home, "current")), "versions/0.4.1-jack.1");
  assert.equal(d.calls.restart, 2, "restarted into the new version, then back into the previous one");
  const event = d.updater.events().at(-1);
  assert.deepEqual([event.code, event.from, event.to, event.reason], ["tentacles_update_rolled_back", "0.4.1-jack.2", "0.4.1-jack.1", "health_pair_failed"]);
  assert.equal(d.updater.readState().current, "0.4.1-jack.1");
});

test("a health check that throws or times out also rolls back", async (t) => {
  const d = device(t, { health: () => { throw new Error("boom"); } });
  await installV1(d);
  assert.equal((await d.updater.run({ trigger: "auto" })).status, "rolled_back");
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
});

// --- Undo (U5) -------------------------------------------------------------------

test("Undo goes only to the previous on-disk version that is still >= floor and listed", async (t) => {
  const d = device(t);
  await installV1(d);
  await d.updater.run({ trigger: "auto" });
  assert.deepEqual(await d.updater.undo(), { status: "undone", from: "0.4.1-jack.2", to: "0.4.1-jack.1" });
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");

  // Previous raised above by the floor: no Undo.
  const floor = device(t, { serial: 3, floor: "0.4.1-jack.2" });
  await installV1(floor);
  await floor.updater.run({ trigger: "auto" });
  assert.equal(floor.updater.events().at(-1).undoAvailable, false);
  assert.deepEqual(await floor.updater.undo(), { status: "failed", reason: "undo_unavailable" });

  // Previous deleted from disk: no Undo.
  const gone = device(t);
  await installV1(gone);
  await gone.updater.run({ trigger: "auto" });
  fs.rmSync(path.join(gone.home, "versions", "0.4.1-jack.1"), { recursive: true });
  assert.deepEqual(await gone.updater.undo(), { status: "failed", reason: "undo_unavailable" });
});

test("Undo refuses a previous version that the current manifest no longer lists", async (t) => {
  const d = device(t);
  await installV1(d);
  await d.updater.run({ trigger: "auto" });
  const v2 = packageTgz("0.4.1-jack.2");
  d.server.manifest(signEnvelope(manifestOf({ serial: 3, expires: LATER, securityFloor: "0.4.1-jack.2", recommended: "0.4.1-jack.2", versions: [entryFor("0.4.1-jack.2", v2)] }), d.key));
  assert.deepEqual(await d.updater.undo(), { status: "failed", reason: "undo_unavailable" });
});

// --- crash guard (U6) ------------------------------------------------------------

test("crash guard: 3 failed starts in 10 min pin the previous version and ADD a hold", async (t) => {
  const d = device(t);
  await installV1(d);
  await d.updater.run({ trigger: "auto" });
  assert.equal(d.updater.recordFailedStart().status, "recorded");
  assert.equal(d.updater.recordFailedStart().status, "recorded");
  assert.deepEqual(d.updater.recordFailedStart(), { status: "pinned", to: "0.4.1-jack.1" });
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
  assert.match(fs.readFileSync(path.join(d.home, "hold"), "utf8"), /^crash-guard 0\.4\.1-jack\.2 /);
  assert.equal(d.updater.events().at(-1).code, "tentacles_crash_guard_hold");
  assert.deepEqual(await d.updater.run({ trigger: "now" }), { status: "held" }, "the guard's hold blocks re-applying the bad version");
});

test("crash guard never removes or rewrites an existing hold, and does not switch under it", async (t) => {
  const d = device(t);
  await installV1(d);
  await d.updater.run({ trigger: "auto" });
  fs.writeFileSync(path.join(d.home, "hold"), "0.4.1 KRA-6911\n", { mode: 0o600 });
  for (let index = 0; index < 3; index += 1) d.updater.recordFailedStart();
  assert.equal(fs.readFileSync(path.join(d.home, "hold"), "utf8"), "0.4.1 KRA-6911\n");
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.2");
});

test("failed starts older than 10 minutes do not count", (t) => {
  let now = NOW;
  const home = tempHome(t);
  const updater = new SelfUpdater({ home, publicKeys: [], now: () => now, computerId: "computer-a1" });
  updater.recordFailedStart();
  now += 6 * 60_000;
  updater.recordFailedStart();
  now += 6 * 60_000;
  assert.equal(updater.recordFailedStart().status, "recorded");
  assert.equal(fs.existsSync(path.join(home, "hold")), false);
});

test("no code path in the updater removes or truncates the hold file", () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "updater");
  for (const name of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    for (const line of source.split("\n")) {
      if (/paths\.hold|"hold"/.test(line)) {
        assert.doesNotMatch(line, /unlink|rmSync|rm\(|truncate|rename|flag: "w"/, `${name}: ${line.trim()}`);
      }
    }
  }
});

// --- events (U7), RPC contract, CLI (U5), fail-closed ------------------------------

test("events carry versions, codes and the computer id only: no paths, no user names", async (t) => {
  const d = device(t, { health: { ok: false, reason: "health_seats_failed" } });
  await installV1(d);
  await d.updater.run({ trigger: "auto" });
  d.server.artifact("0.4.1-jack.2", Buffer.from("bad"));
  await d.updater.run({ trigger: "now" });
  const text = fs.readFileSync(path.join(d.home, "state", "events.jsonl"), "utf8");
  const user = os.userInfo().username;
  const values = text.trim().split("\n").map((line) => { const { schema, ...rest } = JSON.parse(line); assert.equal(schema, "tentacles-update-event/v1"); return JSON.stringify(rest); }).join("\n");
  assert.equal(values.includes("/"), false, "no path separator in any event value");
  assert.match(values, /tentacles_update_rolled_back/);
  assert.match(values, /artifact_sha_mismatch/);
  if (user.length >= 3) assert.equal(text.toLowerCase().includes(user.toLowerCase()), false);
  assert.equal(text.includes(os.tmpdir()), false);
  for (const line of text.trim().split("\n")) {
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["at", "code", "computerId", "from", "reason", "schema", "to", "undoAvailable"]);
  }
  assert.throws(() => buildEvent({ code: "tentacles_updated", computerId: "computer-a1", reason: "/home/someone" }), /reason/);
  assert.throws(() => requireComputerId("laptop-of-sampleuser", { userNames: ["sampleuser"] }), /user name/);
  assert.equal(requireComputerId("computer-a1", { userNames: ["sampleuser"] }), "computer-a1");
});

test("the 0.4.1 legacy RPC list is unchanged; doctor-status carries the self-update block only when present", async () => {
  assert.deepEqual([...REMOTE_RPC_METHODS], RPC);
  const base = { client: { request: async () => ({}) }, doctorImpl: async () => ({ pairing: { status: "paired" }, labs: [] }) };
  const absent = new LoopbackRuntimeAdapter({ ...base, selfUpdateSummaryImpl: () => null });
  assert.equal("selfUpdate" in await absent.doctorStatus(), false);
  const summary = { schema: "tentacles-self-update/v1", current: "0.4.1-jack.2", previous: null, held: false, holdVersion: null, holdTicket: null, events: [] };
  const present = new LoopbackRuntimeAdapter({ ...base, selfUpdateSummaryImpl: () => summary });
  assert.deepEqual((await present.doctorStatus()).selfUpdate, summary);
  const broken = new LoopbackRuntimeAdapter({ ...base, selfUpdateSummaryImpl: () => { throw new Error("x"); } });
  assert.equal("selfUpdate" in await broken.doctorStatus(), false);
});

test("U5: Update now and Undo accept no version, URL or hash", async (t) => {
  const home = tempHome(t);
  await assert.rejects(updaterMain(["now", "0.4.1-jack.9"], { home, out: () => {} }), /takes no arguments/);
  await assert.rejects(updaterMain(["undo", "--version", "0.4.1-jack.1"], { home, out: () => {} }), /takes no arguments/);
  await assert.rejects(updaterMain(["now", "--url", "http://elsewhere.invalid/x.tgz"], { home, out: () => {} }), /takes no arguments/);
});

test("fail closed: explicit empty pins refuse updates and the release check refuses the build", async (t) => {
  const home = tempHome(t);
  let fetched = false;
  const updater = new SelfUpdater({ home, publicKeys: [], computerId: "computer-a1", fetchImpl: async () => { fetched = true; return new Response("{}"); }, isIdle: async () => true });
  assert.deepEqual(await updater.run({ trigger: "now" }), { status: "failed", reason: "updater_unconfigured" });
  assert.equal(fetched, false);
  assert.throws(() => assertPinnedKeys([]), /two pinned Ed25519 public keys/);
  const a = ephemeralKey();
  const b = ephemeralKey();
  assert.throws(() => assertPinnedKeys([a.raw, a.raw]), /must differ/);
  assert.equal(assertPinnedKeys([a.raw, b.raw]), true);
  assert.throws(() => assertPinnedKeys([a.raw, "bm90LWEta2V5"]), UpdateError);
});

test("the updater never references T3, ~/.claude, ~/.codex or ~/.t3", () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "updater");
  for (const name of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(source, /\.claude|\.codex|["'/]\.t3["'/]|t3 update|"update"\]/, name);
  }
});

// --- launcher ------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { AUTO_CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, Launcher } from "../src/updater/launcher.mjs";
import { signalLauncher } from "../src/updater/updater.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; setImmediate(() => child.emit("exit", null, signal)); };
  return child;
}

for (const failure of ["404", "network error"]) {
  test(`shipped pins with no published manifest (${failure}) fail non-fatally without retry spam`, async (t) => {
    const d = device(t);
    await installV1(d);
    let fetches = 0;
    const updater = new SelfUpdater({ home: d.home, computerId: "computer-a1", now: () => NOW,
      fetchImpl: async () => {
        fetches += 1;
        assert.ok(fetches <= 3, "no retry loop");
        if (failure === "network error") throw new Error("synthetic network failure");
        return new Response("missing", { status: 404 });
      },
      isIdle: async () => assert.fail("must not reach install selection"),
    });
    assert.strictEqual(updater.publicKeys, PINNED_PUBLIC_KEYS);
    assert.deepEqual(await updater.run({ trigger: "now" }), { status: "failed", reason: "manifest_unavailable" });
    assert.equal(fetches, 1);
    let starts = 0;
    const child = fakeChild();
    const launcher = new Launcher({ updater, args: [], now: () => NOW,
      spawnImpl: () => { starts += 1; return child; },
    });
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const running = launcher.run();
    try {
      t.mock.timers.tick(FIRST_CHECK_DELAY_MS - 1);
      assert.equal(fetches, 1);
      t.mock.timers.tick(1);
      await new Promise(setImmediate);
      assert.equal(fetches, 2);
      assert.equal(updater.events().length, 2, "one bounded event per check");
      t.mock.timers.tick(AUTO_CHECK_INTERVAL_MS - FIRST_CHECK_DELAY_MS - 1);
      await new Promise(setImmediate);
      assert.equal(fetches, 2, "failure does not schedule an early retry");
      t.mock.timers.tick(1);
      await new Promise(setImmediate);
      assert.equal(fetches, 3);
      assert.equal(updater.events().length, 3);
      assert.ok(updater.events().every((event) => event.reason === "manifest_unavailable"));
      assert.equal(starts, 1, "the running application is never restarted");
      assert.equal(child.signalCode, null);
      assert.equal(updater.currentVersion(), "0.4.1-jack.1");
      assert.deepEqual(fs.readdirSync(updater.paths.versions), ["0.4.1-jack.1"]);
      assert.equal(updater.readState().lastSerial, 0);
    } finally {
      child.emit("exit", 0, null);
      assert.equal(await running, 0);
    }
  });
}

test("launcher: a child that dies within a minute feeds the crash guard; the third pins and holds", async (t) => {
  const d = device(t);
  await installV1(d);
  await d.updater.run({ trigger: "auto" });
  const spawned = [];
  for (let index = 0; index < 3; index += 1) {
    const launcher = new Launcher({
      updater: d.updater, args: ["pair"], now: () => NOW, pollMs: 60_000, firstCheckMs: 60_000, checkIntervalMs: 60_000,
      spawnImpl: (bin, args) => { spawned.push({ bin, args }); const child = fakeChild(); setImmediate(() => child.emit("exit", 1, null)); return child; },
    });
    assert.equal(await launcher.run(), 1);
  }
  assert.equal(spawned[0].bin, path.join(fs.realpathSync(path.join(d.home, "versions", "0.4.1-jack.2")), "bin", "t3-agent-bridge"));
  assert.deepEqual(spawned[0].args, ["pair"]);
  assert.equal(d.updater.currentVersion(), "0.4.1-jack.1");
  assert.equal(fs.existsSync(path.join(d.home, "hold")), true);
});

test("launcher: Update now from another process restarts the child through the request file, never a signal", async (t) => {
  const d = device(t);
  await installV1(d);
  const children = [];
  const launcher = new Launcher({
    updater: d.updater, args: ["pair"], now: () => NOW, pollMs: 20, firstCheckMs: 60_000, checkIntervalMs: 60_000,
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child; },
  });
  const running = launcher.run();
  const outside = new SelfUpdater({ home: d.home, publicKeys: [], computerId: "computer-a1" });
  await signalLauncher(outside, { timeoutMs: 5_000, pollMs: 20 });
  assert.equal(children.length, 2, "the first child was stopped and a new one started");
  assert.equal(children[0].signalCode, "SIGTERM");
  await assert.rejects(signalLauncher(new SelfUpdater({ home: tempHome(t), publicKeys: [], computerId: "computer-a1" }), { timeoutMs: 100, pollMs: 20 }), /acknowledged/);
  launcher.startedAt = NOW - 120_000;
  children[1].emit("exit", 0, null);
  await running;
});

test("self-update refuses every noncanonical release origin before fetching", async () => {
  for (const baseUrl of ["http://192.168.0.21:3000/matej/t3-code-tentacles/releases/download", "https://ocelotnas/releases/download", "https://github.com.evil.invalid/m-check1B/t3-code-tentacles-private/releases/download", "https://github.com/m-check1B/t3-code-tentacles/releases/download"]) {
    assert.throws(() => new SelfUpdater({ baseUrl, fetchImpl: () => assert.fail("must not fetch") }), /release source/);
  }
});

test("an isolated installed updater includes its compiled release source", async (t) => {
  const { installUpdater } = await import("../src/updater/cli.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const home = tempHome(t);
  installUpdater({ home });
  const modulePath = path.join(home, "updater", "updater.mjs");
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `const { SelfUpdater } = await import(${JSON.stringify(modulePath)}); console.log(new SelfUpdater().baseUrl);`]);
  assert.equal(stdout.trim(), BASE);
});

test("the maintenance signer is closed before any live credential or network operation", async () => {
  const { defaultBackends } = await import("../scripts/release/sign-manifest.mjs");
  assert.throws(() => defaultBackends({ spawnImpl: () => assert.fail("must not spawn"), fetchImpl: () => assert.fail("must not fetch") }), { code: "github_provenance_unavailable" });
});
