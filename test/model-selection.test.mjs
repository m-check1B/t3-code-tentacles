import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KNOWN_COMMANDS, PACKAGE_VERSION, parseArgs, usage } from "../src/cli.mjs";
import { DEFAULT_INSTANCE_ID } from "../src/config.mjs";
import {
  continueThread,
  ensureProject,
  originate,
  startThread,
} from "../src/bridge.mjs";
import {
  budgetOptionId,
  defaultModelForLab,
  labKind,
  ORIGINATE_LABS,
  parseModelOptionFlag,
  parseModelOptionFlags,
  requireContinueSelection,
  requireRuntimeMode,
  resolveModelSelection,
  retainedSelectionPin,
} from "../src/model-selection.mjs";
import { applyIntent } from "../src/orchestrate.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
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
  assert.equal(budgetOptionId("codex-app", "gpt-5.6-sol"), "reasoningEffort");
  assert.equal(budgetOptionId("hermes", "openai-codex:gpt-5.6-sol"), "reasoningEffort");
  assert.equal(budgetOptionId("hermes", "some-other-model"), null);
  assert.equal(budgetOptionId("claudeAgent", "claude-opus-4-6"), "effort");
  assert.equal(budgetOptionId("grok", "grok-4.7"), "reasoningEffort");
  for (const lab of ["cursor", "deepseek", "kimi", "pi", "opencode"]) {
    assert.equal(budgetOptionId(lab, "any"), null, lab);
  }
});

test("each advertised lab has a kind and only Cursor omits a default model", () => {
  assert.equal(labKind("grok"), "native");
  assert.equal(labKind("codex-app"), "native");
  assert.equal(labKind("hermes"), "adapter");
  assert.equal(labKind("cursor"), "explicit");
  assert.equal(defaultModelForLab("grok"), "grok-4.6");
  assert.equal(defaultModelForLab("hermes"), "deepseek:deepseek-v4-flash");
  assert.equal(defaultModelForLab("codex"), "gpt-5.6-luna");
  assert.equal(defaultModelForLab("codex-app"), "gpt-5.6-luna");
  assert.equal(defaultModelForLab("claudeAgent"), "claude-sonnet-5");
  assert.equal(defaultModelForLab("opencode"), "opencode/big-pickle");
  assert.equal(defaultModelForLab("cursor"), null);
});

test("Cursor is an explicit non-default originate lab with no invented budget option", () => {
  assert.equal(ORIGINATE_LABS.includes("cursor"), true);
  assert.equal(DEFAULT_INSTANCE_ID, "hermes");
  assert.notEqual(DEFAULT_INSTANCE_ID, "cursor");
  assert.deepEqual(
    resolveModelSelection({ instanceId: "cursor", model: "default", budget: "high" }),
    { instanceId: "cursor", model: "default" },
  );
  const parsed = parseArgs([
    "originate",
    "--workspace", "/tmp/cursor-explicit",
    "--title", "Cursor explicit",
    "--message", "validate only",
    "--instance", "cursor",
    "--model", "default",
    "--runtime-mode", "full-access",
  ]);
  assert.equal(parsed.options.instance, "cursor");
  assert.equal(parsed.options["runtime-mode"], "full-access");

  const missingModel = spawnSync(process.execPath, [
    path.resolve("src/cli.mjs"),
    "originate",
    "--workspace", "/tmp/cursor-explicit",
    "--title", "Cursor explicit",
    "--message", "validate only",
    "--instance", "cursor",
    "--runtime-mode", "full-access",
  ], { encoding: "utf8", env: { ...process.env, T3_URL: "http://127.0.0.1:9" } });
  assert.equal(missingModel.status, 1);
  assert.match(`${missingModel.stderr}`, /cursor is an explicit lab; pass --model/);
});

test("Codex CLI and Codex app preserve distinct T3-native instance ids", async () => {
  assert.equal(ORIGINATE_LABS.includes("codex"), true);
  assert.equal(ORIGINATE_LABS.includes("codex-app"), true);
  assert.deepEqual(
    resolveModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", budget: "high" }),
    { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "codex-app", model: "gpt-5.6-sol", budget: "high" }),
    { instanceId: "codex-app", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
  );

  const client = recordingClient();
  await startThread(client, {
    projectId: "p-codex",
    threadId: "t-cli",
    title: "Codex CLI",
    message: "standalone",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    budget: "high",
    runtimeMode: "full-access",
  });
  await startThread(client, {
    projectId: "p-codex",
    threadId: "t-app",
    title: "Codex app",
    message: "app bundled",
    instanceId: "codex-app",
    model: "gpt-5.6-sol",
    budget: "high",
    runtimeMode: "full-access",
  });
  const creates = client.commands.filter((command) => command.type === "thread.create");
  assert.deepEqual(creates.map((command) => command.modelSelection.instanceId), ["codex", "codex-app"]);
  assert.deepEqual(creates.map((command) => command.runtimeMode), ["full-access", "full-access"]);
});

