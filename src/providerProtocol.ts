import {
  createHash,
} from "node:crypto";

export const WINDOWS_PROVIDER_PROTOCOL_VERSION =
  "toadaid.windows-provider-worker.v1" as const;

export const WINDOWS_PROVIDER_MAX_FRAME_BYTES =
  256 * 1024;

export type WindowsProviderRequestKind =
  | "HANDSHAKE"
  | "HEALTH"
  | "OBSERVE";

export type WindowsProviderResponseStatus =
  | "OK"
  | "ERROR";

export type ProviderJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProviderJsonValue[]
  | Readonly<{
      [key: string]: ProviderJsonValue;
    }>;

export interface WindowsProviderRequestEnvelope {
  readonly protocolVersion:
    typeof WINDOWS_PROVIDER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly generationId: string;
  readonly kind: WindowsProviderRequestKind;
  readonly payload: ProviderJsonValue;
}

export interface WindowsProviderError {
  readonly code: string;
  readonly messageSha256: string;
}

export interface WindowsProviderResponseEnvelope {
  readonly protocolVersion:
    typeof WINDOWS_PROVIDER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly generationId: string;
  readonly status: WindowsProviderResponseStatus;
  readonly payload: ProviderJsonValue | null;
  readonly error: WindowsProviderError | null;
}

const ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_PATTERN =
  /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

function objectValue(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  object: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some(
      (key, index) => key !== wanted[index],
    )
  ) {
    throw new TypeError(
      `${label} contains unknown or missing fields`,
    );
  }
}

function id(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !ID_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function normalizeJson(
  value: unknown,
  depth = 0,
): ProviderJsonValue {
  if (depth > 8) {
    throw new RangeError(
      "provider protocol payload nesting is too deep",
    );
  }
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "provider protocol payload number must be finite",
      );
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 65_536) {
      throw new RangeError(
        "provider protocol payload string is too large",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096) {
      throw new RangeError(
        "provider protocol payload array is too large",
      );
    }
    return Object.freeze(
      value.map((entry) =>
        normalizeJson(entry, depth + 1),
      ),
    );
  }

  const object = objectValue(
    value,
    "provider protocol payload",
  );
  const keys = Object.keys(object);
  if (keys.length > 512) {
    throw new RangeError(
      "provider protocol payload object has too many keys",
    );
  }
  const normalized:
    Record<string, ProviderJsonValue> = {};
  for (const key of keys.sort()) {
    if (
      key.length < 1 ||
      key.length > 128 ||
      key.includes("\u0000")
    ) {
      throw new TypeError(
        "provider protocol payload key is invalid",
      );
    }
    normalized[key] = normalizeJson(
      object[key],
      depth + 1,
    );
  }
  return Object.freeze(normalized);
}

function requestKind(
  value: unknown,
): WindowsProviderRequestKind {
  if (
    value !== "HANDSHAKE" &&
    value !== "HEALTH" &&
    value !== "OBSERVE"
  ) {
    throw new TypeError(
      "provider request kind is invalid",
    );
  }
  return value;
}

export function validateProviderRequestEnvelope(
  value: unknown,
): WindowsProviderRequestEnvelope {
  const object = objectValue(
    value,
    "provider request",
  );
  exactKeys(
    object,
    [
      "protocolVersion",
      "requestId",
      "generationId",
      "kind",
      "payload",
    ],
    "provider request",
  );
  if (
    object.protocolVersion !==
    WINDOWS_PROVIDER_PROTOCOL_VERSION
  ) {
    throw new Error(
      "provider protocol version mismatch",
    );
  }

  return Object.freeze({
    protocolVersion:
      WINDOWS_PROVIDER_PROTOCOL_VERSION,
    requestId: id(
      object.requestId,
      "requestId",
    ),
    generationId: id(
      object.generationId,
      "generationId",
    ),
    kind: requestKind(object.kind),
    payload: normalizeJson(object.payload),
  });
}

