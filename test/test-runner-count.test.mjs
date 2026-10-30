import assert from "node:assert/strict";
import test from "node:test";

// KRA-9526: every test file registers a fixed case list, so `node --test`
// always reports the same total. Under `node --test --test-force-exit`
// (Node 22) a test child can exit before its report reaches the parent, which
// then silently drops that file's tail and still prints fail 0 (seen: 97-118
// of 118 tests, 31-35 of 35, 923-1003 of 1003). Fail that run instead of
// letting it pass with a short count; the suite exits on its own without it.
test("the suite runs without --test-force-exit so its test count is stable", () => {
  assert.equal(process.execArgv.includes("--test-force-exit"), false,
    "--test-force-exit drops test reports; run `npm test` (node --test) instead");
});
