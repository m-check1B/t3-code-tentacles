import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseArgs, usage } from "../src/cli.mjs";
import { T3HttpError } from "../src/t3-client.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import {
  mapThreadReportStatus,
  projectThreadReport,
  report,
  REPORT_ERROR_MARKER,
  REPORT_MODEL_LABEL,
  THREAD_REPORT_STATUSES,
} from "../src/orchestrate.mjs";

test("thread report status enum is the closed parent-check set", () => {
  assert.deepEqual([...THREAD_REPORT_STATUSES], ["Done", "generating", "ready/idle", "blocked"]);
});

test("CLI and real relay projection share the status truth table, including unproven", async () => {
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
    { name: "absent session is unproven", input: {}, status: null },
    { name: "interrupted is unproven", input: { sessionStatus: "interrupted" }, status: null },
    { name: "unknown session is unproven", input: { sessionStatus: "mystery" }, status: null },
    { name: "malformed session status is unproven", input: { sessionStatus: {} }, status: null },
    { name: "malformed idle error is unproven", input: { sessionStatus: "idle", lastError: {} }, status: null },
    { name: "empty error permits idle", input: { sessionStatus: "idle", lastError: "" }, status: "ready/idle" },
    { name: "explicit error outranks malformed payload", input: { sessionStatus: "error", lastError: {} }, status: "blocked" },
    { name: "settled outranks pending", input: { hasPendingApprovals: true, settledAt: "2026-09-07T00:00:00.000Z" }, status: "Done" },
  ];

  for (const entry of cases) {
    const status = mapThreadReportStatus(entry.input);
    assert.equal(status, entry.status, entry.name);
    const { sessionStatus, lastError, ...flags } = entry.input;
    const thread = { id: "synthetic", ...flags, session: { status: sessionStatus, lastError } };
    const adapter = new LoopbackRuntimeAdapter({
      client: {
        snapshot: async () => ({ threads: [thread] }),
        archivedShell: async () => ({ threads: [] }),
      },
    });
    const relayThread = (await adapter.seats()).threads[0];
    if (status === null) {
      assert.throws(() => projectThreadReport(thread, thread.id), /report is unproven/, entry.name);
      assert.equal(Object.hasOwn(relayThread, "report"), false, entry.name);
    } else {
      assert.equal(THREAD_REPORT_STATUSES.includes(status), true, `${entry.name} stays in the enum`);
      assert.equal(projectThreadReport(thread, thread.id).status, status, entry.name);
      assert.equal(relayThread.report.status, status, entry.name);
    }
  }
});

test("CLI and relay agree on pending activities and malformed sessions", async () => {
  const requested = { kind: "approval.requested", payload: { requestId: "a1" } };
  const resolved = { kind: "approval.resolved", payload: { requestId: "a1" } };
  const cases = [
    { thread: { activities: [requested], session: { status: "running" } }, status: "blocked" },
    { thread: { activities: [requested, resolved], session: { status: "running" } }, status: "generating" },
    { thread: { activities: [requested], hasPendingApprovals: false, session: { status: "ready" } }, status: "ready/idle" },
    { thread: { activities: [{ kind: "user-input.requested", payload: { requestId: "u1" } }] }, status: "blocked" },
    { thread: {}, status: null },
    { thread: { session: [] }, status: null },
    { thread: { session: "ready" }, status: null },
  ];
  for (const fixture of cases) {
    const thread = { id: "synthetic", ...fixture.thread };
    const client = {
      thread: async () => ({ thread }),
      snapshot: async () => ({ threads: [thread] }),
      archivedShell: async () => ({ threads: [] }),
    };
    const projected = (await new LoopbackRuntimeAdapter({ client }).seats()).threads[0];
    if (fixture.status === null) {
      await assert.rejects(report(client, thread.id), /report is unproven/);
      assert.equal(Object.hasOwn(projected, "report"), false);
    } else {
      assert.equal((await report(client, thread.id)).status, fixture.status);
      assert.equal(projected.report.status, fixture.status);
    }
  }
});

