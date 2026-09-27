import {
  createHash,
  randomBytes,
} from "node:crypto";

const ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

export interface ProviderWindowEvidenceInput {
  readonly observationEpoch: string;
  readonly windowsSessionId: string;
  readonly desktopId: string;
  readonly hwnd: string;
  readonly pid: number;
  readonly processCreatedAt: string;
  readonly observedAt: string;
}

export interface ProviderWindowEvidence
  extends ProviderWindowEvidenceInput {
  readonly windowRef: string;
  readonly generationId: string;
  readonly expiresAtMs: number;
}

export interface ProviderElementEvidenceInput {
  readonly observationEpoch: string;
  readonly windowRef: string;
  readonly elementId: string;
  readonly elementEvidenceSha256: string;
  readonly runtimeId: readonly number[] | null;
  readonly ancestrySha256: string;
  readonly boundsSha256: string;
  readonly clickablePointSha256: string | null;
  readonly observedAt: string;
}

export interface ProviderElementEvidence
  extends ProviderElementEvidenceInput {
  readonly elementRef: string;
  readonly generationId: string;
  readonly expiresAtMs: number;
}

export interface ProviderEvidenceStoreOptions {
  readonly generationId: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly randomToken?: () => string;
}

function id(
  value: string,
  label: string,
): string {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function sha(
  value: string,
  label: string,
): string {
  if (!SHA_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function iso(
  value: string,
  label: string,
): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new TypeError(`${label} is invalid`);
  }
  return new Date(time).toISOString();
}

function positivePid(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new RangeError("pid is invalid");
  }
  return value;
}

function opaqueRef(
  prefix: "winref" | "elref",
  generationId: string,
  token: string,
): string {
  const digest = createHash("sha256")
    .update(
      `${prefix}\u0000${generationId}\u0000${token}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 40);
  return `${prefix}-${digest}`;
}

export function assertPreDispatchWindowIdentity(
  expected: ProviderWindowEvidence,
  current: Pick<
    ProviderWindowEvidenceInput,
    | "windowsSessionId"
    | "desktopId"
    | "hwnd"
    | "pid"
    | "processCreatedAt"
  > & {
    readonly generationId: string;
  },
): void {
  if (
    expected.generationId !==
      current.generationId ||
    expected.windowsSessionId !==
      current.windowsSessionId ||
    expected.desktopId !== current.desktopId ||
    expected.hwnd !== current.hwnd ||
    expected.pid !== current.pid ||
    expected.processCreatedAt !==
      current.processCreatedAt
  ) {
    throw new Error(
      "provider pre-dispatch Windows identity changed",
    );
  }
}

export class ProviderEvidenceStore {
  #generationId: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #windows =
    new Map<string, ProviderWindowEvidence>();
  readonly #elements =
    new Map<string, ProviderElementEvidence>();

  constructor(
    options: ProviderEvidenceStoreOptions,
  ) {
    this.#generationId = id(
      options.generationId,
      "generationId",
    );
    this.#ttlMs =
      options.ttlMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs < 1_000 ||
      this.#ttlMs > 300_000
    ) {
      throw new RangeError(
        "provider evidence ttlMs is invalid",
      );
    }
    this.#now =
      options.now ?? Date.now;
    this.#randomToken =
      options.randomToken ??
      (() => randomBytes(32).toString("hex"));
  }

  get generationId(): string {
    return this.#generationId;
  }

  restart(
    generationId: string,
  ): void {
    const next = id(
      generationId,
      "generationId",
    );
    if (next === this.#generationId) {
      throw new Error(
        "provider restart requires new generationId",
      );
    }
    this.#generationId = next;
    this.#windows.clear();
    this.#elements.clear();
  }

  issueWindow(
    input: ProviderWindowEvidenceInput,
  ): ProviderWindowEvidence {
    const windowRef = opaqueRef(
      "winref",
      this.#generationId,
      this.#randomToken(),
    );
    const record =
      Object.freeze({
        windowRef,
        generationId:
          this.#generationId,
        observationEpoch: id(
          input.observationEpoch,
          "observationEpoch",
        ),
        windowsSessionId: id(
          input.windowsSessionId,
          "windowsSessionId",
        ),
        desktopId: id(
          input.desktopId,
          "desktopId",
        ),
        hwnd: id(
          input.hwnd,
          "hwnd",
        ),
        pid: positivePid(input.pid),
        processCreatedAt: iso(
          input.processCreatedAt,
          "processCreatedAt",
        ),
        observedAt: iso(
          input.observedAt,
          "observedAt",
        ),
        expiresAtMs:
          this.#now() + this.#ttlMs,
      } satisfies ProviderWindowEvidence);
    this.#windows.set(
      windowRef,
      record,
    );
    return record;
  }

  resolveWindow(
    windowRef: string,
  ): ProviderWindowEvidence | null {
    const record =
      this.#windows.get(windowRef);
    if (
      record === undefined ||
      record.generationId !==
        this.#generationId ||
      this.#now() >
        record.expiresAtMs
    ) {
      if (record !== undefined) {
        this.#windows.delete(windowRef);
      }
      return null;
    }
    return record;
  }

  issueElement(
    input: ProviderElementEvidenceInput,
  ): ProviderElementEvidence {
    const window =
      this.resolveWindow(input.windowRef);
    if (window === null) {
      throw new Error(
        "element evidence requires current windowRef",
      );
    }
    if (
      window.observationEpoch !==
      input.observationEpoch
    ) {
      throw new Error(
        "element evidence observationEpoch mismatch",
      );
    }
    const runtimeId =
      input.runtimeId === null
        ? null
        : Object.freeze(
            input.runtimeId.map(
              (value) => {
                if (
                  !Number.isSafeInteger(value)
                ) {
                  throw new TypeError(
                    "runtimeId contains invalid value",
                  );
                }
                return value;
              },
            ),
          );
    const elementRef = opaqueRef(
      "elref",
      this.#generationId,
      this.#randomToken(),
    );
    const record =
      Object.freeze({
        elementRef,
        generationId:
          this.#generationId,
        observationEpoch: id(
          input.observationEpoch,
          "observationEpoch",
        ),
        windowRef:
          window.windowRef,
        elementId: id(
          input.elementId,
          "elementId",
        ),
        elementEvidenceSha256: sha(
          input.elementEvidenceSha256,
          "elementEvidenceSha256",
        ),
        runtimeId,
        ancestrySha256: sha(
          input.ancestrySha256,
          "ancestrySha256",
        ),
        boundsSha256: sha(
          input.boundsSha256,
          "boundsSha256",
        ),
        clickablePointSha256:
          input.clickablePointSha256 === null
            ? null
            : sha(
                input.clickablePointSha256,
                "clickablePointSha256",
              ),
        observedAt: iso(
          input.observedAt,
          "observedAt",
        ),
        expiresAtMs:
          Math.min(
            window.expiresAtMs,
            this.#now() + this.#ttlMs,
          ),
      } satisfies ProviderElementEvidence);
    this.#elements.set(
      elementRef,
      record,
    );
    return record;
  }

  resolveElement(
    elementRef: string,
  ): ProviderElementEvidence | null {
    const record =
      this.#elements.get(elementRef);
    if (
      record === undefined ||
      record.generationId !==
        this.#generationId ||
      this.#now() >
        record.expiresAtMs ||
      this.resolveWindow(
        record.windowRef,
      ) === null
    ) {
      if (record !== undefined) {
        this.#elements.delete(elementRef);
      }
      return null;
    }
    return record;
  }
}
