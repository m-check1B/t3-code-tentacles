import test from "node:test";
import assert from "node:assert/strict";
import { RELEASE_DOWNLOAD, releaseAssetUrl, requireReleaseBase } from "../src/updater/release-source.mjs";

test("release URLs pin GitHub, the private repo, tag and asset name", () => {
  assert.equal(releaseAssetUrl("v0.4.1-jack.2", "tentacles-0.4.1-jack.2.tgz"), `${RELEASE_DOWNLOAD}/v0.4.1-jack.2/tentacles-0.4.1-jack.2.tgz`);
  assert.equal(releaseAssetUrl("tentacles-manifest", "tentacles-manifest.json"), `${RELEASE_DOWNLOAD}/tentacles-manifest/tentacles-manifest.json`);
  for (const [tag, file] of [["../evil", "a"], ["v0.4.1", "../a"], ["v0.4.1", "tentacles-0.4.2.tgz"], ["v0.4.1?evil", "a"]]) assert.throws(() => releaseAssetUrl(tag, file));
  for (const base of ["http://192.168.0.21:3000/matej/t3-code-tentacles/releases/download", "https://ocelotnas/releases/download", `${RELEASE_DOWNLOAD}/`, `${RELEASE_DOWNLOAD}?redirect=1`, RELEASE_DOWNLOAD.replace("github.com", "github.com.evil.invalid"), RELEASE_DOWNLOAD.replace("https:", "http:")]) assert.throws(() => requireReleaseBase(base), /release source/);
});
