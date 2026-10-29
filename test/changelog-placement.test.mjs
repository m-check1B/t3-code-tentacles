import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

const JACK3 = "## [0.5.0-jack.3] - 2026-10-28";

test("editing the newest released header does not exempt lines added under it", () => {
  for (const header of ["## [0.5.0-jack.3] - 2026-10-29", `${JACK3} `, "## [0.5.0-jack.3b] - 2026-10-28"]) {
    const head = insertAfter(BASE.replace(JACK3, header), "- shipped fix", "- hidden");
    assert.deepEqual(findMisplaced(BASE, head), [{ line: 9, section: header }, { line: 14, section: header }], header);
  }
});

test("a second [Unreleased] header inside a released section is flagged", () => {
  for (const anchor of ["- shipped fix", "- older"]) {
    const head = insertAfter(BASE, anchor, "## [Unreleased]", "- hidden");
    const section = "## [Unreleased] (duplicate)";
    const at = head.split("\n").indexOf("- hidden") + 1;
    assert.deepEqual(findMisplaced(BASE, head), [{ line: at - 1, section }, { line: at, section }], anchor);
  }
});

test("CRLF line endings are read like LF", () => {
  const crlf = (text) => text.replaceAll("\n", "\r\n");
  assert.deepEqual(findMisplaced(BASE, crlf(BASE)), []);
  assert.deepEqual(findMisplaced(BASE, crlf(insertAfter(BASE, "- pending fix", "- new fix"))), []);
  assert.deepEqual(findMisplaced(crlf(BASE), crlf(insertAfter(BASE, "- shipped fix", "- new fix"))), [{ line: 14, section: JACK3 }]);
});

test("the CLI runs through a symlink and from a subdirectory", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kra9774-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), BASE);
  git("add", "CHANGELOG.md");
  git("commit", "-q", "--no-verify", "-m", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), insertAfter(BASE, "- shipped fix", "- new fix"));
  fs.mkdirSync(path.join(repo, "sub"));
  const link = path.join(repo, "link.mjs");
  fs.symlinkSync(SCRIPT, link);
  for (const [script, cwd] of [[link, repo], [SCRIPT, path.join(repo, "sub")]]) {
    const result = spawnSync(process.execPath, [script, base], { cwd, encoding: "utf8" });
    assert.equal(result.status, 1, `${script} in ${cwd}: ${result.stderr}`);
    assert.match(result.stderr, /CHANGELOG\.md:14 added under released section/);
  }
});
