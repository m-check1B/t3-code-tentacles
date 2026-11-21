#!/usr/bin/env node
// KRA-10869 proof road without an Agent Jack app: one Local turn of LAB through this
// Tentacles and the official T3, with only the public Microsoft Learn server in the
// list (no token, no pinned origin), in a scratch Bot workspace of the admitted form.
// Prints T3's turn items, then deletes the thread and project, the workspace and
// (Grok) the trust entry. PROOF_EMPTY=1 sends an empty list: a negative control that must FAIL.
//
// WHAT A PROOF TURN CAN REACH: T3 runs a Bot connector turn only in full-access mode,
// and T3 offers no per-turn way to deny a lab's shell, file or fetch tools. So the lab's
// model can read every file the T3 user can, run any command, and call every loopback
// service (for example another `opencode serve`), and whatever it reads goes to that
// lab's model provider. A throwaway HOME only moves `~`. Therefore this script runs only:
//   - inside a container whose T3 and lab cannot see the owner's home or other loopback
//     services (checked below: a container marker, no other home readable, no other
//     loopback listener), with T3_URL + T3_HERMES_TOKEN_FILE for the T3 in that container; or
//   - with PROOF_OWNER_T3=1 on the owner's own machine, as a deliberate owner run (the
//     same reach any Local Bot turn there has); its first output line says so.
//   LAB=opencode MODEL=<slug> T3_URL=… T3_HERMES_TOKEN_FILE=… node scripts/jack-tools-proof.mjs   # in the container
//   PROOF_OWNER_T3=1 LAB=… MODEL=… node scripts/jack-tools-proof.mjs                               # owner's own T3
// PASS needs a completed tool item that really calls the server (a source-tagged MCP
// item, or OpenCode `execute` code whose parsed tokens call tools["microsoft-learn"].<tool>(…)),
// a learn.microsoft.com URL in the answer, and nothing that leaves the Bot workspace
// (a session_move, or any absolute path outside it, is FAIL).
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
import { callsServer, leavesWorkspace } from "./jack-tools-proof-check.mjs";

const { LAB, MODEL } = process.env;
if (!LAB || !MODEL) throw new Error("set LAB and MODEL");
const owner = process.env.PROOF_OWNER_T3 === "1";
const refuse = why => { console.error(`refusing: ${why}`); process.exit(2); };
if (owner) {
  console.log("OWNER RUN: this proof uses the owner's own T3 and HOME; the lab turn runs with full access to this user's files and loopback services");
} else {
  if (!process.env.T3_URL || !process.env.T3_HERMES_TOKEN_FILE) refuse("set T3_URL and T3_HERMES_TOKEN_FILE for the T3 inside the container, or PROOF_OWNER_T3=1 on the owner's own machine");
  // The lab runs with full access, so the sandbox must hide the owner's files and services.
  if (!fs.existsSync("/.dockerenv") && !fs.existsSync("/run/.containerenv")) refuse("not inside a container; a full-access proof turn could read the owner's files and loopback services");
  const own = fs.realpathSync(os.homedir());
  for (const root of ["/home", "/Users", "/root"]) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const dir = path.join(root, name);
      if (dir === own || own.startsWith(`${dir}${path.sep}`)) continue;
      try { fs.readdirSync(dir); refuse(`${dir} is readable from here`); } catch { /* hidden or unreadable: fine */ }
    }
  }
  if (fs.existsSync("/proc/net/tcp")) {
    const t3Port = Number(new URL(process.env.T3_URL).port);
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let rows = [];
      try { rows = fs.readFileSync(table, "utf8").split("\n").slice(1); } catch { continue; }
      for (const row of rows) {
        const [, local, , state] = row.trim().split(/\s+/);
        if (state !== "0A" || !local) continue; // LISTEN only
        const port = parseInt(local.split(":").at(-1), 16);
        // Loopback (127.x or ::1) listeners other than this T3 are services a model could call.
        const host = local.split(":")[0];
        const loopback = /^[0-9A-F]{6}7F$/i.test(host) || host === "00000000000000000000000001000000";
        if (loopback && port !== t3Port && !(process.env.PROOF_ALLOW_PORTS ?? "").split(",").includes(String(port))) refuse(`loopback port ${port} is listening; stop it or run in a container without it`);
      }
    }
  }
  // The Grok trust cleanup below edits GROK_HOME: only one inside this throwaway HOME.
  const grokHome = process.env.GROK_HOME;
  if (grokHome && !path.resolve(grokHome).startsWith(`${own}${path.sep}`)) refuse("GROK_HOME is outside this throwaway HOME");
}
const servers = process.env.PROOF_EMPTY === "1" ? [] : [{ name: "microsoft-learn", type: "http", url: PUBLIC_MCP_URL, headers: [] }];
const scope = { businessId: randomUUID(), seatId: randomUUID(), agentId: randomUUID() };
const seat = path.join(fs.realpathSync(os.homedir()), ".jack-local-scratch", "seats", createHash("sha256").update(`${scope.businessId}:${scope.seatId}`).digest("hex"));
const workspace = path.join(seat, "agents", scope.agentId);
const client = owner && !process.env.T3_URL
  ? new T3Client({ reauth: createAutoReauth() })
  : new T3Client({ baseUrl: process.env.T3_URL, tokenFile: process.env.T3_HERMES_TOKEN_FILE });
const adapter = new LoopbackRuntimeAdapter({ client });

let started;
let called = false;
let quoted = false;
let left = false;
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
    if (leavesWorkspace(item, workspace)) left = true;
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
const proven = called && quoted && !left;
console.log(proven ? "PASS: a completed tool item called microsoft-learn, the answer quotes a learn.microsoft.com URL, and nothing left the Bot workspace"
  : `FAIL: tool call ${called ? "seen" : "missing"}, learn.microsoft.com URL in the answer ${quoted ? "seen" : "missing"}, left the Bot workspace ${left ? "yes" : "no"}`);
process.exitCode = proven ? 0 : 1;
