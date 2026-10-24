// Only synthetic bytes and fake children. Never invokes nasvault or bw.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runChild } from "../scripts/release/sign-manifest.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

for (const outcome of ["success", "failure", "timeout", "child death"]) {
  test(`child buffers are zeroed on ${outcome}`, async () => {
    const child = fakeChild();
    const original = Buffer.from("SYNTHETIC-ONLY");
    const pending = runChild(() => child, "synthetic-helper", [], { timeoutMs: 10 });
    child.stdout.emit("data", original);
    if (outcome === "timeout") {
      // The base implementation has no deadline; this close bounds its failure witness.
      setTimeout(() => child.emit("close", 0), 40);
      await assert.rejects(pending, { code: "subprocess_failed" });
      assert.deepEqual(child.kills, ["SIGKILL"]);
    } else {
      child.emit("close", outcome === "success" ? 0 : outcome === "failure" ? 1 : null, outcome === "child death" ? "SIGKILL" : null);
      if (outcome === "success") {
        const copy = await pending;
        assert.equal(copy.toString(), "SYNTHETIC-ONLY");
        copy.fill(0); // the consumer clears its returned copy after use
        assert.ok(copy.every((byte) => byte === 0));
      } else await assert.rejects(pending, { code: "subprocess_failed" });
    }
    assert.ok(original.every((byte) => byte === 0), "original pipe chunk retained bytes");
  });
}

test("oversized and late chunks are rejected and zeroed", async () => {
  const child = fakeChild();
  const original = Buffer.from("SYNTHETIC");
  const extra = Buffer.from("EXTRA");
  const pending = runChild(() => child, "synthetic-helper", [], { maxBytes: 2 });
  child.stdout.emit("data", original);
  child.stdout.emit("data", extra);
  child.emit("close", 0);
  await assert.rejects(pending, { code: "subprocess_failed" });
  assert.ok(original.every((byte) => byte === 0));
  assert.ok(extra.every((byte) => byte === 0));
});

test("key-source helper is reviewed repository source", () => {
  assert.ok(fs.existsSync(new URL("../scripts/release/signer-key-source.mjs", import.meta.url)));
});

// Dynamic import lets the failing-before run still reach the base boundaries.
const signer = await import("../scripts/release/sign-manifest.mjs");

test("pinned helper rejects tampering and symlinks before any spawn", async (t) => {
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-source-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(signer.keySourceBytes().length > 0);
  const file = path.join(dir, "reader.mjs");
  fs.writeFileSync(file, `${fs.readFileSync(signer.KEY_SOURCE)}\n// tampered\n`, { mode: 0o600 });
  let calls = 0;
  await assert.rejects(signer.fetchSecret(() => { calls++; }, file, signer.SIGNING_ITEM, () => {}), { code: "key_source_hash_mismatch" });
  fs.symlinkSync(signer.KEY_SOURCE, path.join(dir, "link"));
  assert.throws(() => signer.keySourceBytes(path.join(dir, "link")), { code: "key_source_missing_or_unsafe" });
  fs.chmodSync(file, 0o620);
  assert.throws(() => signer.keySourceBytes(file), { code: "key_source_unsafe" });
  assert.equal(calls, 0);
});

for (const outcome of ["success", "consumer failure", "extra stdout", "extra stderr", "spawn error", "child death"]) {
  test(`secret fd clears original and consumer buffers on ${outcome}`, async () => {
    const child = fakeChild();
    const original = Buffer.from("SYNTHETIC-ONLY");
    const extra = Buffer.from("UNEXPECTED-SYNTHETIC");
    let copy;
    const pending = signer.fetchSecret(() => child, signer.KEY_SOURCE, signer.SIGNING_ITEM, (bytes) => {
      copy = bytes;
      if (outcome === "consumer failure") throw new Error("synthetic consumer refusal");
      assert.equal(bytes.toString(), "SYNTHETIC-ONLY");
      return "consumed";
    });
    child.stdio[3].emit("data", original);
    if (outcome === "extra stdout") child.stdout.emit("data", extra);
    if (outcome === "extra stderr") child.stderr.emit("data", extra);
    if (outcome === "spawn error") child.emit("error", new Error("synthetic spawn error"));
    child.emit("close", outcome === "child death" ? null : 0, outcome === "child death" ? "SIGKILL" : null);
    if (outcome === "success") assert.equal(await pending, "consumed");
    else await assert.rejects(pending);
    assert.ok(original.every((byte) => byte === 0));
    if (outcome.startsWith("extra")) assert.ok(extra.every((byte) => byte === 0));
    if (copy) assert.ok(copy.every((byte) => byte === 0));
  });
}

test("B3 review binds approved state, exact head, timestamps and all writer identities", () => {
  const head = "a".repeat(40);
  const binding = { head, writers: [{ id: 2, login: "synthetic-writer" }], committedAt: "2026-10-24T10:00:00Z", now: Date.parse("2026-10-24T12:00:00Z"), review: true };
  const receipt = { body: `B3 APPROVE head=${head}`, user: { id: 1, login: "matej" }, state: "APPROVED", commit_id: head, submitted_at: "2026-10-24T11:00:00Z", updated_at: "2026-10-24T11:00:00Z" };
  assert.equal(signer.approvedB3(receipt, binding), true);
  for (const change of [{ state: "COMMENT" }, { commit_id: "b".repeat(40) }, { stale: true }, { dismissed: true }, { updated_at: undefined }, { user: { id: 2, login: "synthetic-writer" } }]) {
    assert.equal(signer.approvedB3({ ...receipt, ...change }, binding), false);
  }
  assert.equal(signer.approvedB3(receipt, { ...binding, writers: [{ id: 1, login: "matej" }] }), false);
  assert.equal(signer.approvedB3(receipt, { ...binding, writers: [null] }), false);
});