test("Cursor session-init commands preserve the explicit lab and full-access mode", async () => {
  const client = recordingClient();
  await startThread(client, {
    projectId: "p-cursor",
    threadId: "t-cursor",
    title: "Cursor",
    message: "start",
    messageId: "m-cursor",
    instanceId: "cursor",
    model: "default",
    budget: "high",
    runtimeMode: "full-access",
  });
  assert.equal(client.commands[0].type, "thread.create");
  assert.equal(client.commands[1].type, "thread.turn.start");
  for (const command of client.commands) {
    assert.deepEqual(command.modelSelection, { instanceId: "cursor", model: "default" });
    assert.equal(command.runtimeMode, "full-access");
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
    resolveModelSelection({ instanceId: "grok", model: "grok-build", budget: "medium" }),
    { instanceId: "grok", model: "grok-build", options: [{ id: "reasoningEffort", value: "medium" }] },
  );
  // No budget: Grok must not inherit the global xhigh default from ~/.grok/config.toml.
  assert.deepEqual(
    resolveModelSelection({ instanceId: "grok", model: "grok-4.7" }),
    { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }] },
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "hermes", model: "openai-codex:gpt-5.6-sol" }),
    { instanceId: "hermes", model: "openai-codex:gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
  );
});

test("effort policy: every knobbed seat pins an effort, Opus/Astra start medium, never above high", () => {
  assert.deepEqual(
    resolveModelSelection({ instanceId: "claudeAgent", model: "claude-opus-5-5" }).options,
    [{ id: "effort", value: "medium" }],
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "codex", model: "gpt-6-astra" }).options,
    [{ id: "reasoningEffort", value: "medium" }],
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "codex", model: "gpt-6-astra", budget: "high" }).options,
    [{ id: "reasoningEffort", value: "high" }],
  );
  assert.deepEqual(
    resolveModelSelection({ instanceId: "codex", model: "gpt-6-sol" }).options,
    [{ id: "reasoningEffort", value: "high" }],
  );
  for (const [instanceId, model, id] of [["grok", "grok-4.7", "reasoningEffort"], ["codex", "gpt-6-astra", "reasoningEffort"], ["claudeAgent", "claude-opus-5-5", "effort"]]) {
    for (const value of ["xhigh", "max"]) {
      assert.throws(
        () => resolveModelSelection({ instanceId, model, options: [{ id, value }] }),
        /above high is Founder-manual only/,
        `${instanceId} ${value}`,
      );
    }
  }
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
  assert.equal(client.commands[1].runtimeMode, "auto-accept-edits");

  await continueThread(client, {
    threadId: "t1",
    message: "again",
    messageId: "m2",
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    options: [{ id: "contextWindow", value: "1m" }],
    budget: "low",
    runtimeMode: "full-access",
  });
  assert.deepEqual(client.commands[2].modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
    options: [{ id: "contextWindow", value: "1m" }, { id: "effort", value: "low" }],
  });
});

test("continueThread preserves an existing non-Hermes selection when lab/model are omitted", async () => {
  const client = recordingClient();
  await startThread(client, {
    projectId: "p1",
    threadId: "grok-thread",
    title: "Grok",
    message: "hello",
    messageId: "m1",
    instanceId: "grok",
    model: "grok-build",
    runtimeMode: "auto-accept-edits",
  });
  assert.deepEqual(client.threads.get("grok-thread").modelSelection, {
    instanceId: "grok",
    model: "grok-build",
    options: [{ id: "reasoningEffort", value: "high" }],
  });

  await continueThread(client, {
    threadId: "grok-thread",
    message: "again",
    messageId: "m2",
    runtimeMode: "auto-accept-edits",
  });
  const continued = client.commands[2];
  assert.equal(continued.type, "thread.turn.start");
  assert.equal("modelSelection" in continued, false);
  assert.notDeepEqual(continued.modelSelection, {
    instanceId: "hermes",
    model: "openai-codex:gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  assert.equal(continued.runtimeMode, "auto-accept-edits");
  assert.equal(continued.message.messageId, "m2");
  assert.deepEqual(client.threads.get("grok-thread").modelSelection, {
    instanceId: "grok",
    model: "grok-build",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  assert.equal(client.threads.get("grok-thread").messages.some((entry) => entry.id === "m2"), true);

  const beforeReplay = client.commands.length;
  await continueThread(client, {
    threadId: "grok-thread",
    message: "again",
    messageId: "m2",
    runtimeMode: "full-access",
  });
  assert.equal(client.commands.length, beforeReplay);

  await continueThread(client, {
    threadId: "grok-thread",
    message: "switch",
    messageId: "m3",
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "serviceTier", value: "default" }],
    budget: "high",
    runtimeMode: "full-access",
  });
  assert.deepEqual(client.commands[3].modelSelection, {
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "serviceTier", value: "default" }, { id: "reasoningEffort", value: "high" }],
  });
});

