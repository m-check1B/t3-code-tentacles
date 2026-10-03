import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("recorded absolute Node works for both aliases with a non-interactive PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles shim "));
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.copyFileSync(new URL("../bin/t3-agent-bridge", import.meta.url), path.join(dir, "bin", "t3-agent-bridge"));
    fs.chmodSync(path.join(dir, "bin", "t3-agent-bridge"), 0o755);
    fs.symlinkSync("t3-agent-bridge", path.join(dir, "bin", "tentacles"));
    fs.writeFileSync(path.join(dir, "bin", "node-path"), `${process.execPath}\n`);
    fs.writeFileSync(path.join(dir, "src", "cli.mjs"), 'console.log(JSON.stringify(process.argv.slice(2)))');
    for (const alias of ["tentacles", "t3-agent-bridge"]) {
      const result = spawnSync(path.join(dir, "bin", alias), ["--version", "argument with spaces"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["--version", "argument with spaces"]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
