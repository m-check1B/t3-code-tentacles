import assert from "node:assert/strict";
import test from "node:test";
import { T3_SUPPORT, t3Support, talkMissingAction } from "../src/t3-support.mjs";

test("src/t3-support.mjs states one stock range with an official download", () => {
  assert.equal(T3_SUPPORT.schema, 1);
  assert.match(T3_SUPPORT.minimum, /^\d+\.\d+\.\d+$/);
  assert.match(T3_SUPPORT.testedThrough, /^\d+\.\d+\.\d+$/);
  assert.equal(T3_SUPPORT.testedTag, `v${T3_SUPPORT.testedThrough}`);
  assert.match(T3_SUPPORT.download, /^https:\/\/github\.com\/pingdotgg\/t3code\/releases/);
});

test("t3Support places versions against the range", () => {
  const support = { ...T3_SUPPORT, minimum: "0.1.8", testedThrough: "0.1.11" };
  assert.equal(t3Support("0.1.8", support).status, "supported");
  assert.equal(t3Support("0.1.11", support).status, "supported");
  assert.equal(t3Support("0.1.12", support).status, "untested");
  assert.equal(t3Support("0.1.12-nightly.20261120.4994", support).status, "untested");
  assert.equal(t3Support("0.1.8-nightly.20261101.1", support).status, "unsupported");
  assert.equal(t3Support("0.0.45", support).status, "unsupported");
  assert.equal(t3Support("0.0.42-tplus.2", support).status, "legacy");
  assert.equal(t3Support("0.1.11-tplus.1", support).status, "legacy");
  assert.equal(t3Support("0.1.0-jack.1", support).status, "legacy");
  assert.equal(t3Support("0.1.12-nightly.20261120.4994", support).status, "untested");
  assert.equal(t3Support(null, support).status, "unknown");
  assert.equal(t3Support("garbage", support).status, "unknown");
  assert.match(t3Support("0.0.45", support).action, /older than 0\.1\.8.*update T3 Code to 0\.1\.11 or newer.*releases\/latest/);
});

test("talk recovery text never asks for a patched or forked build", () => {
  for (const version of ["0.0.45", "0.0.42-tplus.2", "0.1.0-jack.1", "0.1.11", null]) {
    const action = talkMissingAction(version);
    assert.doesNotMatch(action, /patched|approved|TPLUS build|fork(?!\sbuild;)/i);
    assert.match(action, /update T3 Code to \d+\.\d+\.\d+ or newer/);
  }
});

test("t3Support never throws: a broken range reports unknown with one action", () => {
  const where = t3Support("0.1.11", { minimum: "not-a-version", testedThrough: "0.1.11", legacy: { prereleases: [] } });
  assert.equal(where.status, "unknown");
  assert.match(where.action, /reinstall Tentacles, then rerun doctor/);
  assert.equal(t3Support("0.1.11", null).status, "unknown");
});

test("a vendored copy (src, bin, package.json only) imports the bridge and pairer", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const vendored = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-vendored-"));
  try {
    for (const entry of ["src", "bin", "package.json"]) fs.cpSync(path.join(root, entry), path.join(vendored, entry), { recursive: true });
    assert.equal(fs.existsSync(path.join(vendored, "config")), false);
    const support = await import(pathToFileURL(path.join(vendored, "src/t3-support.mjs")).href);
    assert.equal(support.t3Support(support.T3_SUPPORT.testedThrough).status, "supported");
    await import(pathToFileURL(path.join(vendored, "src/bridge.mjs")).href);
    await import(pathToFileURL(path.join(vendored, "src/outbound-pairer.mjs")).href);
  } finally {
    fs.rmSync(vendored, { recursive: true, force: true });
  }
});
