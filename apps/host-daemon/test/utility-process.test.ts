import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createProductionHostRunnerFactory,
  runForkableHostUtilityProcess
} from "../src/utility-process.js";

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

class ParentPort extends EventEmitter {
  readonly sent: unknown[] = [];
  postMessage(value: unknown): void {
    this.sent.push(value);
  }
}

describe("forkable host utility process", () => {
  const composition = (lifecycleClose: () => Promise<void>) => ({
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
    } as never,
    lifecycle: {
      quiesce: vi.fn(async () => undefined),
      interruptAndDrain: vi.fn(async () => ({
        interruptedCommandIds: [],
        releasedGuardianLeaseCount: 0,
        remainingGuardianLeaseCount: 0 as const
      })),
      close: lifecycleClose
    },
    prepareWithReplay: vi.fn(),
    terminalizeProtocolFailure: vi.fn()
  });

  it("latches parent close across pending runner creation and never publishes readiness", async () => {
    const parent = new ParentPort();
    const lifecycleClose = vi.fn(async () => undefined);
    let resolveRunner!: (value: unknown) => void;
    const runnerPending = new Promise<unknown>((resolve) => {
      resolveRunner = resolve;
    });
    const createRunner = vi.fn(async () => (await runnerPending) as never);
    const listen = vi.fn();
    const running = runForkableHostUtilityProcess({
      parent,
      createRunner,
      validateRuntime: vi.fn(
        async () => ({ descriptor: bootstrap.guardian, manifest: {}, revalidate: vi.fn() }) as never
      ),
      listen,
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: false,
      setExitCode: vi.fn()
    });
    parent.emit("message", bootstrap);
    await vi.waitFor(() => expect(createRunner).toHaveBeenCalledOnce());
    parent.emit("close");
    resolveRunner(composition(lifecycleClose));
    await expect(running).resolves.toBeUndefined();
    expect(lifecycleClose).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();
    expect(parent.sent).toEqual([]);
  });

  it("latches SIGTERM across pending listen and closes the late listener before readiness", async () => {
    const parent = new ParentPort();
    const lifecycleClose = vi.fn(async () => undefined);
    const listenerClose = vi.fn(async () => undefined);
    let resolveListener!: (value: unknown) => void;
    const listenerPending = new Promise<unknown>((resolve) => {
      resolveListener = resolve;
    });
    const listen = vi.fn(async () => (await listenerPending) as never);
    const running = runForkableHostUtilityProcess({
      parent,
      createRunner: vi.fn(async () => composition(lifecycleClose)),
      validateRuntime: vi.fn(
        async () => ({ descriptor: bootstrap.guardian, manifest: {}, revalidate: vi.fn() }) as never
      ),
      listen,
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: true,
      setExitCode: vi.fn()
    });
    parent.emit("message", bootstrap);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    process.emit("SIGTERM", "SIGTERM");
    resolveListener({
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4545 }),
      close: listenerClose
    });
    await expect(running).resolves.toBeUndefined();
    expect(listenerClose).toHaveBeenCalledOnce();
    expect(lifecycleClose).toHaveBeenCalledOnce();
    expect(parent.sent).toEqual([]);
  });

  it("sets a static nonzero result when aborted startup cleanup is incomplete", async () => {
    const parent = new ParentPort();
    const setExitCode = vi.fn();
    let resolveListener!: (value: unknown) => void;
    const listenerPending = new Promise<unknown>((resolve) => {
      resolveListener = resolve;
    });
    const listen = vi.fn(async () => (await listenerPending) as never);
    const running = runForkableHostUtilityProcess({
      parent,
      createRunner: vi.fn(async () => composition(vi.fn(async () => undefined))),
      validateRuntime: vi.fn(
        async () => ({ descriptor: bootstrap.guardian, manifest: {}, revalidate: vi.fn() }) as never
      ),
      listen,
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: false,
      setExitCode
    });
    parent.emit("message", bootstrap);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    parent.emit("close");
    resolveListener({
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4545 }),
      close: vi.fn(async () => {
        throw new Error("listener close failed");
      })
    });
    await expect(running).resolves.toBeUndefined();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(parent.sent).toEqual([]);
  });

  it("revalidates runtime for every guardian launch and composes the real provider boundary", async () => {
    const revalidate = vi.fn(async () => undefined);
    const rawLaunch = vi.fn(async () => ({ session: true }));
    const provider = { quiesce: vi.fn(), interruptAndDrain: vi.fn(), close: vi.fn() };
    const createProvider = vi.fn(async (_options: unknown) => provider);
    const factory = createProductionHostRunnerFactory({
      createGuardianLauncher: vi.fn(async () => ({ launch: rawLaunch })) as never,
      localRunnerOptions: {} as never,
      createProvider: createProvider as never,
      bindProvider: vi.fn(() => ({ runner: provider, lifecycle: provider })) as never
    });
    await factory({
      dataRoot: "/private/autostack",
      runtime: { descriptor: bootstrap.guardian, manifest: {}, revalidate } as never
    });
    const options = createProvider.mock.calls[0]![0] as {
      guardianLauncher: { launch(a: unknown, b: unknown): Promise<unknown> };
    };
    await options.guardianLauncher.launch({}, {});
    expect(revalidate).toHaveBeenCalledOnce();
    expect(rawLaunch).toHaveBeenCalledOnce();
  });

  it("consumes bootstrap, publishes readiness, drains on parent lifecycle, and closes", async () => {
    const parent = new ParentPort();
    const quiesce = vi.fn(async () => undefined);
    const interruptAndDrain = vi.fn(async () => ({
      interruptedCommandIds: [],
      releasedGuardianLeaseCount: 0,
      remainingGuardianLeaseCount: 0 as const
    }));
    const close = vi.fn(async () => undefined);
    const start = vi.fn(
      async (options: { readinessWriter: { writeOnce(value: unknown): void } }) => {
        options.readinessWriter.writeOnce({
          schemaVersion: 1,
          type: "runtime.ready",
          service: "autostack-host-daemon",
          pid: 42,
          origin: "http://127.0.0.1:4545"
        });
        return {
          app: {},
          origin: "http://127.0.0.1:4545",
          state: () => "serving",
          quiesce,
          interruptAndDrain,
          close,
          shutdown: vi.fn()
        };
      }
    );
    const running = runForkableHostUtilityProcess({
      parent,
      start: start as never,
      createRunner: vi.fn(),
      validateRuntime: vi.fn(),
      listen: vi.fn(),
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: false,
      setExitCode: vi.fn()
    });
    parent.emit("message", bootstrap);
    await vi.waitFor(() => expect(parent.sent).toHaveLength(1));
    parent.emit("message", { schemaVersion: 1, type: "interrupt-and-drain" });
    await vi.waitFor(() => expect(interruptAndDrain).toHaveBeenCalledOnce());
    expect(parent.sent.at(-1)).toMatchObject({ schemaVersion: 1, type: "drained" });
    parent.emit("message", { schemaVersion: 1, type: "close" });
    await expect(running).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("sets a nonzero exit code when shutdown is incomplete", async () => {
    const parent = new ParentPort();
    const setExitCode = vi.fn();
    const running = runForkableHostUtilityProcess({
      parent,
      start: vi.fn(async () => ({
        app: {},
        origin: "http://127.0.0.1:4545",
        state: () => "failed",
        quiesce: vi.fn(),
        interruptAndDrain: vi.fn(async () => {
          throw new Error("incomplete");
        }),
        close: vi.fn(),
        shutdown: vi.fn()
      })) as never,
      createRunner: vi.fn(),
      validateRuntime: vi.fn(),
      listen: vi.fn(),
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: false,
      setExitCode
    });
    parent.emit("message", bootstrap);
    await vi.waitFor(() => expect(parent.listenerCount("message")).toBeGreaterThan(0));
    parent.emit("message", { schemaVersion: 1, type: "interrupt-and-drain" });
    await vi.waitFor(() => expect(setExitCode).toHaveBeenCalledWith(1));
    parent.emit("close");
    await expect(running).resolves.toBeUndefined();
  });

  it("queues quiesce during startup and rejects close before drain", async () => {
    const parent = new ParentPort();
    const quiesce = vi.fn(async () => undefined);
    let resolveStart!: (value: unknown) => void;
    const startResult = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const setExitCode = vi.fn();
    const running = runForkableHostUtilityProcess({
      parent,
      start: vi.fn(async () => (await startResult) as never) as never,
      createRunner: vi.fn(),
      validateRuntime: vi.fn(),
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: false,
      setExitCode
    });
    parent.emit("message", bootstrap);
    parent.emit("message", { schemaVersion: 1, type: "quiesce" });
    resolveStart({
      app: {},
      origin: "http://127.0.0.1:4545",
      state: () => "serving",
      quiesce,
      interruptAndDrain: vi.fn(),
      close: vi.fn(),
      shutdown: vi.fn()
    });
    await vi.waitFor(() => expect(quiesce).toHaveBeenCalledOnce());
    parent.emit("message", { schemaVersion: 1, type: "close" });
    await vi.waitFor(() => expect(setExitCode).toHaveBeenCalledWith(1));
    await expect(running).resolves.toBeUndefined();
  });

  it("terminates cleanly when the parent closes before bootstrap", async () => {
    const parent = new ParentPort();
    const setExitCode = vi.fn();
    const running = runForkableHostUtilityProcess({
      parent,
      start: vi.fn(async (options: { bootstrapReader: { readOnce(): Promise<unknown> } }) => {
        await options.bootstrapReader.readOnce();
        throw new Error("unreachable");
      }) as never,
      createRunner: vi.fn(),
      validateRuntime: vi.fn(),
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: false,
      setExitCode
    });
    parent.emit("close");
    await expect(running).resolves.toBeUndefined();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it("shuts down cleanly when an initialized parent channel closes", async () => {
    const parent = new ParentPort();
    const shutdown = vi.fn(async () => undefined);
    const running = runForkableHostUtilityProcess({
      parent,
      start: vi.fn(async () => ({
        app: {},
        origin: "http://127.0.0.1:4545",
        state: () => "serving",
        quiesce: vi.fn(),
        interruptAndDrain: vi.fn(),
        close: vi.fn(),
        shutdown
      })) as never,
      createRunner: vi.fn(),
      validateRuntime: vi.fn(),
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: false,
      setExitCode: vi.fn()
    });
    parent.emit("message", bootstrap);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    parent.emit("close");
    await expect(running).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledWith("parent");
  });

  it("runs the same shutdown path for a process signal", async () => {
    const parent = new ParentPort();
    const shutdown = vi.fn(async () => undefined);
    const running = runForkableHostUtilityProcess({
      parent,
      start: vi.fn(async () => ({
        app: {},
        origin: "http://127.0.0.1:4545",
        state: () => "serving",
        quiesce: vi.fn(),
        interruptAndDrain: vi.fn(),
        close: vi.fn(),
        shutdown
      })) as never,
      createRunner: vi.fn(),
      validateRuntime: vi.fn(),
      environment: {},
      pid: 42,
      log: vi.fn(),
      requestId: () => "request_1",
      signals: true,
      setExitCode: vi.fn()
    });
    parent.emit("message", bootstrap);
    await vi.waitFor(() => expect(parent.sent).toHaveLength(0));
    process.emit("SIGTERM", "SIGTERM");
    await expect(running).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledWith("signal");
  });
});
