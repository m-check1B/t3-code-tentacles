import assert from "node:assert/strict";
import test from "node:test";

// KRA-9526: every test file registers a fixed case list, so `node --test`
// always reports the same total. Under `node --test --test-force-exit` a test
// child can exit before its report reaches the parent, which then silently
// drops that file's tail and still prints fail 0 (seen on Node 22.14 and
// 22.22.3: 97-118 of 118 tests, 923-1003 of 1003; Node 24.15 gave full counts
// 10 of 10). Fail that run instead of letting it pass with a short count; the
// suite exits on its own without it.
// Checks the CLI flag only: node:test run({ forceExit: true }) from code is not
// caught, and no repo path uses run().
test("the suite runs without --test-force-exit so its test count is stable", () => {
  assert.equal(process.execArgv.includes("--test-force-exit"), false,
    "--test-force-exit can drop test reports (seen on Node 22); run `npm test` (node --test) instead");
});
