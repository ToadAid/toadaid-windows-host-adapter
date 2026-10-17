import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  DesktopObservationAdapterRegistration,
  DesktopObservationAdapterRequest,
} from "@toadaid/agent-capabilities";

import {
  createWindowsDesktopObservationAdapter,
} from "../src/windowsObservationAdapter.js";

// Mirrors ADAPTER_WATCHDOG_GRACE_MS; kept literal so this test also runs (and
// fails, rather than failing to import) against an adapter without a watchdog.
const ADAPTER_WATCHDOG_GRACE_MS = 2_000;
import type {
  WindowsObservationWorker,
} from "../src/windowsObservationAdapter.js";

// WA-P1A.2 Linux-verifiable checks. The worker's own behaviour (F1, F2, F4)
// is proven natively in test/nativeObservationSafety.test.ts; the checks here
// are the adapter contract (F3) plus source-structure guards, not native proof.

const registration: DesktopObservationAdapterRegistration = {
  schemaVersion: "toadaid.desktop-observation-adapter-registration.v1",
  adapterId: "windows-observation-adapter",
  capabilityId: "host:wait-for",
  toolName: "desktop.wait-for",
  contractId: "toadaid.host.wait-for",
  descriptorSha256: "1".repeat(64),
  implementationFingerprintSha256: "2".repeat(64),
};

function waitRequest(maxWallClockMs: number): DesktopObservationAdapterRequest {
  return {
    schemaVersion: "toadaid.desktop-observation-adapter-request.v1",
    invocationId: "invocation-001",
    runId: "run-001",
    hostId: "windows-host-001",
    sessionId: "host-session-001",
    ownerId: "agent0",
    capabilityId: "host:wait-for",
    toolName: "desktop.wait-for",
    observationEpoch: "observation-epoch-001",
    parametersSha256: "3".repeat(64),
    maxWallClockMs,
    parameters: {
      kind: "WAIT_FOR",
      capabilityId: "host:wait-for",
      toolName: "desktop.wait-for",
      hostId: "windows-host-001",
      sessionId: "host-session-001",
      ownerId: "agent0",
      displayIds: [],
      region: null,
      windowId: "hwnd-1",
      annotate: false,
      includeScreenshot: false,
      useDom: false,
      maxElements: 256,
      condition: "text_exists",
      text: "absent",
      timeoutMs: maxWallClockMs,
      intervalMs: 250,
      maxWallClockMs,
    },
  };
}

test("WA-P1A.2 F3: the worker receives an inner deadline before the adapter's outer wall clock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-p1a2-f3-"));
  try {
  for (const max of [1_500, 10_000]) {
    const seen: (number | undefined)[] = [];
    const worker: WindowsObservationWorker = {
      async run(request, artifactRoot, workerDeadlineUtcMs) {
        seen.push(workerDeadlineUtcMs);
        const path = join(artifactRoot, "wait-result-f3-0.json");
        const bytes = Buffer.from('{"matched":false}', "utf8");
        await writeFile(path, bytes);
        return {
          observationEpoch: request.observationEpoch,
          hostId: request.hostId,
          sessionId: request.sessionId,
          displayIds: [],
          windowId: request.parameters.windowId,
          evidenceSha256: "4".repeat(64),
          artifacts: [{ id: "wait-result-f3-0", kind: "WAIT_RESULT", sha256: createHash("sha256").update(bytes).digest("hex") }],
          matched: false,
          artifactFiles: [{ id: "wait-result-f3-0", path }],
        };
      },
    };
    const adapter = createWindowsDesktopObservationAdapter({ registration, artifactRoot: root, worker, platform: "linux" });
    const before = Date.now();
    const result = await adapter.observe(waitRequest(max));
    const after = Date.now();
    assert.equal(result.matched, false);
    const deadline = seen[0];
    assert.equal(typeof deadline, "number", "worker must receive workerDeadlineUtcMs");
    const reserve = Math.min(750, Math.floor(max / 4));
    assert.ok(deadline! >= before + max - reserve && deadline! <= after + max - reserve, `deadline within reserve for ${max}`);
    assert.ok(deadline! < before + max, "inner deadline strictly before the outer wall clock");
  }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WA-P1A.2 review: a wait longer than its wall clock is refused before the worker runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-p1a2-refuse-"));
  try {
    let calls = 0;
    const worker: WindowsObservationWorker = { async run() { calls += 1; throw new Error("must not run"); } };
    const adapter = createWindowsDesktopObservationAdapter({ registration, artifactRoot: root, worker, platform: "linux" });
    const base = waitRequest(3_000);
    await assert.rejects(adapter.observe({ ...base, parameters: { ...base.parameters, timeoutMs: 20_000 } }), /WAIT_TIMEOUT_EXCEEDS_WALL_CLOCK/);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WA-P1A.2 review: the adapter's own watchdog bounds a worker that never answers", { timeout: 8_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-p1a2-watchdog-"));
  try {
    const worker: WindowsObservationWorker = { run: () => new Promise(() => {}) };
    const adapter = createWindowsDesktopObservationAdapter({ registration, artifactRoot: root, worker, platform: "linux" });
    const started = Date.now();
    await assert.rejects(adapter.observe(waitRequest(500)), /exceeded the adapter watchdog/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 500 + ADAPTER_WATCHDOG_GRACE_MS - 50 && elapsed < 500 + ADAPTER_WATCHDOG_GRACE_MS + 1_500, `watchdog fired after ${elapsed} ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WA-P1A.2 source guards: region coverage, window containment, name redaction, oracle-safe text wait", async () => {
  const source = await readFile(new URL("../../worker/windows-observation.ps1", import.meta.url), "utf8");
  for (const required of [
    "function Region-CoveredByDisplays",
    "requested region is not fully on a display",
    "$windowScopeRects",
    "Rect-ContainedByAny $rect $windowScopeRects",
    "function Text-PolicyFor",
    "nameRedacted = (-not $policy.nameRecorded)",
    "if ($policy.nameRecorded) {",
    "(Text-PolicyFor (Element-TextFacts $candidate)).nameRecorded",
    "wait deadline exhausted before the first check",
    "public static bool TryGetStyle(",
    "$editStyleUnverified = $editClass -and -not $styleVerified",
    "function Safe-Identifier",
    '$reason = "WORKER_BUDGET_REACHED"',
    'if ($MyInvocation.InvocationName -ne ".") {',
  ]) {
    assert.equal(source.includes(required), true, required);
  }
  // The element fingerprint must be computed from the redacted record.
  const nameAt = source.indexOf("if ($policy.nameRecorded) {");
  const fingerprintAt = source.indexOf("$fingerprint = $record | ConvertTo-Json");
  assert.ok(nameAt > 0 && fingerprintAt > nameAt, "fingerprint after redaction");
  assert.equal(source.includes("$found = $window.FindFirst("), false, "text_exists must not accept the first name match unconditionally");
});
