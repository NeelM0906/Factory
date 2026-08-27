import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { GuardianLaunchDescriptor } from "@autostack/contracts";

import { validateGuardianRuntime } from "../src/guardian-launcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  );
});

type Overrides = (root: string) => Record<string, unknown>;

interface Fixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly guardian: string;
  readonly descriptor: GuardianLaunchDescriptor;
}

const none: Overrides = () => ({});

/**
 * Lays down a runtime the validator accepts, then lets a caller perturb exactly one property.
 * `manifestOverrides` changes what the manifest file says without changing what the descriptor
 * claims; `descriptorOverrides` changes the descriptor around an untouched manifest. Both receive
 * the generated root so an override can stay inside the fixture it belongs to.
 */
const buildRuntime = async (
  manifestOverrides: Overrides = none,
  descriptorOverrides: Overrides = none
): Promise<Fixture> => {
  const root = join(await realpath(tmpdir()), `autostack-host-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(join(root, "native"), { recursive: true, mode: 0o700 });
  const electron = join(root, "electron");
  const guardian = join(root, "guardian.js");
  await writeFile(electron, "electron", { mode: 0o700 });
  await writeFile(guardian, "guardian", { mode: 0o600 });
  const manifest = {
    schemaVersion: 1,
    electronExecutable: electron,
    guardianModule: guardian,
    nativeDirectory: join(root, "native"),
    desktopBuildRoot: root,
    electronVersion: "43.4.0",
    nodePtyVersion: "1.1.0"
  } as const;
  const bytes = `${JSON.stringify({ ...manifest, ...manifestOverrides(root) })}\n`;
  const manifestPath = join(root, "runtime-manifest.json");
  await writeFile(manifestPath, bytes, { mode: 0o600 });
  await chmod(root, 0o700);
  return {
    root,
    manifestPath,
    guardian,
    descriptor: {
      ...manifest,
      ...descriptorOverrides(root),
      runtimeManifestDigest: createHash("sha256").update(bytes).digest("hex")
    } as Fixture["descriptor"]
  };
};

describe("guardian runtime", () => {
  it("pins a bounded exact manifest and rejects digest drift", async () => {
    const fixture = await buildRuntime();

    const runtime = await validateGuardianRuntime(fixture.descriptor);
    await expect(runtime.revalidate()).resolves.toBeUndefined();
    await expect(
      validateGuardianRuntime({ ...fixture.descriptor, runtimeManifestDigest: "a".repeat(64) })
    ).rejects.toThrow("Runtime manifest digest is invalid.");
  });

  it("rejects a manifest whose own content disagrees with the descriptor it authenticates", async () => {
    const fixture = await buildRuntime((root) => ({
      electronExecutable: join(root, "electron-other")
    }));

    await expect(validateGuardianRuntime(fixture.descriptor)).rejects.toThrow(
      "Runtime manifest does not match its descriptor."
    );
  });

  it("rejects a guardian module outside the build root even when the manifest agrees", async () => {
    const escape: Overrides = (root) => ({ guardianModule: join(root, "..", "escape.js") });
    const fixture = await buildRuntime(escape, escape);

    await expect(validateGuardianRuntime(fixture.descriptor)).rejects.toThrow(
      "Guardian runtime escapes its build root."
    );
  });

  it("rejects a build root that other users may write", async () => {
    const fixture = await buildRuntime();
    await chmod(fixture.root, 0o777);

    await expect(validateGuardianRuntime(fixture.descriptor)).rejects.toThrow(
      "Runtime path permissions are unsafe."
    );
  });

  it("rejects an absolute runtime path that reaches the build root through a symlink", async () => {
    const fixture = await buildRuntime();
    const alias = `${fixture.root}-alias`;
    roots.push(alias);
    await symlink(fixture.root, alias);

    await expect(
      validateGuardianRuntime({ ...fixture.descriptor, desktopBuildRoot: alias })
    ).rejects.toThrow("Runtime path is not canonical.");
  });

  it("refuses to revalidate after a pinned file is replaced by a different inode", async () => {
    const fixture = await buildRuntime();
    const runtime = await validateGuardianRuntime(fixture.descriptor);

    await unlink(fixture.guardian);
    await writeFile(fixture.guardian, "guardian", { mode: 0o600 });

    await expect(runtime.revalidate()).rejects.toThrow("Guardian runtime identity changed.");
  });

  it("refuses to revalidate after the manifest is rewritten in place", async () => {
    const fixture = await buildRuntime();
    const runtime = await validateGuardianRuntime(fixture.descriptor);

    await writeFile(fixture.manifestPath, `${JSON.stringify({ schemaVersion: 1 })}\n`, {
      mode: 0o600
    });

    await expect(runtime.revalidate()).rejects.toThrow("Runtime manifest changed.");
  });
});
