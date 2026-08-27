import { describe, expect, it } from "vitest";

import { createControlPlaneReadiness, publishControlPlaneReadiness } from "../src/readiness.js";

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

  it("refuses a listener address that is a pipe path rather than a bound socket", () => {
    expect(() => createControlPlaneReadiness("/tmp/autostack.sock", 42)).toThrow(
      /Control-plane listener address is invalid/
    );
    expect(() => createControlPlaneReadiness(null, 42)).toThrow(
      /Control-plane listener address is invalid/
    );
  });

  it("refuses a loopback listener whose port is not a resolved number", () => {
    expect(() => createControlPlaneReadiness({ address: "127.0.0.1", port: "4402" }, 42)).toThrow(
      /Control-plane listener address is invalid/
    );
    expect(() => createControlPlaneReadiness({ address: "127.0.0.1" }, 42)).toThrow(
      /Control-plane listener address is invalid/
    );
  });

  it("hands the readiness record to the parent channel and returns exactly what it posted", () => {
    const posted: unknown[] = [];

    const readiness = publishControlPlaneReadiness(
      { postMessage: (value) => void posted.push(value) },
      { address: "127.0.0.1", port: 4403 },
      99
    );

    expect(posted).toEqual([readiness]);
    expect(readiness).toEqual({
      schemaVersion: 1,
      type: "runtime.ready",
      service: "autostack-control-plane",
      pid: 99,
      origin: "http://127.0.0.1:4403"
    });
  });

  it("never posts a message when the listener address is rejected", () => {
    const posted: unknown[] = [];

    expect(() =>
      publishControlPlaneReadiness(
        { postMessage: (value) => void posted.push(value) },
        { address: "::1", port: 4403 },
        99
      )
    ).toThrow(/Control-plane listener address is invalid/);
    expect(posted).toEqual([]);
  });
});
