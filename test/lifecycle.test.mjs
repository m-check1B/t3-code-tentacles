import assert from "node:assert/strict";
import test from "node:test";
import { applyIntent, inspectLeakedSessions } from "../src/orchestrate.mjs";
import { T3HttpError } from "../src/t3-client.mjs";
function harness({ archived = false, refuseStop = false, status = "ready" } = {}) {
  const thread = { id: "throwaway", archivedAt: archived ? "2026-01-01T00:00:00Z" : null, session: { status, activeTurnId: status === "running" ? "turn" : null } };
  const commands = [];
  const client = {
    thread: async () => {
      if (thread.archivedAt) throw new T3HttpError({ method: "GET", pathname: "/thread", status: 404 });
      return { thread: structuredClone(thread) };
    },
    archivedShell: async () => ({ threads: thread.archivedAt ? [structuredClone(thread)] : [] }),
    dispatch: async (command) => {
      commands.push(command);
      if (command.type === "thread.archive") {
        if (thread.archivedAt) throw new Error("already archived");
        thread.archivedAt = "2026-01-01T00:00:00Z";
      }
      if (command.type === "thread.unarchive") thread.archivedAt = null;
      if (command.type === "thread.session.stop" && !thread.archivedAt && !refuseStop) thread.session = { status: "stopped", activeTurnId: null };
      return { sequence: commands.length };
    },
  };
  return { client, thread, commands };
}
for (const action of ["thread.stop", "thread.archive"]) {
  for (const archived of [false, true]) {
    test(`${action} verifies termination even without wait; initially archived=${archived}`, async () => {
      const h = harness({ archived, status: "running" });
      const result = await applyIntent(h.client, { action, threadId: "throwaway" }, { wait: false, timeoutMs: 0 });
      assert.equal(result.projected, true);
      assert.equal(result.sessionStatus, "stopped");
      assert.equal(h.thread.session.activeTurnId, null);
      assert.equal(h.thread.archivedAt != null, archived || action === "thread.archive");
      if (archived) assert.equal(h.commands[0].type, "thread.unarchive");
      assert(h.commands.some((c) => c.type === "thread.session.stop"));
    });
  }
}
test("an unverified stop fails and restores an archived thread", async () => {
  const h = harness({ archived: true, refuseStop: true });
  await assert.rejects(applyIntent(h.client, { action: "thread.stop", threadId: "throwaway" }, { wait: false, timeoutMs: 0 }), /did not verify/);
  assert(h.thread.archivedAt);
  assert.equal(h.thread.session.status, "ready");
});
test("a detail identity mismatch never dispatches", async () => {
  const h = harness();
  h.client.thread = async () => ({ thread: { ...h.thread, id: "someone-else" } });
  await assert.rejects(applyIntent(h.client, { action: "thread.stop", threadId: "throwaway" }), /identity mismatch/);
  assert.equal(h.commands.length, 0);
});
test("doctor reports archived live sessions without prompts or errors", async () => {
  const h = harness({ archived: true });
  h.thread.title = "PRIVATE";
  h.thread.session.lastError = "PRIVATE";
  assert.deepEqual(await inspectLeakedSessions(h.client), { status: "leaked", count: 1, threads: [{ threadId: "throwaway", sessionStatus: "ready" }] });
  h.thread.session = { status: "stopped", activeTurnId: null };
  assert.deepEqual(await inspectLeakedSessions(h.client), { status: "clear", count: 0, threads: [] });
  h.client.archivedShell = async () => { throw new Error("PRIVATE"); };
  assert.deepEqual(await inspectLeakedSessions(h.client), { status: "unavailable", count: null, threads: [] });
});
