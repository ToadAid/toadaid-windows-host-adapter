import {
  createHash,
} from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";
import {
  spawn,
} from "node:child_process";

import {
  DESKTOP_OBSERVATION_CONTRACT_IDS,
  DESKTOP_OBSERVATION_TOOL_NAMES,
} from "@toadaid/agent-capabilities";
import type {
  DesktopObservationAdapterRegistration,
  DesktopObservationAdapterRequest,
  DesktopObservationAdapterResult,
  DesktopObservationArtifactReference,
  DesktopObservationElementEvidence,
  GovernedDesktopObservationAdapter,
} from "@toadaid/agent-capabilities";

const WORKER_PATH = fileURLToPath(
  new URL(
    "../../worker/windows-observation.ps1",
    import.meta.url,
  ),
);

const SHA_PATTERN = /^[a-f0-9]{64}$/;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface WindowsWorkerArtifactFile {
  readonly id: string;
  readonly path: string;
}

export interface WindowsObservationWorkerResponse {
  readonly observationEpoch: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly displayIds: readonly number[];
  readonly windowId: string | null;
  readonly evidenceSha256: string;
  readonly artifacts: readonly DesktopObservationArtifactReference[];
  readonly elements?: readonly DesktopObservationElementEvidence[];
  readonly matched?: boolean;
  readonly artifactFiles: readonly WindowsWorkerArtifactFile[];
}

export interface WindowsObservationWorker {
  run(
    request: DesktopObservationAdapterRequest,
    artifactRoot: string,
  ): Promise<WindowsObservationWorkerResponse>;
}

export interface WindowsObservationAdapterOptions {
  readonly registration: DesktopObservationAdapterRegistration;
  readonly artifactRoot: string;
  readonly worker?: WindowsObservationWorker;
  readonly powershellPath?: string;
  readonly platform?: NodeJS.Platform;
}

export interface WindowsDesktopObservationAdapter
  extends GovernedDesktopObservationAdapter {
  resolveArtifactPath(
    artifactId: string,
  ): string | null;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256")
    .update(text, "utf8")
    .digest("hex");
}

function boundedId(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      value,
    )
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function sha(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !SHA_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertRegistration(
  registration: DesktopObservationAdapterRegistration,
): void {
  if (
    registration.schemaVersion !==
    "toadaid.desktop-observation-adapter-registration.v1"
  ) {
    throw new TypeError(
      "unsupported desktop observation adapter registration schemaVersion",
    );
  }
  const expectedTool =
    DESKTOP_OBSERVATION_TOOL_NAMES[
      registration.capabilityId
    ];
  if (
    expectedTool === undefined ||
    registration.toolName !== expectedTool
  ) {
    throw new Error(
      "Windows observation registration capability/tool mismatch",
    );
  }
  const expectedContract =
    DESKTOP_OBSERVATION_CONTRACT_IDS[
      registration.capabilityId
    ];
  if (
    expectedContract === undefined ||
    registration.contractId !== expectedContract
  ) {
    throw new Error(
      "Windows observation registration capability/contract mismatch",
    );
  }
  boundedId(
    registration.adapterId,
    "registration.adapterId",
  );
  sha(
    registration.descriptorSha256,
    "registration.descriptorSha256",
  );
  sha(
    registration.implementationFingerprintSha256,
    "registration.implementationFingerprintSha256",
  );
}

function ensureArtifactRootAbsolute(
  artifactRoot: string,
): string {
  if (
    typeof artifactRoot !== "string" ||
    !isAbsolute(artifactRoot)
  ) {
    throw new Error(
      "Windows observation artifactRoot must be absolute",
    );
  }
  return resolve(artifactRoot);
}

function artifactExtension(
  kind: DesktopObservationArtifactReference["kind"],
): string {
  return kind === "SCREENSHOT" ? ".png" : ".json";
}

async function verifyArtifactFiles(
  root: string,
  response: WindowsObservationWorkerResponse,
): Promise<Map<string, string>> {
  const rootReal = await realpath(root);
  const byId = new Map(
    response.artifactFiles.map(
      (entry) => [entry.id, entry.path] as const,
    ),
  );
  const resolved = new Map<string, string>();

  for (const artifact of response.artifacts) {
    boundedId(artifact.id, "artifact.id");
    sha(artifact.sha256, "artifact.sha256");

    const pathValue = byId.get(artifact.id);
    if (pathValue === undefined) {
      throw new Error(
        `worker omitted artifact file mapping: ${artifact.id}`,
      );
    }

    const expectedSuffix =
      artifactExtension(artifact.kind);
    if (!pathValue.endsWith(expectedSuffix)) {
      throw new Error(
        `artifact extension mismatch: ${artifact.id}`,
      );
    }

    const fileReal = await realpath(pathValue);
    const rel = relative(rootReal, fileReal);
    if (
      rel === "" ||
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(rel)
    ) {
      throw new Error(
        `artifact escaped configured root: ${artifact.id}`,
      );
    }

    const info = await stat(fileReal);
    if (!info.isFile()) {
      throw new Error(
        `artifact is not a file: ${artifact.id}`,
      );
    }

    const bytes = await readFile(fileReal);
    if (sha256Bytes(bytes) !== artifact.sha256) {
      throw new Error(
        `artifact SHA mismatch: ${artifact.id}`,
      );
    }

    resolved.set(artifact.id, fileReal);
  }

  return resolved;
}

function normalizeWorkerResponse(
  value: WindowsObservationWorkerResponse,
  request: DesktopObservationAdapterRequest,
): WindowsObservationWorkerResponse {
  if (
    value.observationEpoch !==
      request.observationEpoch ||
    value.hostId !== request.hostId ||
    value.sessionId !== request.sessionId
  ) {
    throw new Error(
      "Windows worker response identity mismatch",
    );
  }

  sha(value.evidenceSha256, "worker.evidenceSha256");

  if (
    !Array.isArray(value.displayIds) ||
    value.displayIds.some(
      (id) =>
        !Number.isSafeInteger(id) ||
        id < 0 ||
        id > 31,
    )
  ) {
    throw new TypeError(
      "Windows worker displayIds are invalid",
    );
  }

  if (
    value.windowId !== null &&
    typeof value.windowId !== "string"
  ) {
    throw new TypeError(
      "Windows worker windowId is invalid",
    );
  }

  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > 16
  ) {
    throw new RangeError(
      "Windows worker artifacts are invalid",
    );
  }

  if (
    !Array.isArray(value.artifactFiles) ||
    value.artifactFiles.length !==
      value.artifacts.length
  ) {
    throw new Error(
      "Windows worker artifact file mapping is incomplete",
    );
  }

  return value;
}

