#!/usr/bin/env node
// KRA-9774 CHANGELOG placement check: lines a branch adds to CHANGELOG.md must
// land under ## [Unreleased]. A release PR may turn [Unreleased] into a new
// version section; removals and moves out of released sections are allowed.
// Usage: node scripts/changelog-placement.mjs [base-ref] (default origin/main).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const UNRELEASED = "## [Unreleased]";
const isSection = (line) => line.startsWith("## ");

// 1-based head line numbers that are not in the LCS of base and head.
export function addedLines(baseText, headText) {
  const a = baseText.split("\n");
  const b = headText.split("\n");
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

// Returns [{ line, section }] for added lines outside [Unreleased].
export function findMisplaced(baseText, headText) {
  const head = headText.split("\n");
  const baseSections = new Set(baseText.split("\n").filter(isSection));
  // Release PR: the first version section is new and the base still had [Unreleased].
  const firstVersion = head.find((line) => isSection(line) && line !== UNRELEASED);
  const released = baseSections.has(UNRELEASED) && firstVersion !== undefined && !baseSections.has(firstVersion) ? firstVersion : null;
  const sectionAt = [];
  let section = null;
  for (const line of head) {
    if (isSection(line)) section = line;
    sectionAt.push(section);
  }
  return addedLines(baseText, headText)
    .map((line) => ({ line, section: sectionAt[line - 1] }))
    .filter(({ section: at }) => at !== null && at !== UNRELEASED && at !== released);
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
  const baseText = git(["show", `${mergeBase.trim()}:CHANGELOG.md`]) ?? "";
  const headText = fs.existsSync("CHANGELOG.md") ? fs.readFileSync("CHANGELOG.md", "utf8") : "";
  const misplaced = findMisplaced(baseText, headText);
  for (const { line, section } of misplaced) err(`CHANGELOG.md:${line} added under released section "${section}"; move it under ${UNRELEASED}`);
  if (misplaced.length) return 1;
  out(`changelog-placement: OK against ${base}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
