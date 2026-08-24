import { describe, expect, it, vi } from "vitest";

import { startHostDaemon } from "../src/server.js";

const bootstrap = {
  schemaVersion: 1,
  type: "host.bootstrap",
  hostToken: "host-token-0123456789-abcdefghijklmnop",
  dataRoot: "/private/autostack",
  host: "127.0.0.1",
  port: 0,
  guardian: {
    electronExecutable: "/private/build/electron",
    guardianModule: "/private/build/guardian.js",
    nativeDirectory: "/private/build/native",
    desktopBuildRoot: "/private/build",
    runtimeManifestDigest: "a".repeat(64),
    electronVersion: "43.4.0",
    nodePtyVersion: "1.1.0"
  }
} as const;

describe("host server", () => {
  it("publishes readiness only after provider recovery and verified listen", async () => {
    const order: string[] = [];
    const close = vi.fn(async () => void order.push("listener.close"));
    const runtime = await startHostDaemon({
      environment: {},
      bootstrapReader: { readOnce: vi.fn(async () => bootstrap) },
      validateRuntime: vi.fn(
        async () => ({ descriptor: bootstrap.guardian, manifest: {}, revalidate: vi.fn() }) as never
      ),
      createRunner: vi.fn(async () => {
        order.push("runner.ready");
        return {
          runner: {
            capabilities: vi.fn(),
            inspectRepository: vi.fn(),
            prepareEnvironment: vi.fn(),
            listEnvironments: vi.fn(),
            startCommand: vi.fn(),
            readCommandEvents: vi.fn(),
            cancelCommand: vi.fn(),
            readArtifactChunk: vi.fn(),
            disposeEnvironment: vi.fn()
          },
          lifecycle: {
            quiesce: vi.fn(async () => undefined),
            interruptAndDrain: vi.fn(async () => ({
              interruptedCommandIds: [],
              releasedGuardianLeaseCount: 0,
              remainingGuardianLeaseCount: 0 as const
            })),
            close: vi.fn(async () => undefined)
          },
          prepareWithReplay: vi.fn(),
          terminalizeProtocolFailure: vi.fn()
        };
      }),
      listen: vi.fn(async () => {
        order.push("listen");
        return { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4545 }), close };
      }),
      readinessWriter: { writeOnce: vi.fn(() => void order.push("ready")) },
      requestId: () => "request_1",
      log: () => undefined,
      signal: new AbortController().signal,
      pid: 77
    });
    expect(order).toEqual(["runner.ready", "listen", "ready"]);
    expect(runtime.origin).toBe("http://127.0.0.1:4545");
    await runtime.shutdown("test");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes provider resources when the listener address is untrusted", async () => {
    const lifecycleClose = vi.fn(async () => undefined);
    await expect(
      startHostDaemon({
        environment: {},
        bootstrapReader: { readOnce: vi.fn(async () => bootstrap) },
        validateRuntime: vi.fn(
          async () =>
            ({ descriptor: bootstrap.guardian, manifest: {}, revalidate: vi.fn() }) as never
        ),
        createRunner: vi.fn(async () => ({
          runner: {} as never,
          lifecycle: { quiesce: vi.fn(), interruptAndDrain: vi.fn(), close: lifecycleClose },
          prepareWithReplay: vi.fn(),
          terminalizeProtocolFailure: vi.fn()
        })),
        listen: vi.fn(async () => ({ address: () => "socket", close: vi.fn() })),
        readinessWriter: { writeOnce: vi.fn() },
        requestId: () => "request_1",
        log: () => undefined,
        signal: new AbortController().signal,
        pid: 77
      })
    ).rejects.toThrow("Host listener did not bind a numeric loopback address.");
    expect(lifecycleClose).toHaveBeenCalledOnce();
  });
});
