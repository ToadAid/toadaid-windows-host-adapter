import {
  createHash,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export interface ProviderArtifactRecord {
  readonly operationDir: string;
  readonly artifactId: string;
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ProviderArtifactStoreOptions {
  readonly root: string;
  readonly maxArtifactBytes?: number;
}

const ARTIFACT_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function contained(
  root: string,
  target: string,
): boolean {
  const rel = relative(root, target);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) &&
    !isAbsolute(rel)
  );
}

export class ProviderArtifactStore {
  readonly #root: string;
  readonly #maxArtifactBytes: number;
  readonly #operations = new Set<string>();

  constructor(
    options: ProviderArtifactStoreOptions,
  ) {
    if (
      typeof options.root !== "string" ||
      !isAbsolute(options.root)
    ) {
      throw new TypeError(
        "provider artifact root must be absolute",
      );
    }
    this.#root = resolve(options.root);
    this.#maxArtifactBytes =
      options.maxArtifactBytes ??
      16 * 1024 * 1024;
    if (
      !Number.isSafeInteger(
        this.#maxArtifactBytes,
      ) ||
      this.#maxArtifactBytes < 1 ||
      this.#maxArtifactBytes >
        64 * 1024 * 1024
    ) {
      throw new RangeError(
        "provider artifact byte bound is invalid",
      );
    }
  }

  async beginOperation():
    Promise<string> {
    await mkdir(
      this.#root,
      {
        recursive: true,
        mode: 0o700,
      },
    );
    const rootReal =
      await realpath(this.#root);
    const created =
      await mkdtemp(
        join(rootReal, "op-"),
      );
    const operationReal =
      await realpath(created);
    if (
      !contained(
        rootReal,
        operationReal,
      )
    ) {
      throw new Error(
        "provider artifact operation escaped root",
      );
    }
    this.#operations.add(
      operationReal,
    );
    return operationReal;
  }

  async writeCreateNew(
    operationDir: string,
    artifactId: string,
    extension: ".json" | ".png" | ".bin",
    data: Uint8Array,
  ): Promise<ProviderArtifactRecord> {
    if (
      !ARTIFACT_ID.test(artifactId)
    ) {
      throw new TypeError(
        "provider artifactId is invalid",
      );
    }
    if (
      data.byteLength >
      this.#maxArtifactBytes
    ) {
      throw new RangeError(
        "provider artifact exceeds byte bound",
      );
    }
    const operationReal =
      await realpath(operationDir);
    if (
      !this.#operations.has(
        operationReal,
      )
    ) {
      throw new Error(
        "provider artifact operation is unknown",
      );
    }
    const pathValue =
      join(
        operationReal,
        `${artifactId}${extension}`,
      );

    const handle =
      await open(
        pathValue,
        "wx",
        0o600,
      );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }

    const fileReal =
      await realpath(pathValue);
    if (
      !contained(
        operationReal,
        fileReal,
      )
    ) {
      throw new Error(
        "provider artifact escaped operation directory",
      );
    }
    const bytes =
      await readFile(fileReal);
    return Object.freeze({
      operationDir:
        operationReal,
      artifactId,
      path: fileReal,
      byteLength:
        bytes.byteLength,
      sha256:
        createHash("sha256")
          .update(bytes)
          .digest("hex"),
    });
  }

  async cleanupOperation(
    operationDir: string,
  ): Promise<void> {
    const operationReal =
      await realpath(operationDir);
    if (
      !this.#operations.delete(
        operationReal,
      )
    ) {
      throw new Error(
        "provider artifact operation is unknown",
      );
    }
    await rm(
      operationReal,
      {
        recursive: true,
        force: true,
      },
    );
  }
}
