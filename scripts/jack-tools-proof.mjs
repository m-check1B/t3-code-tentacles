#!/usr/bin/env node
// KRA-10869 proof road without an Agent Jack app: one Local turn of LAB through this
// Tentacles and the official T3, with only the public Microsoft Learn server in the
// list (no token, no pinned origin), in a scratch Bot workspace of the admitted form.
// Prints T3's turn items, then deletes the thread and project, the workspace and
// (Grok) the trust entry. Exit 0 only when a completed tool item calls the server AND
// the answer quotes a learn.microsoft.com URL. PROOF_EMPTY=1 sends an empty list: a
// negative control that must FAIL.
//   T3_URL=… T3_HERMES_TOKEN_FILE=… LAB=opencode MODEL=<slug> node scripts/jack-tools-proof.mjs
//   PROOF_OWNER_T3=1 LAB=… MODEL=… node scripts/jack-tools-proof.mjs   # the owner's own T3 and HOME
// An unproven lab needs TENTACLES_JACK_TOOLS_TRY=<lab> as well.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitCodexTrust, PUBLIC_MCP_URL } from "../src/bot-connectors.mjs";
import { applyIntents } from "../src/orchestrate.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { createAutoReauth } from "../src/t3-auth.mjs";
import { T3Client } from "../src/t3-client.mjs";

const { LAB, MODEL } = process.env;
if (!LAB || !MODEL) throw new Error("set LAB and MODEL");
// The owner's live T3 and login HOME only on purpose.
const owner = process.env.PROOF_OWNER_T3 === "1";
if (!owner && !process.env.T3_URL) throw new Error("set T3_URL and T3_HERMES_TOKEN_FILE for a throwaway T3, or PROOF_OWNER_T3=1 for the owner's own T3");
if (!owner && fs.realpathSync(os.homedir()) === fs.realpathSync(os.userInfo().homedir)) throw new Error("HOME is the login home; set a throwaway HOME, or PROOF_OWNER_T3=1");
const servers = process.env.PROOF_EMPTY === "1" ? [] : [{ name: "microsoft-learn", type: "http", url: PUBLIC_MCP_URL, headers: [] }];
const scope = { businessId: randomUUID(), seatId: randomUUID(), agentId: randomUUID() };
const seat = path.join(fs.realpathSync(os.homedir()), ".jack-local-scratch", "seats", createHash("sha256").update(`${scope.businessId}:${scope.seatId}`).digest("hex"));
const workspace = path.join(seat, "agents", scope.agentId);
const client = owner && !process.env.T3_URL
  ? new T3Client({ reauth: createAutoReauth() })
  : new T3Client({ baseUrl: process.env.T3_URL, tokenFile: process.env.T3_HERMES_TOKEN_FILE });
const adapter = new LoopbackRuntimeAdapter({ client });

// Only real tool items count, never a shell command or file search that mentions the name.
const SERVER = /^(?:mcp__)?(?:[a-z0-9-]+_)?microsoft[-_]learn(?:__|$|_)/i;
function callsServer(item) {
  if (item.status !== "completed" || !["dynamic_tool", "mcp_tool_call"].includes(item.type)) return false;
  const source = item.toolSource ?? {};
  if (source.key === "mcp:microsoft-learn" || source.name === "microsoft-learn") return true;
  if (typeof item.toolName === "string" && SERVER.test(item.toolName)) return true;
  // OpenCode 2 runs MCP tools inside its code-mode execute tool.
  return item.toolName === "execute" && /tools\[\s*["']microsoft-learn["']\s*\]/.test(String(item.input?.code ?? ""));
}

let started;
let called = false;
let quoted = false;
try {
  started = await adapter.originate({
    workspace, title: "KRA-10869 proof", instanceId: LAB, model: MODEL, runtimeMode: "full-access",
    message: "Call the microsoft_docs_search tool of the microsoft-learn MCP server with the query \"az login\". Answer with only the URL of the first result. Do not search the web or run shell commands.",
    mcpServers: servers, mcpScope: scope, mcpExpiresAt: Date.now() + 110_000,
  });
  console.log(`thread ${started.threadId}\nworkspace ${workspace}\nlist ${servers.length ? "microsoft-learn" : "empty (negative control)"}`);
  let projection;
  for (let i = 0; i < 100; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    projection = (await client.threadDetail(started.threadId)).projection;
    const run = (projection.runs ?? []).at(-1);
    if (run && !["preparing", "queued", "starting", "running", "waiting"].includes(run.status)) { console.log(`run ${run.status}`); break; }
  }
  // Only the public docs server is in the list, so its input and output are safe to show.
  for (const item of projection?.turnItems ?? []) {
    if (["user_message", "reasoning", "checkpoint"].includes(item.type)) continue;
    const { type, status, toolName, toolSource, input, text } = item;
    console.log(JSON.stringify({ type, status, toolName, toolSource, input, text }).slice(0, 600));
    if (callsServer(item)) called = true;
    if (type === "assistant_message" && typeof text === "string" && text.includes("https://learn.microsoft.com/")) quoted = true;
  }
} finally {
  if (started) {
    await applyIntents(client, [
      { action: "thread.delete", threadId: started.threadId },
      { action: "project.delete", projectId: started.projectId, force: true },
    ]).then(() => console.log("deleted the thread and its project"), error => console.log(`delete failed: ${error.message}`));
  }
  fs.rmSync(seat, { recursive: true, force: true });
  console.log(`removed ${seat}`);
  const trust = path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "trusted_folders.toml");
  if (LAB === "grok" && fs.existsSync(trust)) {
    // Tentacles appended exactly: header, trusted = true, decided_at = <seconds>.
    const file = fs.realpathSync(trust); // a dotfiles link: write its target, keep its mode
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    const at = lines.indexOf(`[folders.${JSON.stringify(workspace)}]`);
    if (at >= 0) {
      lines.splice(at, 3);
      commitCodexTrust({ file, text, mode: fs.statSync(file).mode & 0o777, next: lines.join("\n") });
      console.log(`removed the trust entry from ${trust}`);
    }
  }
}
const proven = called && quoted;
console.log(proven ? "PASS: a completed tool item called microsoft-learn and the answer quotes a learn.microsoft.com URL"
  : `FAIL: tool call ${called ? "seen" : "missing"}, learn.microsoft.com URL in the answer ${quoted ? "seen" : "missing"}`);
process.exitCode = proven ? 0 : 1;
