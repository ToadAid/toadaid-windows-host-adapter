import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// WA-BUILD-CLEAN-P1 (issue #16): stale compiled tests must not execute, and the
// dist cleanup must fail closed on anything that is not provably this
// package's own generated output. Every case runs in a disposable fixture
// repository under the OS temp directory; nothing outside it is touched.

const SCRIPT = resolve(process.cwd(), "scripts", "dist-hygiene.mjs");
const PACKAGE = "@toadaid/windows-host-adapter";

type Run = { status: number | null; stdout: string; stderr: string };
function hygiene(root: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

const CURRENT_TEST = 'import test from "node:test";\ntest("fixture: current compiled test", () => {});\n';
const STALE_TEST = [
  'import { writeFileSync } from "node:fs";',
  'import test from "node:test";',
  'test("fixture: STALE compiled test from another branch", () => {',
  '  writeFileSync(new URL("../../STALE_EXECUTED", import.meta.url), "executed");',
  '  throw new Error("stale compiled test executed");',
  "});",
  "",
].join("\n");

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "toadaid-dist-hygiene-"));
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: PACKAGE, private: true })}\n`);
  git(root, "init", "-q");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "test", "a.test.ts"), CURRENT_TEST);
  const p = hygiene(root, "clean", "--prepare");
  assert.equal(p.status, 0, p.stderr);
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await mkdir(join(root, "dist", "test"), { recursive: true });
  await writeFile(join(root, "dist", "src", "a.js"), "export const a = 1;\n");
  await writeFile(join(root, "dist", "src", "a.d.ts"), "export declare const a = 1;\n");
  await writeFile(join(root, "dist", "test", "a.test.js"), CURRENT_TEST);
  const m = hygiene(root, "mark", "--config", "tsconfig.json");
  assert.equal(m.status, 0, m.stderr);
  return root;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function withFixture(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fixture();
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("WA-BUILD-CLEAN-P1: clean removes only this package's marked dist, including a stale compiled test, and is idempotent", async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, "dist", "test", "stale.test.js"), STALE_TEST);
    const r = hygiene(root, "clean");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await exists(join(root, "dist")), false);
    assert.equal(await readFile(join(root, "test", "a.test.ts"), "utf8"), CURRENT_TEST);
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(await exists(join(root, "package.json")), true);
    const again = hygiene(root, "clean");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to clean/);
  });
});

test("WA-BUILD-CLEAN-P1: run-tests refuses a stale compiled test and never executes it", async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, "dist", "test", "stale.test.js"), STALE_TEST);
    const r = hygiene(root, "run-tests");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /stale compiled test\(s\) with no current source: dist\/test\/stale\.test\.js/);
    assert.equal(await exists(join(root, "STALE_EXECUTED")), false, "the stale test must not run");
  });
});

test("WA-BUILD-CLEAN-P1: run-tests runs exactly the compiled tests of the current sources", async () => {
  await withFixture(async (root) => {
    const l = hygiene(root, "run-tests", "--list");
    assert.equal(l.status, 0, l.stderr);
    assert.deepEqual(l.stdout.trim().split(/\r?\n/), ["dist/test/a.test.js"]);
    const r = hygiene(root, "run-tests");
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });
});

test("WA-BUILD-CLEAN-P1: a build that fails after prepare leaves a dist the next clean can verify and remove", async () => {
  await withFixture(async (root) => {
    assert.equal(hygiene(root, "clean", "--prepare").status, 0);
    // simulate tsc emitting part of its output and then failing (mark never runs)
    await mkdir(join(root, "dist", "test"), { recursive: true });
    await writeFile(join(root, "dist", "test", "a.test.js"), CURRENT_TEST);
    const r = hygiene(root, "run-tests");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /did not complete/);
    const c = hygiene(root, "clean");
    assert.equal(c.status, 0, c.stderr);
    assert.equal(await exists(join(root, "dist")), false);
  });
});

test("WA-BUILD-CLEAN-P1: run-tests refuses dist built from other source bytes or without the tests", async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, "test", "a.test.ts"), `${CURRENT_TEST}// edited after the build\n`);
    const changed = hygiene(root, "run-tests");
    assert.equal(changed.status, 2);
    assert.match(changed.stderr, /different source files/);
  });
  await withFixture(async (root) => {
    const again = hygiene(root, "mark", "--config", "tsconfig.json");
    assert.equal(again.status, 2, "mark requires a freshly prepared dist");
    assert.match(again.stderr, /not prepared/);
    assert.equal(hygiene(root, "clean", "--prepare").status, 0);
    await mkdir(join(root, "dist", "src"), { recursive: true });
    await writeFile(join(root, "dist", "src", "a.js"), "export const a = 1;\n");
    assert.equal(hygiene(root, "mark", "--config", "tsconfig.build.json").status, 0);
    const r = hygiene(root, "run-tests");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not compile the tests/);
  });
});

