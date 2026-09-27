import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
} from "node:fs/promises";
import {
  join,
} from "node:path";
import {
  tmpdir,
} from "node:os";
import test from "node:test";

import {
  ProviderArtifactStore,
} from "../src/providerArtifacts.js";

test("WA-P1A.1 artifacts use unpredictable operation dirs and create-new writes", async () => {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "toadaid-provider-artifacts-",
      ),
    );
  const store =
    new ProviderArtifactStore({
      root,
      maxArtifactBytes:
        1_024,
    });
  const operation =
    await store.beginOperation();

  assert.match(
    operation,
    /op-[A-Za-z0-9_-]+$/,
  );

  const first =
    await store.writeCreateNew(
      operation,
      "artifact-001",
      ".json",
      Buffer.from(
        '{"ok":true}',
        "utf8",
      ),
    );

  assert.equal(
    first.byteLength,
    11,
  );
  assert.match(
    first.sha256,
    /^[a-f0-9]{64}$/,
  );

  await assert.rejects(
    store.writeCreateNew(
      operation,
      "artifact-001",
      ".json",
      Buffer.from("{}", "utf8"),
    ),
    /EEXIST/,
  );

  await store.cleanupOperation(
    operation,
  );
  await assert.rejects(
    access(operation),
  );
});

test("WA-P1A.1 artifact writes refuse unknown operations and byte overflow", async () => {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "toadaid-provider-artifacts-",
      ),
    );
  const store =
    new ProviderArtifactStore({
      root,
      maxArtifactBytes: 8,
    });
  const operation =
    await store.beginOperation();

  await assert.rejects(
    store.writeCreateNew(
      operation,
      "artifact-big",
      ".bin",
      Buffer.alloc(9),
    ),
    /byte bound/,
  );

  await assert.rejects(
    store.writeCreateNew(
      join(root, "not-issued"),
      "artifact-001",
      ".bin",
      Buffer.alloc(1),
    ),
  );
});
