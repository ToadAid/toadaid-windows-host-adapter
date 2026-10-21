import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOwnedTempRoot, removeOwnedTempRoot, TempRootRefusal, withTempRoot } from "./support/tempRoot.js";

// WA-TEST-TEMP-P1 (issue #15): owned temp roots are removed after success and
// after failure, and removal fails closed instead of following links.

const PREFIX = "toadaid-temp-root-selftest-";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

test("WA-TEST-TEMP-P1: an owned temp root is removed after the test body succeeds", async () => {
  let seen = "";
  const value = await withTempRoot(PREFIX, async (root) => {
    seen = root;
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", "artifact.json"), '{"displays":[]}');
    return 42;
  });
  assert.equal(value, 42);
  assert.notEqual(seen, "");
  assert.equal(await exists(seen), false);
});

test("WA-TEST-TEMP-P1: an owned temp root is removed when the test body throws early, and the original error is kept", async () => {
  let seen = "";
  await assert.rejects(
    withTempRoot(PREFIX, async (root) => {
      seen = root;
      await writeFile(join(root, "partial.json"), "{}");
      throw new Error("early refusal before any cleanup code");
    }),
    /early refusal before any cleanup code/,
  );
  assert.equal(await exists(seen), false);
});

test("WA-TEST-TEMP-P1: only well-formed owned prefixes are accepted", async () => {
  for (const bad of ["", "toadaid-", "other-", "../toadaid-x-", "toadaid-x", "toadaid-X-", "toadaid-a/b-"]) {
    await assert.rejects(createOwnedTempRoot(bad), TempRootRefusal, JSON.stringify(bad));
  }
  await assert.rejects(removeOwnedTempRoot(tmpdir(), PREFIX), TempRootRefusal);
  await assert.rejects(removeOwnedTempRoot(join(tmpdir(), "unrelated-folder"), PREFIX), TempRootRefusal);
});

test("WA-TEST-TEMP-P1: removal refuses a root swapped for a symlink/junction and never follows it", async () => {
  const outside = await createOwnedTempRoot("toadaid-temp-root-outside-");
  try {
    await writeFile(join(outside, "keep.txt"), "must survive\n");
    let seen = "";
    await assert.rejects(
      withTempRoot(PREFIX, async (root) => {
        seen = root;
        await rm(root, { recursive: true });
        await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
      }),
      /no longer a real directory/,
    );
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "must survive\n");
    await rm(seen); // the link itself, not its target
    assert.equal(await exists(join(outside, "keep.txt")), true);
  } finally {
    await removeOwnedTempRoot(outside, "toadaid-temp-root-outside-");
  }
});

test("WA-TEST-TEMP-P1: a root the test already removed is not an error", async () => {
  await withTempRoot(PREFIX, async (root) => {
    await rm(root, { recursive: true });
  });
});
