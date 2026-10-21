import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// WA-TEST-TEMP-P1 (issue #15): every test that needs a temporary directory owns
// exactly one fresh root directly inside the OS temp directory and removes
// exactly that root when it finishes, whether it passed or failed. Removal
// refuses anything ambiguous instead of guessing: a root replaced by a symlink
// or junction, a root that no longer resolves to itself, or a path that is not
// a direct child of the OS temp directory with the expected prefix. There is no
// glob and nothing else in the temp directory is ever touched.

const OWNED_PREFIX = /^(toadaid|wa-p1a2)-[a-z0-9]+(-[a-z0-9]+)*-$/;

export class TempRootRefusal extends Error {}

async function tempBase(): Promise<string> {
  return realpath(tmpdir());
}

/**
 * Creates a fresh root and returns it in the OS temp directory's own spelling
 * (e.g. a Windows 8.3 short parent such as RUNNER~1), so tests that check
 * path canonicalisation still exercise it. Ownership is verified via realpath.
 */
export async function createOwnedTempRoot(prefix: string): Promise<string> {
  if (!OWNED_PREFIX.test(prefix)) throw new TempRootRefusal(`refusing temp root prefix ${JSON.stringify(prefix)}`);
  const root = await mkdtemp(join(tmpdir(), prefix));
  const base = await tempBase();
  if ((await realpath(root)) !== join(base, basename(root)) || !basename(root).startsWith(prefix)) {
    throw new TempRootRefusal(`temp root ${root} is not a direct child of ${base}`);
  }
  return root;
}

export async function removeOwnedTempRoot(root: string, prefix: string): Promise<void> {
  if (!OWNED_PREFIX.test(prefix)) throw new TempRootRefusal(`refusing temp root prefix ${JSON.stringify(prefix)}`);
  const base = await tempBase();
  const name = basename(root);
  const parentOk = dirname(root) === tmpdir() || dirname(root) === base;
  if (!parentOk || !name.startsWith(prefix) || name.length <= prefix.length) {
    throw new TempRootRefusal(`refusing to remove ${root}: not an owned temp root under ${base}`);
  }
  let st;
  try {
    st = await lstat(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new TempRootRefusal(`refusing to remove ${root}: it is no longer a real directory`);
  }
  if ((await realpath(root)) !== join(base, name)) {
    throw new TempRootRefusal(`refusing to remove ${root}: it no longer resolves to the owned root`);
  }
  await rm(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
}

/** Runs `fn` with a fresh owned temp root and always removes exactly that root afterwards. */
export async function withTempRoot<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await createOwnedTempRoot(prefix);
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await fn(root);
  } catch (e) {
    failed = true;
    failure = e;
  }
  try {
    await removeOwnedTempRoot(root, prefix);
  } catch (cleanupError) {
    if (failed) throw new AggregateError([failure, cleanupError], "the test failed and its temp root could not be removed");
    throw cleanupError;
  }
  if (failed) throw failure;
  return result as T;
}
