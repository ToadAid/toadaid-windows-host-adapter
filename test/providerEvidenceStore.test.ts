import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderEvidenceStore,
  assertPreDispatchWindowIdentity,
} from "../src/providerEvidenceStore.js";

const NOW =
  "2026-09-27T05:00:00.000Z";
const PROCESS_CREATED =
  "2026-09-27T04:00:00.000Z";

function windowInput() {
  return {
    observationEpoch:
      "observation-001",
    windowsSessionId:
      "session-1",
    desktopId:
      "winsta0-default",
    hwnd:
      "hwnd-12345",
    pid: 4242,
    processCreatedAt:
      PROCESS_CREATED,
    observedAt:
      NOW,
  };
}

test("WA-P1A.1 window references are opaque and bind generation + Windows identity", () => {
  let now =
    Date.parse(NOW);
  let token = 0;
  const store =
    new ProviderEvidenceStore({
      generationId:
        "generation-001",
      ttlMs: 5_000,
      now: () => now,
      randomToken:
        () => `token-${++token}`,
    });

  const window =
    store.issueWindow(
      windowInput(),
    );

  assert.match(
    window.windowRef,
    /^winref-[a-f0-9]{40}$/,
  );
  assert.equal(
    window.windowRef.includes(
      "hwnd-12345",
    ),
    false,
  );
  assert.equal(
    store.resolveWindow(
      window.windowRef,
    )?.pid,
    4242,
  );

  assert.doesNotThrow(() =>
    assertPreDispatchWindowIdentity(
      window,
      {
        generationId:
          "generation-001",
        windowsSessionId:
          "session-1",
        desktopId:
          "winsta0-default",
        hwnd:
          "hwnd-12345",
        pid: 4242,
        processCreatedAt:
          new Date(
            PROCESS_CREATED,
          ).toISOString(),
      },
    ),
  );

  assert.throws(
    () =>
      assertPreDispatchWindowIdentity(
        window,
        {
          generationId:
            "generation-001",
          windowsSessionId:
            "session-1",
          desktopId:
            "winsta0-default",
          hwnd:
            "hwnd-12345",
          pid: 4242,
          processCreatedAt:
            "2026-09-27T04:00:01.000Z",
        },
      ),
    /identity changed/,
  );

  now += 5_001;
  assert.equal(
    store.resolveWindow(
      window.windowRef,
    ),
    null,
  );
});

test("WA-P1A.1 restart invalidates window and element evidence", () => {
  let token = 0;
  const store =
    new ProviderEvidenceStore({
      generationId:
        "generation-001",
      ttlMs: 30_000,
      now: () =>
        Date.parse(NOW),
      randomToken:
        () => `token-${++token}`,
    });

  const window =
    store.issueWindow(
      windowInput(),
    );
  const element =
    store.issueElement({
      observationEpoch:
        "observation-001",
      windowRef:
        window.windowRef,
      elementId:
        "element-001",
      elementEvidenceSha256:
        "1".repeat(64),
      runtimeId:
        [42, 7, 99],
      ancestrySha256:
        "2".repeat(64),
      boundsSha256:
        "3".repeat(64),
      clickablePointSha256:
        "4".repeat(64),
      observedAt:
        NOW,
    });

  assert.equal(
    store.resolveElement(
      element.elementRef,
    )?.windowRef,
    window.windowRef,
  );

  store.restart(
    "generation-002",
  );

  assert.equal(
    store.resolveWindow(
      window.windowRef,
    ),
    null,
  );
  assert.equal(
    store.resolveElement(
      element.elementRef,
    ),
    null,
  );
});

test("WA-P1A.1 element evidence cannot detach from exact observation window", () => {
  const store =
    new ProviderEvidenceStore({
      generationId:
        "generation-001",
      now: () =>
        Date.parse(NOW),
      randomToken:
        () => "token",
    });
  const window =
    store.issueWindow(
      windowInput(),
    );

  assert.throws(
    () =>
      store.issueElement({
        observationEpoch:
          "observation-other",
        windowRef:
          window.windowRef,
        elementId:
          "element-001",
        elementEvidenceSha256:
          "1".repeat(64),
        runtimeId: null,
        ancestrySha256:
          "2".repeat(64),
        boundsSha256:
          "3".repeat(64),
        clickablePointSha256:
          null,
        observedAt:
          NOW,
      }),
    /observationEpoch mismatch/,
  );
});
