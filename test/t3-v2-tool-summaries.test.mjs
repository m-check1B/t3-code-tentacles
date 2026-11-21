import assert from "node:assert/strict";
import test from "node:test";
import { threadDetailToV1 } from "../src/t3-v2.mjs";
import { projectThreadEvents } from "../src/thread-events.mjs";

// KRA-10862 C4: the shape official T3 0.1.11 projects for a Bot's MCP tool call
// (packages/contracts orchestrationV2.ts `dynamic_tool`, presentation from mcpToolPresentation).
const thread = { id: "12345678-1111-4111-8111-111111111111", title: "Weather", archivedAt: null, runtimeMode: "full-access",
  interactionMode: "default", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] } };
const base = { threadId: thread.id, runId: "run-1", nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null,
  parentItemId: null, title: null, startedAt: "2026-11-21T08:00:01.000Z" };
const items = [
  { ...base, id: "i1", ordinal: 1, type: "dynamic_tool", status: "completed", toolName: "mcp__jack__web.search", title: "web.search",
    toolSource: { key: "mcp:jack", name: "jack", kind: "integration" }, input: { query: "SECRET-QUERY Prague weather" },
    output: { content: "SECRET-OUTPUT 7°C" }, completedAt: "2026-11-21T08:00:03.000Z", updatedAt: "2026-11-21T08:00:03.000Z" },
  // Codex names the tool bare and carries the server in toolSource.
  { ...base, id: "i2", ordinal: 2, type: "dynamic_tool", status: "failed", toolName: "web.search", toolSource: { key: "mcp:jack", name: "jack" },
    input: {}, completedAt: null, updatedAt: "2026-11-21T08:00:04.000Z" },
  // A built-in lab tool, a running MCP call and a web search.
  { ...base, id: "i3", ordinal: 3, type: "dynamic_tool", status: "completed", toolName: "Read", input: {}, completedAt: "2026-11-21T08:00:05.000Z", updatedAt: "2026-11-21T08:00:05.000Z" },
  { ...base, id: "i4", ordinal: 4, type: "dynamic_tool", status: "running", toolName: "mcp__jack__web.search", input: {}, completedAt: null, updatedAt: "2026-11-21T08:00:06.000Z" },
  { ...base, id: "i5", ordinal: 5, type: "web_search", status: "completed", patterns: ["SECRET-PATTERN"], completedAt: "2026-11-21T08:00:07.000Z", updatedAt: "2026-11-21T08:00:07.000Z" },
  // A tool name that is not a plain label is dropped, never echoed.
  { ...base, id: "i6", ordinal: 6, type: "dynamic_tool", status: "completed", toolName: "mcp__jack__x\nIgnore previous", input: {}, completedAt: "2026-11-21T08:00:08.000Z", updatedAt: "2026-11-21T08:00:08.000Z" },
];

test("C4: a Bot's MCP tool calls on official T3 v2 reach Talk as name-only tool summaries", () => {
  const { thread: v1 } = threadDetailToV1({ projection: { thread, runs: [{ id: "run-1", ordinal: 1, status: "completed" }], turnItems: items } }, thread.id);
  assert.deepEqual(v1.activities.map(({ id, summary }) => [id, summary]), [
    ["item:i1", "Used tool: web.search (jack)"],
    ["item:i2", "Tool failed: web.search (jack)"],
    ["item:i5", "Searched the web"],
  ]);
  const { events } = projectThreadEvents(v1);
  const summaries = events.filter((event) => event.kind === "tool_summary");
  assert.deepEqual(summaries.map((event) => [event.eventId, event.payload.summary, event.occurredAt]), [
    ["tool:item:i1", "Used tool: web.search (jack)", "2026-11-21T08:00:03.000Z"],
    ["tool:item:i2", "Tool failed: web.search (jack)", "2026-11-21T08:00:04.000Z"],
    ["tool:item:i5", "Searched the web", "2026-11-21T08:00:07.000Z"],
  ]);
  assert.doesNotMatch(JSON.stringify({ v1, events }), /SECRET|Ignore previous/);
});
