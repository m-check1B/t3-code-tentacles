import assert from "node:assert/strict";
import test from "node:test";
import { callsServer, codeCallsServer, leavesWorkspace } from "../scripts/jack-tools-proof-check.mjs";

// B3 P2-1 on #109 (delta 2): only a real call counts, and leaving the workspace fails.
test("jack-tools-proof counts an execute item only when its code really calls the server", () => {
  for (const code of [
    'const r = await tools["microsoft-learn"].microsoft_docs_search({ query: "az login" });\nreturn r;',
    "return await tools['microsoft-learn'].microsoft_docs_fetch({ url: 'https://learn.microsoft.com/x' })",
  ]) assert.equal(codeCallsServer(code), true, code);
  for (const code of [
    '// tools["microsoft-learn"].microsoft_docs_search({})\nreturn 1;',
    '/* tools["microsoft-learn"].x() */ return 1;',
    'return "tools[\\"microsoft-learn\\"].microsoft_docs_search()";',
    'return `tools["microsoft-learn"].x()`;',
    'const r = await tools.opencode.list_mcp_resources({ server: "microsoft-learn" }); return r;',
    'tools["microsoft-learn"].microsoft_docs_search(', // does not parse
    'const t = tools["microsoft-learn"]; return t;', // no call
    'x.tools["microsoft-learn"].y()', // not the top-level tools object
  ]) assert.equal(codeCallsServer(code), false, code);
  const item = code => ({ type: "dynamic_tool", status: "completed", toolName: "execute", input: { code } });
  assert.equal(callsServer(item('return await tools["microsoft-learn"].microsoft_docs_search({ query: "a" })')), true);
  assert.equal(callsServer({ type: "command_execution", status: "completed", input: "grep -r microsoft-learn /" }), false);
  assert.equal(callsServer({ type: "dynamic_tool", status: "completed", toolName: "mcp__microsoft-learn__microsoft_docs_search" }), true);
  assert.equal(callsServer({ type: "dynamic_tool", status: "completed", toolSource: { key: "mcp:microsoft-learn" }, toolName: "search" }), true);
  assert.equal(callsServer({ type: "dynamic_tool", status: "failed", toolSource: { key: "mcp:microsoft-learn" } }), false);
});

test("jack-tools-proof fails a turn that moves its session or reaches outside the Bot workspace", () => {
  const ws = "/home/u/.jack-local-scratch/seats/abc/agents/bot";
  const exec = code => ({ type: "dynamic_tool", toolName: "execute", input: { code } });
  assert.equal(leavesWorkspace(exec('await tools.opencode.session_move({ directory: "/tmp/kra10869-ocws-x" })'), ws), true);
  assert.equal(leavesWorkspace({ type: "command_execution", input: "find / -name opencode.json" }, ws), true);
  assert.equal(leavesWorkspace({ type: "command_execution", input: "cat ~/.config/opencode/opencode.json" }, ws), true);
  assert.equal(leavesWorkspace({ type: "file_read", input: { path: "/home/u/.t3/caches/opencode.json" } }, ws), true);
  assert.equal(leavesWorkspace({ type: "file_read", input: { path: `${ws}/opencode.json` } }, ws), false);
  assert.equal(leavesWorkspace(exec('return await tools["microsoft-learn"].microsoft_docs_fetch({ url: "https://learn.microsoft.com/cli/azure" })'), ws), false);
});

test("B3 P1-1 on #109: outside a container the proof script refuses before it reaches any T3", { skip: process.platform === "win32" }, async () => {
  const fs = await import("node:fs");
  if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) return; // the container case is the allowed one
  const { spawnSync } = await import("node:child_process");
  const run = env => spawnSync(process.execPath, [new URL("../scripts/jack-tools-proof.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LAB: "opencode", MODEL: "m", ...env }, encoding: "utf8", timeout: 20_000,
  });
  // An unreachable T3 address: any attempt to reach it would show as a different error.
  const refused = run({ T3_URL: "http://127.0.0.1:9", T3_HERMES_TOKEN_FILE: "/nonexistent" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^refusing: not inside a container; a full-access proof turn could read the owner's files and loopback services/);
  assert.equal(refused.stdout, "");
  const bare = run({});
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /^refusing: set T3_URL and T3_HERMES_TOKEN_FILE/);
});
