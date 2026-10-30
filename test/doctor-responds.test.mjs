import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatDoctor } from "../src/bridge.mjs";
import { probeResponds } from "../src/doctor-probe.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

// KRA-9857: a synthetic T3 whose labs answer, stay silent, or fail. No real providers.
function fakeT3(t, behaviour) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-responds-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const projects = new Map();
  const threads = new Map();
  const commands = [];
  const turns = new Map();
  const client = {
    snapshot: async () => ({ projects: [...projects.values()], threads: [...threads.values()] }),
    thread: async (threadId) => {
      if (!threads.has(threadId)) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread: structuredClone(threads.get(threadId)) };
    },
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "project.create") projects.set(command.projectId, { id: command.projectId, workspaceRoot: command.workspaceRoot });
      if (command.type === "thread.create") threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, title: command.title, modelSelection: command.modelSelection, messages: [], session: null });
      if (command.type === "thread.turn.start") {
        const thread = threads.get(command.threadId);
        const mode = behaviour[command.modelSelection.instanceId];
        thread.messages.push({ id: command.message.messageId, role: "user", text: command.message.text });
        turns.set(command.threadId, { state: "pending", turnId: "turn-1" });
        if (mode === "answer") thread.messages.push({ id: "assistant-1", role: "assistant", text: "OK" });
        thread.session = mode === "error"
          ? { status: "error", activeTurnId: null, lastError: "rate limit exceeded SECRET-CANARY" }
          : { status: "running", activeTurnId: "turn-1" };
      }
      if (command.type === "thread.turn.interrupt") {
        turns.get(command.threadId).state = "cancelled";
        threads.get(command.threadId).session = { status: "ready", activeTurnId: null };
      }
      return { sequence: commands.length };
    },
    request: async (route, { body }) => {
      assert.equal(route, "/api/orchestration/turn-result");
      return { ...body, ...turns.get(body.threadId) };
    },
  };
  return { client, commands, workspace };
}

const labs = [
  { instanceId: "codex", ready: true, defaultModel: "gpt-synthetic" },
  { instanceId: "grok", ready: true, defaultModel: "grok-synthetic" },
  { instanceId: "claudeAgent", ready: true, defaultModel: "claude-synthetic" },
  { instanceId: "pi", ready: false, defaultModel: "pi-synthetic" },
];
const options = (workspace) => ({ workspace, timeoutMs: 400, intervalMs: 10, interruptOptions: { intervalMs: 10, startWaitMs: 200, terminalWaitMs: 200 } });

test("answering, silent and failing labs map to responds, no_response and error", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { codex: "silent", grok: "answer", claudeAgent: "error" });
  const result = await probeResponds(client, labs, options(workspace));
  const row = (id) => result.labs.find((lab) => lab.instanceId === id);
  assert.deepEqual(result.labs.map((lab) => lab.instanceId), ["codex", "grok", "claudeAgent"], "only ready labs by default");

  assert.equal(row("grok").status, "responds");
  assert.equal(typeof row("grok").firstEventMs, "number");
  assert.equal(row("grok").action, undefined);

  assert.equal(row("codex").status, "no_response");
  assert.equal(row("codex").firstEventMs, null);
  assert.match(row("codex").action, /never answers/);
  assert.match(row("codex").action, /--model/);
  assert.equal(row("codex").interrupt, "cancelled");
  const interrupts = commands.filter((command) => command.type === "thread.turn.interrupt");
  assert.equal(interrupts.length, 1, "only the silent probe is interrupted");
  assert.equal(interrupts[0].threadId, row("codex").threadId);
  assert.equal(interrupts[0].turnId, "turn-1");

  assert.equal(row("claudeAgent").status, "error");
  assert.equal(row("claudeAgent").code, "usage_limit");
  assert.doesNotMatch(JSON.stringify(result), /SECRET-CANARY|"OK"/, "no provider or model text leaves the probe");

  const created = commands.filter((command) => command.type === "thread.create");
  assert.ok(created.every((command) => /^Tentacles doctor probe: /.test(command.title)));
  const projectCreates = commands.filter((command) => command.type === "project.create");
  assert.equal(projectCreates.length, 1, "parallel probes share one probe project");
  assert.equal(projectCreates[0].workspaceRoot, workspace);
  assert.ok(commands.filter((command) => command.type === "thread.turn.start").every((command) => command.runtimeMode === "full-access"));
  assert.match(formatDoctor({ labs: [], responds: result }), /Responds probe/);
});

test("a lab list selects exactly those labs; a listed lab that is not ready is an error without a model call", async (t) => {
  const { client, commands, workspace } = fakeT3(t, { grok: "answer" });
  const result = await probeResponds(client, labs, { ...options(workspace), select: ["grok", "pi"] });
  assert.deepEqual(result.labs.map((lab) => [lab.instanceId, lab.status, lab.code ?? null]), [["grok", "responds", null], ["pi", "error", "lab_not_ready"]]);
  assert.equal(commands.filter((command) => command.type === "thread.turn.start").length, 1);
});

test("default doctor text is unchanged without the responds block", () => {
  assert.doesNotMatch(formatDoctor({ labs: [] }), /Responds probe/);
});
