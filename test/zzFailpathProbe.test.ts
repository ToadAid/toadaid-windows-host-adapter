import assert from "node:assert/strict";
import test from "node:test";

// DISPOSABLE FAIL-PATH PROBE for the PR #19 review. Lives only on a throwaway
// branch and a do-not-merge draft PR; it is never merged. It fails on purpose
// to prove that the CI temp-leak gate still runs after a failed `npm test`.
test("FAILPATH-PROBE: deliberate failure, no temp leak", () => {
  assert.fail("deliberate failing test (leak-gate fail-path proof, scenario 1: no leak)");
});
