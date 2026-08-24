import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { validateGuardianRuntime } from "../src/guardian-launcher.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("guardian runtime", () => {
  it("pins a bounded exact manifest and rejects digest drift", async () => {
    const root = await (
      await import("node:fs/promises")
    )
      .realpath(join(tmpdir(), `autostack-host-${crypto.randomUUID()}`).replace(/\/[^/]+$/, ""))
      .then((parent) => join(parent, `autostack-host-${crypto.randomUUID()}`));
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
    const bytes = `${JSON.stringify(manifest)}\n`;
    await writeFile(join(root, "runtime-manifest.json"), bytes, { mode: 0o600 });
    await chmod(root, 0o700);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const runtime = await validateGuardianRuntime({ ...manifest, runtimeManifestDigest: digest });
    await expect(runtime.revalidate()).resolves.toBeUndefined();
    await expect(
      validateGuardianRuntime({ ...manifest, runtimeManifestDigest: "a".repeat(64) })
    ).rejects.toThrow("Runtime manifest digest is invalid.");
  });
});