function windowsAbsoluteLocalPath(
  value: string,
): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) &&
    !value.startsWith("\\\\")
  );
}

export function defaultWindowsPowerShellPath(
  systemRoot:
    string | undefined =
      process.env.SystemRoot,
): string {
  if (
    systemRoot === undefined ||
    !windowsAbsoluteLocalPath(systemRoot)
  ) {
    throw new Error(
      "SystemRoot must be an explicit local Windows path",
    );
  }
  return win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function buildWindowsPowerShellInvocation(
  powershellPath: string,
  workerPath = WORKER_PATH,
): Readonly<{
  executable: string;
  argv: readonly string[];
  shell: false;
}> {
  if (
    typeof powershellPath !== "string" ||
    !windowsAbsoluteLocalPath(powershellPath)
  ) {
    throw new TypeError(
      "powershellPath must be an explicit local absolute Windows path",
    );
  }
  if (
    typeof workerPath !== "string" ||
    (
      !isAbsolute(workerPath) &&
      !windowsAbsoluteLocalPath(workerPath)
    ) ||
    workerPath.startsWith("\\\\")
  ) {
    throw new TypeError(
      "workerPath must be an explicit local absolute path",
    );
  }
  return Object.freeze({
    executable: powershellPath,
    argv: Object.freeze([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      workerPath,
    ]),
    shell: false as const,
  });
}

class PowerShellWindowsObservationWorker
  implements WindowsObservationWorker {
  readonly #powershellPath: string;

  constructor(
    powershellPath:
      string =
        defaultWindowsPowerShellPath(),
  ) {
    this.#powershellPath = powershellPath;
  }

  async run(
    request: DesktopObservationAdapterRequest,
    artifactRoot: string,
  ): Promise<WindowsObservationWorkerResponse> {
    const invocation =
      buildWindowsPowerShellInvocation(
        this.#powershellPath,
      );

    return await new Promise(
      (resolvePromise, rejectPromise) => {
        const child = spawn(
          invocation.executable,
          invocation.argv,
          {
            shell: false,
            windowsHide: true,
            stdio: [
              "pipe",
              "pipe",
              "pipe",
            ],
          },
        );

        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;

        const timeout = setTimeout(() => {
          if (settled) return;
          child.kill();
          settled = true;
          rejectPromise(
            new Error(
              "Windows observation worker timed out",
            ),
          );
        }, request.maxWallClockMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk: string) => {
          stdoutBytes += Buffer.byteLength(
            chunk,
            "utf8",
          );
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            child.kill();
            return;
          }
          stdout += chunk;
        });

        child.stderr.on("data", (chunk: string) => {
          stderrBytes += Buffer.byteLength(
            chunk,
            "utf8",
          );
          if (stderrBytes <= MAX_STDERR_BYTES) {
            stderr += chunk;
          }
        });

        child.on("error", (error) => {
          if (settled) return;
          clearTimeout(timeout);
          settled = true;
          rejectPromise(error);
        });

        child.on("close", (code) => {
          if (settled) return;
          clearTimeout(timeout);
          settled = true;

          if (stdoutBytes > MAX_STDOUT_BYTES) {
            rejectPromise(
              new Error(
                "Windows observation worker stdout exceeded bound",
              ),
            );
            return;
          }

          if (code !== 0) {
            rejectPromise(
              new Error(
                `Windows observation worker failed code=${code ?? "null"} stderrSha256=${sha256Text(stderr)}`,
              ),
            );
            return;
          }

          try {
            const parsed =
              JSON.parse(
                stdout,
              ) as WindowsObservationWorkerResponse;
            resolvePromise(parsed);
          } catch {
            rejectPromise(
              new Error(
                `Windows observation worker returned invalid JSON stdoutSha256=${sha256Text(stdout)}`,
              ),
            );
          }
        });

        child.stdin.end(
          JSON.stringify({
            request,
            artifactRoot,
          }),
          "utf8",
        );
      },
    );
  }
}

