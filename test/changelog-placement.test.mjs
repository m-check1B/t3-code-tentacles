import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { findMisplaced } from "../scripts/changelog-placement.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "changelog-placement.mjs");
const BASE = [
  "# Changelog", "",
  "## [Unreleased]", "", "### Fixed", "", "- pending fix", "",
  "## [0.5.0-jack.3] - 2026-10-28", "", "### Fixed", "", "- shipped fix", "",
  "## [0.5.0-jack.2] - 2026-10-24", "", "- older", "",
].join("\n");
const insertAfter = (text, anchor, ...lines) => {
  const all = text.split("\n");
  all.splice(all.indexOf(anchor) + 1, 0, ...lines);
  return all.join("\n");
};

test("a line added under a released section fails (194bd13 shape)", () => {
  const head = insertAfter(BASE, "- shipped fix", "- new fix (KRA-9772)");
  assert.deepEqual(findMisplaced(BASE, head), [{ line: 14, section: "## [0.5.0-jack.3] - 2026-10-28" }]);
});

test("a line added under [Unreleased] passes", () => {
  assert.deepEqual(findMisplaced(BASE, insertAfter(BASE, "- pending fix", "- new fix")), []);
});

test("a release PR that turns [Unreleased] into a version passes", () => {
  const head = BASE.replace("## [Unreleased]", "## [Unreleased]\n\n## [0.5.0-jack.4] - 2026-10-30");
  assert.deepEqual(findMisplaced(BASE, insertAfter(head, "- pending fix", "- release note")), []);
});

test("a release PR still fails on a line added under an older release", () => {
  const head = insertAfter(BASE.replace("## [Unreleased]", "## [0.5.0-jack.4] - 2026-10-30"), "- older", "- late note");
  assert.deepEqual(findMisplaced(BASE, head).map(({ section }) => section), ["## [0.5.0-jack.2] - 2026-10-24"]);
});

test("removing or moving a line out of a released section passes", () => {
  assert.deepEqual(findMisplaced(BASE, BASE.replace("- shipped fix\n", "")), []);
  const moved = insertAfter(BASE.replace("- shipped fix\n", ""), "- pending fix", "- shipped fix");
  assert.deepEqual(findMisplaced(BASE, moved), []);
});

test("no CHANGELOG change passes", () => {
  assert.deepEqual(findMisplaced(BASE, BASE), []);
});

test("a missing base ref exits 2 with a clear reason", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "refs/heads/kra9774-no-such-base"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /base ref refs\/heads\/kra9774-no-such-base not found/);
});
