import { describe, expect, it } from "vitest";

import { createControlPlaneReadiness } from "../src/readiness.js";

describe("control-plane readiness", () => {
  it("publishes only the assigned numeric-loopback listener", () => {
    expect(createControlPlaneReadiness({ address: "127.0.0.1", port: 4402 }, 42)).toEqual({
      schemaVersion: 1,
      type: "runtime.ready",
      service: "autostack-control-plane",
      pid: 42,
      origin: "http://127.0.0.1:4402"
    });
    expect(() => createControlPlaneReadiness({ address: "0.0.0.0", port: 4402 }, 42)).toThrow();
  });
});