export function createWindowsDesktopObservationAdapter(
  options: WindowsObservationAdapterOptions,
): WindowsDesktopObservationAdapter {
  assertRegistration(options.registration);

  const platform =
    options.platform ?? process.platform;
  if (
    options.worker === undefined &&
    platform !== "win32"
  ) {
    throw new Error(
      "default Windows observation worker requires win32",
    );
  }

  const artifactRoot =
    ensureArtifactRootAbsolute(
      options.artifactRoot,
    );
  const worker =
    options.worker ??
    new PowerShellWindowsObservationWorker(
      options.powershellPath,
    );
  const artifactPaths =
    new Map<string, string>();

  return Object.freeze({
    registration: options.registration,

    async observe(
      request: DesktopObservationAdapterRequest,
    ): Promise<DesktopObservationAdapterResult> {
      if (
        request.capabilityId !==
          options.registration.capabilityId ||
        request.toolName !==
          options.registration.toolName
      ) {
        throw new Error(
          "Windows observation request does not match adapter registration",
        );
      }

      if (request.parameters.useDom) {
        throw new Error(
          "Windows observation adapter v1 refuses useDom=true",
        );
      }
      if (request.parameters.annotate) {
        throw new Error(
          "Windows observation adapter v1 refuses annotation overlays",
        );
      }
      if (
        request.parameters.kind === "UI_SNAPSHOT" &&
        request.parameters.windowId !== null &&
        (
          request.parameters.displayIds.length > 0 ||
          request.parameters.region !== null
        )
      ) {
        throw new Error(
          "Windows observation adapter v1 refuses mixed window + display/region UI scope",
        );
      }
      if (
        request.parameters.kind === "WAIT_FOR" &&
        (
          request.parameters.condition ===
            "element_exists" ||
          request.parameters.condition ===
            "element_enabled"
        )
      ) {
        throw new Error(
          "Windows observation adapter v1 refuses selectorless element wait conditions",
        );
      }

      await mkdir(
        artifactRoot,
        {
          recursive: true,
        },
      );

      const workerResult =
        normalizeWorkerResponse(
          await worker.run(
            request,
            artifactRoot,
          ),
          request,
        );

      const verified =
        await verifyArtifactFiles(
          artifactRoot,
          workerResult,
        );
      for (
        const [id, pathValue]
        of verified.entries()
      ) {
        artifactPaths.set(id, pathValue);
      }

      return Object.freeze({
        schemaVersion:
          "toadaid.desktop-observation-adapter-result.v1",
        observationEpoch:
          workerResult.observationEpoch,
        hostId: workerResult.hostId,
        sessionId:
          workerResult.sessionId,
        displayIds:
          Object.freeze(
            [...workerResult.displayIds],
          ),
        windowId:
          workerResult.windowId,
        evidenceSha256:
          workerResult.evidenceSha256,
        artifacts:
          Object.freeze(
            [...workerResult.artifacts],
          ),
        ...(workerResult.elements === undefined
          ? {}
          : {
              elements:
                Object.freeze(
                  [...workerResult.elements],
                ),
            }),
        ...(workerResult.matched === undefined
          ? {}
          : {
              matched:
                workerResult.matched,
            }),
      });
    },

    resolveArtifactPath(
      artifactId: string,
    ): string | null {
      boundedId(
        artifactId,
        "artifactId",
      );
      return artifactPaths.get(
        artifactId,
      ) ?? null;
    },
  });
}