test("continueThread refuses partial selections instead of falling back to Hermes defaults", async () => {
  const client = recordingClient();
  await startThread(client, {
    projectId: "p1",
    threadId: "partial-thread",
    title: "Partial",
    message: "hello",
    messageId: "m1",
    instanceId: "grok",
    model: "grok-build",
    runtimeMode: "full-access",
  });
  const beforePartials = client.commands.length;

  for (const [messageId, partial] of [
    ["only-model", { model: "openai-codex:gpt-5.6-sol" }],
    ["only-instance", { instanceId: "codex" }],
    ["only-budget", { budget: "high" }],
    ["only-options", { options: [{ id: "serviceTier", value: "default" }] }],
  ]) {
    await assert.rejects(
      () => continueThread(client, { threadId: "partial-thread", message: messageId, messageId, runtimeMode: "full-access", ...partial }),
      /Partial continue selection/,
    );
  }
  assert.equal(client.commands.length, beforePartials);

  await continueThread(client, {
    threadId: "partial-thread",
    message: "all-omitted",
    messageId: "m4",
    runtimeMode: "full-access",
  });
  assert.equal("modelSelection" in client.commands[beforePartials], false);
  assert.deepEqual(client.threads.get("partial-thread").modelSelection, {
    instanceId: "grok",
    model: "grok-build",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
});

test("continueThread rejects explicit null lab/model instead of substituting Hermes defaults", async () => {
  const client = recordingClient();
  await startThread(client, {
    projectId: "p1",
    threadId: "null-thread",
    title: "Null",
    message: "hello",
    messageId: "m1",
    instanceId: "grok",
    model: "grok-build",
    runtimeMode: "full-access",
  });
  const beforeNulls = client.commands.length;

  await assert.rejects(
    () => continueThread(client, {
      threadId: "null-thread",
      message: "null-instance",
      messageId: "m2",
      instanceId: null,
      runtimeMode: "full-access",
    }),
    /Partial continue selection \(instanceId\)/,
  );
  await assert.rejects(
    () => continueThread(client, {
      threadId: "null-thread",
      message: "null-model",
      messageId: "m3",
      model: null,
      runtimeMode: "full-access",
    }),
    /Partial continue selection \(model\)/,
  );
  await assert.rejects(
    () => continueThread(client, {
      threadId: "null-thread",
      message: "null-both",
      messageId: "m4",
      instanceId: null,
      model: null,
      runtimeMode: "full-access",
    }),
    /modelSelection\.instanceId must be a non-empty string/,
  );

  assert.equal(client.commands.length, beforeNulls);
  assert.equal(client.commands.some((command) => command.modelSelection?.instanceId === "hermes"), false);
  assert.equal(
    client.commands.some((command) => command.modelSelection?.model === "openai-codex:gpt-5.6-sol"),
    false,
  );
  assert.deepEqual(client.threads.get("null-thread").modelSelection, {
    instanceId: "grok",
    model: "grok-build",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
});

test("startThread omits options for a lab without an effort knob", async () => {
  const client = recordingClient();
  await startThread(client, {
    projectId: "p1",
    threadId: "watch-thread",
    title: "Watch",
    message: "hello",
    messageId: "watch-message",
    instanceId: "kimi",
    model: "moonshotai/kimi-k3",
    runtimeMode: "full-access",
  });
  assert.deepEqual(client.commands[0].modelSelection, { instanceId: "kimi", model: "moonshotai/kimi-k3" });
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
    runtimeMode: "full-access",
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

  const jsonDoctor = parseArgs(["doctor", "--json"]);
  assert.equal(jsonDoctor.command, "doctor");
  assert.equal(jsonDoctor.options.json, true);

  const help = usage();
  assert.match(help, /^Tentacles — chair CLI and additive ACP adapters for T3 Code/m);
  assert.match(help, /Hermes was the first tentacle/);
  assert.match(help, /tentacles doctor \[--json\]/);
  assert.match(help, /tentacles observe/);
  assert.match(help, /tentacles report --thread THREAD_ID/);
  assert.match(help, /report --thread returns a compact parent-check document/);
  assert.match(help, /tentacles pair --pair-file OWNER_ONLY_JSON --machine-id SPHERE_MACHINE_ID/);
  assert.match(help, /one-shot pair offer is read from a 0600 file/);
  assert.match(help, /Never pass a token on the\s+command line/);
  assert.match(help, /Advertised is not proved/);
  assert.match(help, /originate --workspace PATH --title TITLE --message TEXT --runtime-mode approval-required\|auto-accept-edits\|auto\|full-access/);
  assert.match(help, /--instance hermes\|codex\|codex-app\|claudeAgent\|grok\|cursor\|deepseek\|kimi\|pi\|opencode/);
  assert.doesNotMatch(help, /claude-openrouter|install-claude-openrouter-provider/);
  assert.match(help, /install-codex-app-provider \[--instance codex-app\] \[--codex-app-bin PATH\]/);
  assert.match(help, /--instance codex uses T3's standalone CLI runtime/);
  assert.match(help, /--instance codex-app uses the separately configured Codex app-bundled runtime/);
  assert.match(help, /--model MODEL/);
  assert.match(help, /--runtime-mode approval-required\|auto-accept-edits\|auto\|full-access/);
  assert.doesNotMatch(help, /\[--runtime-mode/);
  assert.match(help, /Runtime mode safety invariant/);
  assert.match(help, /Every originate and every non-empty continue runs full-access/);
  assert.match(help, /T3-native selections and every Tentacles-additive adapter/);
  assert.match(help, /Omitting the runtime mode fails closed/);
  assert.match(help, /"runtimeMode":"full-access"/);
  assert.match(help, /--budget low\|medium\|high/);
  assert.match(help, /--option id=value/);

  const spawned = spawnSync(process.execPath, [path.resolve("src/cli.mjs"), "help"], { encoding: "utf8" });
  assert.equal(spawned.status, 0);
  assert.match(spawned.stdout, /--budget low\|medium\|high/);
  assert.match(spawned.stdout, /--option id=value/);
  assert.match(spawned.stdout, /Every originate and every non-empty continue runs full-access/);
});

test("both public CLI names print the package version", () => {
  assert.equal(PACKAGE_VERSION, "0.4.1");
  for (const flag of ["--version", "-V"]) {
    const source = spawnSync(process.execPath, [path.resolve("src/cli.mjs"), flag], { encoding: "utf8" });
    assert.equal(source.status, 0, flag);
    assert.equal(source.stdout, "0.4.1\n", flag);
  }
  const alias = spawnSync(path.resolve("bin/t3-agent-bridge"), ["--version"], { encoding: "utf8" });
  assert.equal(alias.status, 0);
  assert.equal(alias.stdout, "0.4.1\n");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-cli-symlink-"));
  const linkedRoot = path.join(directory, "repo");
  fs.symlinkSync(path.resolve("."), linkedRoot, "dir");
  try {
    const linked = spawnSync(process.execPath, [path.join(linkedRoot, "src/cli.mjs"), "--version"], { encoding: "utf8" });
    assert.equal(linked.status, 0);
    assert.equal(linked.stdout, "0.4.1\n");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI originate rejects unknown options before applying the Hermes default", () => {
  assert.throws(
    () => parseArgs(["originate", "--provider", "grok"]),
    /Unknown originate option --provider; run tentacles help for supported options/,
  );
  assert.throws(
    () => parseArgs(["originate", "--provider"]),
    /Unknown originate option --provider/,
  );

  const spawned = spawnSync(process.execPath, [
    path.resolve("src/cli.mjs"),
    "originate",
    "--provider", "grok",
  ], { encoding: "utf8" });
  assert.equal(spawned.status, 1);
  assert.match(spawned.stderr, /Unknown originate option --provider/);
  assert.doesNotMatch(spawned.stderr, /Missing required option|openai-codex|ECONNREFUSED/);
});

test("CLI rejects removed and unknown lab routes before constructing a T3 client", () => {
  for (const instance of ["claude-openrouter", "unknown-lab"]) {
    const spawned = spawnSync(process.execPath, [
      path.resolve("src/cli.mjs"), "originate",
      "--workspace", "/tmp/tentacles-rejected-lab",
      "--title", "Rejected lab",
      "--message", "must not dispatch",
      "--instance", instance,
      "--model", "placeholder",
      "--runtime-mode", "full-access",
    ], { encoding: "utf8", env: { ...process.env, T3_HERMES_TOKEN_FILE: "/definitely/missing/token" } });
    assert.equal(spawned.status, 1);
    assert.match(spawned.stderr, /--instance must be an advertised Tentacles lab/);
    assert.doesNotMatch(spawned.stderr, /token|ENOENT/i);
  }

  for (const command of [
    "install-provider", "remove-provider", "install-pi-provider", "remove-pi-provider",
    "install-deepseek-provider", "remove-deepseek-provider", "install-kimi-provider", "remove-kimi-provider",
  ]) {
    const spawned = spawnSync(process.execPath, [path.resolve("src/cli.mjs"), command, "--instance", "claude-openrouter"], {
      encoding: "utf8",
      env: { ...process.env, T3_HERMES_TOKEN_FILE: "/definitely/missing/token" },
    });
    assert.equal(spawned.status, 1, command);
    assert.match(spawned.stderr, /reserved legacy state/, command);
    assert.doesNotMatch(spawned.stderr, /ENOENT/, command);
  }
});

test("every command the usage advertises is dispatchable", () => {
  const advertised = new Set();
  for (const line of usage().split("\n")) {
    const match = /^  tentacles ([a-z][a-z-]*)\b/.exec(line);
    if (match) advertised.add(match[1]);
  }
  assert.equal(advertised.has("report"), true);
  assert.equal(advertised.has("install-codex-app-provider"), true);
  for (const command of advertised) {
    assert.equal(KNOWN_COMMANDS.has(command), true, `usage advertises ${command} but the CLI rejects it`);
  }
});

// ── KRA-6202 Gate 4: F2 ambiguous duplicate options ─────────────────────────

test("duplicate option IDs are rejected in either order, for xhigh/max and conflicting legal values", () => {
  const efforts = [
    ["high", "xhigh"],
    ["xhigh", "high"],
    ["high", "max"],
    ["max", "high"],
    ["high", "low"],
    ["high", "high"],
  ];
  for (const [first, second] of efforts) {
    for (const [instanceId, model] of [["grok", "grok-4.7"], ["codex", "gpt-5.6-sol"], ["codex-app", "gpt-5.6-luna"]]) {
      assert.throws(
        () => resolveModelSelection({
          instanceId,
          model,
          options: [{ id: "reasoningEffort", value: first }, { id: "reasoningEffort", value: second }],
        }),
        /must not repeat option id reasoningEffort/,
        `${instanceId} ${first},${second}`,
      );
    }
    assert.throws(
      () => resolveModelSelection({
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: first }, { id: "effort", value: second }],
      }),
      /must not repeat option id effort/,
    );
  }
  // Budget cannot hide a duplicate either.
  assert.throws(
    () => resolveModelSelection({
      instanceId: "grok",
      model: "grok-4.7",
      budget: "high",
      options: [{ id: "reasoningEffort", value: "high" }, { id: "reasoningEffort", value: "xhigh" }],
    }),
    /must not repeat option id reasoningEffort/,
  );
});

test("conflicting Cursor fast-mode duplicates are rejected with and without the alias", () => {
  for (const model of ["composer-2.5-fast", "composer-2.5"]) {
    for (const values of [[true, false], [false, true], [true, true]]) {
      assert.throws(
        () => resolveModelSelection({
          instanceId: "cursor",
          model,
          options: values.map((value) => ({ id: "fastMode", value })),
        }),
        /must not repeat option id fastMode/,
        `${model} ${values}`,
      );
    }
  }
});

test("repeated --option flags with the same ID fail before any dispatch", async () => {
  const cases = [
    ["reasoningEffort=high", "reasoningEffort=xhigh"],
    ["reasoningEffort=xhigh", "reasoningEffort=high"],
    ["reasoningEffort=high", "reasoningEffort=max"],
  ];
  for (const flags of cases) {
    const parsed = parseArgs([
      "originate",
      "--workspace", "/tmp/w",
      "--title", "T",
      "--message", "M",
      "--instance", "grok",
      "--model", "grok-4.7",
      "--runtime-mode", "full-access",
      ...flags.flatMap((flag) => ["--option", flag]),
    ]);
    const options = parseModelOptionFlags(parsed.options.option);
    assert.throws(
      () => resolveModelSelection({ instanceId: parsed.options.instance, model: parsed.options.model, options }),
      /must not repeat option id reasoningEffort/,
    );
    const client = recordingClient();
    await assert.rejects(
      originate(client, { workspace: "/tmp/w", title: "T", message: "M", instanceId: "grok", model: "grok-4.7", options, runtimeMode: "full-access" }),
      /must not repeat option id reasoningEffort/,
    );
    await assert.rejects(
      continueThread(client, { threadId: "t", message: "M", instanceId: "grok", model: "grok-4.7", options, runtimeMode: "full-access" }),
      /must not repeat option id reasoningEffort/,
    );
    assert.equal(client.commands.length, 0);
  }
  const cursorFlags = parseModelOptionFlags(["fastMode=true", "fastMode=false"]);
  assert.throws(
    () => resolveModelSelection({ instanceId: "cursor", model: "composer-2.5", options: cursorFlags }),
    /must not repeat option id fastMode/,
  );
});

// ── KRA-6202 Gate 4: F3 retained-seat continues ─────────────────────────────

function retainedThreadClient(modelSelection, { messages = [] } = {}) {
  const client = recordingClient();
  client.threads.set("retained", { id: "retained", projectId: "p1", modelSelection, messages: [...messages] });
  return client;
}

test("retainedSelectionPin keeps lab/model, pins a missing knob, and returns undefined when already valid", () => {
  assert.deepEqual(retainedSelectionPin({ instanceId: "grok", model: "grok-4.7" }), {
    instanceId: "grok",
    model: "grok-4.7",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  assert.deepEqual(retainedSelectionPin({ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "contextWindow", value: "1m" }] }), {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "contextWindow", value: "1m" }, { id: "effort", value: "medium" }],
  });
  assert.equal(retainedSelectionPin({ instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "low" }] }), undefined);
  assert.equal(retainedSelectionPin({ instanceId: "kimi", model: "moonshotai/kimi-k3" }), undefined);
  // Retained Cursor models are not re-aliased: the exact model is preserved.
  assert.equal(retainedSelectionPin({ instanceId: "cursor", model: "composer-2.5-fast" }), undefined);
  assert.equal(retainedSelectionPin({ instanceId: "cursor", model: "composer-2.5", options: [{ id: "fastMode", value: true }] }), undefined);
  for (const bad of [null, undefined, {}, [], { instanceId: "grok" }, { model: "grok-4.7" }]) {
    assert.throws(() => retainedSelectionPin(bad), /unproven|must be a non-empty string/);
  }
});

test("continueThread pins an unpinned retained seat without switching lab or model", async () => {
  for (const [retained, expected] of [
    [{ instanceId: "grok", model: "grok-4.7" }, { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }] }],
    [{ instanceId: "codex", model: "gpt-6-astra", options: [{ id: "serviceTier", value: "default" }] }, {
      instanceId: "codex",
      model: "gpt-6-astra",
      options: [{ id: "serviceTier", value: "default" }, { id: "reasoningEffort", value: "medium" }],
    }],
    [{ instanceId: "codex-app", model: "gpt-5.6-luna" }, { instanceId: "codex-app", model: "gpt-5.6-luna", options: [{ id: "reasoningEffort", value: "high" }] }],
  ]) {
    const client = retainedThreadClient(retained);
    await continueThread(client, { threadId: "retained", message: "go", messageId: "m1", runtimeMode: "full-access" });
    assert.equal(client.commands.length, 1);
    assert.equal(client.commands[0].type, "thread.turn.start");
    assert.deepEqual(client.commands[0].modelSelection, expected);
    assert.equal(client.commands[0].runtimeMode, "full-access");
    assert.notEqual(client.commands[0].modelSelection.instanceId, DEFAULT_INSTANCE_ID);
  }
});

