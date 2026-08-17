import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseIntentOption } from "../src/cli.mjs";

const INTENT = { action: "thread.turn.start", threadId: "t1", text: "hello" };

test("parseIntentOption parses --intent and refuses to mix it with --intent-file", () => {
  assert.deepEqual(parseIntentOption({ intent: JSON.stringify(INTENT) }), INTENT);
  assert.deepEqual(
    parseIntentOption({ intent: JSON.stringify(INTENT), "no-wait": true }),
    INTENT,
  );
  // Both sources given: fail loud instead of silently preferring --intent.
  assert.throws(
    () => parseIntentOption({ intent: JSON.stringify(INTENT), "intent-file": "/tmp/any.json" }),
    /--intent or --intent-file, not both/,
  );
  assert.throws(() => parseIntentOption({}), /act requires --intent/);
  assert.throws(() => parseIntentOption({ intent: "{not json" }), /not valid JSON/);
});

test("parseIntentOption reads --intent-file when --intent is absent", () => {
  const file = path.join(os.tmpdir(), `intent-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(INTENT));
  try {
    assert.deepEqual(parseIntentOption({ "intent-file": file }), INTENT);
  } finally {
    fs.rmSync(file, { force: true });
  }
  assert.throws(() => parseIntentOption({ "intent-file": "/nonexistent/intent.json" }), /ENOENT/);
});
