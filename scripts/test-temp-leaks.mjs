#!/usr/bin/env node
// Test temp-directory leak gate (WA-TEST-TEMP-P1, issue #15).
//
//   node scripts/test-temp-leaks.mjs snapshot <state.json>
//   node scripts/test-temp-leaks.mjs verify   <state.json>
//
// `snapshot` records the names of test-owned entries (`toadaid-*`, `wa-p1a2-*`)
// directly inside the OS temp directory. `verify` fails (exit 3) if new ones
// remain, reporting only each name, its file count and total bytes. It never
// deletes, moves or reads the contents of anything: historical leftovers are
// the operator's to inspect, and new leftovers are evidence of a test defect.

import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNED = /^(toadaid|wa-p1a2)-/;

async function owned(base) {
  return (await readdir(base)).filter((n) => OWNED.test(n)).sort();
}

async function summarize(dir) {
  let files = 0;
  let bytes = 0;
  let links = 0;
  async function rec(p) {
    const st = await lstat(p);
    if (st.isSymbolicLink()) { links += 1; return; }
    if (st.isDirectory()) { for (const n of await readdir(p)) await rec(join(p, n)); return; }
    files += 1;
    bytes += st.size;
  }
  await rec(dir);
  return { files, bytes, links };
}

async function main() {
  const [command, statePath] = process.argv.slice(2);
  if (!statePath || (command !== "snapshot" && command !== "verify")) {
    console.error("usage: test-temp-leaks.mjs snapshot|verify <state.json>");
    process.exitCode = 2;
    return;
  }
  const base = await realpath(tmpdir());
  if (command === "snapshot") {
    const names = await owned(base);
    await writeFile(statePath, `${JSON.stringify({ base, names })}\n`, "utf8");
    console.log(`test-temp-leaks: ${names.length} pre-existing test-owned entries in ${base} (left untouched)`);
    return;
  }
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.base !== base) {
    console.error(`test-temp-leaks: temp directory changed (${state.base} -> ${base})`);
    process.exitCode = 2;
    return;
  }
  const before = new Set(state.names);
  const leaked = (await owned(base)).filter((n) => !before.has(n));
  if (leaked.length === 0) {
    console.log("test-temp-leaks: no new test-owned temp entries left behind");
    return;
  }
  console.error(`test-temp-leaks: ${leaked.length} new test-owned temp entr${leaked.length === 1 ? "y" : "ies"} left behind (not removed):`);
  for (const n of leaked) {
    const s = await summarize(join(base, n));
    console.error(`  ${n}: ${s.files} files, ${s.bytes} bytes${s.links > 0 ? `, ${s.links} links` : ""}`);
  }
  process.exitCode = 3;
}

main().catch((e) => {
  console.error(`test-temp-leaks: ERROR: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
