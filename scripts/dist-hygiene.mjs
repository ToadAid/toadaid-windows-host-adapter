#!/usr/bin/env node
// Build hygiene for the generated `dist/` directory (WA-BUILD-CLEAN-P1, issue #16).
//
//   node scripts/dist-hygiene.mjs clean      [--root <repo>] [--prepare]
//   node scripts/dist-hygiene.mjs mark       [--root <repo>] --config <tsconfig file>
//   node scripts/dist-hygiene.mjs run-tests  [--root <repo>] [--list]
//
// `clean` removes `<repo>/dist` ONLY when it is provably this package's own
// generated output; otherwise it refuses (exit 2) and deletes nothing:
//   - <repo> has this package's package.json and is inside a git work tree;
//   - dist is a real directory directly inside <repo> (not a symlink/junction,
//     not reached through one, not a file);
//   - dist carries the ownership marker written by `mark` for this package;
//   - every entry below dist is a plain directory or a compiler-emitted file
//     (.js / .d.ts / their .map); no symlinks, no other material;
//   - nothing under dist is tracked (or staged) in git.
// No globbing, no `git clean`/reset/stash, nothing outside dist is touched.
// With --prepare (used by the build scripts) it then creates a fresh dist that
// holds only a "building" marker, so a compile that fails half-way still
// leaves output this script can verify and remove next time.
//
// `mark` (run right after a successful tsc) completes the marker: package,
// tsconfig used, the SHA-256 of that tsconfig and of every config it extends,
// the git HEAD commit, and the SHA-256 of every source file compiled, so the
// output stays traceable to the source and HEAD it was built from. It requires
// the "building" marker from `clean --prepare` and refuses when git HEAD
// cannot be resolved or a config cannot be verified.
//
// `run-tests` runs exactly the compiled tests that correspond to the current
// test/**/*.test.ts sources, and refuses (exit 2) if dist holds any compiled
// test without a current source (a stale test), lacks one, was built by a
// config without tests, or was built from different source bytes, a different
// git HEAD, or different compiler configuration bytes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@toadaid/windows-host-adapter";
const MARKER = ".toadaid-dist-owner.json";
const MARKER_SCHEMA = "toadaid.windows-host-adapter.dist-owner.v1";
const EMITTED = [/\.js$/, /\.d\.ts$/, /\.js\.map$/, /\.d\.ts\.map$/];
const MAX_ENTRIES = 20_000;
const SOURCE_DIRS = { "tsconfig.json": ["src", "test"], "tsconfig.build.json": ["src"] };

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseArgs(argv) {
  const out = { command: argv[0], root: resolve(dirname(fileURLToPath(import.meta.url)), ".."), config: null, list: false, prepare: false };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--root") out.root = argv[++i];
    else if (argv[i] === "--config") out.config = argv[++i];
    else if (argv[i] === "--list") out.list = true;
    else if (argv[i] === "--prepare") out.prepare = true;
    else refuse(`unknown argument: ${argv[i]}`);
  }
  if (typeof out.root !== "string" || out.root.length === 0) refuse("--root needs a path");
  return out;
}

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

async function verifyRoot(rootArg) {
  let root;
  try { root = await realpath(resolve(rootArg)); } catch { refuse(`repository root not found: ${rootArg}`); }
  let pkg;
  try { pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { refuse("no readable package.json at the repository root"); }
  if (pkg?.name !== PACKAGE_NAME) refuse(`package.json at the root is not ${PACKAGE_NAME}`);
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top === null) refuse("the repository root is not inside a git work tree (cannot verify that dist is untracked)");
  return root;
}

async function walk(dir, rel, out) {
  for (const name of await readdir(dir)) {
    if (out.length >= MAX_ENTRIES) refuse(`dist has more than ${MAX_ENTRIES} entries`);
    const abs = join(dir, name);
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = await lstat(abs);
    if (st.isSymbolicLink()) refuse(`unexpected material: dist/${r} is a symlink or junction`);
    if (st.isDirectory()) { await walk(abs, r, out); continue; }
    if (!st.isFile()) refuse(`unexpected material: dist/${r} is not a regular file`);
    if (!(r === MARKER || EMITTED.some((p) => p.test(name)))) refuse(`unexpected material: dist/${r} is not compiler output`);
    out.push(r);
  }
  return out;
}

