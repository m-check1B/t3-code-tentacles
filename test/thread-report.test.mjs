import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseArgs, usage } from "../src/cli.mjs";
import { T3HttpError } from "../src/t3-client.mjs";
import {
  mapThreadReportStatus,
  projectThreadReport,
  report,
  THREAD_REPORT_STATUSES,
} from "../src/orchestrate.mjs";

test("thread report status enum is the closed parent-check set", () => {
  assert.deepEqual([...THREAD_REPORT_STATUSES], ["Done", "generating", "ready/idle", "blocked"]);
});

test("mapThreadReportStatus covers session, approvals, settledAt, and lastError", () => {
  const cases = [
    {
      name: "settled wins over a live session",
      input: { sessionStatus: "running", settledAt: "2026-09-07T00:00:00.000Z" },
      status: "Done",
    },
    {
      name: "settled wins over lastError",
      input: { sessionStatus: "error", settledAt: "2026-09-07T00:00:00.000Z", lastError: "stale" },
      status: "Done",
    },
    {
      name: "pending approvals block",
      input: { sessionStatus: "running", hasPendingApprovals: true },
      status: "blocked",
    },
    {
      name: "pending user input blocks",
      input: { sessionStatus: "ready", hasPendingUserInput: true },
      status: "blocked",
    },
    { name: "starting generates", input: { sessionStatus: "starting" }, status: "generating" },
    { name: "running generates", input: { sessionStatus: "running" }, status: "generating" },
    {
      name: "live turn keeps generating despite leftover lastError",
      input: { sessionStatus: "running", lastError: "previous turn failed" },
      status: "generating",
    },
    { name: "session error blocks", input: { sessionStatus: "error", lastError: "boom" }, status: "blocked" },
    {
      name: "idle lastError blocks",
      input: { sessionStatus: "idle", lastError: "native grok transport closed" },
      status: "blocked",
    },
    { name: "ready is idle", input: { sessionStatus: "ready" }, status: "ready/idle" },
    { name: "idle is idle", input: { sessionStatus: "idle" }, status: "ready/idle" },
    { name: "stopped is idle", input: { sessionStatus: "stopped" }, status: "ready/idle" },
    { name: "absent session is idle", input: {}, status: "ready/idle" },
    { name: "interrupted blocks", input: { sessionStatus: "interrupted" }, status: "blocked" },
    { name: "unknown session blocks", input: { sessionStatus: "mystery" }, status: "blocked" },
  ];

  for (const entry of cases) {
    const status = mapThreadReportStatus(entry.input);
    assert.equal(status, entry.status, entry.name);
    assert.equal(THREAD_REPORT_STATUSES.includes(status), true, `${entry.name} stays in the enum`);
  }
});

test("projectThreadReport maps modelSelection and pending activities without dumping the thread", () => {
  const reportDocument = projectThreadReport({
    id: "t1",
    title: "must not escape report",
    messages: [{ role: "user", text: "secret prompt" }],
    activities: [{ kind: "approval.requested", payload: { requestId: "approval-1", detail: "secret" } }],
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    session: { status: "ready", lastError: null, activeTurnId: "turn-1" },
  }, "t1");
  assert.deepEqual(reportDocument, {
    threadId: "t1",
    status: "blocked",
    lastError: null,
    model: "gpt-5.6-sol",
  });
  assert.equal(Object.hasOwn(reportDocument, "messages"), false);
  assert.equal(Object.hasOwn(reportDocument, "activities"), false);
  assert.equal(Object.hasOwn(reportDocument, "title"), false);
});

test("report reads one thread over HTTP and never scrapes observe", async () => {
  const client = {
    thread: async (threadId) => {
      assert.equal(threadId, "hire-1");
      return {
        thread: {
          id: "hire-1",
          settledAt: "2026-09-07T12:00:00.000Z",
          modelSelection: { instanceId: "grok", model: "grok-4.6" },
          session: { status: "ready", lastError: null },
        },
      };
    },
    snapshot: async () => { throw new Error("observe snapshot must not be called"); },
    shell: async () => { throw new Error("observe shell must not be called"); },
    archivedShell: async () => { throw new Error("observe archived shell must not be called"); },
  };
  assert.deepEqual(await report(client, "hire-1"), {
    threadId: "hire-1",
    status: "Done",
    lastError: null,
    model: "grok-4.6",
  });

  await assert.rejects(
    report({ snapshot: async () => ({ threads: [] }) }, "hire-1"),
    /does not expose a per-thread read/,
  );
  await assert.rejects(
    report({
      thread: async () => { throw new T3HttpError({ method: "GET", pathname: "/api/orchestration/threads/missing", status: 404, body: null }); },
    }, "missing"),
    /T3 GET \/api\/orchestration\/threads\/missing failed \(404\)/,
  );
  await assert.rejects(report({ thread: async () => ({}) }, "empty"), /is not projected/);
});

test("CLI usage and parseArgs document report --thread", () => {
  const parsed = parseArgs(["report", "--thread", "hire-1"]);
  assert.equal(parsed.command, "report");
  assert.equal(parsed.options.thread, "hire-1");

  const help = usage();
  assert.match(help, /tentacles report --thread THREAD_ID/);
  assert.match(help, /Done \| generating \|\s+ready\/idle \| blocked/);
  assert.match(help, /does not scrape the observe snapshot/);

  const spawned = spawnSync(process.execPath, [path.resolve("src/cli.mjs"), "help"], { encoding: "utf8" });
  assert.equal(spawned.status, 0);
  assert.match(spawned.stdout, /tentacles report --thread THREAD_ID/);
});
