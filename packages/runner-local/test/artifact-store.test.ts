import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { ArtifactIdSchema, createId, type ArtifactDescriptor } from "@autostack/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_WRITE_BOUNDARIES,
  ArtifactStore,
  ArtifactStoreError,
  type ArtifactWriteBoundary,
  type ArtifactWriteMetadata
} from "../src/artifact-store.js";
import { inspectArtifactHandle } from "../src/artifact-io.js";
import { ArtifactTransactions } from "../src/artifact-transactions.js";
import { normalizeArtifactError, STATIC_ERROR_MESSAGES } from "../src/artifact-types.js";
import { DataPathPolicy, PathPolicyError } from "../src/path-policy.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const roots: string[] = [];
const metadata: ArtifactWriteMetadata = {
  artifactId: createId("artifact", UUID),
  workspaceId: createId("workspace", UUID),
  runId: createId("run", UUID),
  commandId: createId("command", UUID),
  kind: "command_transcript",
  mediaType: "text/plain; charset=utf-8",
  createdAt: "2026-08-21T12:00:00.000Z"
};

const artifactIdFilenameComponent = (artifactId: string): string =>
  Buffer.from(artifactId, "utf8").toString("hex");

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-artifact-store-"));
  roots.push(root);
  return root;
};

const chunks = async function* (...values: readonly string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
};

const simultaneousBoundary = (
  expectedBoundary: ArtifactWriteBoundary,
  participants = 2
): ((boundary: ArtifactWriteBoundary) => Promise<void>) => {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return async (boundary) => {
    if (boundary !== expectedBoundary) return;
    arrivals += 1;
    if (arrivals === participants) release();
    await Promise.race([
      gate,
      new Promise<never>((_, rejectPromise) =>
        setTimeout(() => rejectPromise(new Error("publication barrier timed out")), 1_000)
      )
    ]);
  };
};

