import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/upstream-t3-issue.sh");
const title = "Upstream T3 Code v9.9.9 fails the Tentacles stock smoke";

// Runs the issue step with a stub curl on PATH; returns the logged calls.
function run(searchItems) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-issue-"));
  try {
    const log = path.join(dir, "calls.log");
    fs.writeFileSync(path.join(dir, "search.json"), JSON.stringify({ items: searchItems }));
    fs.writeFileSync(path.join(dir, "curl"), `#!/usr/bin/env bash
method=GET; url=""
while [ $# -gt 0 ]; do case "$1" in -X) method="$2"; shift 2 ;; -H|-d) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
echo "$method $url" >> "${log}"
case "$url" in *search/issues*) cat "${path.join(dir, "search.json")}" ;; *) echo '{}' ;; esac
`, { mode: 0o755 });
    const result = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
      GH_TOKEN: "fake-token", GITHUB_REPOSITORY: "owner/repo", TAG: "v9.9.9", RUN_URL: "https://example.invalid/run/1" } });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(log, "utf8").trim().split("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const issues = "https://api.github.com/repos/owner/repo/issues";
const creates = (calls) => calls.filter((call) => call === `POST ${issues}`).length;

test("upstream issue step: exactly one issue per tag across open, closed and no match", () => {
  const open = run([{ number: 7, title: `${title} (other)`, state: "open" }, { number: 5, title, state: "open" }]);
  assert.deepEqual(open.slice(1), [`POST ${issues}/5/comments`]);
  const closed = run([{ number: 5, title, state: "closed" }]);
  assert.deepEqual(closed.slice(1), [`PATCH ${issues}/5`, `POST ${issues}/5/comments`]);
  const none = run([{ number: 7, title: `${title} (other)`, state: "open" }]);
  assert.deepEqual(none.slice(1), [`POST ${issues}`]);
  assert.equal(creates(open) + creates(closed) + creates(none), 1);
  assert.equal(creates(none), 1);
});
