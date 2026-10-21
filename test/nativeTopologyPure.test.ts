import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { defaultWindowsPowerShellPath } from "../src/windowsObservationAdapter.js";
import { withTempRoot } from "./support/tempRoot.js";

// WA-CAP-SYNC-P1 (native, pure): these dot-source the REAL worker and call its
// pure functions only; nothing is captured and no desktop is read. They need
// native Windows PowerShell, so they run on windows-2022 CI and are skipped on
// Linux. The DPI-awareness call itself is process-local and is exercised only
// when the worker runs, never here.

const WIN = process.platform === "win32";
const PURE_SKIP = WIN ? false : "native Windows PowerShell required";
const WORKER = fileURLToPath(new URL("../../worker/windows-observation.ps1", import.meta.url));

function runPowerShellFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(defaultWindowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("powershell timed out")); }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { err += d; });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`powershell exit ${code}: ${err.slice(0, 400)}`)); });
  });
}

async function dotSource(cases: readonly unknown[], expression: string): Promise<unknown[]> {
  return withTempRoot("toadaid-wa-capsync-pure-", async (dir) => {
    const casesFile = join(dir, "cases.json");
    const scriptFile = join(dir, "probe.ps1");
    await writeFile(casesFile, JSON.stringify(cases), "utf8");
    await writeFile(scriptFile, [
      `. '${WORKER.replace(/'/g, "''")}'`,
      `$cases = Get-Content -Raw -LiteralPath '${casesFile.replace(/'/g, "''")}' | ConvertFrom-Json`,
      `$out = @(foreach ($c in $cases) { ${expression} })`,
      `[Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress -Depth 4))`,
    ].join("\n"), "utf8");
    return JSON.parse(await runPowerShellFile(scriptFile)) as unknown[];
  });
}

const display = (id: number, primary: boolean, left: number, top: number, right: number, bottom: number, deviceName: string) =>
  ({ id, primary, deviceName, bounds: { left, top, right, bottom } });

test("WA-CAP-SYNC-P1 (native, pure): display topology epoch is deterministic and changes with any topology fact", { skip: PURE_SKIP }, async () => {
  const one = [display(0, true, 0, 0, 1600, 900, "\\\\.\\DISPLAY1")];
  const cases = [
    { displays: one, awareness: 2 },
    { displays: one, awareness: 2 },
    { displays: [display(0, true, 0, 0, 1920, 1080, "\\\\.\\DISPLAY1")], awareness: 2 },
    { displays: [display(0, false, 0, 0, 1600, 900, "\\\\.\\DISPLAY1")], awareness: 2 },
    { displays: [display(0, true, 0, 0, 1600, 900, "\\\\.\\DISPLAY2")], awareness: 2 },
    { displays: one, awareness: 0 },
    { displays: [...one, display(1, false, -1920, 0, 0, 1080, "\\\\.\\DISPLAY2")], awareness: 2 },
  ];
  const got = (await dotSource(cases, "Display-TopologyEpoch @($c.displays) ([int]$c.awareness)")) as string[];
  for (const epoch of got) assert.match(epoch, /^topology-sha256-[a-f0-9]{64}$/);
  assert.equal(got[0], got[1], "same topology, same epoch");
  assert.equal(new Set(got.slice(1)).size, got.length - 1, "bounds, primary, device, awareness and display count each change the epoch");
});

test("WA-CAP-SYNC-P1 (native, pure): wait completion reason is MATCHED only when matched", { skip: PURE_SKIP }, async () => {
  const got = await dotSource([{ m: true }, { m: false }], "Wait-CompletionReason ([bool]$c.m)");
  assert.deepEqual(got, ["MATCHED", "TIMED_OUT"]);
});

test("WA-CAP-SYNC-P1 (source): the worker binds topology before capture and refuses exact-window geometry without per-monitor DPI awareness", async () => {
  const source = await readFile(WORKER, "utf8");
  const binding = source.indexOf("DISPLAY_TOPOLOGY_STALE");
  const firstCapture = source.indexOf("switch ([string]$parameters.kind)");
  assert.ok(binding > 0 && firstCapture > binding, "topology is checked before any kind-specific capture");
  assert.match(source, /\$script:DpiAwareness = Enable-PerMonitorDpiAwareness/);
  assert.match(source, /GEOMETRY_COORDINATE_SPACE_UNPROVEN/);
  assert.match(source, /coordinateSpace = "DESKTOP_PHYSICAL"/);
  // process-local only: no system-wide DPI or registry setting
  for (const forbidden of ["SetProcessDPIAware(", "Set-ItemProperty", "HKCU:", "HKLM:"]) assert.equal(source.includes(forbidden), false, forbidden);
});
