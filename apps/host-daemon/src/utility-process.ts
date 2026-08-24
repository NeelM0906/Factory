import { serve } from "@hono/node-server";

import {
  HostDrainedMessageSchema,
  HostParentLifecycleMessageSchema,
  normalizeSafeJson,
  type HostParentLifecycleMessage
} from "@autostack/contracts";
import {
  LocalRunnerProvider,
  type GuardianLauncher,
  type LocalRunnerProviderOptions
} from "@autostack/runner-local";

import {
  bindLocalRunnerProvider,
  HostDaemonStartupCleanupError,
  startHostDaemon,
  type HostDaemonRuntime,
  type HostRunnerComposition,
  type StartHostDaemonOptions
} from "./server.js";
import type { ValidatedGuardianRuntime } from "./guardian-launcher.js";

export interface HostParentPort {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  off(event: "close", listener: () => void): this;
  postMessage(message: unknown): void;
}

export interface ProductionGuardianLauncherFactory {
  create(runtime: ValidatedGuardianRuntime): Promise<GuardianLauncher>;
}

type LocalRunnerRuntimeOptions = Omit<LocalRunnerProviderOptions, "dataRoot" | "guardianLauncher">;

export const createProductionHostRunnerFactory =
  (dependencies: {
    readonly createGuardianLauncher: (
      runtime: ValidatedGuardianRuntime
    ) => Promise<GuardianLauncher>;
    readonly localRunnerOptions: LocalRunnerRuntimeOptions;
    readonly createProvider?: typeof LocalRunnerProvider.create;
    readonly bindProvider?: typeof bindLocalRunnerProvider;
  }): StartHostDaemonOptions["createRunner"] =>
  async ({ dataRoot, runtime }) => {
    const nativeLauncher = await dependencies.createGuardianLauncher(runtime);
    const guardedLauncher: GuardianLauncher = {
      async launch(bootstrap, observer) {
        await runtime.revalidate();
        return await nativeLauncher.launch(bootstrap, observer);
      }
    };
    const provider = await (dependencies.createProvider ?? LocalRunnerProvider.create)({
      ...dependencies.localRunnerOptions,
      dataRoot,
      guardianLauncher: guardedLauncher
    });
    return (dependencies.bindProvider ?? bindLocalRunnerProvider)(provider);
  };

export const listenOnLoopback: StartHostDaemonOptions["listen"] = async ({ app, hostname, port }) =>
  await new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port }, () =>
      resolve({
        address: () => server.address(),
        close: async () =>
          await new Promise<void>((closeResolve, closeReject) =>
            server.close((error) => (error === undefined ? closeResolve() : closeReject(error)))
          )
      })
    );
    server.once("error", reject);
  });

export interface ForkableHostUtilityProcessOptions {
  readonly parent: HostParentPort;
  readonly createRunner: StartHostDaemonOptions["createRunner"];
  readonly validateRuntime: NonNullable<StartHostDaemonOptions["validateRuntime"]>;
  readonly listen?: StartHostDaemonOptions["listen"];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  readonly log: StartHostDaemonOptions["log"];
  readonly requestId: () => string;
  readonly start?: typeof startHostDaemon;
  readonly signals?: boolean;
  readonly setExitCode?: (code: number) => void;
}

export const runForkableHostUtilityProcess = async (
  options: ForkableHostUtilityProcessOptions
): Promise<void> => {
  const abort = new AbortController();
  const setExitCode = options.setExitCode ?? ((code: number) => (process.exitCode = code));
  let bootstrapSeen = false;
  let bootstrapResolve!: (value: unknown) => void;
  let bootstrapReject!: (reason: unknown) => void;
  const bootstrap = new Promise<unknown>((resolve, reject) => {
    bootstrapResolve = resolve;
    bootstrapReject = reject;
  });
  let runtime: HostDaemonRuntime | undefined;
  let terminationReason: "parent" | "signal" | undefined;
  let drained = false;
  let finished = false;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending: HostParentLifecycleMessage[] = [];
  let lifecycle = Promise.resolve();

  const cleanup = (): void => {
    options.parent.off("message", onMessage);
    options.parent.off("close", onParentClose);
    if (options.signals !== false) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  };
  const complete = (): void => {
    if (finished) return;
    finished = true;
    cleanup();
    finish();
  };
  const fail = async (): Promise<void> => {
    setExitCode(1);
    abort.abort();
    try {
      await runtime?.shutdown("parent");
    } catch {
      // The nonzero exit result remains authoritative.
    }
    complete();
  };
  const requestTermination = (reason: "parent" | "signal"): void => {
    terminationReason ??= reason;
    abort.abort(new DOMException("Host startup terminated.", "AbortError"));
    if (!bootstrapSeen) bootstrapReject(abort.signal.reason);
    if (runtime !== undefined) {
      lifecycle = lifecycle
        .then(async () => {
          await runtime!.shutdown(reason);
          complete();
        })
        .catch(fail);
    }
  };
  const applyLifecycle = async (message: HostParentLifecycleMessage): Promise<void> => {
    if (runtime === undefined) {
      pending.push(message);
      return;
    }
    if (message.type === "quiesce") {
      await runtime.quiesce();
      return;
    }
    if (message.type === "interrupt-and-drain") {
      const result = await runtime.interruptAndDrain();
      options.parent.postMessage(
        HostDrainedMessageSchema.parse({ schemaVersion: 1, type: "drained", result })
      );
      drained = true;
      return;
    }
    if (!drained) throw new TypeError("Host close requires a completed drain.");
    await runtime.close();
    complete();
  };
  const enqueueLifecycle = (message: HostParentLifecycleMessage): void => {
    lifecycle = lifecycle.then(() => applyLifecycle(message)).catch(fail);
  };
  function onMessage(candidate: unknown): void {
    if (!bootstrapSeen) {
      bootstrapSeen = true;
      bootstrapResolve(candidate);
      return;
    }
    try {
      enqueueLifecycle(HostParentLifecycleMessageSchema.parse(normalizeSafeJson(candidate)));
    } catch (error) {
      bootstrapReject(error);
      void fail();
    }
  }
  function onParentClose(): void {
    requestTermination("parent");
  }
  function onSignal(): void {
    requestTermination("signal");
  }

  options.parent.on("message", onMessage);
  options.parent.on("close", onParentClose);
  if (options.signals !== false) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    runtime = await (options.start ?? startHostDaemon)({
      environment: options.environment,
      bootstrapReader: { readOnce: async () => await bootstrap },
      validateRuntime: options.validateRuntime,
      createRunner: options.createRunner,
      listen: options.listen ?? listenOnLoopback,
      readinessWriter: { writeOnce: (record) => options.parent.postMessage(record) },
      requestId: options.requestId,
      log: options.log,
      signal: abort.signal,
      pid: options.pid
    });
    if (terminationReason !== undefined) {
      await runtime.shutdown(terminationReason);
      complete();
    } else {
      for (const message of pending.splice(0)) enqueueLifecycle(message);
    }
  } catch (error) {
    if (
      terminationReason !== undefined &&
      !(error instanceof HostDaemonStartupCleanupError) &&
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      complete();
    } else {
      await fail();
    }
  }
  await completed;
};