test("continueThread leaves valid-pinned and knobless retained seats unchanged", async () => {
  for (const retained of [
    { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "low" }] },
    { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] },
    { instanceId: "kimi", model: "moonshotai/kimi-k3" },
    { instanceId: "cursor", model: "composer-2.5", options: [{ id: "fastMode", value: true }] },
    { instanceId: "opencode", model: "opencode/big-pickle" },
  ]) {
    const client = retainedThreadClient(retained);
    await continueThread(client, { threadId: "retained", message: "go", messageId: "m1", runtimeMode: "auto-accept-edits" });
    assert.equal(client.commands.length, 1);
    assert.equal("modelSelection" in client.commands[0], false, retained.instanceId);
    assert.equal(client.commands[0].runtimeMode, "auto-accept-edits");
  }
});

test("continueThread refuses prohibited, ambiguous, or unproven retained selections before dispatch", async () => {
  for (const [retained, pattern] of [
    [{ instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "xhigh" }] }, /above high is Founder-manual only/],
    [{ instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "max" }] }, /above high is Founder-manual only/],
    [{ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }] }, /above high is Founder-manual only/],
    [{ instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }, { id: "reasoningEffort", value: "xhigh" }] }, /must not repeat option id reasoningEffort/],
    [null, /unproven/],
    [undefined, /unproven/],
  ]) {
    const client = retainedThreadClient(retained);
    await assert.rejects(
      continueThread(client, { threadId: "retained", message: "go", messageId: "m1", runtimeMode: "full-access" }),
      pattern,
    );
    assert.equal(client.commands.length, 0);
  }
});