async function readMarker(dist) {
  const p = join(dist, MARKER);
  let st;
  try { st = await lstat(p); } catch { refuse("unknown ownership: dist has no ownership marker (remove it by hand after checking its contents)"); }
  if (!st.isFile()) refuse("unknown ownership: the ownership marker is not a regular file");
  let m;
  try { m = JSON.parse(await readFile(p, "utf8")); } catch { refuse("unknown ownership: the ownership marker is not valid JSON"); }
  if (m?.schema !== MARKER_SCHEMA || m?.package !== PACKAGE_NAME) refuse("unknown ownership: the ownership marker does not belong to this package");
  if (m.status !== "building" && m.status !== "complete") refuse("unknown ownership: the ownership marker has an unknown status");
  return m;
}

/** Returns null when dist is absent; otherwise the verified marker and entries. Refuses on anything ambiguous. */
async function inspectDist(root) {
  const dist = join(root, "dist");
  let st;
  try { st = await lstat(dist); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
  if (st.isSymbolicLink()) refuse("dist is a symlink or junction");
  if (!st.isDirectory()) refuse("dist exists but is not a directory");
  const real = await realpath(dist);
  if (!samePath(real, join(root, "dist")) || !samePath(dirname(real), root)) refuse("dist does not resolve to a directory directly inside the repository root");
  const marker = await readMarker(dist);
  const entries = await walk(dist, "", []);
  const tracked = git(root, ["ls-files", "-z", "--", "dist"]);
  if (tracked === null) refuse("cannot verify with git that dist is untracked");
  if (tracked.length > 0) refuse("dist contains files tracked by git; refusing to remove them");
  return { dist, marker, entries };
}

async function sourceFiles(root, dirs) {
  const files = [];
  async function rec(abs, rel) {
    for (const name of (await readdir(abs)).sort()) {
      const a = join(abs, name);
      const r = `${rel}/${name}`;
      const st = await lstat(a);
      if (st.isDirectory()) await rec(a, r);
      else if (st.isFile() && name.endsWith(".ts")) files.push(r);
    }
  }
  for (const d of dirs) {
    try { await rec(join(root, d), d); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
  files.sort();
  const out = {};
  for (const f of files) out[f] = createHash("sha256").update(await readFile(join(root, ...f.split("/")))).digest("hex");
  return out;
}

function baseMarker() {
  return { schema: MARKER_SCHEMA, package: PACKAGE_NAME, generatedBy: "scripts/dist-hygiene.mjs" };
}

async function currentHead(root) {
  const out = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const head = out === null ? "" : out.trim();
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head) ? head : null;
}

/** SHA-256 of `config` and of every config it extends (relative paths only), keyed by repo-relative path. */
async function configHashes(root, config) {
  const out = {};
  let rel = config;
  for (let depth = 0; depth < 8; depth += 1) {
    if (Object.hasOwn(out, rel)) refuse(`compiler configuration extends itself in a cycle at ${rel}`);
    const abs = resolve(root, ...rel.split("/"));
    const inside = relative(root, abs);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) refuse(`compiler configuration ${rel} is outside the repository`);
    let bytes;
    try { bytes = await readFile(abs); } catch { refuse(`compiler configuration ${rel} is missing`); }
    out[rel] = createHash("sha256").update(bytes).digest("hex");
    let parsed;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { refuse(`compiler configuration ${rel} is not plain JSON; cannot verify what it extends`); }
    const ext = parsed?.extends;
    if (ext === undefined) return out;
    if (typeof ext !== "string" || !(ext.startsWith("./") || ext.startsWith("../"))) refuse(`compiler configuration ${rel} extends ${JSON.stringify(ext)}, which cannot be verified`);
    rel = relative(root, resolve(dirname(abs), ext)).split(sep).join("/");
  }
  return refuse("compiler configuration extends chain is too deep");
}

async function clean(root, prepare) {
  const found = await inspectDist(root);
  const dist = join(root, "dist");
  if (found === null) console.log("dist-hygiene: dist absent; nothing to clean");
  else {
    await rm(found.dist, { recursive: true, force: false });
    try { await lstat(found.dist); refuse("dist still exists after removal"); } catch (e) { if (e instanceof Refusal) throw e; }
    console.log(`dist-hygiene: removed generated dist (${found.entries.length} files, marker ${found.marker.status}, HEAD ${found.marker.head ?? "unknown"})`);
  }
  if (prepare) {
    await mkdir(dist);
    await writeFile(join(dist, MARKER), `${JSON.stringify({ ...baseMarker(), status: "building" }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
}

async function mark(root, config) {
  if (!Object.hasOwn(SOURCE_DIRS, config ?? "")) refuse(`--config must be one of ${Object.keys(SOURCE_DIRS).join(", ")}`);
  const dist = join(root, "dist");
  let st;
  try { st = await lstat(dist); } catch { refuse("dist does not exist; run tsc first"); }
  if (st.isSymbolicLink() || !st.isDirectory()) refuse("dist is not a real directory");
  const prior = await readMarker(dist);
  if (prior.status !== "building") refuse("dist was not prepared by `clean --prepare` for this build");
  const head = await currentHead(root);
  if (head === null) refuse("git HEAD cannot be resolved; a build must be traceable to a commit");
  const marker = {
    ...baseMarker(),
    status: "complete",
    config,
    configs: await configHashes(root, config),
    head,
    sources: await sourceFiles(root, SOURCE_DIRS[config]),
  };
  await writeFile(join(dist, MARKER), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  const entries = await walk(dist, "", []);
  console.log(`dist-hygiene: marked dist (${config}, ${Object.keys(marker.sources).length} sources, ${entries.length} files)`);
}

async function runTests(root, list) {
  const found = await inspectDist(root);
  if (found === null) refuse("dist is absent; run `npm run test:build` first");
  const { marker, entries } = found;
  if (marker.status !== "complete") refuse("dist build did not complete (marker still says building); rebuild");
  if (marker.config !== "tsconfig.json") refuse(`dist was built with ${marker.config}, which does not compile the tests`);
  const current = await sourceFiles(root, SOURCE_DIRS["tsconfig.json"]);
  const a = JSON.stringify(Object.entries(current));
  const b = JSON.stringify(Object.entries(marker.sources ?? {}));
  if (a !== b) refuse("dist was built from different source files than the current checkout; rebuild");
  const head = await currentHead(root);
  if (head === null) refuse("git HEAD cannot be resolved; cannot verify which commit dist belongs to");
  if (typeof marker.head !== "string" || marker.head !== head) refuse(`dist was built at a different git HEAD (${marker.head ?? "none recorded"}) than the current checkout (${head}); rebuild`);
  const configs = await configHashes(root, marker.config);
  if (JSON.stringify(Object.entries(configs)) !== JSON.stringify(Object.entries(marker.configs ?? {}))) refuse("dist was built with different compiler configuration bytes than the current checkout; rebuild");
  const expected = Object.keys(current).filter((f) => f.startsWith("test/") && f.endsWith(".test.ts")).map((f) => f.replace(/\.ts$/, ".js"));
  const compiled = entries.filter((e) => e.startsWith("test/") && e.endsWith(".test.js"));
  const stale = compiled.filter((e) => !expected.includes(e));
  const missing = expected.filter((e) => !compiled.includes(e));
  if (stale.length > 0) refuse(`stale compiled test(s) with no current source: ${stale.map((s) => `dist/${s}`).join(", ")}`);
  if (missing.length > 0) refuse(`compiled test(s) missing: ${missing.map((s) => `dist/${s}`).join(", ")}`);
  const files = expected.map((e) => join("dist", ...e.split("/")));
  if (list) { for (const f of files) console.log(f.split(sep).join("/")); return 0; }
  const r = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit", windowsHide: true });
  return r.status ?? 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = await verifyRoot(args.root);
  if (args.command === "clean") return clean(root, args.prepare);
  if (args.command === "mark") return mark(root, args.config);
  if (args.command === "run-tests") { process.exitCode = await runTests(root, args.list); return; }
  refuse("usage: dist-hygiene.mjs clean|mark|run-tests [--root <repo>] [--config <tsconfig>] [--list]");
}

main().catch((e) => {
  if (e instanceof Refusal) { console.error(`dist-hygiene: REFUSED: ${e.message}`); process.exitCode = 2; return; }
  console.error(`dist-hygiene: ERROR: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
