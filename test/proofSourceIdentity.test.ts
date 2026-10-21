import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// WA-PROOF-PORTABILITY-P1 (issue #17): the native proof harness resolves its
// source and capability identity with supported git commands, before any temp
// directory or observation exists, and refuses with typed, bounded errors.
// These tests use disposable fixture repositories only: no observation, no
// fixture window, no live desktop. Every fixture root is removed afterwards.

type Identity = {
  resolveSourceIdentity: (repo: string, options?: Record<string, unknown>) => Promise<{ commit: string; ref: string | null; worktree: string; clean: boolean; dirtyEntries: number; headExpectation: string }>;
  resolveCapabilityIdentity: (repo: string, options?: Record<string, unknown>) => Promise<{ pinnedCommit: string; lockedCommit: string | null; installedCommit: string; lockfile: string; desktopObservationJsSha256: string }>;
  APPROVED_CAPABILITY_COMMIT: string;
  APPROVED_CONTRACT_SHA256: string;
};
const MODULE = pathToFileURL(resolve(process.cwd(), "scripts", "wa-p1b", "sourceIdentity.mjs")).href;
const HARNESS = resolve(process.cwd(), "scripts", "windows-observation-native-proof.mjs");
const load = async (): Promise<Identity> => (await import(MODULE)) as Identity;

const PIN = "a".repeat(40);
const OTHER = "b".repeat(40);
const CONTRACT = "export const fixtureContract = true;\n";
const CONTRACT_SHA = createHash("sha256").update(CONTRACT).digest("hex");
const OPTS = { expectedCommit: PIN, expectedContractSha256: CONTRACT_SHA };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=proof fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const spec = (commit: string) => `github:ToadAid/toadaid-agent-capabilities#${commit}`;
const resolved = (commit: string) => `git+ssh://git@github.com/ToadAid/toadaid-agent-capabilities.git#${commit}`;
const lockJson = (commit: string) => `${JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@toadaid/agent-capabilities": { resolved: resolved(commit) } } })}\n`;

type Fixture = { root: string; repo: string };