async function assertRefusedIntact(root: string, pattern: RegExp, keep: string[]): Promise<void> {
  const r = hygiene(root, "clean");
  assert.equal(r.status, 2, `expected a refusal, got: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, pattern);
  for (const p of keep) assert.equal(await exists(join(root, ...p.split("/"))), true, `${p} must survive a refusal`);
}

test("WA-BUILD-CLEAN-P1: clean fails closed on unknown ownership and unexpected material, deleting nothing", async () => {
  await withFixture(async (root) => {
    await rm(join(root, "dist", ".toadaid-dist-owner.json"));
    await assertRefusedIntact(root, /unknown ownership/, ["dist/src/a.js", "dist/test/a.test.js"]);
  });
  await withFixture(async (root) => {
    await writeFile(join(root, "dist", ".toadaid-dist-owner.json"), JSON.stringify({ schema: "something-else", package: PACKAGE }));
    await assertRefusedIntact(root, /unknown ownership/, ["dist/src/a.js"]);
  });
  await withFixture(async (root) => {
    await writeFile(join(root, "dist", "operator-notes.txt"), "not compiler output\n");
    await assertRefusedIntact(root, /unexpected material: dist\/operator-notes\.txt/, ["dist/operator-notes.txt", "dist/src/a.js"]);
  });
  await withFixture(async (root) => {
    await rm(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist"), "a file, not a directory\n");
    await assertRefusedIntact(root, /not a directory/, ["dist"]);
  });
});

test("WA-BUILD-CLEAN-P1: clean fails closed on symlinks/junctions and never follows them", async () => {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await withFixture(async (root) => {
    const outside = join(root, "outside-precious");
    await mkdir(outside);
    await writeFile(join(outside, "keep.js"), "precious\n");
    await writeFile(join(outside, ".toadaid-dist-owner.json"), await readFile(join(root, "dist", ".toadaid-dist-owner.json")));
    await rm(join(root, "dist"), { recursive: true });
    await symlink(outside, join(root, "dist"), linkType);
    await assertRefusedIntact(root, /dist is a symlink or junction/, ["outside-precious/keep.js"]);
  });
  await withFixture(async (root) => {
    const outside = join(root, "outside-precious");
    await mkdir(outside);
    await writeFile(join(outside, "keep.js"), "precious\n");
    await symlink(outside, join(root, "dist", "src", "linked"), linkType);
    await assertRefusedIntact(root, /dist\/src\/linked is a symlink or junction/, ["outside-precious/keep.js", "dist/src/a.js"]);
  });
});

test("WA-BUILD-CLEAN-P1: clean refuses tracked files and foreign roots", async () => {
  await withFixture(async (root) => {
    git(root, "add", "-f", "dist/src/a.js");
    await assertRefusedIntact(root, /tracked by git/, ["dist/src/a.js"]);
  });
  await withFixture(async (root) => {
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "someone-else", private: true })}\n`);
    await assertRefusedIntact(root, /is not @toadaid\/windows-host-adapter/, ["dist/src/a.js"]);
  });
});

test("WA-BUILD-CLEAN-P1: this checkout's dist is marked and traceable to the current sources", async () => {
  const marker = JSON.parse(await readFile(resolve(process.cwd(), "dist", ".toadaid-dist-owner.json"), "utf8")) as {
    schema: string; package: string; status: string; config: string; sources: Record<string, string>;
  };
  assert.equal(marker.schema, "toadaid.windows-host-adapter.dist-owner.v1");
  assert.equal(marker.status, "complete");
  assert.equal(marker.package, PACKAGE);
  assert.equal(marker.config, "tsconfig.json");
  const self = "test/distHygiene.test.ts";
  const bytes = await readFile(resolve(process.cwd(), ...self.split("/")));
  assert.equal(marker.sources[self], createHash("sha256").update(bytes).digest("hex"));
  const compiled = (await readdir(resolve(process.cwd(), "dist", "test"))).filter((f) => f.endsWith(".test.js")).sort();
  const sources = (await readdir(resolve(process.cwd(), "test"))).filter((f) => f.endsWith(".test.ts")).map((f) => f.replace(/\.ts$/, ".js")).sort();
  assert.deepEqual(compiled, sources);
});
