import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  HostRuntimeManifestSchema,
  type GuardianLaunchDescriptor,
  type HostRuntimeManifest
} from "@autostack/contracts";

const MAX_MANIFEST_BYTES = 65_536;
const MANIFEST_FILENAME = "runtime-manifest.json";

interface PinnedIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly owner: number;
  readonly kind: "file" | "directory";
}

export interface ValidatedGuardianRuntime {
  readonly descriptor: GuardianLaunchDescriptor;
  readonly manifest: HostRuntimeManifest;
  revalidate(): Promise<void>;
}

const assertPrivateIdentity = async (
  path: string,
  kind: PinnedIdentity["kind"]
): Promise<PinnedIdentity> => {
  if (!isAbsolute(path) || (await realpath(path)) !== path) {
    throw new TypeError("Runtime path is not canonical.");
  }
  const link = await lstat(path);
  const metadata = await stat(path, { bigint: true });
  const correctKind = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  if (link.isSymbolicLink() || !correctKind || metadata.uid !== BigInt(process.getuid?.() ?? -1)) {
    throw new TypeError("Runtime path identity is invalid.");
  }
  if ((Number(metadata.mode) & 0o022) !== 0) {
    throw new TypeError("Runtime path permissions are unsafe.");
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: Number(metadata.mode),
    owner: Number(metadata.uid),
    kind
  };
};

const assertInside = (root: string, candidate: string): void => {
  const child = relative(root, candidate);
  if (child === "" || child.startsWith("../") || isAbsolute(child)) {
    throw new TypeError("Guardian runtime escapes its build root.");
  }
};

const sameIdentity = (left: PinnedIdentity, right: PinnedIdentity): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.mode === right.mode &&
  left.owner === right.owner &&
  left.kind === right.kind;

const readManifestSnapshot = async (path: string): Promise<Buffer> => {
  await assertPrivateIdentity(path, "file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead > MAX_MANIFEST_BYTES ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(bytesRead) !== before.size
    ) {
      throw new TypeError("Runtime manifest snapshot is unstable.");
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export const validateGuardianRuntime = async (
  descriptor: GuardianLaunchDescriptor
): Promise<ValidatedGuardianRuntime> => {
  const manifestPath = join(descriptor.desktopBuildRoot, MANIFEST_FILENAME);
  const bytes = await readManifestSnapshot(manifestPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.runtimeManifestDigest) {
    throw new TypeError("Runtime manifest digest is invalid.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Runtime manifest is invalid.");
  }
  const manifest = HostRuntimeManifestSchema.parse(candidate);
  const comparableDescriptor = {
    schemaVersion: 1,
    electronExecutable: descriptor.electronExecutable,
    guardianModule: descriptor.guardianModule,
    nativeDirectory: descriptor.nativeDirectory,
    desktopBuildRoot: descriptor.desktopBuildRoot,
    electronVersion: descriptor.electronVersion,
    nodePtyVersion: descriptor.nodePtyVersion
  } as const;
  if (JSON.stringify(manifest) !== JSON.stringify(comparableDescriptor)) {
    throw new TypeError("Runtime manifest does not match its descriptor.");
  }
  assertInside(descriptor.desktopBuildRoot, descriptor.guardianModule);
  assertInside(descriptor.desktopBuildRoot, descriptor.nativeDirectory);
  const paths = [
    [descriptor.desktopBuildRoot, "directory"],
    [descriptor.electronExecutable, "file"],
    [descriptor.guardianModule, "file"],
    [descriptor.nativeDirectory, "directory"],
    [manifestPath, "file"]
  ] as const;
  const pinned = await Promise.all(paths.map(([path, kind]) => assertPrivateIdentity(path, kind)));
  return {
    descriptor,
    manifest,
    async revalidate() {
      const current = await Promise.all(
        paths.map(([path, kind]) => assertPrivateIdentity(path, kind))
      );
      if (!current.every((identity, index) => sameIdentity(identity, pinned[index]!))) {
        throw new TypeError("Guardian runtime identity changed.");
      }
      const currentBytes = await readManifestSnapshot(manifestPath);
      if (!currentBytes.equals(bytes)) throw new TypeError("Runtime manifest changed.");
    }
  };
};
