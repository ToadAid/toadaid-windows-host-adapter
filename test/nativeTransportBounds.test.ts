import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { normalizeDesktopObservationRequest } from "@toadaid/agent-capabilities/desktop-observation";
import type { DesktopObservationAdapterRequest } from "@toadaid/agent-capabilities/desktop-observation";

import {
  createPowerShellWindowsObservationWorker,
  createWindowsDesktopObservationAdapter,
  defaultWindowsPowerShellPath,
} from "../src/windowsObservationAdapter.js";
import { withTempRoot } from "./support/tempRoot.js";

// U02 transport evidence (native, no UI). The REAL worker cannot be made to
// misbehave without modifying it, so U02 stays BLOCKED for the real worker.
// What these prove natively is the REAL PowerShell transport (spawn, bounded
// stdout/stderr, exit handling, JSON parse) and the adapter's response checks.
// They run against small SYNTHETIC worker scripts that misbehave on purpose.
// Nothing reads a screen or UI tree. Skipped off Windows.

const WIN = process.platform === "win32";
const SKIP = WIN ? false : "native Windows PowerShell required";

function request(epoch: string, maxWallClockMs = 15_000): DesktopObservationAdapterRequest {
  return {
    schemaVersion: "toadaid.desktop-observation-adapter-request.v1",
    invocationId: `u02-${epoch}`,
    runId: "u02-transport",
    hostId: "u02-host",
    sessionId: "u02-session",
    ownerId: "u02-owner",
    capabilityId: "host:display-inventory",
    toolName: "desktop.display-inventory",
    observationEpoch: epoch,
    provider: { providerDescriptorSha256: "1".repeat(64), providerGenerationSha256: "2".repeat(64), evidenceNamespace: "u02-transport" },
    parametersSha256: "3".repeat(64),
    maxWallClockMs,
    parameters: normalizeDesktopObservationRequest({ kind: "DISPLAY_INVENTORY", hostId: "u02-host", sessionId: "u02-session", ownerId: "u02-owner", maxWallClockMs }),
  } as DesktopObservationAdapterRequest;
}

function powershellCount(filter: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // The probe's own command line contains the filter, so it excludes itself.
    const script = `$p = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${filter}*' }); [Console]::Out.Write($p.Count)`;
    const child = spawn(defaultWindowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    child.on("error", reject);
    child.on("close", () => resolve(Number(out.trim())));
  });
}

async function syntheticWorker(dir: string, name: string, body: string) {
  const path = join(dir, `${name}.ps1`);
  await writeFile(path, body, "utf8");
  return createPowerShellWindowsObservationWorker(defaultWindowsPowerShellPath(), path);
}

test("U02 transport (native, no UI): stdout beyond the 2 MiB bound is refused and the child is gone", { skip: SKIP, timeout: 60_000 }, async () => {
  await withTempRoot("toadaid-wa-u02-transport-", async (dir) => {
    const marker = `u02-oversized-${randomBytes(6).toString("hex")}`;
    const worker = await syntheticWorker(dir, marker, "[Console]::Out.Write(('x' * 3145728))\n");
    await assert.rejects(worker.run(request("u02-oversized"), join(dir, "artifacts")), /stdout exceeded bound/);
    let alive = -1;
    for (let i = 0; i < 10 && alive !== 0; i += 1) {
      alive = await powershellCount(marker);
      if (alive !== 0) await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(alive, 0, "the oversized child process is gone");
  });
});

test("U02 transport (native, no UI): malformed JSON is refused and only its SHA-256 is reported", { skip: SKIP, timeout: 60_000 }, async () => {
  await withTempRoot("toadaid-wa-u02-transport-", async (dir) => {
    const secret = `u02-not-json-${randomBytes(6).toString("hex")}`;
    const worker = await syntheticWorker(dir, "malformed", `[Console]::Out.Write('{"observationEpoch": ${secret}')\n`);
    await assert.rejects(worker.run(request("u02-malformed"), join(dir, "artifacts")), (error: Error) => {
      assert.match(error.message, /returned invalid JSON stdoutSha256=[a-f0-9]{64}$/);
      assert.equal(error.message.includes(secret), false, "raw stdout never enters the error");
      return true;
    });
  });
});

test("U02 transport (native, no UI): a failing worker reports its exit code and a stderr hash, never stderr itself, even when stderr floods", { skip: SKIP, timeout: 60_000 }, async () => {
  await withTempRoot("toadaid-wa-u02-transport-", async (dir) => {
    const secret = `u02-stderr-secret-${randomBytes(6).toString("hex")}`;
    const worker = await syntheticWorker(dir, "failing", `[Console]::Error.Write('${secret}')\n[Console]::Error.Write(('e' * 1048576))\nexit 3\n`);
    await assert.rejects(worker.run(request("u02-failing"), join(dir, "artifacts")), (error: Error) => {
      assert.match(error.message, /failed code=3 stderrSha256=[a-f0-9]{64}$/);
      assert.equal(error.message.includes(secret), false, "stderr content never enters the error");
      return true;
    });
  });
});

test("U02 transport (native, no UI): well-formed JSON of the wrong identity or shape is refused by the adapter", { skip: SKIP, timeout: 60_000 }, async () => {
  await withTempRoot("toadaid-wa-u02-transport-", async (dir) => {
    const registration = {
      schemaVersion: "toadaid.desktop-observation-adapter-registration.v1" as const,
      adapterId: "u02-transport-adapter",
      capabilityId: "host:display-inventory" as const,
      toolName: "desktop.display-inventory",
      contractId: "toadaid.host.display-inventory",
      descriptorSha256: "4".repeat(64),
      implementationFingerprintSha256: "5".repeat(64),
    };
    const cases: readonly (readonly [string, string, RegExp])[] = [
      ["wrong-epoch", `{"observationEpoch":"someone-else","hostId":"u02-host","sessionId":"u02-session","displayIds":[],"windowId":null,"displayTopologyEpoch":"topology-x","evidenceSha256":"${"6".repeat(64)}","artifacts":[],"artifactFiles":[]}`, /identity mismatch/],
      ["no-topology", `{"observationEpoch":"u02-no-topology","hostId":"u02-host","sessionId":"u02-session","displayIds":[0],"windowId":null,"evidenceSha256":"${"6".repeat(64)}","artifacts":[{"id":"a-0","kind":"DISPLAY_INVENTORY","sha256":"${"7".repeat(64)}"}],"artifactFiles":[{"id":"a-0","path":"C:\\\\nowhere\\\\a-0.json"}]}`, /displayTopologyEpoch is invalid/],
      ["bad-display-id", `{"observationEpoch":"u02-bad-display-id","hostId":"u02-host","sessionId":"u02-session","displayIds":[99],"windowId":null,"displayTopologyEpoch":"topology-x","evidenceSha256":"${"6".repeat(64)}","artifacts":[],"artifactFiles":[]}`, /displayIds are invalid/],
    ];
    for (const [name, json, expected] of cases) {
      const worker = await syntheticWorker(dir, name, `[Console]::Out.Write('${json.replace(/'/g, "''")}')\n`);
      const adapter = createWindowsDesktopObservationAdapter({ registration, artifactRoot: join(dir, "artifacts"), worker });
      const epoch = name === "wrong-epoch" ? "u02-wrong-epoch" : `u02-${name}`;
      await assert.rejects(adapter.observe(request(epoch)), expected, name);
    }
  });
});
