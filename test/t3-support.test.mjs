import assert from "node:assert/strict";
import test from "node:test";
import { T3_SUPPORT, t3Support, talkMissingAction } from "../src/t3-support.mjs";

test("config/t3-support.json states one stock range with an official download", () => {
  assert.equal(T3_SUPPORT.schema, 1);
  assert.match(T3_SUPPORT.minimum, /^\d+\.\d+\.\d+$/);
  assert.match(T3_SUPPORT.testedThrough, /^\d+\.\d+\.\d+$/);
  assert.equal(T3_SUPPORT.testedTag, `v${T3_SUPPORT.testedThrough}`);
  assert.match(T3_SUPPORT.download, /^https:\/\/github\.com\/pingdotgg\/t3code\/releases/);
});

test("t3Support places versions against the range", () => {
  const support = { minimum: "0.1.8", testedThrough: "0.1.11", download: "https://github.com/pingdotgg/t3code/releases/latest" };
  assert.equal(t3Support("0.1.8", support).status, "supported");
  assert.equal(t3Support("0.1.11", support).status, "supported");
  assert.equal(t3Support("0.1.12", support).status, "untested");
  assert.equal(t3Support("0.1.12-nightly.20261120.4994", support).status, "untested");
  assert.equal(t3Support("0.1.8-nightly.20261101.1", support).status, "unsupported");
  assert.equal(t3Support("0.0.45", support).status, "unsupported");
  assert.equal(t3Support("0.0.42-tplus.2", support).status, "legacy");
  assert.equal(t3Support("0.1.11-tplus.1", support).status, "legacy");
  assert.equal(t3Support(null, support).status, "unknown");
  assert.equal(t3Support("garbage", support).status, "unknown");
  assert.match(t3Support("0.0.45", support).action, /older than 0\.1\.8.*update T3 Code to 0\.1\.11 or newer.*releases\/latest/);
});

test("talk recovery text never asks for a patched or forked build", () => {
  for (const version of ["0.0.45", "0.0.42-tplus.2", "0.1.11", null]) {
    const action = talkMissingAction(version);
    assert.doesNotMatch(action, /patched|approved|TPLUS build|fork(?!\sbuild;)/i);
    assert.match(action, /update T3 Code to \d+\.\d+\.\d+ or newer/);
  }
});
