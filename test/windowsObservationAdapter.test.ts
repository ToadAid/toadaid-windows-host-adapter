import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
import {
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  join,
} from "node:path";
import test from "node:test";

import type {
  DesktopObservationAdapterRegistration,
  DesktopObservationAdapterRequest,
} from "@toadaid/agent-capabilities/desktop-observation";

import {
  buildWindowsPowerShellInvocation,
  createWindowsDesktopObservationAdapter,
  defaultWindowsPowerShellPath,
} from "../src/windowsObservationAdapter.js";
import type {
  WindowsObservationWorker,
} from "../src/windowsObservationAdapter.js";
import { withTempRoot } from "./support/tempRoot.js";

function sha256(
  value: Uint8Array | string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function registration():
  DesktopObservationAdapterRegistration {
  return {
    schemaVersion:
      "toadaid.desktop-observation-adapter-registration.v1",
    adapterId:
      "windows-observation-adapter",
    capabilityId:
      "host:display-inventory",
    toolName:
      "desktop.display-inventory",
    contractId:
      "toadaid.host.display-inventory",
    descriptorSha256:
      "1".repeat(64),
    implementationFingerprintSha256:
      "2".repeat(64),
  };
}

function request():
  DesktopObservationAdapterRequest {
  return {
    schemaVersion:
      "toadaid.desktop-observation-adapter-request.v1",
    invocationId: "invocation-001",
    runId: "run-001",
    hostId: "windows-host-001",
    sessionId: "host-session-001",
    ownerId: "agent0",
    capabilityId:
      "host:display-inventory",
    toolName:
      "desktop.display-inventory",
    observationEpoch:
      "observation-epoch-001",
    provider: {
      providerDescriptorSha256: "5".repeat(64),
      providerGenerationSha256: "6".repeat(64),
      evidenceNamespace: "windows-host-001-session-001",
    },
    parametersSha256:
      "3".repeat(64),
    maxWallClockMs: 5_000,
    parameters: {
      kind: "DISPLAY_INVENTORY",
      capabilityId:
        "host:display-inventory",
      toolName:
        "desktop.display-inventory",
      hostId: "windows-host-001",
      sessionId:
        "host-session-001",
      ownerId: "agent0",
      displayIds: [],
      displayTopologyEpoch: null,
      region: null,
      windowId: null,
      annotate: false,
      includeScreenshot: false,
      useDom: false,
      maxElements: 0,
      condition: null,
      text: null,
      timeoutMs: 0,
      intervalMs: 0,
      maxWallClockMs: 5_000,
    },
  };
}

test("WA-P1 PowerShell invocation is argv-only with shell=false", () => {
  const invocation =
    buildWindowsPowerShellInvocation(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\adapter\\windows-observation.ps1",
    );

  assert.equal(
    invocation.executable,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(
    invocation.shell,
    false,
  );
  assert.deepEqual(
    invocation.argv.slice(0, 6),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ],
  );
});

test("WA-P1 PowerShell path is explicit local absolute and derived from SystemRoot", () => {
  assert.equal(
    defaultWindowsPowerShellPath("C:\\Windows"),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );

  assert.throws(
    () =>
      buildWindowsPowerShellInvocation(
        "powershell.exe",
        "C:\\adapter\\windows-observation.ps1",
      ),
    /explicit local absolute Windows path/,
  );

  assert.throws(
    () =>
      buildWindowsPowerShellInvocation(
        "\\\\server\\share\\powershell.exe",
        "C:\\adapter\\windows-observation.ps1",
      ),
    /explicit local absolute Windows path/,
  );
});

test("WA-P1 adapter verifies artifacts and exposes only verified local resolution", async () => withTempRoot("toadaid-windows-observation-", async (root) => {
  const artifactPath =
    join(
      root,
      "display-inventory-observation-epo-0.json",
    );
  const artifactBytes =
    Buffer.from(
      '{"displays":[]}',
      "utf8",
    );
  await writeFile(
    artifactPath,
    artifactBytes,
  );

  const worker:
    WindowsObservationWorker = {
      async run(workerRequest) {
        return {
          observationEpoch:
            workerRequest.observationEpoch,
          hostId:
            workerRequest.hostId,
          sessionId:
            workerRequest.sessionId,
          displayIds: [],
          windowId: null,
          displayTopologyEpoch:
            "topology-test-001",
          evidenceSha256:
            "4".repeat(64),
          artifacts: [
            {
              id:
                "display-inventory-observation-epo-0",
              kind:
                "DISPLAY_INVENTORY",
              sha256:
                sha256(artifactBytes),
            },
          ],
          artifactFiles: [
            {
              id:
                "display-inventory-observation-epo-0",
              path: artifactPath,
            },
          ],
        };
      },
    };

  const adapter =
    createWindowsDesktopObservationAdapter({
      registration:
        registration(),
      artifactRoot: root,
      worker,
      platform: "linux",
    });

  const result =
    await adapter.observe(
      request(),
    );

  assert.equal(
    result.artifacts.length,
    1,
  );
  // The adapter resolves artifacts to their canonical real path; tmpdir() may
  // be a different spelling of the same directory (e.g. a Windows 8.3 short
  // name such as RUNNER~1 on GitHub-hosted runners). Compare canonical forms.
  assert.equal(
    adapter.resolveArtifactPath(
      result.artifacts[0]!.id,
    ),
    await realpath(artifactPath),
  );

  const onDisk = await readFile(
    artifactPath,
  );
  assert.equal(
    sha256(onDisk),
    result.artifacts[0]!.sha256,
  );
}));

test("WA-P1 refuses capability/tool substitution before worker entry", async () => withTempRoot("toadaid-windows-observation-", async (root) => {
  let calls = 0;
  const worker:
    WindowsObservationWorker = {
      async run() {
        calls += 1;
        throw new Error("must not run");
      },
    };

  const adapter =
    createWindowsDesktopObservationAdapter({
      registration:
        registration(),
      artifactRoot: root,
      worker,
      platform: "linux",
    });

  await assert.rejects(
    adapter.observe({
      ...request(),
      capabilityId:
        "host:screenshot",
      toolName:
        "desktop.screenshot",
    }),
    /does not match adapter registration/,
  );
  assert.equal(calls, 0);
}));

test("WA-P1 refuses DOM, annotation, and selectorless element waits before worker entry", async () => withTempRoot("toadaid-windows-observation-", async (root) => {
  let calls = 0;
  const worker:
    WindowsObservationWorker = {
      async run() {
        calls += 1;
        throw new Error("must not run");
      },
    };

  const uiRegistration:
    DesktopObservationAdapterRegistration = {
      ...registration(),
      capabilityId:
        "host:ui-snapshot",
      toolName:
        "desktop.ui-snapshot",
      contractId:
        "toadaid.host.ui-snapshot",
    };
  const uiAdapter =
    createWindowsDesktopObservationAdapter({
      registration:
        uiRegistration,
      artifactRoot: root,
      worker,
      platform: "linux",
    });

  await assert.rejects(
    uiAdapter.observe({
      ...request(),
      capabilityId:
        "host:ui-snapshot",
      toolName:
        "desktop.ui-snapshot",
      parameters: {
        ...request().parameters,
        kind: "UI_SNAPSHOT",
        capabilityId:
          "host:ui-snapshot",
        toolName:
          "desktop.ui-snapshot",
        windowId:
          "hwnd-123",
        useDom: true,
        maxElements: 10,
      },
    }),
    /refuses useDom=true/,
  );

  await assert.rejects(
    uiAdapter.observe({
      ...request(),
      capabilityId:
        "host:ui-snapshot",
      toolName:
        "desktop.ui-snapshot",
      parameters: {
        ...request().parameters,
        kind: "UI_SNAPSHOT",
        capabilityId:
          "host:ui-snapshot",
        toolName:
          "desktop.ui-snapshot",
        windowId:
          "hwnd-123",
        displayIds: [0],
        maxElements: 10,
      },
    }),
    /refuses mixed window \+ display\/region UI scope/,
  );

  const waitRegistration:
    DesktopObservationAdapterRegistration = {
      ...registration(),
      capabilityId:
        "host:wait-for",
      toolName:
        "desktop.wait-for",
      contractId:
        "toadaid.host.wait-for",
    };
  const waitAdapter =
    createWindowsDesktopObservationAdapter({
      registration:
        waitRegistration,
      artifactRoot: root,
      worker,
      platform: "linux",
    });

  await assert.rejects(
    waitAdapter.observe({
      ...request(),
      capabilityId:
        "host:wait-for",
      toolName:
        "desktop.wait-for",
      parameters: {
        ...request().parameters,
        kind: "WAIT_FOR",
        capabilityId:
          "host:wait-for",
        toolName:
          "desktop.wait-for",
        windowId:
          "hwnd-123",
        condition:
          "element_exists",
        timeoutMs: 1_000,
        intervalMs: 250,
        maxWallClockMs: 1_000,
      },
    }),
    /selectorless element wait/,
  );

  assert.equal(calls, 0);
}));

test("WA-P1 source worker remains observation-only", async () => {
  const sourcePath = new URL(
    "../../worker/windows-observation.ps1",
    import.meta.url,
  );
  const source = await readFile(
    sourcePath,
    "utf8",
  );

  for (const forbidden of [
    "SendKeys",
    "SetCursorPos",
    "mouse_event",
    "InvokePattern",
    "SetValue",
    "TerminateProcess",
    "Set-ItemProperty",
    "Remove-Item",
    "Start-Process",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      forbidden,
    );
  }

  assert.equal(
    source.includes("CopyFromScreen"),
    true,
  );
  assert.equal(
    source.includes("AutomationElement"),
    true,
  );
  assert.equal(
    source.includes("ConvertFrom-Json -Depth"),
    false,
  );
  assert.equal(
    source.includes("Artifact-Token"),
    true,
  );
  assert.equal(
    source.includes("Resolve-AuthorizedRects"),
    true,
  );
  assert.equal(
    source.includes("Rect-ContainedByAny"),
    true,
  );
  assert.equal(
    source.includes("Element-IsWithinWindow"),
    true,
  );
  assert.equal(
    source.includes("Rect-IsValid"),
    true,
  );
  assert.equal(
    source.includes(
      "$child = $walker.GetNextSibling($child)",
    ),
    true,
  );
  assert.equal(
    source.includes(
      "$sibling = $walker.GetNextSibling($element)",
    ),
    false,
  );
});
