import assert from "node:assert/strict";
import test from "node:test";

import {
  WINDOWS_PROVIDER_PROTOCOL_VERSION,
  decodeProviderRequestFrame,
  decodeProviderResponseFrame,
  encodeProviderFrame,
  providerErrorFingerprint,
  providerTransportFailureDisposition,
  validateProviderRequestEnvelope,
} from "../src/providerProtocol.js";

test("WA-P1A.1 protocol round-trips one bounded strict JSON line", () => {
  const request =
    validateProviderRequestEnvelope({
      protocolVersion:
        WINDOWS_PROVIDER_PROTOCOL_VERSION,
      requestId: "request-001",
      generationId: "generation-001",
      kind: "HEALTH",
      payload: {
        probe: true,
      },
    });
  const decoded =
    decodeProviderRequestFrame(
      encodeProviderFrame(request),
    );
  assert.deepEqual(decoded, request);
});

test("WA-P1A.1 protocol refuses unknown fields, wrong version, multiline, and oversized frames", () => {
  assert.throws(
    () =>
      validateProviderRequestEnvelope({
        protocolVersion:
          WINDOWS_PROVIDER_PROTOCOL_VERSION,
        requestId: "request-001",
        generationId:
          "generation-001",
        kind: "HEALTH",
        payload: {},
        surprise: true,
      }),
    /unknown or missing fields/,
  );

  assert.throws(
    () =>
      validateProviderRequestEnvelope({
        protocolVersion:
          "toadaid.windows-provider-worker.v0",
        requestId: "request-001",
        generationId:
          "generation-001",
        kind: "HEALTH",
        payload: {},
      }),
    /version mismatch/,
  );

  assert.throws(
    () =>
      decodeProviderRequestFrame(
        '{"a":1}\n{"b":2}\n',
      ),
    /exactly one JSON line/,
  );

  assert.throws(
    () =>
      decodeProviderRequestFrame(
        `${"x".repeat(300_000)}\n`,
      ),
    /frame size/,
  );
});

test("WA-P1A.1 response errors carry fingerprints not raw messages", () => {
  const fingerprint =
    providerErrorFingerprint(
      "sensitive local path details",
    );
  const response =
    decodeProviderResponseFrame(
      `${JSON.stringify({
        protocolVersion:
          WINDOWS_PROVIDER_PROTOCOL_VERSION,
        requestId: "request-001",
        generationId:
          "generation-001",
        status: "ERROR",
        payload: null,
        error: {
          code: "WORKER_FAILED",
          messageSha256:
            fingerprint,
        },
      })}\n`,
    );
  assert.equal(
    response.error?.messageSha256,
    fingerprint,
  );
  assert.equal(
    JSON.stringify(response).includes(
      "sensitive local path details",
    ),
    false,
  );
});

test("WA-P1A.1 mutation transport loss is reconciliation-required only after dispatch entry", () => {
  assert.equal(
    providerTransportFailureDisposition(
      false,
      true,
    ),
    "SAFE_FAILURE",
  );
  assert.equal(
    providerTransportFailureDisposition(
      true,
      false,
    ),
    "SAFE_FAILURE",
  );
  assert.equal(
    providerTransportFailureDisposition(
      true,
      true,
    ),
    "RECONCILIATION_REQUIRED",
  );
});
