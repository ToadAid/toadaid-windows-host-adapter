// WA-PROOF-PORTABILITY-P1 (issue #17): source and capability identity for the
// native proof harness, resolved BEFORE any temp directory, fixture window or
// observation exists. Every failure is a typed, bounded ProofPreflightError.
//
// Source identity uses supported git commands (never reads .git/HEAD directly),
// so a clean clone and a linked `git worktree` resolve the same way.
// Capability identity requires that the pinned, locked and actually installed
// capability commits are all the approved pin and that the installed built
// contract has the expected hash. A lockfile is trusted only when git tracks it
// unmodified; an untracked lockfile is refused, never used. With no lockfile
// in the commit, the manifest-pin fallback is used only when explicitly allowed.
// Results carry no filesystem paths (the proof report is redacted).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

export const APPROVED_CAPABILITY_COMMIT = "bd55a3d8fd45aeabe717e794263e04b4032fa242";
export const APPROVED_CONTRACT_SHA256 = "310e30a2058f56e1310475bd20752d8883573028f836fd946fcaedb400172cda";
const CAPABILITY = "@toadaid/agent-capabilities";
const GIT_TIMEOUT_MS = 10_000;

export class ProofPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProofPreflightError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new ProofPreflightError(code, message); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

function git(repo, args, options) {
  const r = spawnSync(options.gitBinary ?? "git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (r.error?.code === "ENOENT") fail("WA_P1B_GIT_MISSING", "git is not available");
  if (r.error?.code === "ETIMEDOUT" || r.signal) fail("WA_P1B_GIT_TIMEOUT", `git ${args[0]} did not finish within ${GIT_TIMEOUT_MS} ms`);
  if (r.error) fail("WA_P1B_GIT_FAILED", `git ${args[0]} could not run`);
  return { status: r.status, stdout: r.stdout ?? "" };
}

/**
 * Exact source identity of the harness repository. With `expectedHead` (one
 * complete 40-character lowercase SHA-1), HEAD must be exactly that commit.
 * @returns {{ commit: string, ref: string|null, worktree: "MAIN"|"LINKED", clean: boolean, dirtyEntries: number, headExpectation: "MATCHED"|"NOT_REQUESTED" }}
 */
export async function resolveSourceIdentity(repo, options = {}) {
  const requireClean = options.requireClean ?? true;
  const expectedHead = options.expectedHead ?? null;
  // Validated before any git call: only one complete commit SHA is accepted
  // (no abbreviations, refs, upper case or surrounding whitespace).
  if (expectedHead !== null && (typeof expectedHead !== "string" || !/^[0-9a-f]{40}$/.test(expectedHead))) {
    fail("WA_P1B_EXPECTED_HEAD_INVALID", "the expected HEAD must be one complete 40-character lowercase hex commit SHA");
  }
  const top = git(repo, ["rev-parse", "--show-toplevel"], options);
  if (top.status !== 0) fail("WA_P1B_REPO_NOT_FOUND", "the harness directory is not inside a git work tree");
  let repoReal;
  let topReal;
  try {
    repoReal = await realpath(repo);
    topReal = await realpath(top.stdout.trim());
  } catch {
    fail("WA_P1B_REPO_AMBIGUOUS", "the work tree root cannot be resolved");
  }
  if (!samePath(repoReal, topReal)) fail("WA_P1B_REPO_AMBIGUOUS", "the harness repository is not the root of its git work tree");

  const head = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  const commit = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) fail("WA_P1B_HEAD_UNEXPECTED", "HEAD does not resolve to a single SHA-1 commit");
  if (expectedHead !== null && commit !== expectedHead) fail("WA_P1B_HEAD_MISMATCH", `HEAD is ${commit}, not the expected ${expectedHead}`);

  const sym = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  const ref = sym.status === 0 && sym.stdout.trim() !== "" ? sym.stdout.trim() : null;

  const dirs = git(repo, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], options);
  const [gitDir, commonDir] = dirs.stdout.trim().split(/\r?\n/);
  if (dirs.status !== 0 || !gitDir || !commonDir) fail("WA_P1B_REPO_AMBIGUOUS", "git directories cannot be resolved");
  let worktree;
  try {
    worktree = samePath(await realpath(gitDir), await realpath(commonDir)) ? "MAIN" : "LINKED";
  } catch {
    fail("WA_P1B_REPO_AMBIGUOUS", "git directories cannot be resolved");
  }

  const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=normal"], options);
  if (status.status !== 0) fail("WA_P1B_GIT_FAILED", "git status failed");
  const dirtyEntries = status.stdout.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  if (requireClean && dirtyEntries > 0) {
    fail("WA_P1B_WORKTREE_DIRTY", `the work tree has ${dirtyEntries} modified or untracked entr${dirtyEntries === 1 ? "y" : "ies"}; exact-source evidence needs a clean checkout`);
  }
  return { commit, ref, worktree, clean: dirtyEntries === 0, dirtyEntries, headExpectation: expectedHead === null ? "NOT_REQUESTED" : "MATCHED" };
}

