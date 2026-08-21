import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseArgs, usage } from "../src/cli.mjs";
import {
  continueThread,
  ensureProject,
  originate,
  startThread,
} from "../src/bridge.mjs";
import {
  budgetOptionId,
  parseModelOptionFlag,
  parseModelOptionFlags,
  requireRuntimeMode,
  resolveModelSelection,
} from "../src/model-selection.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

function recordingClient({ projectWorkspace } = {}) {
  const commands = [];
  const projects = new Map();
  const threads = new Map();
  return {
    commands,
    projects,
    threads,
    shell: async () => ({ projects: [...projects.values()] }),
    thread: async (threadId) => {
      const thread = threads.get(threadId);
      if (!thread) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
      return { thread };
    },
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "project.create") {
        projects.set(command.projectId, {
          id: command.projectId,
          workspaceRoot: command.workspaceRoot || projectWorkspace,
          defaultModelSelection: command.defaultModelSelection,
        });
      } else if (command.type === "thread.create") {
        threads.set(command.threadId, {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          messages: [],
        });
      } else if (command.type === "thread.turn.start") {
        threads.get(command.threadId).messages.push({
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
        });
      }
      return { sequence: commands.length };
    },
  };
}

test("budgetOptionId maps only known lab effort knobs", () => {
  assert.equal(budgetOptionId("codex", "gpt-5.6-sol"), "reasoningEffort");
  assert.equal(budgetOptionId("hermes", "openai-codex:gpt-5.6-sol"), "reasoningEffort");
  assert.equal(budgetOptionId("hermes", "some-other-model"), null);
  assert.equal(budgetOptionId("claudeAgent", "claude-opus-4-6"), "effort");
  for (const lab of ["grok", "deepseek", "kimi", "pi", "opencode"]) {
    assert.equal(budgetOptionId(lab, "any"), null, lab);
  }
});

test("resolveModelSelection maps budget unless an overlapping option is present", () => {
  assert.deepEqual(
    resolveModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", budget: "high" }),
    { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "hermes", model: "openai-codex:gpt-5.6-sol", budget: "medium" }),
    { instanceId: "hermes", model: "openai-codex:gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "medium" }] },
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "claudeAgent", model: "claude-sonnet-5", budget: "low" }),
    { instanceId: "claudeAgent", model: "claude-sonnet-5", options: [{ id: "effort", value: "low" }] },
  );
  assert.deepEqual(
    resolveModelSelection({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      budget: "high",
      options: [{ id: "reasoningEffort", value: "low" }, { id: "serviceTier", value: "default" }],
    }),
    {
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "low" }, { id: "serviceTier", value: "default" }],
    },
  );
  assert.deepEqual(
    resolveModelSelection({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
      budget: "high",
      options: [{ id: "contextWindow", value: "1m" }],
    }),
    {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
      options: [{ id: "contextWindow", value: "1m" }, { id: "effort", value: "high" }],
    },
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "grok", model: "grok-build", budget: "high" }),
    { instanceId: "grok", model: "grok-build" },
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "hermes", model: "openai-codex:gpt-5.6-sol" }),
    { instanceId: "hermes", model: "openai-codex:gpt-5.6-sol" },
  );
});

test("resolveModelSelection and option flags fail closed on invalid input", () => {
  assert.throws(() => resolveModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", budget: "banana" }), /budget must be one of/);
  assert.throws(() => resolveModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: { id: "x" } }), /must be an array/);
  assert.throws(() => resolveModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "", value: "low" }] }), /id/);
  assert.throws(() => resolveModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "" }] }), /value/);
  assert.throws(() => parseModelOptionFlag("reasoningEffort"), /id=value/);
  assert.throws(() => parseModelOptionFlag("=low"), /id=value/);
  assert.throws(() => parseModelOptionFlags(["serviceTier=default", "nope"]), /id=value/);
  assert.throws(() => requireRuntimeMode("banana"), /runtimeMode must be one of/);
});