test("retained-seat validation preserves idempotent replay and the explicit runtime-mode gate", async () => {
  // A replay of an already-projected message dispatches nothing and does not re-judge the seat.
  const replay = retainedThreadClient(
    { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "xhigh" }] },
    { messages: [{ id: "m-done", role: "user", text: "go" }] },
  );
  assert.deepEqual(
    await continueThread(replay, { threadId: "retained", message: "go", messageId: "m-done", turnCommandId: "cmd-done", runtimeMode: "full-access" }),
    { threadId: "retained", projectId: "p1", messageId: "m-done", turnCommandId: "cmd-done" },
  );
  assert.equal(replay.commands.length, 0);

  const pinned = retainedThreadClient({ instanceId: "grok", model: "grok-4.7" });
  await continueThread(pinned, { threadId: "retained", message: "go", messageId: "m1", runtimeMode: "full-access" });
  await continueThread(pinned, { threadId: "retained", message: "go", messageId: "m1", runtimeMode: "full-access" });
  assert.equal(pinned.commands.length, 1);

  const missingMode = retainedThreadClient({ instanceId: "grok", model: "grok-4.7" });
  await assert.rejects(
    continueThread(missingMode, { threadId: "retained", message: "go", messageId: "m1" }),
    /runtimeMode is required/,
  );
  assert.equal(missingMode.commands.length, 0);
});

