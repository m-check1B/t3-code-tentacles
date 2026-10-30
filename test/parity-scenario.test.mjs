import assert from "node:assert/strict";
import test from "node:test";
import { runParityScenario, SCENARIO } from "../scripts/parity-scenario.mjs";

test(`KRA-8959: ${SCENARIO} passes every step on synthetic labs`, { timeout: 30_000 }, async () => {
  const lines = [];
  const report = await runParityScenario({ log: (line) => lines.push(line) });
  assert.deepEqual(report.steps.map((step) => step.id), [1, 2, 3, 4, 5, 6]);
  for (const step of report.steps) assert.ok(step.passed, `step${step.id} ${step.name}: ${step.evidence}`);
  assert.equal(report.passed, true, lines.join("\n"));
});
