import { describe, expect, it } from "vitest";

import { parseHostBootstrap, rejectHostEnvironmentOverrides } from "../src/config.js";

const descriptor = {
  electronExecutable: "/private/build/electron",
  guardianModule: "/private/build/guardian.js",
  nativeDirectory: "/private/build/native",
  desktopBuildRoot: "/private/build",
  runtimeManifestDigest: "a".repeat(64),
  electronVersion: "43.4.0",
  nodePtyVersion: "1.1.0"
} as const;

describe("host bootstrap", () => {
  it("accepts only a private one-shot loopback bootstrap", () => {
    expect(
      parseHostBootstrap({
        schemaVersion: 1,
        type: "host.bootstrap",
        hostToken: "host-token-0123456789-abcdefghijklmnop",
        dataRoot: "/private/autostack",
        host: "127.0.0.1",
        port: 0,
        guardian: descriptor
      })
    ).toMatchObject({ host: "127.0.0.1", port: 0 });
  });

  it.each(["change-me", "x".repeat(32), "replace-with-real-token"])(
    "rejects unsafe token %s",
    (hostToken) => {
      expect(() =>
        parseHostBootstrap({
          schemaVersion: 1,
          type: "host.bootstrap",
          hostToken,
          dataRoot: "/private/autostack",
          host: "127.0.0.1",
          port: 0,
          guardian: descriptor
        })
      ).toThrow();
    }
  );

  it("rejects environment configuration overrides", () => {
    expect(rejectHostEnvironmentOverrides({})).toBeUndefined();
    expect(() => rejectHostEnvironmentOverrides({ AUTOSTACK_PORT: "8000" })).toThrow(
      "Host configuration overrides are forbidden."
    );
  });
});