test("act thread.continue/thread.restart apply the same retained-seat contract", async () => {
  function actClient(modelSelection, status = "ready") {
    const commands = [];
    const thread = { id: "t1", modelSelection, messages: [], session: { status, activeTurnId: null, updatedAt: "before", lastError: null } };
    return {
      commands,
      thread: async () => ({ thread }),
      dispatch: async (command) => {
        commands.push(command);
        if (command.type === "thread.session.stop") thread.session = { ...thread.session, status: "stopped" };
        if (command.type === "thread.turn.start") {
          thread.messages.push({ id: command.message.messageId, role: "user" });
          thread.session = { status: "running", activeTurnId: "turn", updatedAt: "after", lastError: null };
        }
        return { sequence: commands.length };
      },
    };
  }
  const waits = { intervalMs: 0, timeoutMs: 1_000 };

  const unpinned = actClient({ instanceId: "grok", model: "grok-4.7" });
  await applyIntent(unpinned, { action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access" }, waits);
  assert.deepEqual(unpinned.commands[0].modelSelection, { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }] });

  const valid = actClient({ instanceId: "kimi", model: "moonshotai/kimi-k3" });
  await applyIntent(valid, { action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access" }, waits);
  assert.equal("modelSelection" in valid.commands[0], false);

  // A prohibited retained effort fails before the restart stop is dispatched too.
  for (const action of ["thread.continue", "thread.restart"]) {
    const prohibited = actClient({ instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "xhigh" }] }, "error");
    await assert.rejects(
      applyIntent(prohibited, { action, threadId: "t1", text: "go", runtimeMode: "full-access" }, waits),
      /above high is Founder-manual only/,
    );
    assert.equal(prohibited.commands.length, 0, action);
  }

  const unprojected = { commands: [], thread: async () => { throw new T3HttpError({ method: "GET", pathname: "t1", status: 404, body: null }); }, dispatch: async (command) => { unprojected.commands.push(command); } };
  await assert.rejects(
    applyIntent(unprojected, { action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access" }, waits),
    /retained model selection is unproven/,
  );
  assert.equal(unprojected.commands.length, 0);

  // An explicit selection is unchanged by the retained check.
  const explicit = actClient({ instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "xhigh" }] });
  await applyIntent(explicit, { action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access", instanceId: "codex", model: "gpt-5.6-sol" }, waits);
  assert.deepEqual(explicit.commands[0].modelSelection, { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] });
});

test("the pair relay continue inherits retained-seat pinning through continueThread", async () => {
  const client = retainedThreadClient({ instanceId: "grok", model: "grok-4.7" });
  const runtime = new LoopbackRuntimeAdapter({ client });
  await runtime.continue({ threadId: "retained", message: "go", messageId: "m1" });
  assert.deepEqual(client.commands[0].modelSelection, { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }] });

  const prohibited = retainedThreadClient({ instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "xhigh" }] });
  await assert.rejects(
    new LoopbackRuntimeAdapter({ client: prohibited }).continue({ threadId: "retained", message: "go", messageId: "m1" }),
    /above high is Founder-manual only/,
  );
  assert.equal(prohibited.commands.length, 0);
});

