import assert from "node:assert/strict";
import test from "node:test";

import {
  WINDOWS_PROVIDER_PROTOCOL_VERSION,
  decodeProviderRequestFrame,
  decodeProviderResponseFrame,
  validateProviderRequestEnvelope,
} from "../src/index.js";

const request = {
  protocolVersion: WINDOWS_PROVIDER_PROTOCOL_VERSION,
  requestId: "request-001",
  generationId: "generation-001",
  kind: "HEALTH",
  payload: { probe: "value" },
};

test("WA-P1A.1 strict frames refuse duplicate keys instead of last-wins (kind smuggling)", () => {
  const line = JSON.stringify(request).replace('"kind":"HEALTH"', '"kind":"HEALTH","kind":"OBSERVE"');
  assert.throws(() => decodeProviderRequestFrame(`${line}\n`), /duplicate key/);
  const nested = JSON.stringify(request).replace('{"probe":"value"}', '{"probe":"a","probe":"b"}');
  assert.throws(() => decodeProviderRequestFrame(`${nested}\n`), /duplicate key/);
  const response = JSON.stringify({
    protocolVersion: WINDOWS_PROVIDER_PROTOCOL_VERSION,
    requestId: "request-001",
    generationId: "generation-001",
    status: "OK",
    payload: null,
    error: null,
  }).replace('"status":"OK"', '"status":"ERROR","status":"OK"');
  assert.throws(() => decodeProviderResponseFrame(`${response}\n`), /duplicate key/);
  // Distinct keys that only look alike after escaping are still distinct keys.
  const escaped = JSON.stringify(request).replace('{"probe":"value"}', '{"probe":"a","pr\\u006fbe2":"b"}');
  assert.deepEqual(decodeProviderRequestFrame(`${escaped}\n`).payload, { probe: "a", probe2: "b" });
  // An escaped spelling of the SAME key is a duplicate.
  const sameEscaped = JSON.stringify(request).replace('{"probe":"value"}', '{"probe":"a","pr\\u006fbe":"b"}');
  assert.throws(() => decodeProviderRequestFrame(`${sameEscaped}\n`), /duplicate key/);
});

test("WA-P1A.1 strict frames refuse invalid UTF-8 instead of substituting U+FFFD", () => {
  const bytes = Buffer.from(`${JSON.stringify({ ...request, payload: { s: "X" } })}\n`, "utf8");
  bytes[bytes.indexOf("X")] = 0xff;
  assert.throws(() => decodeProviderRequestFrame(bytes), /UTF-8/);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${JSON.stringify(request)}\n`, "utf8")]);
  assert.throws(() => decodeProviderRequestFrame(bom), /invalid JSON/);
});

test("WA-P1A.1 payload normalization refuses __proto__ keys (no prototype injection)", () => {
  const line = JSON.stringify(request).replace('{"probe":"value"}', '{"__proto__":{"polluted":true},"probe":"value"}');
  assert.throws(() => decodeProviderRequestFrame(`${line}\n`), /payload key is invalid/);
  const parsed = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
  assert.throws(() => validateProviderRequestEnvelope({ ...request, payload: parsed }), /payload key is invalid/);
  const ok = decodeProviderRequestFrame(`${JSON.stringify(request)}\n`);
  assert.equal(Object.getPrototypeOf(ok.payload), Object.prototype);
});
