import type { AddressInfo } from "node:net";

import type { Hono } from "hono";

import type {
  PrepareEnvironmentRequest,
  PreparedEnvironment,
  ReadCommandEventsRequest,
  RunnerDrainResult
} from "@autostack/contracts";
import type { LocalRunnerLifecycle, RunnerProvider } from "@autostack/domain";
import { localRunnerHostControl, type LocalRunnerProvider } from "@autostack/runner-local";

import { createHostApp, createHostBearerAuthenticator, type HostStructuredLogger } from "./app.js";
import {
  readHostBootstrapOnce,
  rejectHostEnvironmentOverrides,
  type BootstrapReader,
  type HostDaemonBootstrap
} from "./config.js";
import { validateGuardianRuntime, type ValidatedGuardianRuntime } from "./guardian-launcher.js";
import { createReadinessPublisher, type BoundAddress, type ReadinessWriter } from "./readiness.js";
import {
  createHostIngressState,
  createShutdownController,
  type HostRuntimeState
} from "./shutdown.js";

export interface HostRunnerComposition {
  readonly runner: RunnerProvider;
  readonly lifecycle: LocalRunnerLifecycle;
  readonly prepareWithReplay: (
    request: PrepareEnvironmentRequest
  ) => Promise<{ readonly environment: PreparedEnvironment; readonly replayed: boolean }>;
  readonly terminalizeProtocolFailure: (request: ReadCommandEventsRequest) => Promise<void>;
}

export const bindLocalRunnerProvider = (provider: LocalRunnerProvider): HostRunnerComposition => {
  const control = localRunnerHostControl(provider);
  return {
    runner: provider,
    lifecycle: provider,
    prepareWithReplay: (request) => control.prepareEnvironmentWithReplay(request),
    terminalizeProtocolFailure: async (request) => {
      await control.terminalizeProtocolFailure(request, "output_quarantined");
    }
  };
};

export interface HostListener {
  address(): AddressInfo | string | null;
  close(): Promise<void> | void;
}

export interface StartHostDaemonOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly bootstrapReader: BootstrapReader;
  readonly validateRuntime?: (
    descriptor: HostDaemonBootstrap["guardian"]
  ) => Promise<ValidatedGuardianRuntime>;
  readonly createRunner: (input: {
    readonly dataRoot: string;
    readonly runtime: ValidatedGuardianRuntime;
  }) => Promise<HostRunnerComposition>;
  readonly listen: (input: {
    readonly app: Hono;
    readonly hostname: "127.0.0.1";
    readonly port: 0;
  }) => Promise<HostListener>;
  readonly readinessWriter: ReadinessWriter;
  readonly requestId: () => string;
  readonly log: HostStructuredLogger;
  readonly signal: AbortSignal;
  readonly pid: number;
}

export interface HostDaemonRuntime {
  readonly app: Hono;
  readonly origin: `http://127.0.0.1:${number}`;
  state(): HostRuntimeState;
  quiesce(): Promise<void>;
  interruptAndDrain(): Promise<RunnerDrainResult>;
  close(): Promise<void>;
  shutdown(reason: "parent" | "signal" | "test"): Promise<void>;
}

export class HostDaemonStartupCleanupError extends Error {
  constructor() {
    super("Host startup cleanup was incomplete.");
    this.name = "HostDaemonStartupCleanupError";
  }
}

const parseAddress = (address: AddressInfo | string | null): BoundAddress => {
  if (address === null || typeof address === "string") {
    throw new TypeError("Host listener did not bind a numeric loopback address.");
  }
  return { address: address.address, family: address.family, port: address.port };
};

export const startHostDaemon = async (
  options: StartHostDaemonOptions
): Promise<HostDaemonRuntime> => {
  const assertStartupActive = (): void => options.signal.throwIfAborted();
  rejectHostEnvironmentOverrides(options.environment);
  const bootstrap = await readHostBootstrapOnce(options.bootstrapReader, options.signal);
  assertStartupActive();
  let composition: HostRunnerComposition | undefined;
  let listener: HostListener | undefined;
  try {
    const runtime = await (options.validateRuntime ?? validateGuardianRuntime)(bootstrap.guardian);
    assertStartupActive();
    composition = await options.createRunner({ dataRoot: bootstrap.dataRoot, runtime });
    assertStartupActive();
    const ingress = createHostIngressState();
    const shutdown = createShutdownController({ lifecycle: composition.lifecycle, ingress });
    const app = createHostApp({
      runner: composition.runner,
      ingress,
      auth: createHostBearerAuthenticator(bootstrap.hostToken),
      prepareWithReplay: composition.prepareWithReplay,
      terminalizeProtocolFailure: composition.terminalizeProtocolFailure,
      requestId: options.requestId,
      log: options.log,
      isSensitive: (value) => value.includes(bootstrap.hostToken)
    });
    listener = await options.listen({ app, hostname: bootstrap.host, port: bootstrap.port });
    assertStartupActive();
    const address = parseAddress(listener.address());
    const record = await createReadinessPublisher(options.readinessWriter).publish(
      address,
      options.pid
    );
    let shutdownPromise: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closePromise ??= (async () => {
        ingress.closing();
        await listener!.close();
        await shutdown.close();
      })());
    return {
      app,
      origin: record.origin as `http://127.0.0.1:${number}`,
      state: ingress.state,
      quiesce: shutdown.quiesce,
      interruptAndDrain: shutdown.interruptAndDrain,
      close,
      shutdown: () =>
        (shutdownPromise ??= (async () => {
          await shutdown.quiesce();
          await shutdown.interruptAndDrain();
          await close();
        })())
    };
  } catch (error) {
    let cleanupIncomplete = false;
    try {
      await listener?.close();
    } catch {
      cleanupIncomplete = true;
    }
    try {
      await composition?.lifecycle.close();
    } catch {
      cleanupIncomplete = true;
    }
    if (cleanupIncomplete) throw new HostDaemonStartupCleanupError();
    throw error;
  }
};