// G5-R1: partial selection input fails closed on every continue surface.
const PARTIAL_SELECTIONS = [
  ["budget-only", { budget: "low" }],
  ["options-empty", { options: [] }],
  ["options-null", { options: null }],
  ["options-duplicate", { options: [{ id: "reasoningEffort", value: "high" }, { id: "reasoningEffort", value: "xhigh" }] }],
  ["options-prohibited", { options: [{ id: "reasoningEffort", value: "xhigh" }] }],
  ["instance-only", { instanceId: "codex" }],
  ["model-only", { model: "gpt-5.6-sol" }],
  ["instance-and-budget", { instanceId: "grok", budget: "low" }],
  ["model-and-options", { model: "grok-4.7", options: [{ id: "reasoningEffort", value: "low" }] }],
];
const RETAINED_GROK = { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }] };

function selectionActClient(modelSelection, status = "ready") {
  const commands = [];
  const thread = { id: "t1", modelSelection: structuredClone(modelSelection), messages: [], session: { status, activeTurnId: null, updatedAt: "before", lastError: null } };
  return {
    commands,
    thread: async () => ({ thread }),
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "thread.session.stop") thread.session = { ...thread.session, status: "stopped", updatedAt: "stopped" };
      if (command.type === "thread.turn.start") {
        thread.messages.push({ id: command.message.messageId, role: "user" });
        if (command.modelSelection) thread.modelSelection = structuredClone(command.modelSelection);
        thread.session = { status: "running", activeTurnId: "turn", updatedAt: "after", lastError: null };
      }
      return { sequence: commands.length };
    },
  };
}

test("requireContinueSelection accepts all-omitted or instanceId+model and refuses every partial", () => {
  assert.equal(requireContinueSelection({}), false);
  assert.equal(requireContinueSelection({ instanceId: undefined, model: undefined, options: undefined, budget: undefined }), false);
  assert.equal(requireContinueSelection({ instanceId: "grok", model: "grok-4.7" }), true);
  assert.equal(requireContinueSelection({ instanceId: "grok", model: "grok-4.7", budget: "low", options: [] }), true);
  for (const [name, partial] of [...PARTIAL_SELECTIONS, ["modelSelection-only", { modelSelection: RETAINED_GROK }]]) {
    assert.throws(() => requireContinueSelection(partial), /Partial continue selection/, name);
  }
});