function commitOf(spec) {
  return /#([0-9a-f]{40})$/.exec(String(spec ?? ""))?.[1] ?? null;
}

async function readJson(path, code, what) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fail(code, `${what} is missing or not valid JSON`);
  }
}

/**
 * Pinned, locked and installed capability identity; refuses any mismatch.
 * @returns {{ pinnedCommit: string, lockedCommit: string|null, installedCommit: string, lockfile: "COMMITTED"|"ABSENT_MANIFEST_PIN_FALLBACK", desktopObservationJsSha256: string }}
 */
export async function resolveCapabilityIdentity(repo, options = {}) {
  const expectedCommit = options.expectedCommit ?? APPROVED_CAPABILITY_COMMIT;
  const expectedContract = options.expectedContractSha256 ?? APPROVED_CONTRACT_SHA256;

  const manifest = await readJson(join(repo, "package.json"), "WA_P1B_MANIFEST_INVALID", "package.json");
  const pinnedCommit = commitOf(manifest?.dependencies?.[CAPABILITY]);
  if (pinnedCommit === null) fail("WA_P1B_CAPABILITY_PIN_UNEXPECTED", "package.json does not pin the capability package to a commit");
  if (pinnedCommit !== expectedCommit) fail("WA_P1B_CAPABILITY_PIN_UNEXPECTED", `package.json pins ${pinnedCommit}, not the approved ${expectedCommit}`);

  const tracked = git(repo, ["ls-files", "--error-unmatch", "--", "package-lock.json"], options).status === 0;
  const inHead = git(repo, ["cat-file", "-e", "HEAD:package-lock.json"], options).status === 0;
  let lockfile;
  let lockedCommit = null;
  if (tracked && inHead) {
    const modified = git(repo, ["diff", "--quiet", "HEAD", "--", "package-lock.json"], options).status !== 0;
    if (modified) fail("WA_P1B_LOCKFILE_MODIFIED", "package-lock.json differs from the committed version");
    const lock = await readJson(join(repo, "package-lock.json"), "WA_P1B_LOCKFILE_INVALID", "package-lock.json");
    lockedCommit = commitOf(lock?.packages?.[`node_modules/${CAPABILITY}`]?.resolved);
    if (lockedCommit !== pinnedCommit) fail("WA_P1B_CAPABILITY_PIN_MISMATCH", `the committed lockfile resolves ${lockedCommit ?? "nothing"}, not the pinned ${pinnedCommit}`);
    lockfile = "COMMITTED";
  } else {
    let present = false;
    try { await readFile(join(repo, "package-lock.json")); present = true; } catch { present = false; }
    if (present) fail("WA_P1B_LOCKFILE_UNTRACKED", "package-lock.json exists but is not the committed lockfile; it is never trusted");
    if (options.allowManifestPinFallback !== true) fail("WA_P1B_LOCKFILE_ABSENT", "no committed lockfile; pass --accept-manifest-pin-without-lockfile to validate against the manifest pin instead");
    lockfile = "ABSENT_MANIFEST_PIN_FALLBACK";
  }

  const hidden = await readJson(join(repo, "node_modules", ".package-lock.json"), "WA_P1B_CAPABILITY_NOT_INSTALLED", "the installed dependency record (node_modules/.package-lock.json)");
  const installedCommit = commitOf(hidden?.packages?.[`node_modules/${CAPABILITY}`]?.resolved);
  if (installedCommit === null) fail("WA_P1B_CAPABILITY_NOT_INSTALLED", "the capability package is not recorded as installed");
  if (installedCommit !== pinnedCommit) fail("WA_P1B_CAPABILITY_PIN_MISMATCH", `the installed capability is ${installedCommit}, not the pinned ${pinnedCommit}`);

  let contract;
  try {
    contract = await readFile(join(repo, "node_modules", "@toadaid", "agent-capabilities", "dist", "src", "desktopObservation.js"));
  } catch {
    fail("WA_P1B_CAPABILITY_NOT_INSTALLED", "the built capability contract is missing");
  }
  const desktopObservationJsSha256 = sha256(contract);
  if (desktopObservationJsSha256 !== expectedContract) fail("WA_P1B_CAPABILITY_BUILD_UNEXPECTED", `the built capability contract hashes to ${desktopObservationJsSha256}, not the approved ${expectedContract}`);

  return { pinnedCommit, lockedCommit, installedCommit, lockfile, desktopObservationJsSha256 };
}
