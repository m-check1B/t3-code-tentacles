import assert from "node:assert/strict";
import test from "node:test";

import { resolveModelSelection } from "../src/model-selection.mjs";

test("Cursor Composer Fast alias becomes T3's parameterized base model", () => {
  assert.deepEqual(
    resolveModelSelection({
      instanceId: "cursor",
      model: "composer-2.5-fast",
    }),
    {
      instanceId: "cursor",
      model: "composer-2.5",
      options: [{ id: "fastMode", value: true }],
    },
  );
});

test("Cursor Composer Fast alias rejects a contradictory fast-mode option", () => {
  assert.throws(
    () => resolveModelSelection({
      instanceId: "cursor",
      model: "composer-2.5-fast",
      options: [{ id: "fastMode", value: false }],
    }),
    /conflicts with option fastMode/,
  );
});