test("library and relay continue refuse partial selections with zero dispatch", async () => {
  for (const [name, partial] of PARTIAL_SELECTIONS) {
    const library = retainedThreadClient(structuredClone(RETAINED_GROK));
    await assert.rejects(
      continueThread(library, { threadId: "retained", message: "go", messageId: "m1", runtimeMode: "full-access", ...partial }),
      /Partial continue selection/,
      `library ${name}`,
    );
    assert.equal(library.commands.length, 0, `library ${name}`);
    assert.deepEqual(library.threads.get("retained").modelSelection, RETAINED_GROK);

    const relayClient = retainedThreadClient(structuredClone(RETAINED_GROK));
    let continueCalls = 0;
    const relay = new LoopbackRuntimeAdapter({
      client: relayClient,
      continueImpl: (...args) => { continueCalls++; return continueThread(...args); },
    });
    await assert.rejects(
      async () => relay.continue({ threadId: "retained", message: "go", messageId: "m1", ...partial }),
      /Partial continue selection/,
      `relay ${name}`,
    );
    assert.equal(continueCalls, 0, `relay ${name}`);
    assert.equal(relayClient.commands.length, 0, `relay ${name}`);
  }
});

test("relay continue keeps explicit and all-omitted selections working", async () => {
  const explicit = retainedThreadClient(structuredClone(RETAINED_GROK));
  await new LoopbackRuntimeAdapter({ client: explicit }).continue({
    threadId: "retained", message: "go", messageId: "m1", instanceId: "codex", model: "gpt-6-astra", budget: "low",
  });
  assert.deepEqual(explicit.commands[0].modelSelection, { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "low" }] });
  assert.equal(explicit.commands[0].runtimeMode, "full-access");

  const retained = retainedThreadClient(structuredClone(RETAINED_GROK));
  const runtime = new LoopbackRuntimeAdapter({ client: retained });
  await runtime.continue({ threadId: "retained", message: "go", messageId: "m1" });
  await runtime.continue({ threadId: "retained", message: "go", messageId: "m1" });
  assert.equal(retained.commands.length, 1);
  assert.equal("modelSelection" in retained.commands[0], false);
});

test("act thread.continue/thread.restart refuse partial selections before any stop or start", async () => {
  const waits = { intervalMs: 0, timeoutMs: 1_000 };
  const partials = [...PARTIAL_SELECTIONS, ["modelSelection-only", { modelSelection: { options: [{ id: "reasoningEffort", value: "low" }] } }]];
  for (const action of ["thread.continue", "thread.restart"]) {
    for (const status of ["ready", "error"]) {
      for (const [name, partial] of partials) {
        const client = selectionActClient(RETAINED_GROK, status);
        await assert.rejects(
          applyIntent(client, { action, threadId: "t1", text: "go", runtimeMode: "full-access", ...partial }, waits),
          /Partial continue selection/,
          `${action} ${status} ${name}`,
        );
        assert.equal(client.commands.length, 0, `${action} ${status} ${name}`);
      }
    }
  }
});

test("act thread.continue/thread.restart keep explicit and all-omitted selections working", async () => {
  const waits = { intervalMs: 0, timeoutMs: 1_000 };
  const explicit = selectionActClient(RETAINED_GROK);
  await applyIntent(explicit, { action: "thread.continue", threadId: "t1", text: "go", runtimeMode: "full-access", instanceId: "grok", model: "grok-4.7", budget: "low" }, waits);
  assert.equal(explicit.commands.length, 1);
  assert.deepEqual(explicit.commands[0].modelSelection, { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "low" }] });

  const restart = selectionActClient(RETAINED_GROK);
  await applyIntent(restart, { action: "thread.restart", threadId: "t1", text: "go", runtimeMode: "full-access", instanceId: "codex", model: "gpt-6-astra", options: [{ id: "serviceTier", value: "default" }] }, waits);
  assert.deepEqual(restart.commands.map((command) => command.type), ["thread.session.stop", "thread.turn.start"]);
  assert.deepEqual(restart.commands[1].modelSelection, {
    instanceId: "codex",
    model: "gpt-6-astra",
    options: [{ id: "serviceTier", value: "default" }, { id: "reasoningEffort", value: "medium" }],
  });

  // An explicit selection is still validated before the restart stop.
  const prohibited = selectionActClient(RETAINED_GROK);
  await assert.rejects(
    applyIntent(prohibited, { action: "thread.restart", threadId: "t1", text: "go", runtimeMode: "full-access", instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "xhigh" }] }, waits),
    /above high is Founder-manual only/,
  );
  assert.equal(prohibited.commands.length, 0);

  const retainedRestart = selectionActClient({ instanceId: "grok", model: "grok-4.7" });
  await applyIntent(retainedRestart, { action: "thread.restart", threadId: "t1", text: "go", runtimeMode: "full-access" }, waits);
  assert.deepEqual(retainedRestart.commands.map((command) => command.type), ["thread.session.stop", "thread.turn.start"]);
  assert.deepEqual(retainedRestart.commands[1].modelSelection, { instanceId: "grok", model: "grok-4.7", options: [{ id: "reasoningEffort", value: "high" }] });
});
