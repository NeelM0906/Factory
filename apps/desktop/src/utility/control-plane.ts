import { ControlPlaneBootstrapSchema, normalizeSafeJson } from "@autostack/contracts";

import { startControlPlane, type ControlPlaneRuntime } from "../../../control-plane/src/server.js";
import { applyControlPlaneLifecycle } from "./control-plane-lifecycle.js";
import { createTerminalEvidenceAuthorizingFetch } from "./terminal-evidence-fetch.js";

const parentPort = process.parentPort;
if (parentPort === undefined || parentPort === null) {
  throw new TypeError("control-plane utility parent port is unavailable");
}

interface DesktopRequestMessage {
  readonly schemaVersion: 1;
  readonly type: "desktop.request";
  readonly requestId: string;
  readonly request: unknown;
}

interface RepositoryResolvedMessage {
  readonly schemaVersion: 1;
  readonly type: "repository.resolved";
  readonly requestId: string;
  readonly ok: boolean;
  readonly path?: string;
}

interface TerminalEvidenceAuthorizedMessage {
  readonly schemaVersion: 1;
  readonly type: "terminal-evidence.authorized";
  readonly requestId: string;
  readonly ok: boolean;
}

let runtime: ControlPlaneRuntime | undefined;
let bootstrapped = false;
let lifecycle = Promise.resolve();
const keepAlive = setInterval(() => undefined, 60_000);
const lifecycleState = { drained: false };
const repositoryRequests = new Map<
  string,
  { readonly resolve: (path: string) => void; readonly reject: (reason: unknown) => void }
>();
const evidenceRequests = new Map<
  string,
  { readonly resolve: () => void; readonly reject: (reason: unknown) => void }
>();

const isMessage = <T extends { readonly type: string }>(
  candidate: unknown,
  type: T["type"]
): candidate is T =>
  candidate !== null &&
  typeof candidate === "object" &&
  (candidate as { schemaVersion?: unknown }).schemaVersion === 1 &&
  (candidate as { type?: unknown }).type === type;

const failClosed = (): void => {
  process.exitCode = 1;
  void (runtime?.close() ?? Promise.resolve()).finally(() => {
    clearInterval(keepAlive);
    process.exit();
  });
};

const bootstrap = async (candidate: unknown): Promise<void> => {
  if (bootstrapped) throw new TypeError("duplicate control-plane bootstrap");
  bootstrapped = true;
  const input = ControlPlaneBootstrapSchema.parse(normalizeSafeJson(candidate));
  runtime = await startControlPlane({
    bootstrap: input,
    installSignalHandlers: false,
    readinessWriter: parentPort,
    log: () => undefined,
    hostFetch: createTerminalEvidenceAuthorizingFetch({
      hostOrigin: input.hostOrigin,
      authorize: async (request) =>
        await new Promise<void>((resolve, reject) => {
          const requestId = crypto.randomUUID();
          evidenceRequests.set(requestId, { resolve, reject });
          parentPort.postMessage({
            schemaVersion: 1,
            type: "terminal-evidence.authorize",
            requestId,
            request
          });
        })
    }),
    repositoryPaths: {
      resolve: async (repositoryCapabilityId) =>
        await new Promise<string>((resolve, reject) => {
          const requestId = crypto.randomUUID();
          repositoryRequests.set(requestId, { resolve, reject });
          parentPort.postMessage({
            schemaVersion: 1,
            type: "repository.resolve",
            requestId,
            repositoryCapabilityId
          });
        })
    }
  });
};

const applyDesktopRequest = async (message: DesktopRequestMessage): Promise<void> => {
  try {
    if (runtime?.desktopDispatcher === undefined) {
      throw new TypeError("desktop dispatcher is unavailable");
    }
    const response = await runtime.desktopDispatcher.dispatch(message.request as never);
    parentPort.postMessage({
      schemaVersion: 1,
      type: "desktop.response",
      requestId: message.requestId,
      ok: true,
      response
    });
  } catch {
    parentPort.postMessage({
      schemaVersion: 1,
      type: "desktop.response",
      requestId: message.requestId,
      ok: false
    });
  }
};

const applyRepositoryResponse = (message: RepositoryResolvedMessage): void => {
  const pending = repositoryRequests.get(message.requestId);
  if (pending === undefined) return;
  repositoryRequests.delete(message.requestId);
  if (message.ok && typeof message.path === "string") pending.resolve(message.path);
  else pending.reject(new TypeError("repository capability is unavailable"));
};

const applyEvidenceResponse = (message: TerminalEvidenceAuthorizedMessage): void => {
  const pending = evidenceRequests.get(message.requestId);
  if (pending === undefined) return;
  evidenceRequests.delete(message.requestId);
  if (message.ok) pending.resolve();
  else pending.reject(new TypeError("terminal evidence authorization failed"));
};

const applyLifecycle = async (candidate: unknown): Promise<void> => {
  if (runtime === undefined) throw new TypeError("control plane is not ready");
  const result = await applyControlPlaneLifecycle(runtime, parentPort, lifecycleState, candidate);
  if (result === "exit") {
    clearInterval(keepAlive);
    process.exit(0);
  }
};

parentPort.on("message", (event) => {
  if (!bootstrapped) {
    void bootstrap(event.data).catch(failClosed);
    return;
  }
  if (isMessage<RepositoryResolvedMessage>(event.data, "repository.resolved")) {
    applyRepositoryResponse(event.data);
    return;
  }
  if (isMessage<TerminalEvidenceAuthorizedMessage>(event.data, "terminal-evidence.authorized")) {
    applyEvidenceResponse(event.data);
    return;
  }
  if (isMessage<DesktopRequestMessage>(event.data, "desktop.request")) {
    lifecycle = lifecycle
      .then(() => applyDesktopRequest(event.data as DesktopRequestMessage))
      .catch(() => failClosed());
    return;
  }
  lifecycle = lifecycle.then(() => applyLifecycle(event.data)).catch(() => failClosed());
});
