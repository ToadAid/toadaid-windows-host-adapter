import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// DISPOSABLE FAIL-PATH PROBE for the PR #19 review. Lives only on a throwaway
// branch and a do-not-merge draft PR; it is never merged. It fails on purpose
// and leaves one empty synthetic temp directory, to prove that the CI
// temp-leak gate runs after a failed `npm test` and reports the leak.
test("FAILPATH-PROBE: deliberate failure with a synthetic temp leak", () => {
  mkdtempSync(join(tmpdir(), "toadaid-failpath-probe-"));
  assert.fail("deliberate failing test (leak-gate fail-path proof, scenario 2: synthetic leak)");
});
