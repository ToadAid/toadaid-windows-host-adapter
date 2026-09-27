import {
  createHash,
} from "node:crypto";
import {
  mkdir,
} from "node:fs/promises";
import {
  resolve,
} from "node:path";

import {
  createWindowsDesktopObservationAdapter,
} from "../dist/src/index.js";

if (process.platform !== "win32") {
  console.error(
    "WINDOWS_LIVE_OBSERVATION_REQUIRED: run this proof on native Windows.",
  );
  process.exitCode = 2;
} else {
  const artifactRoot = resolve(
    "artifacts/live-observation",
  );
  await mkdir(
    artifactRoot,
    { recursive: true },
  );

  const registration = {
    schemaVersion:
      "toadaid.desktop-observation-adapter-registration.v1",
    adapterId:
      "windows-observation-live-display",
    capabilityId:
      "host:display-inventory",
    toolName:
      "desktop.display-inventory",
    contractId:
      "toadaid.host.display-inventory",
    descriptorSha256:
      "0".repeat(64),
    implementationFingerprintSha256:
      createHash("sha256")
        .update(
          "WA-P1-live-local-unregistered",
        )
        .digest("hex"),
  };

  const adapter =
    createWindowsDesktopObservationAdapter({
      registration,
      artifactRoot,
    });

  const epoch =
    `live-${Date.now()}`;
  const result =
    await adapter.observe({
      schemaVersion:
        "toadaid.desktop-observation-adapter-request.v1",
      invocationId:
        "live-observation-smoke",
      runId:
        "live-observation-smoke",
      hostId:
        "windows-live-host",
      sessionId:
        "windows-live-session",
      ownerId:
        "operator",
      capabilityId:
        "host:display-inventory",
      toolName:
        "desktop.display-inventory",
      observationEpoch:
        epoch,
      parametersSha256:
        "0".repeat(64),
      maxWallClockMs:
        10_000,
      parameters: {
        kind:
          "DISPLAY_INVENTORY",
        capabilityId:
          "host:display-inventory",
        toolName:
          "desktop.display-inventory",
        hostId:
          "windows-live-host",
        sessionId:
          "windows-live-session",
        ownerId:
          "operator",
        displayIds: [],
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
        maxWallClockMs:
          10_000,
      },
    });

  console.log(
    JSON.stringify(
      {
        marker:
          "WA_P1_WINDOWS_DISPLAY_INVENTORY_OK",
        displayIds:
          result.displayIds,
        artifacts:
          result.artifacts.map(
            (artifact) => ({
              ...artifact,
              localPath:
                adapter.resolveArtifactPath(
                  artifact.id,
                ),
            }),
          ),
      },
      null,
      2,
    ),
  );
}
