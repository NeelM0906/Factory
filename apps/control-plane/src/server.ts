import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { serve as honoServe } from "@hono/node-server";

import {
  ControlPlaneBootstrapSchema,
  createIdFactory,
  type AgentHarnessPort,
  type ControlPlaneBootstrap,
  type DeliveryIntegrationPort,
  type IdFactory,
  type IngressDelivery,
  type IntegrationIngressPort,
  type StoredDomainEvent,
  type WorkspaceId
} from "@autostack/contracts";
import type { RunnerProvider } from "@autostack/domain";
import { createSqliteIngressQueue, openDatabase, SqliteDurableStore } from "@autostack/db";
import type { IngressQueue } from "@autostack/db";
import {
  GitHubUnsupportedEventError,
  parseGitHubDelivery,
  verifyGitHubSignature
} from "@autostack/integration-github";
import {
  createStageRetryAt,
  HandlerRegistry,
  LocalWorkflowExecutor,
  registerPipelineStations,
  type RegisterPipelineStationsDependencies
} from "@autostack/workflow";

import { createApp } from "./app.js";
import { createChannelBindingStore, type ChannelBindingStore } from "./channel-binding-store.js";
import { CommandReconciler } from "./command-reconciler.js";
import {
  createControlPlaneDesktopDispatcher,
  type ControlPlaneDesktopDispatcher,
  type ControlPlaneDesktopDispatcherDependencies
} from "./desktop-dispatcher.js";
import { registerGitHubIngress } from "./ingress/github.js";
import { loadConfig, loadOrCreateLocalWorkspaceId, type ControlPlaneConfig } from "./config.js";
import { createHostDaemonClient } from "./host-daemon-client.js";
import { LocalArtifactService } from "./local-artifact-service.js";
import { LocalExecutionService } from "./local-execution-service.js";
import { EventBackedLocalExecutionState } from "./local-execution-state.js";
import { publishControlPlaneReadiness, type ReadinessWriter } from "./readiness.js";
import { CommandReconciliationSupervisor } from "./reconciliation-supervisor.js";
import { ControlPlaneShutdown } from "./shutdown.js";

export { createChannelBindingStore } from "./channel-binding-store.js";
export type { ChannelBindingStore } from "./channel-binding-store.js";
export { createControlPlaneDesktopDispatcher } from "./desktop-dispatcher.js";
export type {
  ControlPlaneDesktopDispatcher,
  ControlPlaneDesktopDispatcherDependencies
} from "./desktop-dispatcher.js";

type ServeImplementation = typeof honoServe;
type Server = ReturnType<ServeImplementation>;

export interface StartControlPlaneOptions {
  readonly config?: ControlPlaneConfig;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly serve?: ServeImplementation;
  readonly installSignalHandlers?: boolean;
  readonly log?: (line: string) => void;
  readonly openDatabase?: typeof openDatabase;
  readonly bootstrap?: ControlPlaneBootstrap;
  readonly hostFetch?: typeof globalThis.fetch;
  readonly readinessWriter?: ReadinessWriter;
  readonly repositoryPaths?: ControlPlaneDesktopDispatcherDependencies["repositoryPaths"];
  /**
   * When provided, registers the six pipeline station handlers on the internal `HandlerRegistry`
   * so that the `LocalWorkflowExecutor` can drive triage → plan → implement → verify → review →
   * publish. The caller (typically the desktop runtime) is responsible for constructing the
   * concrete `AgentHarnessPort`, `RunnerProvider`, and `DeliveryIntegrationPort`.
   */
  readonly pipelineStations?: RegisterPipelineStationsDependencies;
  /**
   * When provided, registers `POST /ingress/github` on the Hono app with HMAC-SHA256 signature
   * verification. The secret is the webhook secret configured on the GitHub App.
   */
  readonly githubIngress?: { readonly webhookSecret: string };
}

export interface ControlPlaneRuntime {
  readonly app: ReturnType<typeof createApp>;
  readonly executor: LocalWorkflowExecutor;
  readonly localExecution?: LocalExecutionService;
  readonly desktopDispatcher?: ControlPlaneDesktopDispatcher;
  readonly ingressQueue: import("@autostack/db").IngressQueue;
  readonly channelBindings: ChannelBindingStore;
  quiesce(): Promise<void>;
  drain(): Promise<void>;
  retireHostGeneration(): Promise<void>;
  close(): Promise<void>;
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error?: Error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });

const waitForListening = (server: Server): Promise<void> => {
  if (typeof server.once !== "function") return Promise.resolve();
  if (server.listening) return Promise.resolve();

  return new Promise((resolveListening, rejectListening) => {
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListening();
    };
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      rejectListening(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
};

const retryAt = createStageRetryAt({ random: Math.random });

const unconfiguredPort = (name: string): never => {
  throw new TypeError(
    `${name} is not yet configured. Connect an agent adapter, runner, or delivery integration first.`
  );
};

const UNCONFIGURED_HARNESS: AgentHarnessPort = {
  descriptor: {
    schemaVersion: 1,
    adapterId: "unconfigured",
    kind: "native",
    displayName: "Unconfigured",
    capabilities: { resume: false, steering: false, permissions: false, structuredPlans: false }
  },
  start: () => unconfiguredPort("AgentHarnessPort"),
  resume: () => unconfiguredPort("AgentHarnessPort"),
  steer: () => unconfiguredPort("AgentHarnessPort"),
  cancel: () => unconfiguredPort("AgentHarnessPort")
};

const UNCONFIGURED_RUNNER: RunnerProvider = {
  capabilities: () => unconfiguredPort("RunnerProvider"),
  inspectRepository: () => unconfiguredPort("RunnerProvider"),
  prepareEnvironment: () => unconfiguredPort("RunnerProvider"),
  listEnvironments: () => unconfiguredPort("RunnerProvider"),
  startCommand: () => unconfiguredPort("RunnerProvider"),
  readCommandEvents: async function* () { unconfiguredPort("RunnerProvider"); },
  cancelCommand: () => unconfiguredPort("RunnerProvider"),
  readArtifactChunk: () => unconfiguredPort("RunnerProvider"),
  disposeEnvironment: () => unconfiguredPort("RunnerProvider")
};

const UNCONFIGURED_DELIVERY: DeliveryIntegrationPort = {
  createDraftPullRequest: () => unconfiguredPort("DeliveryIntegrationPort"),
  postSlackProgress: () => unconfiguredPort("DeliveryIntegrationPort")
};

function createIngressAdapter(
  queue: IngressQueue,
  now: () => string
): IntegrationIngressPort {
  const seen = new Set<string>();
  return {
    accept: async (delivery: IngressDelivery): Promise<{ readonly replayed: boolean }> => {
      if (seen.has(delivery.deduplicationKey)) return { replayed: true };
      seen.add(delivery.deduplicationKey);
      await queue.enqueue({
        envelopeId: delivery.deduplicationKey,
        payload: delivery,
        enqueuedAt: now()
      });
      return { replayed: false };
    }
  };
}

function buildDefaultPipelineStations(
  store: SqliteDurableStore,
  ids: IdFactory,
  workspaceId: WorkspaceId,
  now: () => string
): RegisterPipelineStationsDependencies {
  return {
    dependencies: {
      now,
      random: () => Math.random(),
      ids,
      harness: UNCONFIGURED_HARNESS,
      runner: UNCONFIGURED_RUNNER,
      delivery: UNCONFIGURED_DELIVERY,
      readRunEvents: async (runId): Promise<readonly StoredDomainEvent[]> =>
        store.readRunEvents({ workspaceId, runId }),
      workspaceId,
      actor: { kind: "system", id: "workflow" }
    },
    configuration: {
      inspection: { sourcePath: "/tmp/autostack-unconfigured", baseRef: "main" },
      cwdRoot: ".",
      resourceLimits: { cpu: 2, memoryMb: 4_096, durationSeconds: 1_800 },
      allowedPermissionKinds: [],
      allowedCredentialRefIds: [],
      eligibleApproverIds: ["local-user"]
    }
  };
}

export async function startControlPlane(
  options: StartControlPlaneOptions = {}
): Promise<ControlPlaneRuntime> {
  const bootstrap =
    options.bootstrap === undefined
      ? undefined
      : ControlPlaneBootstrapSchema.parse(options.bootstrap);
  const config =
    bootstrap === undefined ? (options.config ?? loadConfig(options.environment)) : undefined;
  const effectiveConfig =
    bootstrap === undefined
      ? config!
      : {
          dataDirectory: bootstrap.dataDirectory,
          token: "",
          host: "127.0.0.1",
          port: 0
        };
  const log = options.log ?? ((line: string) => console.log(line));
  const database = (options.openDatabase ?? openDatabase)({
    filePath: join(effectiveConfig.dataDirectory, "autostack.sqlite")
  });
  const ids = createIdFactory();
  const now = () => new Date().toISOString();
  let executor: LocalWorkflowExecutor | undefined;
  let server: Server | undefined;
  let removeSignalHandlers = (): void => undefined;
  let storeClosed = false;
  try {
    const workspaceRows = database.connection
      .prepare("SELECT DISTINCT workspace_id AS workspaceId FROM events LIMIT 2")
      .all() as Array<{ workspaceId: unknown }>;
    const workspaceId = loadOrCreateLocalWorkspaceId(
      effectiveConfig.dataDirectory,
      ids.workspace,
      now,
      workspaceRows.map(({ workspaceId: existing }) => existing)
    );
    const store = new SqliteDurableStore(database, {
      eventId: ids.event,
      leaseToken: randomUUID,
      now,
      sensitiveValues: bootstrap === undefined ? [effectiveConfig.token] : [bootstrap.hostToken]
    });
    const sensitiveValues =
      bootstrap === undefined ? [effectiveConfig.token] : [bootstrap.hostToken];
    const registry = new HandlerRegistry({ sensitiveValues });
    const stationConfig =
      options.pipelineStations ??
      (bootstrap === undefined
        ? undefined
        : buildDefaultPipelineStations(store, ids, workspaceId, now));
    if (stationConfig !== undefined) {
      registerPipelineStations(registry, stationConfig);
    }
    const ingressQueue = createSqliteIngressQueue(database.connection);
    const channelBindings = createChannelBindingStore();
    const runtimeExecutor = new LocalWorkflowExecutor({
      store,
      registry,
      workerId: `local-control-plane-${process.pid}`,
      now,
      leaseDurationMs: 30_000,
      pollIntervalMs: 1_000,
      sensitiveValues,
      retryAt,
      reportError: (error, job) => {
        log(
          JSON.stringify({
            level: "error",
            event: "workflow_error",
            error,
            ...(job === undefined ? {} : { jobId: job.jobId })
          })
        );
      }
    });
    executor = runtimeExecutor;
    let ingressOpen = true;
    const state = new EventBackedLocalExecutionState({ store, workspaceId, now });
    const hostClient =
      bootstrap === undefined
        ? undefined
        : createHostDaemonClient({
            origin: bootstrap.hostOrigin,
            token: bootstrap.hostToken,
            fetch: options.hostFetch ?? globalThis.fetch
          });
    const artifacts = hostClient === undefined ? undefined : new LocalArtifactService(hostClient);
    const reconciler =
      hostClient === undefined || artifacts === undefined
        ? undefined
        : new CommandReconciler({ host: hostClient, artifacts, evidence: state });
    const reconciliation =
      hostClient === undefined || reconciler === undefined
        ? undefined
        : new CommandReconciliationSupervisor({
            recovery: state,
            host: hostClient,
            reconciler
          });
    let closeLifecycle = async (): Promise<void> => {
      throw new TypeError("Control-plane lifecycle is not ready.");
    };
    const localExecution =
      hostClient === undefined
        ? undefined
        : new LocalExecutionService({
            host: hostClient,
            state,
            ...(reconciliation === undefined ? {} : { reconciler: reconciliation }),
            retirement: {
              closeIngress: async () => void (ingressOpen = false),
              stopReconciliation: async () => reconciliation?.stop(),
              closePersistence: () => closeLifecycle()
            }
          });
    const app = createApp({
      store,
      executor: runtimeExecutor,
      ...(bootstrap === undefined
        ? { token: effectiveConfig.token }
        : { tokenDigest: bootstrap.apiTokenDigest }),
      workspaceId,
      now,
      ids: { job: ids.job },
      mode: localExecution === undefined ? "hosted" : "local",
      ...(localExecution === undefined ? {} : { localExecution }),
      ingress: { isOpen: () => ingressOpen }
    });
    if (options.githubIngress !== undefined) {
      const webhookSecret = options.githubIngress.webhookSecret;
      const ingressPort = createIngressAdapter(ingressQueue, now);
      registerGitHubIngress(app, {
        ingress: ingressPort,
        verifySignature: (input) =>
          verifyGitHubSignature({ ...input, secret: webhookSecret }),
        parseDelivery: parseGitHubDelivery,
        isUnsupportedEvent: (error) => error instanceof GitHubUnsupportedEventError,
        now,
        isOpen: () => ingressOpen
      });
      log(JSON.stringify({ level: "info", event: "github_ingress_registered" }));
    }

    const desktopDispatcher =
      localExecution === undefined || options.repositoryPaths === undefined
        ? undefined
        : createControlPlaneDesktopDispatcher({
            ids,
            repositoryPaths: options.repositoryPaths,
            authority: state,
            local: localExecution
          });

    await reconciliation?.recover();

    server = (options.serve ?? honoServe)({
      fetch: app.fetch,
      hostname: effectiveConfig.host,
      port: effectiveConfig.port
    });
    const listeningServer = server;
    await waitForListening(listeningServer);
    if (options.readinessWriter !== undefined) {
      publishControlPlaneReadiness(options.readinessWriter, listeningServer.address());
    }
    runtimeExecutor.start();

    const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const signalHandler = (): void => {
      void close().catch((error: unknown) => {
        log(
          JSON.stringify({
            level: "error",
            event: "shutdown_failed",
            message: error instanceof Error ? error.message : "Unknown shutdown error."
          })
        );
        process.exitCode = 1;
      });
    };

    const shutdown = new ControlPlaneShutdown({
      quiesceIngress: async () => {
        for (const signal of signals) process.removeListener(signal, signalHandler);
        ingressOpen = false;
      },
      drainReconciliation: async () => reconciliation?.drain(),
      closeListener: () => closeServer(listeningServer),
      closeExecutor: () => runtimeExecutor.stop(),
      closePersistence: async () => {
        if (!storeClosed) {
          await store.close();
          storeClosed = true;
        }
      }
    });
    const close = (): Promise<void> => shutdown.close();
    closeLifecycle = close;

    if (options.installSignalHandlers ?? true) {
      for (const signal of signals) process.once(signal, signalHandler);
      removeSignalHandlers = () => {
        for (const signal of signals) process.removeListener(signal, signalHandler);
      };
    }

    log(
      JSON.stringify({
        level: "info",
        event: "control_plane_started",
        host: effectiveConfig.host,
        port: effectiveConfig.port
      })
    );

    return {
      app,
      executor: runtimeExecutor,
      ingressQueue,
      channelBindings,
      ...(localExecution === undefined ? {} : { localExecution }),
      ...(desktopDispatcher === undefined ? {} : { desktopDispatcher }),
      quiesce: () => shutdown.quiesce(),
      drain: () => shutdown.drain(),
      retireHostGeneration: () =>
        localExecution === undefined ? Promise.resolve() : localExecution.retireHostGeneration(),
      close
    };
  } catch (error) {
    removeSignalHandlers();
    try {
      if (server !== undefined) await closeServer(server);
    } catch {
      // The original startup error remains authoritative.
    }
    try {
      await executor?.stop();
    } catch {
      // The original startup error remains authoritative.
    }
    try {
      database.close();
    } catch {
      // The original startup error remains authoritative.
    }
    throw error;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function readKeychainPassword(service: string, account: string): string | undefined {
  try {
    const result = execSync(
      `security find-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return result.trim();
  } catch {
    return undefined;
  }
}

if (isEntrypoint) {
  const webhookSecret = readKeychainPassword("com.autostack.github-app", "webhook-secret");
  void startControlPlane({
    ...(webhookSecret !== undefined ? { githubIngress: { webhookSecret } } : {})
  }).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "control_plane_start_failed",
        message: error instanceof Error ? error.message : "Unknown startup error."
      })
    );
    process.exitCode = 1;
  });
}
