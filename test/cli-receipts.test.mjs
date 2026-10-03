import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const rejected of [false, true]) {
  test(`no-wait CLI emits acceptance and exit status; rejected=${rejected}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-test-"));
    const tokenFile = path.join(dir, "token");
    fs.writeFileSync(tokenFile, "synthetic-fixture-only-token", { mode: 0o600 });
    let command;
    const server = createServer(async (request, response) => {
      let data = "";
      for await (const chunk of request) data += chunk;
      command = JSON.parse(data);
      response.writeHead(rejected ? 400 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(rejected ? { error: "PRIVATE_BODY" } : { sequence: 1 }));
    });
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "act", "--intent", JSON.stringify({ action: "thread.pin", threadId: "synthetic-thread", commandId: "retry-same-id" }), "--no-wait"], {
        env: { ...process.env, T3_URL: `http://127.0.0.1:${server.address().port}`, T3_HERMES_TOKEN_FILE: tokenFile },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      assert.equal(code, rejected ? 1 : 0, stderr);
      const [receipt] = JSON.parse(stdout);
      assert.equal(receipt.accepted, !rejected);
      assert.equal(receipt.commandId, "retry-same-id");
      assert.equal(command.commandId, "retry-same-id");
      assert.equal(receipt.status, rejected ? "rejected" : "accepted");
      assert(!stdout.includes("PRIVATE_BODY"));
      assert(!stderr.includes("PRIVATE_BODY"));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