test("report rejects empty and mismatched projections rather than relabeling them", async () => {
  for (const detail of [
    { thread: {} },
    { thread: { id: "other", session: { status: "ready" } } },
    { session: { status: "ready" } },
  ]) {
    await assert.rejects(report({ thread: async () => detail }, "requested"), /projection identity mismatch/);
  }
  const rawThread = { id: "requested", session: { status: "ready" } };
  assert.equal((await report({ thread: async () => rawThread }, "requested")).status, "ready/idle");
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

// ── KRA-6202 Gate 4: F5 bounded safe report projection ──────────────────────

const PROMPT_CANARY = "PROMPT-CANARY-7f3a";
const AUTH_CANARY = "Bearer AUTH-CANARY-91c2";

function assertNoLeak(document, label) {
  const printed = JSON.stringify(document, null, 2);
  for (const canary of [PROMPT_CANARY, "AUTH-CANARY-91c2", "\u0007", "\u001b", "\n\t"]) {
    assert.equal(printed.includes(canary), false, `${label}: ${JSON.stringify(canary)} escaped`);
  }
  assert.deepEqual(Object.keys(document).sort(), ["lastError", "model", "status", "threadId"], label);
  assert.ok(document.lastError === null || document.lastError === REPORT_ERROR_MARKER, label);
  assert.ok(document.model === null || REPORT_MODEL_LABEL.test(document.model), label);
  assert.ok(printed.length < 400, `${label}: report stays compact`);
}

test("report never reflects provider error payloads, but keeps error presence and blocked status", async () => {
  const payloads = [
    { name: "string with prompt/auth", lastError: `upstream 401: ${AUTH_CANARY} while running "${PROMPT_CANARY}"` },
    { name: "nested object", lastError: { message: PROMPT_CANARY, request: { headers: { authorization: AUTH_CANARY } } } },
    { name: "array", lastError: [PROMPT_CANARY, AUTH_CANARY] },
    { name: "control characters", lastError: `boom\u0007\u001b[31m${PROMPT_CANARY}\n\tat provider` },
    { name: "long payload", lastError: `${PROMPT_CANARY}${"x".repeat(200_000)}` },
    { name: "number", lastError: 401 },
  ];
  for (const { name, lastError } of payloads) {
    for (const [sessionStatus, expected] of [["error", "blocked"], ["running", "generating"], ["idle", typeof lastError === "string" ? "blocked" : null]]) {
      const thread = { id: "t1", modelSelection: { instanceId: "grok", model: "grok-4.7" }, session: { status: sessionStatus, lastError } };
      const label = `${name} / ${sessionStatus}`;
      if (expected === null) {
        // A malformed payload without stronger evidence stays unproven, and the
        // refusal itself does not echo the payload.
        await assert.rejects(report({ thread: async () => ({ thread }) }, "t1"), (error) => {
          assert.match(error.message, /report is unproven/);
          assert.equal(error.message.includes(PROMPT_CANARY), false, label);
          return true;
        });
        continue;
      }
      const document = await report({ thread: async () => ({ thread }) }, "t1");
      assert.equal(document.status, expected, label);
      assert.equal(document.lastError, REPORT_ERROR_MARKER, label);
      assertNoLeak(document, label);
    }
  }

  const settled = projectThreadReport({ id: "t1", settledAt: "2026-09-07T00:00:00.000Z", session: { status: "error", lastError: { secret: PROMPT_CANARY } } }, "t1");
  assert.equal(settled.status, "Done");
  assert.equal(settled.lastError, REPORT_ERROR_MARKER);
  assertNoLeak(settled, "settled with object error");

  // An error session without a payload still reports error presence.
  assert.equal(projectThreadReport({ id: "t1", session: { status: "error" } }, "t1").lastError, REPORT_ERROR_MARKER);
  // No error evidence stays null.
  for (const lastError of [null, undefined, ""]) {
    const document = projectThreadReport({ id: "t1", session: { status: "idle", lastError } }, "t1");
    assert.equal(document.status, "ready/idle");
    assert.equal(document.lastError, null);
  }
});

test("report model labels are bounded, printable IDs", () => {
  const accepted = ["gpt-5.6-sol", "grok-4.7", "claude-opus-5-5", "deepseek:deepseek-v4-flash", "moonshotai/kimi-k3".replace("/", ":"), "x".repeat(80)];
  for (const model of accepted) {
    assert.equal(projectThreadReport({ id: "t1", modelSelection: { model }, session: { status: "idle" } }, "t1").model, model);
  }
  const refused = [
    "x".repeat(81),
    `gpt\u0007${PROMPT_CANARY}`,
    "gpt-5\nInjected: line",
    `${AUTH_CANARY}`,
    "",
    42,
    { id: PROMPT_CANARY },
    ["gpt-5.6-sol"],
  ];
  for (const model of refused) {
    const document = projectThreadReport({ id: "t1", modelSelection: { model }, session: { status: "idle" } }, "t1");
    assert.equal(document.status, "ready/idle");
    assert.equal(document.model, null, JSON.stringify(model));
    assertNoLeak(document, `model ${JSON.stringify(model).slice(0, 40)}`);
  }
});

test("relay and CLI share the same model-label bound", async () => {
  for (const model of ["gpt-5.6-sol", "x".repeat(81), `gpt\u0007${PROMPT_CANARY}`]) {
    const thread = { id: "t1", modelSelection: { instanceId: "codex", model, options: [{ id: "reasoningEffort", value: "high" }] }, session: { status: "idle" } };
    const cli = projectThreadReport(thread, "t1");
    const relay = (await new LoopbackRuntimeAdapter({
      client: { snapshot: async () => ({ threads: [thread] }), archivedShell: async () => ({ threads: [] }) },
    }).seats()).threads[0];
    const relayModelVisible = relay.report.summary.includes(model);
    assert.equal(cli.model !== null, relayModelVisible, JSON.stringify(model).slice(0, 40));
  }
});