test("startThread and continueThread put options on the dispatched command JSON", async () => {
  const client = recordingClient();
  await startThread(client, {
    projectId: "p1",
    threadId: "t1",
    title: "Budget",
    message: "go",
    messageId: "m1",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    budget: "high",
    runtimeMode: "auto-accept-edits",
  });
  assert.equal(client.commands.length, 2);
  assert.equal(client.commands[0].type, "thread.create");
  assert.equal(client.commands[1].type, "thread.turn.start");
  const expected = {
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  assert.deepEqual(client.commands[0].modelSelection, expected);
  assert.deepEqual(client.commands[1].modelSelection, expected);
  assert.equal(client.commands[0].runtimeMode, "auto-accept-edits");

  await continueThread(client, {
    threadId: "t1",
    message: "again",
    messageId: "m2",
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    options: [{ id: "contextWindow", value: "1m" }],
    budget: "low",
  });
  assert.deepEqual(client.commands[2].modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    options: [{ id: "contextWindow", value: "1m" }, { id: "effort", value: "low" }],
  });
});

test("startThread omits options when none are provided", async () => {
  const client = recordingClient();
  await startThread(client, {
    projectId: "p1",
    threadId: "watch-thread",
    title: "Watch",
    message: "hello",
    messageId: "watch-message",
    instanceId: "hermes",
    model: "openai-codex:gpt-5.6-sol",
  });
  assert.deepEqual(client.commands[0].modelSelection, { instanceId: "hermes", model: "openai-codex:gpt-5.6-sol" });
  assert.equal("options" in client.commands[0].modelSelection, false);
  assert.equal("options" in client.commands[1].modelSelection, false);
});

test("originate and ensureProject put options on project.create and thread commands", async () => {
  const client = recordingClient();
  await originate(client, {
    workspace: "/tmp/originate-budget",
    title: "Lab budget",
    message: "run this",
    instanceId: "hermes",
    model: "openai-codex:gpt-5.6-sol",
    budget: "high",
    options: [{ id: "serviceTier", value: "default" }],
  });
  const projectCreate = client.commands.find((command) => command.type === "project.create");
  const threadCreate = client.commands.find((command) => command.type === "thread.create");
  const turnStart = client.commands.find((command) => command.type === "thread.turn.start");
  const expected = {
    instanceId: "hermes",
    model: "openai-codex:gpt-5.6-sol",
    options: [{ id: "serviceTier", value: "default" }, { id: "reasoningEffort", value: "high" }],
  };
  assert.deepEqual(projectCreate.defaultModelSelection, expected);
  assert.deepEqual(threadCreate.modelSelection, expected);
  assert.deepEqual(turnStart.modelSelection, expected);

  const existing = recordingClient();
  existing.projects.set("already", { id: "already", workspaceRoot: "/tmp/existing" });
  const ensured = await ensureProject(existing, {
    workspace: "/tmp/existing",
    title: "Existing",
    instanceId: "pi",
    model: "gpt-5.6-terra",
    budget: "high",
  });
  assert.equal(ensured.created, false);
  assert.equal(existing.commands.length, 0);
});

test("CLI parseArgs collects repeatable --option and usage documents originate flags", () => {
  const parsed = parseArgs([
    "originate",
    "--workspace", "/tmp/w",
    "--title", "T",
    "--message", "M",
    "--instance", "codex",
    "--model", "gpt-5.6-sol",
    "--runtime-mode", "full-access",
    "--budget", "high",
    "--option", "serviceTier=default",
    "--option", "reasoningEffort=low",
  ]);
  assert.equal(parsed.command, "originate");
  assert.deepEqual(parsed.options.option, ["serviceTier=default", "reasoningEffort=low"]);
  assert.equal(parsed.options.budget, "high");
  assert.equal(parsed.options.instance, "codex");
  assert.equal(parsed.options["runtime-mode"], "full-access");
  assert.deepEqual(
    resolveModelSelection({
      instanceId: parsed.options.instance,
      model: parsed.options.model,
      options: parseModelOptionFlags(parsed.options.option),
      budget: parsed.options.budget,
    }),
    {
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "serviceTier", value: "default" }, { id: "reasoningEffort", value: "low" }],
    },
  );

  const help = usage();
  assert.match(help, /originate --workspace PATH --title TITLE --message TEXT/);
  assert.match(help, /--instance hermes\|codex\|claudeAgent\|grok\|deepseek\|kimi\|pi\|opencode/);
  assert.match(help, /--model MODEL/);
  assert.match(help, /--runtime-mode approval-required\|auto-accept-edits\|auto\|full-access/);
  assert.match(help, /--budget low\|medium\|high/);
  assert.match(help, /--option id=value/);

  const spawned = spawnSync(process.execPath, [path.resolve("src/cli.mjs"), "help"], { encoding: "utf8" });
  assert.equal(spawned.status, 0);
  assert.match(spawned.stdout, /--budget low\|medium\|high/);
  assert.match(spawned.stdout, /--option id=value/);
});