const killWriterAtBoundary = async (
  dataRoot: string,
  boundary: ArtifactWriteBoundary,
  content: string
): Promise<void> => {
  const artifactStoreUrl = new URL("../src/artifact-store.ts", import.meta.url).href;
  const script = `
    import { ArtifactStore } from ${JSON.stringify(artifactStoreUrl)};
    const metadata = ${JSON.stringify(metadata)};
    const content = async function* () { yield Buffer.from(${JSON.stringify(content)}); };
    const store = await ArtifactStore.create({
      dataRoot: ${JSON.stringify(dataRoot)},
      onBoundary: async (boundary) => {
        if (boundary !== ${JSON.stringify(boundary)}) return;
        process.stdout.write("READY\\n");
        await new Promise(() => {});
      }
    });
    await store.writeArtifact({ metadata, content: content(), maximumBytes: 128 });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  let diagnostics = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostics += chunk;
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`Crash child did not reach ${boundary}: ${diagnostics}`));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (output.includes("READY\n")) return;
      clearTimeout(timeout);
      rejectPromise(
        new Error(`Crash child exited early with ${String(code)}/${String(signal)}: ${diagnostics}`)
      );
    });
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes("READY\n")) return;
      clearTimeout(timeout);
      resolvePromise();
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ArtifactStore", () => {
  it("does not create missing artifact directories while admitting recovery topology", async () => {
    const dataRoot = await temporaryRoot();
    await mkdir(join(dataRoot, "artifacts/transactions"), { recursive: true, mode: 0o700 });

    await expect(ArtifactStore.create({ dataRoot })).rejects.toMatchObject({
      code: "unsafe_state"
    });
    expect(await readdir(join(dataRoot, "artifacts"))).toEqual(["transactions"]);
  });

  it("recovers more than 512 legitimate pending entries without namespace mutation", async () => {
    const dataRoot = await temporaryRoot();
    await ArtifactStore.create({ dataRoot });
    const transactions = join(dataRoot, "artifacts/transactions");
    const artifactComponent = artifactIdFilenameComponent(metadata.artifactId);
    await Promise.all(
      Array.from({ length: 513 }, async (_, index) => {
        const attemptId = index.toString(16).padStart(32, "0");
        await writeFile(join(transactions, `${artifactComponent}.${attemptId}.pending`), "", {
          mode: 0o600
        });
      })
    );
    const before = await readdir(transactions);

    await expect(ArtifactStore.create({ dataRoot })).resolves.toBeInstanceOf(ArtifactStore);
    expect(await readdir(transactions)).toEqual(before);
  });

  it("requests a lifecycle-aligned bound and rejects its synthetic max-plus-one", async () => {
    const requestedBounds: number[] = [];
    const syntheticEntryCount = 20_001;
    const files = {
      async listExistingDirectory(_relativePath: string, maximumEntries: number) {
        requestedBounds.push(maximumEntries);
        if (syntheticEntryCount > maximumEntries) {
          throw new ArtifactStoreError("unsafe_state", "Synthetic enumeration overflow.");
        }
        return [];
      }
    };
    const transactions = new ArtifactTransactions(files as never, async () => undefined);

    await expect(transactions.recover({ async verifyCommitted() {} })).rejects.toMatchObject({
      code: "unsafe_state"
    });
    expect(requestedBounds).toEqual([20_000]);
  });

  it("keeps exported error messages and write boundaries immutable at runtime", () => {
    const secret = "runtime-mutation-secret";
    expect(Object.isFrozen(STATIC_ERROR_MESSAGES)).toBe(true);
    expect(() => {
      (STATIC_ERROR_MESSAGES as Record<string, string>).filesystem_error = secret;
    }).toThrow(TypeError);
    expect(normalizeArtifactError(new Error(secret)).message).toBe(
      "The private artifact operation failed safely."
    );

    expect(Object.isFrozen(ARTIFACT_WRITE_BOUNDARIES)).toBe(true);
    expect(() => {
      (ARTIFACT_WRITE_BOUNDARIES as unknown as string[]).push("secret-boundary");
    }).toThrow(TypeError);
    expect(ARTIFACT_WRITE_BOUNDARIES).not.toContain("secret-boundary");
  });

  it("publishes SHA-256 addressed private blob and metadata after durable boundaries", async () => {
    const dataRoot = await temporaryRoot();
    const boundaries: ArtifactWriteBoundary[] = [];
    const store = await ArtifactStore.create({
      dataRoot,
      onBoundary: (boundary) => {
        boundaries.push(boundary);
      }
    });

    const descriptor = await store.writeArtifact({
      metadata,
      content: chunks("hello", " world"),
      maximumBytes: 64
    });
    const expectedDigest = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    const blob = join(dataRoot, "artifacts", "sha256", "b9", expectedDigest);
    const metadataPath = join(
      dataRoot,
      "artifacts",
      "metadata",
      `${artifactIdFilenameComponent(metadata.artifactId)}.json`
    );

    expect(descriptor).toMatchObject({ digest: expectedDigest, byteSize: 11 });
    expect(await readFile(blob, "utf8")).toBe("hello world");
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(descriptor);
    expect((await lstat(dataRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(blob)).mode & 0o777).toBe(0o600);
    expect((await lstat(metadataPath)).mode & 0o777).toBe(0o600);
    expect(boundaries).toEqual(ARTIFACT_WRITE_BOUNDARIES);
  });

  it("deduplicates identical content while retaining immutable per-artifact metadata", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });

    const first = await store.writeArtifact({
      metadata,
      content: chunks("same"),
      maximumBytes: 16
    });
    const second = await store.writeArtifact({
      metadata: {
        ...metadata,
        artifactId: createId("artifact", "123e4567-e89b-42d3-a456-426614174001")
      },
      content: chunks("same"),
      maximumBytes: 16
    });
    const digestDirectory = join(dataRoot, "artifacts", "sha256", first.digest.slice(0, 2));

    expect(second.digest).toBe(first.digest);
    expect(await readdir(digestDirectory)).toEqual([first.digest]);
  });

  it("recovers distinct contract-accepted uppercase artifact IDs after restart", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const uppercaseUuidMetadata: ArtifactWriteMetadata = {
      ...metadata,
      artifactId: createId("artifact", "123E4567-E89B-42D3-A456-426614174001")
    };
    const uppercasePrefixMetadata: ArtifactWriteMetadata = {
      ...metadata,
      artifactId: ArtifactIdSchema.parse("ART_123E4567-E89B-42D3-A456-426614174002")
    };
    const first = await store.writeArtifact({
      metadata: uppercaseUuidMetadata,
      content: chunks("uppercase-uuid"),
      maximumBytes: 32
    });
    const second = await store.writeArtifact({
      metadata: uppercasePrefixMetadata,
      content: chunks("uppercase-prefix"),
      maximumBytes: 32
    });

    const restarted = await ArtifactStore.create({ dataRoot });

    await expect(restarted.findArtifact(uppercaseUuidMetadata.artifactId)).resolves.toEqual(first);
    await expect(restarted.findArtifact(uppercasePrefixMetadata.artifactId)).resolves.toEqual(
      second
    );
  });

  it("keeps same-UUID lowercase and uppercase artifact IDs distinct through restart", async () => {
    const dataRoot = await temporaryRoot();
    const lowerMetadata: ArtifactWriteMetadata = {
      ...metadata,
      artifactId: createId("artifact", "123e4567-e89b-42d3-a456-42661417400a")
    };
    const upperMetadata: ArtifactWriteMetadata = {
      ...metadata,
      artifactId: ArtifactIdSchema.parse("ART_123E4567-E89B-42D3-A456-42661417400A")
    };
    const store = await ArtifactStore.create({ dataRoot });
    const lower = await store.writeArtifact({
      metadata: lowerMetadata,
      content: chunks("lowercase-artifact"),
      maximumBytes: 32
    });
    const upper = await store.writeArtifact({
      metadata: upperMetadata,
      content: chunks("uppercase-artifact"),
      maximumBytes: 32
    });
    expect(upper.digest).not.toBe(lower.digest);

    const restarted = await ArtifactStore.create({ dataRoot });

    await expect(
      restarted.readArtifact(lowerMetadata.artifactId, { offset: 0, length: 32 })
    ).resolves.toMatchObject({ descriptor: lower, bytes: Buffer.from("lowercase-artifact") });
    await expect(
      restarted.readArtifact(upperMetadata.artifactId, { offset: 0, length: 32 })
    ).resolves.toMatchObject({ descriptor: upper, bytes: Buffer.from("uppercase-artifact") });
  });

  it("replays an identical artifact ID and content without mutating metadata", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const first = await store.writeArtifact({
      metadata,
      content: chunks("same"),
      maximumBytes: 16
    });
    const metadataPath = join(
      dataRoot,
      "artifacts",
      "metadata",
      `${artifactIdFilenameComponent(metadata.artifactId)}.json`
    );
    const before = await readFile(metadataPath);

    const replay = await store.writeArtifact({
      metadata,
      content: chunks("same"),
      maximumBytes: 16
    });

    expect(replay).toEqual(first);
    expect(await readFile(metadataPath)).toEqual(before);
  });

  it("keeps a committed artifact visible while an identical replay is stalled", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const descriptor = await store.writeArtifact({
      metadata,
      content: chunks("committed-replay"),
      maximumBytes: 32
    });
    let releaseReplay!: () => void;
    let replayStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      replayStarted = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseReplay = resolvePromise;
    });
    const stalled = async function* (): AsyncIterable<Uint8Array> {
      replayStarted();
      await release;
      yield Buffer.from("committed-replay");
    };

    const replay = store.writeArtifact({ metadata, content: stalled(), maximumBytes: 32 });
    await started;

    await expect(store.findArtifact(metadata.artifactId)).resolves.toEqual(descriptor);
    await expect(
      store.readArtifact(metadata.artifactId, { offset: 0, length: 32 })
    ).resolves.toMatchObject({ bytes: Buffer.from("committed-replay"), done: true });
    releaseReplay();
    await expect(replay).resolves.toEqual(descriptor);
  });

  it("accepts Uint8Array chunks created in another JavaScript realm", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });
    const crossRealm = runInNewContext("new Uint8Array([99, 114, 111, 115, 115])") as Uint8Array;
    const content = async function* (): AsyncIterable<Uint8Array> {
      yield crossRealm;
    };

    await expect(
      store.writeArtifact({ metadata, content: content(), maximumBytes: 16 })
    ).resolves.toMatchObject({ byteSize: 5 });
  });

  it("copies artifact bytes without reading an own valueOf accessor or substituting content", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const source = new Uint8Array([0x61]);
    let valueOfReads = 0;
    Object.defineProperty(source, "valueOf", {
      configurable: true,
      get() {
        valueOfReads += 1;
        return () => new Uint8Array(100).fill(0x62);
      }
    });

    const descriptor = await store.writeArtifact({
      metadata,
      content: (async function* () {
        yield source;
      })(),
      maximumBytes: 1
    });

    expect(valueOfReads).toBe(0);
    expect(descriptor.byteSize).toBe(1);
    await expect(
      store.readArtifact(metadata.artifactId, { offset: 0, length: 1 })
    ).resolves.toMatchObject({ bytes: Buffer.from([0x61]), done: true });
  });

  it("accounts the intrinsic artifact length without reading an own length getter", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });
    const source = new Uint8Array([0x61]);
    let lengthReads = 0;
    Object.defineProperties(source, {
      valueOf: { configurable: true, value: () => source },
      length: {
        configurable: true,
        get() {
          lengthReads += 1;
          return 100;
        }
      }
    });

    await expect(
      store.writeArtifact({
        metadata,
        content: (async function* () {
          yield source;
        })(),
        maximumBytes: 1
      })
    ).resolves.toMatchObject({ byteSize: 1 });
    expect(lengthReads).toBe(0);
  });

  it("does not read a terminal iterator value or call return after natural exhaustion", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });
    let iteration = 0;
    let valueReads = 0;
    let releaseReturn: (() => void) | undefined;
    let signalReturn!: () => void;
    const returnStarted = new Promise<void>((resolvePromise) => {
      signalReturn = resolvePromise;
    });
    const content: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            iteration += 1;
            if (iteration === 1) {
              return Promise.resolve({ done: false, value: Buffer.from("done") });
            }
            return Promise.resolve(
              Object.defineProperty({ done: true }, "value", {
                get() {
                  valueReads += 1;
                  throw new Error("terminal value must not be read");
                }
              }) as IteratorResult<Uint8Array>
            );
          },
          return() {
            signalReturn();
            return new Promise<IteratorResult<Uint8Array>>((resolvePromise) => {
              releaseReturn = () => resolvePromise({ done: true, value: undefined as never });
            });
          }
        };
      }
    };

    const write = store.writeArtifact({ metadata, content, maximumBytes: 16 });
    const outcome = await Promise.race([
      write.then(() => "written" as const).catch(() => "failed" as const),
      returnStarted.then(() => "return-called" as const)
    ]);
    releaseReturn?.();
    await write.catch(() => undefined);

    expect(outcome).toBe("written");
    expect(valueReads).toBe(0);
    expect(releaseReturn).toBeUndefined();
  });

  it("fails closed when an existing digest path contains mismatched bytes", async () => {
    const dataRoot = await temporaryRoot();
    const digest = createHash("sha256").update("expected").digest("hex");
    const digestDirectory = join(dataRoot, "artifacts", "sha256", digest.slice(0, 2));
    const store = await ArtifactStore.create({ dataRoot });
    await mkdir(digestDirectory, { mode: 0o700 });
    await writeFile(join(digestDirectory, digest), "collision", { mode: 0o600 });

    await expect(
      store.writeArtifact({ metadata, content: chunks("expected"), maximumBytes: 16 })
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("rejects an identical pre-existing blob with widened permissions", async () => {
    const dataRoot = await temporaryRoot();
    const digest = createHash("sha256").update("expected").digest("hex");
    const digestDirectory = join(dataRoot, "artifacts", "sha256", digest.slice(0, 2));
    const blob = join(digestDirectory, digest);
    const store = await ArtifactStore.create({ dataRoot });
    await mkdir(digestDirectory, { mode: 0o700 });
    await writeFile(blob, "expected", { mode: 0o644 });

    await expect(
      store.writeArtifact({ metadata, content: chunks("expected"), maximumBytes: 16 })
    ).rejects.toMatchObject({ code: "unsafe_state" });

    expect((await lstat(blob)).mode & 0o777).toBe(0o644);
  });

  it("enforces maximum bytes while streaming and publishes no metadata", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });

    await expect(
      store.writeArtifact({ metadata, content: chunks("1234", "5"), maximumBytes: 4 })
    ).rejects.toMatchObject({ code: "artifact_too_large" });
    await expect(store.findArtifact(metadata.artifactId)).resolves.toBeUndefined();
  });

  it("rejects configured and ANSI-interleaved known credentials on the final rescan", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });

    await expect(
      store.writeArtifact({
        metadata,
        content: chunks("configured-se", "cret-value"),
        maximumBytes: 64,
        sensitiveValues: ["configured-secret-value"]
      })
    ).rejects.toMatchObject({ code: "sensitive_artifact" });
    await expect(
      store.writeArtifact({
        metadata,
        content: chunks("ghp_1234567890\u001b]0;hidden-title\u0007ABCDEFGHIJ"),
        maximumBytes: 128
      })
    ).rejects.toMatchObject({ code: "sensitive_artifact" });
    await expect(
      store.writeArtifact({
        metadata,
        content: chunks(`ghp_${"A".repeat(5_000)}`),
        maximumBytes: 6_000
      })
    ).rejects.toMatchObject({ code: "sensitive_artifact" });
  });

  it.each([
    {
      name: "configured credential requiring independent CSI projections",
      pieces: ["configured\u001b[31Asec", "\u001b[31mret"],
      sensitiveValues: ["configuredAsecret"]
    },
    {
      name: "known credential requiring independent CSI projections",
      pieces: [`ghp_\u001b[31A${"A".repeat(10)}`, `\u001b[31@${"A".repeat(9)}`],
      sensitiveValues: []
    }
  ])("blocks artifact publication for a $name", async ({ pieces, sensitiveValues }) => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });

    await expect(
      store.writeArtifact({
        metadata,
        content: chunks(...pieces),
        maximumBytes: 128,
        sensitiveValues
      })
    ).rejects.toMatchObject({ code: "sensitive_artifact" });
    await expect(store.findArtifact(metadata.artifactId)).resolves.toBeUndefined();
  });

  it("verifies digest and size on bounded reads and never follows blob symlinks", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const descriptor = await store.writeArtifact({
      metadata,
      content: chunks("verified bytes"),
      maximumBytes: 64
    });

    await expect(
      store.readArtifact(metadata.artifactId, { offset: 2, length: 4 })
    ).resolves.toEqual({
      descriptor,
      offset: 2,
      bytes: Buffer.from("rifi"),
      nextOffset: 6,
      done: false
    });

    const blob = join(
      dataRoot,
      "artifacts",
      "sha256",
      descriptor.digest.slice(0, 2),
      descriptor.digest
    );
    const outside = join(dataRoot, "outside");
    const { rm } = await import("node:fs/promises");
    await writeFile(outside, "verified bytes");
    await rm(blob);
    await symlink(outside, blob);

    await expect(
      store.readArtifact(metadata.artifactId, { offset: 0, length: 4 })
    ).rejects.toBeInstanceOf(ArtifactStoreError);
  });

  it("rejects invalid, oversized, and unavailable bounded reads", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });

    await expect(
      store.readArtifact(metadata.artifactId, { offset: -1, length: 1 })
    ).rejects.toMatchObject({
      code: "invalid_read"
    });
    await expect(
      store.readArtifact(metadata.artifactId, { offset: 0, length: 1_048_577 })
    ).rejects.toMatchObject({ code: "invalid_read" });
    await expect(
      store.readArtifact("not-an-artifact" as never, { offset: 0, length: 1 })
    ).rejects.toMatchObject({
      code: "invalid_read"
    });
    await expect(
      store.readArtifact(metadata.artifactId, { offset: 0, length: 1 })
    ).rejects.toMatchObject({
      code: "invalid_read"
    });
  });

  it("detects same-size blob mutation during digest verification", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const descriptor = await store.writeArtifact({
      metadata,
      content: chunks("original"),
      maximumBytes: 16
    });
    const blob = join(
      dataRoot,
      "artifacts",
      "sha256",
      descriptor.digest.slice(0, 2),
      descriptor.digest
    );
    await writeFile(blob, "mutated!");

    await expect(store.findArtifact(metadata.artifactId)).rejects.toMatchObject({
      code: "integrity_mismatch"
    });
  });

  it("rejects malformed and symlinked immutable metadata", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    await store.writeArtifact({ metadata, content: chunks("safe"), maximumBytes: 16 });
    const metadataPath = join(
      dataRoot,
      "artifacts",
      "metadata",
      `${artifactIdFilenameComponent(metadata.artifactId)}.json`
    );
    await writeFile(metadataPath, "not-json");
    await expect(store.findArtifact(metadata.artifactId)).rejects.toMatchObject({
      code: "integrity_mismatch"
    });
    const outside = join(dataRoot, "outside-metadata");
    await writeFile(outside, "{}");
    const malformed = `${metadataPath}.malformed`;
    await rename(metadataPath, malformed);
    await symlink(outside, metadataPath);

    await expect(store.findArtifact(metadata.artifactId)).rejects.toMatchObject({
      code: "unsafe_state"
    });
  });

  it.each(ARTIFACT_WRITE_BOUNDARIES)(
    "recovers fail-closed after an injected crash at %s",
    async (crashAt) => {
      const dataRoot = await temporaryRoot();
      const crashingStore = await ArtifactStore.create({
        dataRoot,
        onBoundary: (boundary) => {
          if (boundary === crashAt) throw new Error("injected crash");
        }
      });

      const error = await crashingStore
        .writeArtifact({ metadata, content: chunks("crash-safe"), maximumBytes: 64 })
        .catch((reason) => reason);
      expect(error).toMatchObject({ name: "ArtifactStoreError", code: "filesystem_error" });
      expect(String(error)).not.toContain("injected crash");
      const recoveredStore = await ArtifactStore.create({ dataRoot });
      const recovered = await recoveredStore.findArtifact(metadata.artifactId);
      if (recovered !== undefined) {
        expect(recovered).toMatchObject({ artifactId: metadata.artifactId });
      } else {
        await expect(
          recoveredStore.writeArtifact({
            metadata,
            content: chunks("crash-safe"),
            maximumBytes: 64
          })
        ).resolves.toMatchObject({ artifactId: metadata.artifactId });
      }
    }
  );

  it("rejects secret-bearing metadata without persisting credential values", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const unsafe = {
      ...metadata,
      mediaType: "text/ghp_12345678901234567890"
    } as ArtifactWriteMetadata;

    await expect(
      store.writeArtifact({ metadata: unsafe, content: chunks("safe"), maximumBytes: 16 })
    ).rejects.toMatchObject({ code: "invalid_metadata" });
    expect(JSON.stringify(await readdir(join(dataRoot, "artifacts")))).not.toContain("ghp_");
  });

  it("fails closed when immutable metadata for an artifact ID disagrees", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const descriptor: ArtifactDescriptor = await store.writeArtifact({
      metadata,
      content: chunks("first"),
      maximumBytes: 16
    });

    await expect(
      store.writeArtifact({ metadata, content: chunks("second"), maximumBytes: 16 })
    ).rejects.toMatchObject({ code: "metadata_conflict" });
    await expect(store.findArtifact(metadata.artifactId)).resolves.toEqual(descriptor);
  });

  it("rejects invalid write bounds and identifiers before creating a transaction", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });

    await expect(
      store.writeArtifact({ metadata, content: chunks("safe"), maximumBytes: -1 })
    ).rejects.toMatchObject({ code: "artifact_too_large" });
    await expect(
      store.writeArtifact({
        metadata: { ...metadata, artifactId: "invalid" } as never,
        content: chunks("safe"),
        maximumBytes: 16
      })
    ).rejects.toMatchObject({ code: "invalid_metadata" });
    await expect(store.findArtifact("invalid" as never)).rejects.toMatchObject({
      code: "invalid_metadata"
    });
  });

  it("fails closed on unexpected recovery entries", async () => {
    const dataRoot = await temporaryRoot();
    const transactions = join(dataRoot, "artifacts", "transactions");
    await ArtifactStore.create({ dataRoot });
    await writeFile(join(transactions, "unexpected"), "state", { mode: 0o600 });

    await expect(ArtifactStore.create({ dataRoot })).rejects.toMatchObject({
      code: "unsafe_state"
    });
  });

  it("rejects a symlinked digest-prefix directory during confined recovery", async () => {
    const dataRoot = await temporaryRoot();
    await ArtifactStore.create({ dataRoot });
    const outside = join(await temporaryRoot(), "outside-prefix");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(dataRoot, "artifacts", "sha256", "aa"));

    await expect(ArtifactStore.create({ dataRoot })).rejects.toMatchObject({
      name: "ArtifactStoreError",
      code: "unsafe_state"
    });
  });

  it.each([
    ["raw ID text", "art_deadbeef"],
    ["uppercase hex", artifactIdFilenameComponent(metadata.artifactId).toUpperCase()],
    ["encoded traversal text", Buffer.from("../", "utf8").toString("hex")],
    ["odd hex", "6"]
  ] as const)("rejects a metadata filename with %s", async (_, component) => {
    const dataRoot = await temporaryRoot();
    await ArtifactStore.create({ dataRoot });
    await writeFile(join(dataRoot, "artifacts", "metadata", `${component}.json`), "{}\n", {
      mode: 0o600
    });

    await expect(ArtifactStore.create({ dataRoot })).rejects.toMatchObject({
      name: "ArtifactStoreError",
      code: "unsafe_state"
    });
  });

  it.each([
    {
      name: "non-private pending file",
      prepare: async (dataRoot: string) => {
        await writeFile(
          join(
            dataRoot,
            "artifacts",
            "transactions",
            `${artifactIdFilenameComponent(metadata.artifactId)}.${"a".repeat(32)}.pending`
          ),
          "",
          { mode: 0o644 }
        );
      }
    },
    {
      name: "symlinked stream temporary file",
      prepare: async (dataRoot: string) => {
        const outside = join(await temporaryRoot(), "outside-stream");
        await writeFile(outside, "private", { mode: 0o600 });
        await symlink(
          outside,
          join(
            dataRoot,
            "artifacts",
            "tmp",
            `${artifactIdFilenameComponent(metadata.artifactId)}.${"b".repeat(32)}.blob.tmp`
          )
        );
      }
    },
    {
      name: "unmatched hard-linked digest file",
      prepare: async (dataRoot: string) => {
        const digest = "c".repeat(64);
        const prefix = join(dataRoot, "artifacts", "sha256", "cc");
        await mkdir(prefix, { mode: 0o700 });
        const canonical = join(prefix, digest);
        await writeFile(canonical, "collision", { mode: 0o600 });
        await link(canonical, join(await temporaryRoot(), "outside-hardlink"));
      }
    },
    {
      name: "digest file with more than two links",
      prepare: async (dataRoot: string) => {
        const digest = "d".repeat(64);
        const prefix = join(dataRoot, "artifacts", "sha256", "dd");
        await mkdir(prefix, { mode: 0o700 });
        const canonical = join(prefix, digest);
        await writeFile(canonical, "too-many-links", { mode: 0o600 });
        await link(canonical, join(await temporaryRoot(), "outside-hardlink-one"));
        await link(canonical, join(await temporaryRoot(), "outside-hardlink-two"));
      }
    },
    {
      name: "directory in the metadata namespace",
      prepare: async (dataRoot: string) => {
        await mkdir(join(dataRoot, "artifacts", "metadata", "unexpected-directory"), {
          mode: 0o700
        });
      }
    },
    {
      name: "file in the digest-prefix namespace",
      prepare: async (dataRoot: string) => {
        await writeFile(join(dataRoot, "artifacts", "sha256", "ee"), "not-a-directory", {
          mode: 0o600
        });
      }
    }
  ])("rejects $name during confined recovery", async ({ prepare }) => {
    const dataRoot = await temporaryRoot();
    await ArtifactStore.create({ dataRoot });
    await prepare(dataRoot);

    await expect(ArtifactStore.create({ dataRoot })).rejects.toMatchObject({
      name: "ArtifactStoreError",
      code: "unsafe_state"
    });
  });

  it("recovers a later linked alias when an earlier stale attempt names the same canonical file", async () => {
    const dataRoot = await temporaryRoot();
    await ArtifactStore.create({ dataRoot });
    const directory = join(dataRoot, "artifacts", "metadata");
    const artifactComponent = artifactIdFilenameComponent(metadata.artifactId);
    const canonical = join(directory, `${artifactComponent}.json`);
    const earlier = join(directory, `${artifactComponent}.${"1".repeat(32)}.metadata.tmp`);
    const later = join(directory, `${artifactComponent}.${"2".repeat(32)}.metadata.tmp`);
    await writeFile(earlier, "stale\n", { mode: 0o600 });
    await writeFile(canonical, "winner\n", { mode: 0o600 });
    await link(canonical, later);

    await expect(ArtifactStore.create({ dataRoot })).resolves.toBeInstanceOf(ArtifactStore);
    await expect(lstat(later)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(earlier)).resolves.toMatchObject({ nlink: 1 });
    await expect(lstat(canonical)).resolves.toMatchObject({ nlink: 1 });
  });

  it("rejects reads past EOF and offset-plus-length overflow while allowing exact EOF", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });
    const descriptor = await store.writeArtifact({
      metadata,
      content: chunks("eof"),
      maximumBytes: 16
    });

    await expect(
      store.readArtifact(metadata.artifactId, { offset: descriptor.byteSize, length: 1 })
    ).resolves.toMatchObject({
      bytes: Buffer.alloc(0),
      nextOffset: descriptor.byteSize,
      done: true
    });
    await expect(
      store.readArtifact(metadata.artifactId, { offset: descriptor.byteSize + 1, length: 1 })
    ).rejects.toMatchObject({ code: "invalid_read" });
    await expect(
      store.readArtifact(metadata.artifactId, { offset: Number.MAX_SAFE_INTEGER, length: 1 })
    ).rejects.toMatchObject({ code: "invalid_read" });
  });

  it("rejects hard-linked blob and metadata inodes", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const descriptor = await store.writeArtifact({
      metadata,
      content: chunks("hardlink-safe"),
      maximumBytes: 32
    });
    const blob = join(
      dataRoot,
      "artifacts",
      "sha256",
      descriptor.digest.slice(0, 2),
      descriptor.digest
    );
    await link(blob, join(dataRoot, "blob-hardlink"));
    await expect(store.findArtifact(metadata.artifactId)).rejects.toBeInstanceOf(
      ArtifactStoreError
    );

    const secondRoot = await temporaryRoot();
    const secondStore = await ArtifactStore.create({ dataRoot: secondRoot });
    await secondStore.writeArtifact({
      metadata,
      content: chunks("metadata-safe"),
      maximumBytes: 32
    });
    const metadataPath = join(
      secondRoot,
      "artifacts",
      "metadata",
      `${artifactIdFilenameComponent(metadata.artifactId)}.json`
    );
    await link(metadataPath, join(secondRoot, "metadata-hardlink"));
    await expect(secondStore.findArtifact(metadata.artifactId)).rejects.toBeInstanceOf(
      ArtifactStoreError
    );
  });

  it("rejects a hard link added to an artifact inode after the confined open", async () => {
    const dataRoot = await temporaryRoot();
    const policy = await DataPathPolicy.create(join(dataRoot, "state"));
    const created = await policy.openFile("artifact.bin", "wx");
    await created.writeFile("held-inode");
    await created.sync();
    await created.close();
    const handle = await policy.openFile("artifact.bin", "r");
    await link(join(policy.root, "artifact.bin"), join(dataRoot, "outside-hardlink"));

    await expect(inspectArtifactHandle(handle)).rejects.toThrow(/inode|link|private/i);
    await handle.close();
  });

  it("rejects permissions widened after an artifact inode is opened", async () => {
    const dataRoot = await temporaryRoot();
    const policy = await DataPathPolicy.create(join(dataRoot, "state"));
    const created = await policy.openFile("artifact.bin", "wx");
    await created.writeFile("held-inode");
    await created.sync();
    await created.close();
    const handle = await policy.openFile("artifact.bin", "r");
    await chmod(join(policy.root, "artifact.bin"), 0o644);

    await expect(inspectArtifactHandle(handle)).rejects.toThrow(/inode|permission|private/i);
    await handle.close();
  });

  it("rejects special mode bits added after an artifact inode is opened", async () => {
    const dataRoot = await temporaryRoot();
    const policy = await DataPathPolicy.create(join(dataRoot, "state"));
    const created = await policy.openFile("artifact.bin", "wx");
    await created.writeFile("held-inode");
    await created.sync();
    await created.close();
    const handle = await policy.openFile("artifact.bin", "r");
    await chmod(join(policy.root, "artifact.bin"), 0o1600);

    await expect(inspectArtifactHandle(handle)).rejects.toThrow(/inode|permission|private/i);
    await handle.close();
  });

  it("rejects a descriptor-size mismatch before reading artifact bytes", async () => {
    const dataRoot = await temporaryRoot();
    const artifactPath = join(dataRoot, "size-mismatch.bin");
    await writeFile(artifactPath, "xy", { mode: 0o600 });
    const handle = await open(artifactPath, "r");
    const readable = handle as unknown as {
      read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
    };
    const originalRead = readable.read.bind(handle);
    let readCalls = 0;
    readable.read = async (...args) => {
      readCalls += 1;
      return originalRead(...args);
    };
    const inspectWithExpectedSize = inspectArtifactHandle as unknown as (
      opened: typeof handle,
      sensitiveValues: readonly string[],
      selection: undefined,
      expectedByteSize: number
    ) => Promise<unknown>;

    try {
      await expect(inspectWithExpectedSize(handle, [], undefined, 1)).rejects.toThrow(
        /size|inode|descriptor/i
      );
      expect(readCalls).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("bounds a dishonest artifact handle to its pinned size", async () => {
    const dataRoot = await temporaryRoot();
    const artifactPath = join(dataRoot, "dishonest-read.bin");
    await writeFile(artifactPath, "x", { mode: 0o600 });
    const status = await lstat(artifactPath);
    const requestedLengths: number[] = [];
    const fakeHandle = {
      stat: async () => status,
      read: async (buffer: Buffer, _offset: number, length: number) => {
        requestedLengths.push(length);
        return { buffer, bytesRead: requestedLengths.length === 1 ? 1_000 : 0 };
      }
    };

    await expect(inspectArtifactHandle(fakeHandle as never)).rejects.toThrow(/read|inode|size/i);
    expect(requestedLengths).toEqual([1]);
  });

  it("uses one bounded EOF guard when an artifact grows during verification", async () => {
    const dataRoot = await temporaryRoot();
    const artifactPath = join(dataRoot, "growing-read.bin");
    await writeFile(artifactPath, "x", { mode: 0o600 });
    const handle = await open(artifactPath, "r");
    const readable = handle as unknown as {
      read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
    };
    const originalRead = readable.read.bind(handle);
    let calls = 0;
    let requestedBytes = 0;
    readable.read = async (...args) => {
      requestedBytes += args[2] as number;
      const result = await originalRead(...args);
      calls += 1;
      if (calls === 1) await writeFile(artifactPath, "xy", { mode: 0o600 });
      return result;
    };
    const inspectWithExpectedSize = inspectArtifactHandle as unknown as (
      opened: typeof handle,
      sensitiveValues: readonly string[],
      selection: undefined,
      expectedByteSize: number
    ) => Promise<unknown>;

    try {
      await expect(inspectWithExpectedSize(handle, [], undefined, 1)).rejects.toThrow(
        /changed|grew|inode/i
      );
      expect(requestedBytes).toBeLessThanOrEqual(2);
    } finally {
      await handle.close();
    }
  });

  it.each([
    { target: "metadata", mutation: "hardlink" },
    { target: "metadata", mutation: "mode" },
    { target: "commit", mutation: "hardlink" },
    { target: "commit", mutation: "mode" }
  ] as const)(
    "rejects a post-open $mutation mutation of the $target state handle",
    async ({ target, mutation }) => {
      const dataRoot = await temporaryRoot();
      const store = await ArtifactStore.create({ dataRoot });
      await store.writeArtifact({ metadata, content: chunks("state-handle"), maximumBytes: 32 });
      const suffix = target === "metadata" ? ".json" : ".committed";
      let mutated = false;
      const originalOpen = DataPathPolicy.prototype.openFile;
      const openSpy = vi
        .spyOn(DataPathPolicy.prototype, "openFile")
        .mockImplementation(async function (this: DataPathPolicy, relativePath, mode) {
          const handle = await originalOpen.call(this, relativePath, mode);
          if (mode === "r" && relativePath.endsWith(suffix) && !mutated) {
            mutated = true;
            const absolutePath = join(dataRoot, relativePath);
            if (mutation === "hardlink") {
              await link(absolutePath, join(dataRoot, `${target}-post-open-link`));
            } else {
              await chmod(absolutePath, 0o1600);
            }
          }
          return handle;
        });

      try {
        await expect(store.findArtifact(metadata.artifactId)).rejects.toBeInstanceOf(
          ArtifactStoreError
        );
        expect(mutated).toBe(true);
      } finally {
        openSpy.mockRestore();
      }
    }
  );

  it("sanitizes hook and failing-iterator errors and removes uncommitted state", async () => {
    const dataRoot = await temporaryRoot();
    const secretPath = join(dataRoot, "credential-do-not-leak");
    const hookStore = await ArtifactStore.create({
      dataRoot,
      onBoundary: (boundary) => {
        if (boundary === "blob.file-opened") throw new Error(secretPath);
      }
    });
    const hookError = await hookStore
      .writeArtifact({ metadata, content: chunks("safe"), maximumBytes: 16 })
      .catch((error) => error);
    expect(hookError).toMatchObject({ name: "ArtifactStoreError", code: "filesystem_error" });
    expect(String(hookError)).not.toContain(secretPath);

    const iteratorRoot = await temporaryRoot();
    const iteratorStore = await ArtifactStore.create({ dataRoot: iteratorRoot });
    const failing = async function* (): AsyncIterable<Uint8Array> {
      yield Buffer.from("partial");
      throw new ArtifactStoreError("metadata_conflict", secretPath);
    };
    const iteratorError = await iteratorStore
      .writeArtifact({ metadata, content: failing(), maximumBytes: 32 })
      .catch((error) => error);
    expect(iteratorError).toMatchObject({ name: "ArtifactStoreError", code: "filesystem_error" });
    expect(String(iteratorError)).not.toContain(secretPath);
    await expect(readdir(join(iteratorRoot, "artifacts", "tmp"))).resolves.toEqual([]);
    await expect(readdir(join(iteratorRoot, "artifacts", "transactions"))).resolves.toEqual([]);
    await expect(readdir(join(iteratorRoot, "artifacts", "metadata"))).resolves.toEqual([]);

    const getterRoot = await temporaryRoot();
    const getterStore = await ArtifactStore.create({ dataRoot: getterRoot });
    const hostileContent: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.resolve({
              get done() {
                throw new ArtifactStoreError("metadata_conflict", secretPath);
              },
              value: Buffer.from("unreachable")
            }) as unknown as Promise<IteratorResult<Uint8Array>>;
          }
        };
      }
    };
    const getterError = await getterStore
      .writeArtifact({ metadata, content: hostileContent, maximumBytes: 32 })
      .catch((error) => error);
    expect(getterError).toMatchObject({ name: "ArtifactStoreError", code: "filesystem_error" });
    expect(String(getterError)).not.toContain(secretPath);

    const hostileRange = {
      get offset(): number {
        throw new ArtifactStoreError("metadata_conflict", secretPath);
      },
      length: 1
    };
    const rangeError = await getterStore
      .readArtifact(metadata.artifactId, hostileRange)
      .catch((error) => error);
    expect(rangeError).toMatchObject({ name: "ArtifactStoreError", code: "invalid_read" });
    expect(String(rangeError)).not.toContain(secretPath);
  });

  it("re-materializes path-policy failures at the public artifact boundary", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const secret = join(dataRoot, "path-policy-secret");
    const existsSpy = vi
      .spyOn(DataPathPolicy.prototype, "fileExists")
      .mockRejectedValueOnce(new PathPolicyError("filesystem_error", secret));
    try {
      const error = await store.findArtifact(metadata.artifactId).catch((reason) => reason);
      expect(error).toMatchObject({ name: "ArtifactStoreError", code: "unsafe_state" });
      expect(String(error)).not.toContain(secret);
    } finally {
      existsSpy.mockRestore();
    }
  });

  it("does not wait for a hostile iterator return while releasing the transaction", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const hostile: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: Buffer.from("too-large") }),
          return: () => new Promise<IteratorResult<Uint8Array>>(() => {})
        };
      }
    };

    const outcome = await Promise.race([
      store
        .writeArtifact({ metadata, content: hostile, maximumBytes: 1 })
        .then(() => ({ kind: "resolved" as const }))
        .catch((error) => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "timeout" }>((resolvePromise) =>
        setTimeout(() => resolvePromise({ kind: "timeout" }), 250)
      )
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { name: "ArtifactStoreError", code: "artifact_too_large" }
    });
    await expect(readdir(join(dataRoot, "artifacts", "tmp"))).resolves.toEqual([]);
    await expect(readdir(join(dataRoot, "artifacts", "transactions"))).resolves.toEqual([]);
    await expect(
      store.writeArtifact({ metadata, content: chunks("retry"), maximumBytes: 16 })
    ).resolves.toMatchObject({ byteSize: 5 });
  });

  it("rejects an oversized cross-realm chunk before copying it", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });
    const oversized = runInNewContext("new Uint8Array(1024 * 1024)") as Uint8Array;
    const fromSpy = vi.spyOn(Buffer, "from");

    try {
      await expect(
        store.writeArtifact({
          metadata,
          content: (async function* () {
            yield oversized;
          })(),
          maximumBytes: 1
        })
      ).rejects.toMatchObject({ code: "artifact_too_large" });
      expect(fromSpy.mock.calls.some(([value]) => value === oversized)).toBe(false);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("closes the publish destination when opening its source fails", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const originalOpen = DataPathPolicy.prototype.openFile;
    let streamReads = 0;
    let publishCloseCount = 0;
    const openSpy = vi
      .spyOn(DataPathPolicy.prototype, "openFile")
      .mockImplementation(async function (this: DataPathPolicy, relativePath, mode) {
        if (mode === "r" && relativePath.endsWith(".blob.tmp")) {
          streamReads += 1;
          if (streamReads === 2) throw new Error("injected source-open failure");
        }
        const handle = await originalOpen.call(this, relativePath, mode);
        if (mode === "wx" && relativePath.endsWith(".publish.tmp")) {
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            publishCloseCount += 1;
            return originalClose();
          };
        }
        return handle;
      });

    try {
      await expect(
        store.writeArtifact({ metadata, content: chunks("source-race"), maximumBytes: 32 })
      ).rejects.toMatchObject({ name: "ArtifactStoreError" });
      expect(publishCloseCount).toBe(1);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.each([
    ["stream write", ".blob.tmp"],
    ["publication write", ".publish.tmp"]
  ] as const)(
    "does not report success when the %s handle close initially fails",
    async (_, suffix) => {
      const dataRoot = await temporaryRoot();
      const store = await ArtifactStore.create({ dataRoot });
      const secret = join(dataRoot, "close-failure-secret");
      const originalOpen = DataPathPolicy.prototype.openFile;
      let injected = false;
      let closeCalls = 0;
      const openSpy = vi
        .spyOn(DataPathPolicy.prototype, "openFile")
        .mockImplementation(async function (this: DataPathPolicy, relativePath, mode) {
          const handle = await originalOpen.call(this, relativePath, mode);
          if (!injected && mode === "wx" && relativePath.endsWith(suffix)) {
            injected = true;
            const originalClose = handle.close.bind(handle);
            handle.close = async () => {
              closeCalls += 1;
              if (closeCalls === 1) throw new Error(secret);
              return originalClose();
            };
          }
          return handle;
        });
      try {
        const error = await store
          .writeArtifact({ metadata, content: chunks("close-sensitive"), maximumBytes: 32 })
          .catch((reason) => reason);
        expect(error).toMatchObject({ name: "ArtifactStoreError", code: "filesystem_error" });
        expect(String(error)).not.toContain(secret);
        expect(closeCalls).toBe(2);
        await expect(store.findArtifact(metadata.artifactId)).resolves.toBeUndefined();
      } finally {
        openSpy.mockRestore();
      }
    }
  );

  it("does not return artifact bytes when the read handle close initially fails", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const descriptor = await store.writeArtifact({
      metadata,
      content: chunks("read-close"),
      maximumBytes: 32
    });
    const blobRelative = `artifacts/sha256/${descriptor.digest.slice(0, 2)}/${descriptor.digest}`;
    const originalOpen = DataPathPolicy.prototype.openFile;
    let injected = false;
    let closeCalls = 0;
    const openSpy = vi
      .spyOn(DataPathPolicy.prototype, "openFile")
      .mockImplementation(async function (this: DataPathPolicy, relativePath, mode) {
        const handle = await originalOpen.call(this, relativePath, mode);
        if (!injected && mode === "r" && relativePath === blobRelative) {
          injected = true;
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            closeCalls += 1;
            if (closeCalls === 1) throw new Error("read-close-secret");
            return originalClose();
          };
        }
        return handle;
      });
    try {
      await expect(
        store.readArtifact(metadata.artifactId, { offset: 0, length: 1 })
      ).rejects.toMatchObject({ name: "ArtifactStoreError", code: "filesystem_error" });
      expect(closeCalls).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
    await expect(
      store.readArtifact(metadata.artifactId, { offset: 0, length: 1 })
    ).resolves.toMatchObject({ bytes: Buffer.from("r") });
  });

  it("preserves a primary write failure while observing and retrying close cleanup", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });
    const originalOpen = DataPathPolicy.prototype.openFile;
    let closeCalls = 0;
    const openSpy = vi
      .spyOn(DataPathPolicy.prototype, "openFile")
      .mockImplementation(async function (this: DataPathPolicy, relativePath, mode) {
        const handle = await originalOpen.call(this, relativePath, mode);
        if (mode === "wx" && relativePath.endsWith(".blob.tmp")) {
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            closeCalls += 1;
            if (closeCalls === 1) throw new Error("secondary close failure");
            return originalClose();
          };
        }
        return handle;
      });
    try {
      await expect(
        store.writeArtifact({ metadata, content: chunks("too-large"), maximumBytes: 1 })
      ).rejects.toMatchObject({ code: "artifact_too_large" });
      expect(closeCalls).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("validates and selects a range with one full blob scan", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const payload = Buffer.alloc(256 * 1_024, 0x78);
    const descriptor = await store.writeArtifact({
      metadata,
      content: (async function* () {
        yield payload;
      })(),
      maximumBytes: payload.byteLength
    });
    const blobRelative = `artifacts/sha256/${descriptor.digest.slice(0, 2)}/${descriptor.digest}`;
    const originalOpen = DataPathPolicy.prototype.openFile;
    let blobOpens = 0;
    let blobBytesRead = 0;
    const openSpy = vi
      .spyOn(DataPathPolicy.prototype, "openFile")
      .mockImplementation(async function (this: DataPathPolicy, relativePath, mode) {
        const handle = await originalOpen.call(this, relativePath, mode);
        if (mode === "r" && relativePath === blobRelative) {
          blobOpens += 1;
          const readable = handle as unknown as {
            read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
          };
          const originalRead = readable.read.bind(handle);
          readable.read = async (...args) => {
            const result = await originalRead(...args);
            blobBytesRead += result.bytesRead;
            return result;
          };
        }
        return handle;
      });
    try {
      await expect(
        store.readArtifact(metadata.artifactId, { offset: payload.byteLength - 1, length: 1 })
      ).resolves.toMatchObject({ bytes: Buffer.from("x"), done: true });
      expect(blobOpens).toBe(1);
      expect(blobBytesRead).toBe(payload.byteLength);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("snapshots request accessors once before opening a transaction", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const reads = new Map<string, number>();
    const metadataProxy = new Proxy(metadata, {
      get(target, property, receiver) {
        if (typeof property === "string") reads.set(property, (reads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      }
    });
    let metadataReads = 0;
    let contentReads = 0;
    let boundReads = 0;
    let sensitiveReads = 0;
    const request = {
      get metadata() {
        metadataReads += 1;
        return metadataProxy;
      },
      get content() {
        contentReads += 1;
        return chunks("snapshot");
      },
      get maximumBytes() {
        boundReads += 1;
        return 32;
      },
      get sensitiveValues() {
        sensitiveReads += 1;
        return ["configured-value"];
      }
    };

    await expect(store.writeArtifact(request)).resolves.toMatchObject({ byteSize: 8 });
    expect({ metadataReads, contentReads, boundReads, sensitiveReads }).toEqual({
      metadataReads: 1,
      contentReads: 1,
      boundReads: 1,
      sensitiveReads: 1
    });
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
  });

  it("bounds configured-secret iteration before retaining an excessive value", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    let nextCalls = 0;
    let returnCalls = 0;
    const excessive = {
      [Symbol.iterator]() {
        return {
          next() {
            nextCalls += 1;
            return nextCalls <= 300
              ? { done: false as const, value: `configured-${nextCalls}` }
              : { done: true as const, value: undefined };
          },
          return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          }
        };
      }
    };

    await expect(
      store.writeArtifact({
        metadata,
        content: chunks("safe"),
        maximumBytes: 16,
        sensitiveValues: excessive as never
      })
    ).rejects.toMatchObject({ name: "ArtifactStoreError", code: "invalid_metadata" });
    expect(nextCalls).toBe(257);
    expect(returnCalls).toBe(1);
    await expect(readdir(join(dataRoot, "artifacts", "transactions"))).resolves.toEqual([]);
  });

  it("stops configured-secret admission at the aggregate character bound", async () => {
    const store = await ArtifactStore.create({ dataRoot: await temporaryRoot() });
    const candidates = ["x".repeat(65_536), "y", "must-not-be-read"];
    let nextCalls = 0;
    let returnCalls = 0;
    const excessive = {
      [Symbol.iterator]() {
        return {
          next() {
            const value = candidates[nextCalls];
            nextCalls += 1;
            return value === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value };
          },
          return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          }
        };
      }
    };

    await expect(
      store.writeArtifact({
        metadata,
        content: chunks("safe"),
        maximumBytes: 16,
        sensitiveValues: excessive as never
      })
    ).rejects.toMatchObject({ code: "invalid_metadata" });
    expect(nextCalls).toBe(2);
    expect(returnCalls).toBe(1);
  });

  it("sanitizes hostile configured-secret iteration and observes rejecting cleanup", async () => {
    const dataRoot = await temporaryRoot();
    const store = await ArtifactStore.create({ dataRoot });
    const secret = join(dataRoot, "sensitive-iterator-secret");
    let returnCalls = 0;
    const hostile = {
      [Symbol.iterator]() {
        return {
          next() {
            const error = new ArtifactStoreError("metadata_conflict", secret) as Error & {
              cause?: unknown;
              leaked?: string;
            };
            error.cause = new Error(secret);
            error.leaked = secret;
            throw error;
          },
          return() {
            returnCalls += 1;
            return Promise.reject(new Error(secret));
          }
        };
      }
    };

    const error = await store
      .writeArtifact({
        metadata,
        content: chunks("safe"),
        maximumBytes: 16,
        sensitiveValues: hostile as never
      })
      .catch((reason) => reason);

    expect(error).toMatchObject({ name: "ArtifactStoreError", code: "invalid_metadata" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("leaked");
    expect(String(error)).not.toContain(secret);
    expect(returnCalls).toBe(1);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  });

  it("terminates an infinite configured-secret iterable without awaiting cleanup", async () => {
    const dataRoot = await temporaryRoot();
    const artifactStoreUrl = new URL("../src/artifact-store.ts", import.meta.url).href;
    const script = `
      import { ArtifactStore } from ${JSON.stringify(artifactStoreUrl)};
      const metadata = ${JSON.stringify(metadata)};
      let returnCalls = 0;
      const sensitiveValues = {
        [Symbol.iterator]() {
          return {
            next() { return { done: false, value: "configured" }; },
            return() { returnCalls += 1; return new Promise(() => {}); }
          };
        }
      };
      const content = async function* () { yield Buffer.from("safe"); };
      try {
        await ArtifactStore.create({ dataRoot: ${JSON.stringify(dataRoot)} }).then((store) =>
          store.writeArtifact({ metadata, content: content(), maximumBytes: 16, sensitiveValues })
        );
        process.stdout.write(JSON.stringify({ code: "resolved", returnCalls }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error?.code, returnCalls }));
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      diagnostics += chunk;
    });
    const exited = new Promise<"exit">((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", () => resolvePromise("exit"));
    });
    const outcome = await Promise.race([
      exited,
      new Promise<"timeout">((resolvePromise) => setTimeout(() => resolvePromise("timeout"), 1_000))
    ]);
    if (outcome === "timeout") {
      child.kill("SIGKILL");
      await exited;
    }

    expect(outcome, diagnostics).toBe("exit");
    expect(JSON.parse(output)).toEqual({ code: "invalid_metadata", returnCalls: 1 });
  });

  it("rescans and re-hashes the published final blob inode before metadata publication", async () => {
    const dataRoot = await temporaryRoot();
    const digest = createHash("sha256").update("final-safe").digest("hex");
    let tampered = false;
    const store = await ArtifactStore.create({
      dataRoot,
      onBoundary: async (boundary) => {
        if ((boundary as string) !== "blob.published") return;
        tampered = true;
        await writeFile(
          join(dataRoot, "artifacts", "sha256", digest.slice(0, 2), digest),
          "final-evil"
        );
      }
    });

    await expect(
      store.writeArtifact({ metadata, content: chunks("final-safe"), maximumBytes: 32 })
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
    expect(tampered).toBe(true);
    await expect(store.findArtifact(metadata.artifactId)).resolves.toBeUndefined();
  });

  it("never clobbers a racing blob or immutable metadata winner", async () => {
    const dataRoot = await temporaryRoot();
    const digest = createHash("sha256").update("winner-input").digest("hex");
    const blob = join(dataRoot, "artifacts", "sha256", digest.slice(0, 2), digest);
    const metadataPath = join(
      dataRoot,
      "artifacts",
      "metadata",
      `${artifactIdFilenameComponent(metadata.artifactId)}.json`
    );
    let blobInserted = false;
    const blobStore = await ArtifactStore.create({
      dataRoot,
      onBoundary: async (boundary) => {
        if ((boundary as string) !== "blob.before-publish" || blobInserted) return;
        blobInserted = true;
        await writeFile(blob, "winner-bytes", { flag: "wx", mode: 0o600 });
      }
    });
    await expect(
      blobStore.writeArtifact({ metadata, content: chunks("winner-input"), maximumBytes: 32 })
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
    expect(await readFile(blob, "utf8")).toBe("winner-bytes");

    const metadataRoot = await temporaryRoot();
    const conflicting = { ...metadata, digest: "0".repeat(64), byteSize: 1 };
    let metadataInserted = false;
    const metadataStore = await ArtifactStore.create({
      dataRoot: metadataRoot,
      onBoundary: async (boundary) => {
        if ((boundary as string) !== "metadata.before-publish" || metadataInserted) return;
        metadataInserted = true;
        await writeFile(
          join(
            metadataRoot,
            "artifacts",
            "metadata",
            `${artifactIdFilenameComponent(metadata.artifactId)}.json`
          ),
          `${JSON.stringify(conflicting)}\n`,
          { flag: "wx", mode: 0o600 }
        );
      }
    });
    await expect(
      metadataStore.writeArtifact({ metadata, content: chunks("winner-input"), maximumBytes: 32 })
    ).rejects.toMatchObject({ code: "metadata_conflict" });
    expect(
      JSON.parse(
        await readFile(
          join(
            metadataRoot,
            "artifacts",
            "metadata",
            `${artifactIdFilenameComponent(metadata.artifactId)}.json`
          ),
          "utf8"
        )
      )
    ).toEqual(conflicting);
  });

  it("rejects same-size colliding bytes for digest dedupe and same-ID replay", async () => {
    const actualCrypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    vi.resetModules();
    vi.doMock("node:crypto", () => ({
      ...actualCrypto,
      createHash: () => {
        const hash = actualCrypto.createHash("sha256");
        const facade = {
          update(value: Uint8Array) {
            hash.update(value);
            return facade;
          },
          digest(encoding?: string) {
            void hash.digest();
            return encoding === "hex" ? "a".repeat(64) : Buffer.alloc(32, 0xaa);
          }
        };
        return facade;
      }
    }));
    try {
      const { ArtifactStore: CollidingArtifactStore } = await import("../src/artifact-store.js");
      const replayRoot = await temporaryRoot();
      const replayStore = await CollidingArtifactStore.create({ dataRoot: replayRoot });
      await replayStore.writeArtifact({
        metadata,
        content: chunks("first-collision"),
        maximumBytes: 32
      });
      await expect(
        replayStore.writeArtifact({
          metadata,
          content: chunks("other-collision"),
          maximumBytes: 32
        })
      ).rejects.toMatchObject({ code: "integrity_mismatch" });

      const dedupeRoot = await temporaryRoot();
      const dedupeStore = await CollidingArtifactStore.create({ dataRoot: dedupeRoot });
      const secondMetadata: ArtifactWriteMetadata = {
        ...metadata,
        artifactId: createId("artifact", "123e4567-e89b-42d3-a456-426614174003")
      };
      await dedupeStore.writeArtifact({
        metadata,
        content: chunks("first-collision"),
        maximumBytes: 32
      });
      await expect(
        dedupeStore.writeArtifact({
          metadata: secondMetadata,
          content: chunks("other-collision"),
          maximumBytes: 32
        })
      ).rejects.toMatchObject({ code: "integrity_mismatch" });
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });

  it("serializes same-digest and same-artifact publication races", async () => {
    const dataRoot = await temporaryRoot();
    let publishing = 0;
    let maximumPublishing = 0;
    const store = await ArtifactStore.create({
      dataRoot,
      onBoundary: async (boundary) => {
        if ((boundary as string) !== "blob.before-publish") return;
        publishing += 1;
        maximumPublishing = Math.max(maximumPublishing, publishing);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        publishing -= 1;
      }
    });
    const otherMetadata: ArtifactWriteMetadata = {
      ...metadata,
      artifactId: createId("artifact", "123e4567-e89b-42d3-a456-426614174001")
    };
    const [first, second] = await Promise.all([
      store.writeArtifact({ metadata, content: chunks("same-digest"), maximumBytes: 32 }),
      store.writeArtifact({
        metadata: otherMetadata,
        content: chunks("same-digest"),
        maximumBytes: 32
      })
    ]);
    expect(first.digest).toBe(second.digest);
    expect(maximumPublishing).toBe(1);

    const [replayOne, replayTwo] = await Promise.all([
      store.writeArtifact({ metadata, content: chunks("same-digest"), maximumBytes: 32 }),
      store.writeArtifact({ metadata, content: chunks("same-digest"), maximumBytes: 32 })
    ]);
    expect(replayOne).toEqual(replayTwo);
  });

  it("preserves a foreign pending transaction and converges two store instances", async () => {
    const dataRoot = await temporaryRoot();
    let releaseFirst!: () => void;
    let signalPending!: () => void;
    const pendingReached = new Promise<void>((resolvePromise) => {
      signalPending = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const firstStore = await ArtifactStore.create({
      dataRoot,
      onBoundary: async (boundary) => {
        if (boundary !== "transaction.directory-synced") return;
        signalPending();
        await release;
      }
    });
    const secondStore = await ArtifactStore.create({ dataRoot });
    const firstWrite = firstStore
      .writeArtifact({ metadata, content: chunks("cross-instance"), maximumBytes: 32 })
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      );
    await pendingReached;
    const transactionDirectory = join(dataRoot, "artifacts", "transactions");
    const firstPending = (await readdir(transactionDirectory)).find((entry) =>
      new RegExp(
        `^${artifactIdFilenameComponent(metadata.artifactId)}\\.[0-9a-f]{32}\\.pending$`
      ).test(entry)
    );
    expect(firstPending).toBeDefined();
    const secondWrite = secondStore
      .writeArtifact({ metadata, content: chunks("cross-instance"), maximumBytes: 32 })
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      );

    const second = await secondWrite;
    expect(second.ok).toBe(true);
    await expect(lstat(join(transactionDirectory, firstPending!))).resolves.toMatchObject({
      nlink: 1
    });
    releaseFirst();

    const first = await firstWrite;
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("Cross-instance writes did not converge.");
    expect(second.value).toEqual(first.value);
    await expect(firstStore.findArtifact(metadata.artifactId)).resolves.toEqual(first.value);
    await expect(secondStore.findArtifact(metadata.artifactId)).resolves.toEqual(first.value);
  });

  it("preserves a committed same-digest winner when another store abandons its creator", async () => {
    const dataRoot = await temporaryRoot();
    const winnerMetadata: ArtifactWriteMetadata = {
      ...metadata,
      artifactId: createId("artifact", "123e4567-e89b-42d3-a456-426614174002")
    };
    let releaseCreator!: () => void;
    let signalPublished!: () => void;
    const published = new Promise<void>((resolvePromise) => {
      signalPublished = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseCreator = resolvePromise;
    });
    let creatorAborted = false;
    const creatorStore = await ArtifactStore.create({
      dataRoot,
      onBoundary: async (boundary) => {
        if (boundary !== "blob.published" || creatorAborted) return;
        signalPublished();
        await release;
        creatorAborted = true;
        throw new Error("creator aborted after another artifact committed");
      }
    });
    const winnerStore = await ArtifactStore.create({ dataRoot });
    const creatorWrite = creatorStore
      .writeArtifact({ metadata, content: chunks("shared-winner"), maximumBytes: 32 })
      .catch((error) => error);
    await published;

    const winner = await winnerStore.writeArtifact({
      metadata: winnerMetadata,
      content: chunks("shared-winner"),
      maximumBytes: 32
    });
    releaseCreator();
    await expect(creatorWrite).resolves.toMatchObject({ code: "filesystem_error" });

    await expect(winnerStore.findArtifact(winnerMetadata.artifactId)).resolves.toEqual(winner);
    await expect(
      creatorStore.writeArtifact({ metadata, content: chunks("shared-winner"), maximumBytes: 32 })
    ).resolves.toMatchObject({ digest: winner.digest });
  });

  it.each(["blob.canonical-linked", "transaction.committed-linked"] as const)(
    "lets a live publisher finish after recovery heals its alias at %s",
    async (pauseAt) => {
      const dataRoot = await temporaryRoot();
      let releasePublisher!: () => void;
      let signalPaused!: () => void;
      const paused = new Promise<void>((resolvePromise) => {
        signalPaused = resolvePromise;
      });
      const release = new Promise<void>((resolvePromise) => {
        releasePublisher = resolvePromise;
      });
      const publisher = await ArtifactStore.create({
        dataRoot,
        onBoundary: async (boundary) => {
          if (boundary !== pauseAt) return;
          signalPaused();
          await release;
        }
      });
      const publishing = publisher.writeArtifact({
        metadata,
        content: chunks("live-recovery"),
        maximumBytes: 32
      });
      await paused;

      let recovering: ArtifactStore;
      try {
        recovering = await ArtifactStore.create({ dataRoot });
      } finally {
        releasePublisher();
      }

      const descriptor = await publishing;
      await expect(publisher.findArtifact(metadata.artifactId)).resolves.toEqual(descriptor);
      await expect(recovering.findArtifact(metadata.artifactId)).resolves.toEqual(descriptor);
    }
  );

  it("converges truly simultaneous stores writing the same artifact bytes", async () => {
    const dataRoot = await temporaryRoot();
    const barrier = simultaneousBoundary("blob.final-creation-parent-synced");
    const first = await ArtifactStore.create({ dataRoot, onBoundary: barrier });
    const second = await ArtifactStore.create({ dataRoot, onBoundary: barrier });

    const results = await Promise.allSettled([
      first.writeArtifact({ metadata, content: chunks("simultaneous"), maximumBytes: 32 }),
      second.writeArtifact({ metadata, content: chunks("simultaneous"), maximumBytes: 32 })
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled") return;
    expect(results[1].value).toEqual(results[0].value);
    await expect(first.findArtifact(metadata.artifactId)).resolves.toEqual(results[0].value);
    await expect(second.findArtifact(metadata.artifactId)).resolves.toEqual(results[0].value);
  });

  it("adopts a concurrent first creation of a missing multi-segment data root", async () => {
    const runs = await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const parent = await temporaryRoot();
        const dataRoot = join(parent, `missing-${index}`, "nested", "state");
        return Promise.allSettled([
          ArtifactStore.create({ dataRoot }),
          ArtifactStore.create({ dataRoot })
        ]);
      })
    );

    for (const pair of runs) {
      expect(pair[0]).toMatchObject({ status: "fulfilled" });
      expect(pair[1]).toMatchObject({ status: "fulfilled" });
    }
  });

  it("selects one immutable metadata winner for simultaneous different bytes", async () => {
    const dataRoot = await temporaryRoot();
    const barrier = simultaneousBoundary("metadata.directory-synced");
    const first = await ArtifactStore.create({ dataRoot, onBoundary: barrier });
    const second = await ArtifactStore.create({ dataRoot, onBoundary: barrier });

    const results = await Promise.allSettled([
      first.writeArtifact({ metadata, content: chunks("first-winner"), maximumBytes: 32 }),
      second.writeArtifact({ metadata, content: chunks("other-winner"), maximumBytes: 32 })
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<ArtifactDescriptor> =>
        result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      name: "ArtifactStoreError",
      code: "metadata_conflict"
    });
    await expect(first.findArtifact(metadata.artifactId)).resolves.toEqual(fulfilled[0]?.value);
    await expect(second.findArtifact(metadata.artifactId)).resolves.toEqual(fulfilled[0]?.value);
  });

  it("deduplicates one digest across simultaneous stores and different artifact IDs", async () => {
    const dataRoot = await temporaryRoot();
    const barrier = simultaneousBoundary("blob.final-creation-parent-synced");
    const first = await ArtifactStore.create({ dataRoot, onBoundary: barrier });
    const second = await ArtifactStore.create({ dataRoot, onBoundary: barrier });
    const otherMetadata: ArtifactWriteMetadata = {
      ...metadata,
      artifactId: createId("artifact", "123e4567-e89b-42d3-a456-426614174004")
    };

    const results = await Promise.allSettled([
      first.writeArtifact({ metadata, content: chunks("shared-digest"), maximumBytes: 32 }),
      second.writeArtifact({
        metadata: otherMetadata,
        content: chunks("shared-digest"),
        maximumBytes: 32
      })
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled") return;
    expect(results[1].value.digest).toBe(results[0].value.digest);
    await expect(first.findArtifact(metadata.artifactId)).resolves.toEqual(results[0].value);
    await expect(second.findArtifact(otherMetadata.artifactId)).resolves.toEqual(results[1].value);
  });

  it("preserves a verified pair after the durable committed boundary", async () => {
    const dataRoot = await temporaryRoot();
    const crashingStore = await ArtifactStore.create({
      dataRoot,
      onBoundary: (boundary) => {
        if ((boundary as string) === "transaction.committed-directory-synced") {
          throw new Error("private crash detail");
        }
      }
    });
    const error = await crashingStore
      .writeArtifact({ metadata, content: chunks("committed"), maximumBytes: 32 })
      .catch((reason) => reason);
    expect(error).toMatchObject({ name: "ArtifactStoreError", code: "filesystem_error" });
    expect(String(error)).not.toContain("private crash detail");

    const recoveredStore = await ArtifactStore.create({ dataRoot });
    await expect(recoveredStore.findArtifact(metadata.artifactId)).resolves.toMatchObject({
      artifactId: metadata.artifactId
    });
  });

  it.each(["publishing", "committed"] as const)(
    "tolerates an incomplete attempt-scoped %s temp and permits an identical retry",
    async (phase) => {
      const dataRoot = await temporaryRoot();
      await ArtifactStore.create({ dataRoot });
      const content = "partial-marker";
      const digest = createHash("sha256").update(content).digest("hex");
      const attemptId = "1".repeat(32);
      const descriptor: ArtifactDescriptor = {
        artifactId: metadata.artifactId,
        workspaceId: metadata.workspaceId,
        runId: metadata.runId,
        commandId: metadata.commandId,
        kind: metadata.kind,
        mediaType: metadata.mediaType,
        digest,
        byteSize: Buffer.byteLength(content),
        createdAt: metadata.createdAt
      };
      const transactionDirectory = join(dataRoot, "artifacts", "transactions");
      await writeFile(
        join(
          transactionDirectory,
          `${artifactIdFilenameComponent(metadata.artifactId)}.${attemptId}.pending`
        ),
        "",
        { mode: 0o600 }
      );
      const digestDirectory = join(dataRoot, "artifacts", "sha256", digest.slice(0, 2));
      await mkdir(digestDirectory, { mode: 0o700 });
      if (phase === "publishing") {
        await writeFile(join(digestDirectory, `${digest}.${attemptId}.publish.tmp`), "partial", {
          mode: 0o600
        });
      } else {
        await writeFile(join(digestDirectory, digest), content, { mode: 0o600 });
        await writeFile(
          join(
            dataRoot,
            "artifacts",
            "metadata",
            `${artifactIdFilenameComponent(metadata.artifactId)}.json`
          ),
          `${JSON.stringify(descriptor)}\n`,
          { mode: 0o600 }
        );
        await writeFile(
          join(
            transactionDirectory,
            `${artifactIdFilenameComponent(metadata.artifactId)}.${attemptId}.commit.tmp`
          ),
          "partial",
          { mode: 0o600 }
        );
      }

      const recoveredStore = await ArtifactStore.create({ dataRoot });
      await expect(recoveredStore.findArtifact(metadata.artifactId)).resolves.toBeUndefined();
      await expect(
        recoveredStore.writeArtifact({ metadata, content: chunks(content), maximumBytes: 32 })
      ).resolves.toMatchObject({ digest });
    }
  );

  it.each([
    "transaction.file-opened",
    "blob.file-synced",
    "transaction.publishing-file-opened",
    "transaction.publishing-file-synced",
    "blob.canonical-linked",
    "blob.canonical-directory-synced",
    "blob.publish-temp-unlinked",
    "metadata.file-synced",
    "metadata.canonical-linked",
    "metadata.canonical-directory-synced",
    "metadata.publish-temp-unlinked",
    "transaction.committed-file-opened",
    "transaction.committed-file-synced",
    "transaction.committed-linked",
    "transaction.committed-directory-synced",
    "transaction.commit-temp-unlinked"
  ] as const)("recovers after a real process kill at %s", async (boundary) => {
    const dataRoot = await temporaryRoot();
    const content = "process-kill-marker";

    await killWriterAtBoundary(dataRoot, boundary, content);

    const recoveredStore = await ArtifactStore.create({ dataRoot });
    const recovered = await recoveredStore.findArtifact(metadata.artifactId);
    if (recovered === undefined) {
      await expect(
        recoveredStore.writeArtifact({ metadata, content: chunks(content), maximumBytes: 64 })
      ).resolves.toMatchObject({ artifactId: metadata.artifactId });
    } else {
      expect(recovered).toMatchObject({ artifactId: metadata.artifactId });
    }
  });

  it("rejects a malformed canonical commit binding", async () => {
    const dataRoot = await temporaryRoot();
    await ArtifactStore.create({ dataRoot });
    const transactionDirectory = join(dataRoot, "artifacts", "transactions");
    await writeFile(
      join(transactionDirectory, `${artifactIdFilenameComponent(metadata.artifactId)}.committed`),
      "not-a-metadata-hash\n",
      { mode: 0o600 }
    );

    await expect(ArtifactStore.create({ dataRoot })).rejects.toMatchObject({
      code: "integrity_mismatch"
    });
  });
});
