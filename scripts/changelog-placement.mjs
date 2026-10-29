#!/usr/bin/env node
// KRA-9774 CHANGELOG placement check: lines a branch adds to CHANGELOG.md must
// land under ## [Unreleased]. A release PR may turn [Unreleased] into a new
// version section; removals and moves out of released sections are allowed.
// Usage: node scripts/changelog-placement.mjs [base-ref] (default origin/main).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const UNRELEASED = "## [Unreleased]";
const isSection = (line) => line.startsWith("## ");
// "## [0.5.0-jack.3] - 2026-10-28" -> "0.5.0-jack.3", so a date or spacing edit keeps the version.
const versionOf = (line) => /^## \[([^\]]*)\]/.exec(line)?.[1] ?? line.trimEnd();
const lines = (text) => text.split(/\r?\n/);

// 1-based head line numbers that are not in the LCS of base and head.
export function addedLines(baseText, headText) {
  const a = lines(baseText);
  const b = lines(headText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const n = endA - start;
  const m = endB - start;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[start + i] === b[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const added = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[start + i] === b[start + j]) { i += 1; j += 1; }
    else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) i += 1;
    else { added.push(start + j + 1); j += 1; }
  }
  return added;
}

// Returns [{ line, section }] for added lines outside [Unreleased]. Only the first
// [Unreleased] header counts; later ones are flagged like released sections.
export function findMisplaced(baseText, headText) {
  const head = lines(headText);
  const baseVersions = new Set(lines(baseText).filter(isSection).map(versionOf));
  const headVersions = new Set(head.filter(isSection).map(versionOf));
  const unreleasedAt = head.findIndex((line) => isSection(line) && versionOf(line) === "Unreleased");
  // Release PR: the first version section has a version the base lacks, the base had
  // [Unreleased], and no released version vanished (renaming a released header is no release).
  const firstVersion = head.findIndex((line, index) => isSection(line) && index !== unreleasedAt);
  const kept = [...baseVersions].every((version) => version === "Unreleased" || headVersions.has(version));
  const releasedAt = baseVersions.has("Unreleased") && kept && firstVersion !== -1 && !baseVersions.has(versionOf(head[firstVersion])) ? firstVersion : -1;
  // null = lines may be added here (preamble, the first [Unreleased], a new release).
  const sectionAt = [];
  let section = null;
  head.forEach((line, index) => {
    if (isSection(line) && (index === unreleasedAt || index === releasedAt)) section = null;
    else if (isSection(line)) section = versionOf(line) === "Unreleased" ? `${line} (duplicate)` : line;
    sectionAt.push(section);
  });
  return addedLines(baseText, headText)
    .map((line) => ({ line, section: sectionAt[line - 1] }))
    .filter(({ section: at }) => at !== null);
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

export function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  const base = argv[0] || "origin/main";
  const mergeBase = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) && git(["merge-base", base, "HEAD"]);
  if (!mergeBase) {
    err(`changelog-placement: base ref ${base} not found or shares no history with HEAD; fetch it first`);
    return 2;
  }
  const changelog = path.join(git(["rev-parse", "--show-toplevel"])?.trim() ?? ".", "CHANGELOG.md");
  const baseText = git(["show", `${mergeBase.trim()}:CHANGELOG.md`]) ?? "";
  const headText = fs.existsSync(changelog) ? fs.readFileSync(changelog, "utf8") : "";
  const misplaced = findMisplaced(baseText, headText);
  for (const { line, section } of misplaced) err(`CHANGELOG.md:${line} added under released section "${section}"; move it under ${UNRELEASED}`);
  if (misplaced.length) return 1;
  out(`changelog-placement: OK against ${base}`);
  return 0;
}

// realpath: Node resolves a symlinked entry script, so compare real paths or main() never runs.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) process.exitCode = main();