/** A repo with package.json pinned to PIN, an "installed" capability, and (optionally) a committed lockfile. */
async function fixture(options: { lock?: string | null; installed?: string; contract?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "toadaid-proof-identity-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  await writeFile(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "fixture", dependencies: { "@toadaid/agent-capabilities": spec(PIN) } })}\n`);
  const lock = options.lock === undefined ? lockJson(PIN) : options.lock;
  if (lock !== null) await writeFile(join(repo, "package-lock.json"), lock);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const cap = join(repo, "node_modules", "@toadaid", "agent-capabilities", "dist", "src");
  await mkdir(cap, { recursive: true });
  await writeFile(join(cap, "desktopObservation.js"), options.contract ?? CONTRACT);
  await writeFile(join(repo, "node_modules", ".package-lock.json"), lockJson(options.installed ?? PIN));
  return { root, repo };
}

async function withFixture(options: Parameters<typeof fixture>[0], fn: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture(options);
  try { await fn(f); } finally { await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function refuses(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.equal((e as { name?: string }).name, "ProofPreflightError");
    assert.equal((e as { code?: string }).code, code);
    return true;
  });
}

test("WA-PROOF-PORTABILITY-P1: a clean clone and a linked git worktree resolve the same exact source identity", async () => {
  const { resolveSourceIdentity } = await load();
  await withFixture({}, async ({ root, repo }) => {
    const head = git(repo, "rev-parse", "HEAD");
    const main = await resolveSourceIdentity(repo);
    assert.deepEqual({ commit: main.commit, worktree: main.worktree, clean: main.clean }, { commit: head, worktree: "MAIN", clean: true });
    const linked = join(root, "linked");
    git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD");
    const wt = await resolveSourceIdentity(linked);
    assert.deepEqual({ commit: wt.commit, ref: wt.ref, worktree: wt.worktree, clean: wt.clean }, { commit: head, ref: null, worktree: "LINKED", clean: true });
    assert.equal(JSON.stringify(wt).includes(root), false, "identity carries no paths");
  });
});

test("WA-PROOF-PORTABILITY-P1: dirty work trees, a missing HEAD, an ambiguous root and missing git are refused with typed codes", async () => {
  const { resolveSourceIdentity } = await load();
  await withFixture({}, async ({ repo }) => {
    await writeFile(join(repo, "package.json"), "{}\n");
    await refuses(resolveSourceIdentity(repo), "WA_P1B_WORKTREE_DIRTY");
    assert.equal((await resolveSourceIdentity(repo, { requireClean: false })).dirtyEntries, 1);
    git(repo, "checkout", "-q", "--", "package.json");
    await writeFile(join(repo, "untracked.txt"), "x\n");
    await refuses(resolveSourceIdentity(repo), "WA_P1B_WORKTREE_DIRTY");
    await rm(join(repo, "untracked.txt"));
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, "sub", "keep.txt"), "x\n");
    git(repo, "add", "sub");
    git(repo, "commit", "-q", "-m", "sub");
    await refuses(resolveSourceIdentity(join(repo, "sub")), "WA_P1B_REPO_AMBIGUOUS");
    await refuses(resolveSourceIdentity(repo, { gitBinary: "toadaid-definitely-not-git" }), "WA_P1B_GIT_MISSING");
  });
  const bare = await mkdtemp(join(tmpdir(), "toadaid-proof-identity-"));
  try {
    git(bare, "init", "-q");
    await refuses(resolveSourceIdentity(bare), "WA_P1B_HEAD_UNEXPECTED");
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test("WA-PROOF-PORTABILITY-P1: the capability is trusted only from a committed, unmodified lockfile matching pin, install and build", async () => {
  const { resolveCapabilityIdentity } = await load();
  await withFixture({}, async ({ repo }) => {
    assert.deepEqual(await resolveCapabilityIdentity(repo, OPTS), { pinnedCommit: PIN, lockedCommit: PIN, installedCommit: PIN, lockfile: "COMMITTED", desktopObservationJsSha256: CONTRACT_SHA });
    await writeFile(join(repo, "package-lock.json"), lockJson(OTHER));
    await refuses(resolveCapabilityIdentity(repo, OPTS), "WA_P1B_LOCKFILE_MODIFIED");
  });
  await withFixture({ lock: lockJson(OTHER) }, async ({ repo }) => {
    await refuses(resolveCapabilityIdentity(repo, OPTS), "WA_P1B_CAPABILITY_PIN_MISMATCH");
  });
  await withFixture({ installed: OTHER }, async ({ repo }) => {
    await refuses(resolveCapabilityIdentity(repo, OPTS), "WA_P1B_CAPABILITY_PIN_MISMATCH");
  });
  await withFixture({ contract: "export const tampered = true;\n" }, async ({ repo }) => {
    await refuses(resolveCapabilityIdentity(repo, OPTS), "WA_P1B_CAPABILITY_BUILD_UNEXPECTED");
  });
  await withFixture({}, async ({ repo }) => {
    await refuses(resolveCapabilityIdentity(repo, { ...OPTS, expectedCommit: OTHER }), "WA_P1B_CAPABILITY_PIN_UNEXPECTED");
    await rm(join(repo, "node_modules", ".package-lock.json"));
    await refuses(resolveCapabilityIdentity(repo, OPTS), "WA_P1B_CAPABILITY_NOT_INSTALLED");
  });
});

test("WA-PROOF-PORTABILITY-P1: an untracked lockfile is never trusted; no lockfile needs the explicit manifest-pin fallback", async () => {
  const { resolveCapabilityIdentity } = await load();
  await withFixture({ lock: null }, async ({ repo }) => {
    await refuses(resolveCapabilityIdentity(repo, OPTS), "WA_P1B_LOCKFILE_ABSENT");
    assert.deepEqual(await resolveCapabilityIdentity(repo, { ...OPTS, allowManifestPinFallback: true }), { pinnedCommit: PIN, lockedCommit: null, installedCommit: PIN, lockfile: "ABSENT_MANIFEST_PIN_FALLBACK", desktopObservationJsSha256: CONTRACT_SHA });
    // an untracked lockfile that even matches the pin is refused, with or without the fallback flag
    await writeFile(join(repo, "package-lock.json"), lockJson(PIN));
    await refuses(resolveCapabilityIdentity(repo, OPTS), "WA_P1B_LOCKFILE_UNTRACKED");
    await refuses(resolveCapabilityIdentity(repo, { ...OPTS, allowManifestPinFallback: true }), "WA_P1B_LOCKFILE_UNTRACKED");
  });
});

test("WA-PROOF-PORTABILITY-P1: this checkout's installed capability matches the approved pin and built contract", async () => {
  const { resolveCapabilityIdentity, resolveSourceIdentity, APPROVED_CAPABILITY_COMMIT, APPROVED_CONTRACT_SHA256 } = await load();
  assert.equal(APPROVED_CAPABILITY_COMMIT, "be750075e644be399d0dc92df406074d3bbff9c2");
  assert.equal(APPROVED_CONTRACT_SHA256, "86f0d458826f81e98053e72490c7b19b2860dedabab25b974d47bc28673ff755");
  const cap = await resolveCapabilityIdentity(process.cwd());
  assert.deepEqual(cap, { pinnedCommit: APPROVED_CAPABILITY_COMMIT, lockedCommit: APPROVED_CAPABILITY_COMMIT, installedCommit: APPROVED_CAPABILITY_COMMIT, lockfile: "COMMITTED", desktopObservationJsSha256: APPROVED_CONTRACT_SHA256 });
  const src = await resolveSourceIdentity(process.cwd(), { requireClean: false });
  assert.equal(src.commit, spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim());
});

test("WA-PROOF-PORTABILITY-P1: --preflight-only never observes, refuses early with a typed code or passes, and creates no temp directory", async () => {
  const before = (await readdir(tmpdir())).filter((n) => n.startsWith("toadaid-wa-p1b-")).sort();
  const r = spawnSync(process.execPath, [HARNESS, "--preflight-only"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  const after = (await readdir(tmpdir())).filter((n) => n.startsWith("toadaid-wa-p1b-")).sort();
  assert.deepEqual(after, before, "no harness temp directory was created");
  if (r.status === 0) {
    const out = JSON.parse(r.stdout) as { preflight: string; observation: string; adapter: { clean: boolean } };
    assert.equal(out.preflight, "PASS");
    assert.equal(out.observation, "NOT_RUN");
    assert.equal(out.adapter.clean, true);
  } else {
    assert.equal(r.status, 4, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^WA_P1B_PREFLIGHT_REFUSED code=WA_P1B_[A-Z_]+$/m);
  }
  assert.equal(/WA_P1B_FIXTURE|screenshot|UI_SNAPSHOT/i.test(r.stdout), false, "no observation output");
});

test("WA-PROOF-PORTABILITY-P1 review: an expected HEAD must match exactly, in a clean clone and in a linked worktree", async () => {
  const { resolveSourceIdentity } = await load();
  await withFixture({}, async ({ root, repo }) => {
    const head = git(repo, "rev-parse", "HEAD");
    const main = await resolveSourceIdentity(repo, { expectedHead: head });
    assert.deepEqual({ commit: main.commit, worktree: main.worktree, headExpectation: main.headExpectation }, { commit: head, worktree: "MAIN", headExpectation: "MATCHED" });
    assert.equal((await resolveSourceIdentity(repo)).headExpectation, "NOT_REQUESTED");
    await refuses(resolveSourceIdentity(repo, { expectedHead: OTHER }), "WA_P1B_HEAD_MISMATCH");

    const linked = join(root, "linked");
    git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD");
    const wt = await resolveSourceIdentity(linked, { expectedHead: head });
    assert.deepEqual({ commit: wt.commit, worktree: wt.worktree, headExpectation: wt.headExpectation }, { commit: head, worktree: "LINKED", headExpectation: "MATCHED" });
    await refuses(resolveSourceIdentity(linked, { expectedHead: OTHER }), "WA_P1B_HEAD_MISMATCH");

    // a new commit moves HEAD: the old expectation no longer matches
    git(repo, "commit", "-q", "--allow-empty", "-m", "moved");
    await refuses(resolveSourceIdentity(repo, { expectedHead: head }), "WA_P1B_HEAD_MISMATCH");
    assert.equal((await resolveSourceIdentity(repo, { expectedHead: git(repo, "rev-parse", "HEAD") })).headExpectation, "MATCHED");
  });
});

test("WA-PROOF-PORTABILITY-P1 review: a malformed expected HEAD is refused before any git call", async () => {
  const { resolveSourceIdentity } = await load();
  await withFixture({}, async ({ repo }) => {
    const head = git(repo, "rev-parse", "HEAD");
    for (const bad of ["", "abc", head.slice(0, 39), head.slice(0, 7), head.toUpperCase(), `${head}0`, "g".repeat(40), ` ${head}`, `${head}\n`, "c".repeat(64), "HEAD", "main"]) {
      await refuses(resolveSourceIdentity(repo, { expectedHead: bad }), "WA_P1B_EXPECTED_HEAD_INVALID");
    }
    // validated before git runs: even without git the malformed value is the reported refusal
    await refuses(resolveSourceIdentity(repo, { expectedHead: "abc", gitBinary: "toadaid-definitely-not-git" }), "WA_P1B_EXPECTED_HEAD_INVALID");
  });
});

test("WA-PROOF-PORTABILITY-P1 review: the harness refuses malformed or mismatched --expect-head with exit 4, before any temp directory", async () => {
  const iso = await mkdtemp(join(tmpdir(), "toadaid-proof-expect-head-"));
  try {
    const env = { ...process.env, TMPDIR: iso, TEMP: iso, TMP: iso };
    const run = (...args: string[]) => spawnSync(process.execPath, [HARNESS, "--preflight-only", ...args], { encoding: "utf8", windowsHide: true, timeout: 60_000, env });
    for (const [args, code] of [
      [["--expect-head", "not-a-sha"], "WA_P1B_EXPECTED_HEAD_INVALID"],
      [["--expect-head"], "WA_P1B_EXPECTED_HEAD_INVALID"],
      [["--expect-head", "0".repeat(40)], "WA_P1B_HEAD_MISMATCH"],
    ] as const) {
      const r = run(...args);
      assert.equal(r.status, 4, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`^WA_P1B_PREFLIGHT_REFUSED code=${code}$`, "m"));
      assert.equal(r.stdout, "", "a refusal prints no identity and no observation output");
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const ok = run("--expect-head", head);
    if (ok.status === 0) {
      const out = JSON.parse(ok.stdout) as { preflight: string; observation: string; adapter: { commit: string; headExpectation: string } };
      assert.deepEqual([out.preflight, out.observation, out.adapter.commit, out.adapter.headExpectation], ["PASS", "NOT_RUN", head, "MATCHED"]);
    } else {
      // a developer checkout with local edits is refused, typed, after the HEAD matched
      assert.equal(ok.status, 4, ok.stderr);
      assert.match(ok.stderr, /^WA_P1B_PREFLIGHT_REFUSED code=WA_P1B_WORKTREE_DIRTY$/m);
    }
    assert.deepEqual(await readdir(iso), [], "the harness created nothing in the temp directory");
  } finally {
    await rm(iso, { recursive: true, force: true });
  }
});
