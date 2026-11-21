#!/usr/bin/env node
// KRA-10869 proof road without an Agent Jack app: one Local turn of LAB through this
// Tentacles and the official T3, with only the public Microsoft Learn server in the
// list (no token, no pinned origin), in a scratch Bot workspace of the admitted form.
// Prints T3's turn items, then deletes the thread and project, the workspace and
// (Grok) the trust entry. Exit 0 only when a completed tool item names the server.
//   LAB=opencode MODEL=<slug T3 lists> node scripts/jack-tools-proof.mjs
// An unproven lab needs TENTACLES_JACK_TOOLS_TRY=<lab> as well.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PUBLIC_MCP_URL } from "../src/bot-connectors.mjs";
import { applyIntents } from "../src/orchestrate.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { createAutoReauth } from "../src/t3-auth.mjs";
import { T3Client } from "../src/t3-client.mjs";

const { LAB, MODEL } = process.env;
if (!LAB || !MODEL) throw new Error("set LAB and MODEL");
const scope = { businessId: randomUUID(), seatId: randomUUID(), agentId: randomUUID() };
const seat = path.join(os.homedir(), ".jack-local-scratch", "seats", createHash("sha256").update(`${scope.businessId}:${scope.seatId}`).digest("hex"));
const workspace = path.join(seat, "agents", scope.agentId);
// T3_URL + T3_HERMES_TOKEN_FILE point at a throwaway T3; otherwise the owner's T3.
const client = process.env.T3_URL
  ? new T3Client({ baseUrl: process.env.T3_URL, tokenFile: process.env.T3_HERMES_TOKEN_FILE })
  : new T3Client({ reauth: createAutoReauth() });
const adapter = new LoopbackRuntimeAdapter({ client });
let started;
let proven = false;
try {
  started = await adapter.originate({
    workspace, title: "KRA-10869 proof", instanceId: LAB, model: MODEL, runtimeMode: "full-access",
    message: "Call the microsoft_docs_search tool of the microsoft-learn server with the query \"az login\", then answer with the title of the first result only.",
    mcpServers: [{ name: "microsoft-learn", type: "http", url: PUBLIC_MCP_URL, headers: [] }],
    mcpScope: scope, mcpExpiresAt: Date.now() + 110_000,
  });
  console.log(`thread ${started.threadId}\nworkspace ${workspace}`);
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
    const line = JSON.stringify({ type, status, toolName, toolSource, input, text });
    console.log(line.slice(0, 600));
    if (type !== "assistant_message" && status === "completed" && /microsoft[-_]learn/i.test(line)) proven = true;
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
    const header = `[folders.${JSON.stringify(workspace)}]`;
    const lines = fs.readFileSync(trust, "utf8").split("\n");
    const at = lines.indexOf(header);
    if (at >= 0) {
      lines.splice(at, 3);
      fs.writeFileSync(`${trust}.tmp`, lines.join("\n"), { mode: fs.statSync(trust).mode & 0o777 });
      fs.renameSync(`${trust}.tmp`, trust);
      console.log(`removed the trust entry from ${trust}`);
    }
  }
}
console.log(proven ? "PASS: a completed tool item names microsoft-learn" : "FAIL: no completed tool item names microsoft-learn");
process.exitCode = proven ? 0 : 1;
