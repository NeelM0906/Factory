import { describe, expect, it } from "vitest";

import {
  HostParentLifecycleMessageSchema,
  HostReadinessRecordSchema,
  HostRuntimeManifestSchema
} from "../src/host-runtime.js";

describe("host runtime contracts", () => {
  it("shares strict readiness and parent lifecycle records", () => {
    expect(
      HostReadinessRecordSchema.parse({
        schemaVersion: 1,
        type: "runtime.ready",
        service: "autostack-host-daemon",
        pid: 42,
        origin: "http://127.0.0.1:4200"
      })
    ).toMatchObject({ pid: 42 });
    expect(
      HostParentLifecycleMessageSchema.parse({ schemaVersion: 1, type: "interrupt-and-drain" })
    ).toMatchObject({ type: "interrupt-and-drain" });
  });

  it("locks the exact Task 9 runtime manifest versions", () => {
    expect(
      HostRuntimeManifestSchema.parse({
        schemaVersion: 1,
        electronExecutable: "/build/electron",
        guardianModule: "/build/guardian.js",
        nativeDirectory: "/build/native",
        desktopBuildRoot: "/build",
        electronVersion: "43.4.0",
        nodePtyVersion: "1.1.0"
      })
    ).toMatchObject({ electronVersion: "43.4.0", nodePtyVersion: "1.1.0" });
  });
});
