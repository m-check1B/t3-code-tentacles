import assert from "node:assert/strict";
import test from "node:test";
import {
  continueThread,
  ensureProject,
  isOpaqueProjectTitle,
  originate,
  resolveProjectTitle,
} from "../src/bridge.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

test("isOpaqueProjectTitle recognizes UUID and 32-hex scratch folder ids only", () => {
  assert.equal(isOpaqueProjectTitle("ec3e4ef4-2f6d-4d4f-a609-866df2f3414f"), true);
  assert.equal(isOpaqueProjectTitle("1ee7e70456815c7198edb0fcbafe64c1"), true);
  assert.equal(isOpaqueProjectTitle("Jack · Code Builder"), false);
  assert.equal(isOpaqueProjectTitle("jack-books"), false);
  assert.equal(isOpaqueProjectTitle(""), false);
  assert.equal(isOpaqueProjectTitle(null), false);
});

test("resolveProjectTitle prefers human-readable Bot title for opaque scratch workspaces", () => {
  assert.equal(
    resolveProjectTitle("/Users/u/.jack-local-scratch/seats/org/agents/ec3e4ef4-2f6d-4d4f-a609-866df2f3414f", "Jack · Code Builder"),
    "Jack · Code Builder",
  );
  assert.equal(
    resolveProjectTitle("/Users/u/.jack-local-scratch/jack-talk/org/1ee7e70456815c7198edb0fcbafe64c1", "Jack · TOP G\n\tAntigravity"),
    "Jack · TOP G Antigravity",
  );
  // Normal repo directories keep their own basename.
  assert.equal(
    resolveProjectTitle("/Users/u/github/jack-books", "Jack · Code Builder"),
    "jack-books",
  );
});

test("ensureProject upgrades existing opaque UUID project title without touching custom titles", async () => {
  const dispatched = [];
  const projects = [
    {
      id: "proj-uuid",
      title: "ec3e4ef4-2f6d-4d4f-a609-866df2f3414f",
      workspaceRoot: "/tmp/.jack-local-scratch/seats/t/agents/ec3e4ef4-2f6d-4d4f-a609-866df2f3414f",
      deletedAt: null,
    },
    {
      id: "proj-custom",
      title: "My Custom Workspace",
      workspaceRoot: "/tmp/.jack-local-scratch/seats/t/agents/1ee7e70456815c7198edb0fcbafe64c1",
      deletedAt: null,
    },
  ];
  const client = {
    async snapshot() { return { projects, threads: [] }; },
    async dispatch(cmd) { dispatched.push(cmd); return { ok: true }; },
  };

  const upgraded = await ensureProject(client, {
    workspace: projects[0].workspaceRoot,
    title: "Jack · Code Builder",
  });
  assert.equal(upgraded.created, false);
  assert.equal(upgraded.project.title, "Jack · Code Builder");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "project.meta.update");
  assert.equal(dispatched[0].projectId, "proj-uuid");
  assert.equal(dispatched[0].title, "Jack · Code Builder");

  // Custom user title is never overwritten.
  const preserved = await ensureProject(client, {
    workspace: projects[1].workspaceRoot,
    title: "Jack · TOP G",
  });
  assert.equal(preserved.project.title, "My Custom Workspace");
  assert.equal(dispatched.length, 1);
});

test("originate titles new scratch-workspace T3 project with the Bot thread title", async () => {
  const dispatched = [];
  const projects = [];
  const threads = new Map();
  const client = {
    async snapshot() { return { projects, threads: [...threads.values()] }; },
    async serverConfig() {
      return {
        providers: [{
          provider: "codex",
          enabled: true,
          status: "ready",
          models: [{ slug: "gpt-6.1-terra", name: "gpt-6.1-terra" }],
        }],
      };
    },
    async thread(id) {
      const t = threads.get(id);
      if (!t) throw new T3HttpError({ method: "GET", pathname: `/threads/${id}`, status: 404, body: "not found" });
      return { thread: t };
    },
    async dispatch(cmd) {
      dispatched.push(cmd);
      if (cmd.type === "project.create") {
        projects.push({ id: cmd.projectId, title: cmd.title, workspaceRoot: cmd.workspaceRoot, deletedAt: null });
      } else if (cmd.type === "thread.create") {
        threads.set(cmd.threadId, { id: cmd.threadId, projectId: cmd.projectId, title: cmd.title, messages: [] });
      } else if (cmd.type === "thread.turn.start") {
        threads.get(cmd.threadId).messages.push({ id: cmd.message.messageId, role: "user", text: cmd.message.text });
      }
      return { ok: true };
    },
  };

  await originate(client, {
    workspace: "/tmp/.jack-local-scratch/seats/org/agents/ec3e4ef4-2f6d-4d4f-a609-866df2f3414f",
    title: "Jack · Code Builder",
    message: "Build Jack Books",
    instanceId: "codex",
    model: "gpt-6.1-terra",
    runtimeMode: "full-access",
  });

  const createProject = dispatched.find((c) => c.type === "project.create");
  assert.ok(createProject);
  assert.equal(createProject.title, "Jack · Code Builder");
});

test("continueThread upgrades legacy opaque project title to the Bot thread title", async () => {
  const dispatched = [];
  const workspace = "/tmp/.jack-local-scratch/seats/org/agents/ec3e4ef4-2f6d-4d4f-a609-866df2f3414f";
  const thread = {
    id: "thread-cb",
    projectId: "proj-cb",
    title: "Jack · Code Builder",
    modelSelection: { provider: "codex", model: "gpt-6.1-terra" },
    messages: [],
  };
  const client = {
    async snapshot() {
      return {
        projects: [{ id: "proj-cb", title: "ec3e4ef4-2f6d-4d4f-a609-866df2f3414f", workspaceRoot: workspace, deletedAt: null }],
        threads: [thread],
      };
    },
    async serverConfig() {
      return {
        providers: [{
          provider: "codex",
          enabled: true,
          status: "ready",
          models: [{ slug: "gpt-6.1-terra", name: "gpt-6.1-terra" }],
        }],
      };
    },
    async thread() { return { thread }; },
    async dispatch(cmd) {
      dispatched.push(cmd);
      if (cmd.type === "thread.turn.start") {
        thread.messages.push({ id: cmd.message.messageId, role: "user", text: cmd.message.text });
      }
      return { ok: true };
    },
  };

  await continueThread(
    client,
    {
      threadId: "thread-cb",
      message: "Continue",
      instanceId: "codex",
      model: "gpt-6.1-terra",
      runtimeMode: "full-access",
      messageId: "msg-1",
    },
    {
      prepareTalkWorkspace: async () => {},
      prefetchedThread: thread,
      prefetchedWorkspace: workspace,
    },
  );

  const rename = dispatched.find((c) => c.type === "project.meta.update");
  assert.ok(rename);
  assert.equal(rename.projectId, "proj-cb");
  assert.equal(rename.title, "Jack · Code Builder");
});