function providerError(
  value: unknown,
): WindowsProviderError | null {
  if (value === null) return null;
  const object = objectValue(
    value,
    "provider error",
  );
  exactKeys(
    object,
    ["code", "messageSha256"],
    "provider error",
  );
  if (
    typeof object.code !== "string" ||
    !ERROR_CODE_PATTERN.test(object.code)
  ) {
    throw new TypeError(
      "provider error code is invalid",
    );
  }
  if (
    typeof object.messageSha256 !== "string" ||
    !SHA_PATTERN.test(object.messageSha256)
  ) {
    throw new TypeError(
      "provider error messageSha256 is invalid",
    );
  }
  return Object.freeze({
    code: object.code,
    messageSha256: object.messageSha256,
  });
}

export function validateProviderResponseEnvelope(
  value: unknown,
): WindowsProviderResponseEnvelope {
  const object = objectValue(
    value,
    "provider response",
  );
  exactKeys(
    object,
    [
      "protocolVersion",
      "requestId",
      "generationId",
      "status",
      "payload",
      "error",
    ],
    "provider response",
  );
  if (
    object.protocolVersion !==
    WINDOWS_PROVIDER_PROTOCOL_VERSION
  ) {
    throw new Error(
      "provider protocol version mismatch",
    );
  }
  if (
    object.status !== "OK" &&
    object.status !== "ERROR"
  ) {
    throw new TypeError(
      "provider response status is invalid",
    );
  }

  const error = providerError(object.error);
  if (
    object.status === "OK" &&
    error !== null
  ) {
    throw new Error(
      "OK provider response cannot contain error",
    );
  }
  if (
    object.status === "ERROR" &&
    error === null
  ) {
    throw new Error(
      "ERROR provider response requires error",
    );
  }

  return Object.freeze({
    protocolVersion:
      WINDOWS_PROVIDER_PROTOCOL_VERSION,
    requestId: id(
      object.requestId,
      "requestId",
    ),
    generationId: id(
      object.generationId,
      "generationId",
    ),
    status: object.status,
    payload:
      object.payload === null
        ? null
        : normalizeJson(object.payload),
    error,
  });
}

function boundedFrameText(
  input: Uint8Array | string,
): string {
  const bytes =
    typeof input === "string"
      ? Buffer.from(input, "utf8")
      : Buffer.from(input);
  if (
    bytes.length < 2 ||
    bytes.length >
      WINDOWS_PROVIDER_MAX_FRAME_BYTES
  ) {
    throw new RangeError(
      "provider protocol frame size is invalid",
    );
  }
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) {
    throw new Error(
      "provider protocol frame must end with newline",
    );
  }
  const body = text.slice(0, -1);
  if (
    body.length < 2 ||
    body.includes("\n") ||
    body.includes("\r")
  ) {
    throw new Error(
      "provider protocol frame must contain exactly one JSON line",
    );
  }
  return body;
}

export function encodeProviderFrame(
  value:
    | WindowsProviderRequestEnvelope
    | WindowsProviderResponseEnvelope,
): Uint8Array {
  const bytes = Buffer.from(
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
  if (
    bytes.length >
    WINDOWS_PROVIDER_MAX_FRAME_BYTES
  ) {
    throw new RangeError(
      "provider protocol frame exceeds byte limit",
    );
  }
  return bytes;
}

export function decodeProviderRequestFrame(
  input: Uint8Array | string,
): WindowsProviderRequestEnvelope {
  const body = boundedFrameText(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      "provider request frame contains invalid JSON",
    );
  }
  return validateProviderRequestEnvelope(parsed);
}

export function decodeProviderResponseFrame(
  input: Uint8Array | string,
): WindowsProviderResponseEnvelope {
  const body = boundedFrameText(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      "provider response frame contains invalid JSON",
    );
  }
  return validateProviderResponseEnvelope(parsed);
}

export function providerErrorFingerprint(
  message: string,
): string {
  return createHash("sha256")
    .update(message.slice(0, 4_096), "utf8")
    .digest("hex");
}

export type ProviderTransportFailureDisposition =
  | "SAFE_FAILURE"
  | "RECONCILIATION_REQUIRED";

export function providerTransportFailureDisposition(
  mutation: boolean,
  dispatchEntered: boolean,
): ProviderTransportFailureDisposition {
  return mutation && dispatchEntered
    ? "RECONCILIATION_REQUIRED"
    : "SAFE_FAILURE";
}
