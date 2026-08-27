import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  ControlPlaneDrainedMessageSchema,
  ControlPlaneReadinessRecordSchema,
  HostDrainedMessageSchema,
  HostReadinessRecordSchema,
  RepositoryCapabilityIdSchema,
  type RepositoryCapabilityId
} from "@autostack/contracts";
import { utilityProcess, type UtilityProcess } from "electron";

import { createChildLogForwarder } from "./child-log.js";
import type { RuntimeChild, RuntimeSupervisorOptions } from "./runtime-supervisor.js";

type Service = Parameters<RuntimeSupervisorOptions["launch"]>[0];

interface RetiredGeneration {
  readonly schemaVersion: 1;
  readonly type: "generation.retired";
  readonly incomplete: boolean;
}

interface QuiesceAcknowledgement {
  readonly schemaVersion: 1;
  readonly type: "lifecycle.ack";
  readonly phase: "quiesce";
}

interface PendingLifecycle {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface DesktopResponse {
  readonly schemaVersion: 1;
  readonly type: "desktop.response";
  readonly requestId: string;
  readonly ok: boolean;
  readonly response?: unknown;
}

interface RepositoryResolveRequest {
  readonly schemaVersion: 1;
  readonly type: "repository.resolve";
  readonly requestId: string;
  readonly repositoryCapabilityId: RepositoryCapabilityId;
}

interface TerminalEvidenceAuthorizeRequest {
  readonly schemaVersion: 1;
  readonly type: "terminal-evidence.authorize";
  readonly requestId: string;
  readonly request: unknown;
}

interface TerminalEvidenceAuthorizedResponse {
  readonly schemaVersion: 1;
  readonly type: "terminal-evidence.authorized";
  readonly requestId: string;
  readonly ok: boolean;
}

export interface ElectronUtilityLauncherOptions {
  readonly utilityRoot?: string;
  /** Where a utility child's bounded, redacted output goes. Injected so tests can read it. */
  readonly writeChildLog?: (line: string) => void;
  readonly resolveRepository: (id: RepositoryCapabilityId) => string | Promise<string>;
  readonly authorizeTerminalEvidence: (request: unknown) => Promise<void>;
}

const isRetiredGeneration = (candidate: unknown): candidate is RetiredGeneration =>
  candidate !== null &&
  typeof candidate === "object" &&
  (candidate as RetiredGeneration).schemaVersion === 1 &&
  (candidate as RetiredGeneration).type === "generation.retired" &&
  typeof (candidate as RetiredGeneration).incomplete === "boolean";

const isQuiesceAcknowledgement = (candidate: unknown): candidate is QuiesceAcknowledgement =>
  candidate !== null &&
  typeof candidate === "object" &&
  (candidate as QuiesceAcknowledgement).schemaVersion === 1 &&
  (candidate as QuiesceAcknowledgement).type === "lifecycle.ack" &&
  (candidate as QuiesceAcknowledgement).phase === "quiesce";

class ElectronRuntimeChild implements RuntimeChild {
  readonly #service: Service;
  readonly #child: UtilityProcess;
  readonly #ready: Promise<Awaited<ReturnType<RuntimeChild["waitReady"]>>>;
  readonly #readyResolve: (value: Awaited<ReturnType<RuntimeChild["waitReady"]>>) => void;
  readonly #readyReject: (reason: unknown) => void;
  #quiescePending: PendingLifecycle | undefined;
  #drainPending: PendingLifecycle | undefined;
  #retirePending: PendingLifecycle | undefined;
  readonly #desktopRequests = new Map<
    string,
    { readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void }
  >();
  readonly #evidenceRequests = new Map<
    string,
    { readonly resolve: () => void; readonly reject: (reason: unknown) => void }
  >();
  readonly #resolveRepository: ElectronUtilityLauncherOptions["resolveRepository"];
  readonly #authorizeTerminalEvidence: ElectronUtilityLauncherOptions["authorizeTerminalEvidence"];
  #exited = false;

  constructor(
    service: Service,
    child: UtilityProcess,
    resolveRepository: ElectronUtilityLauncherOptions["resolveRepository"],
    authorizeTerminalEvidence: ElectronUtilityLauncherOptions["authorizeTerminalEvidence"]
  ) {
    this.#service = service;
    this.#child = child;
    this.#resolveRepository = resolveRepository;
    this.#authorizeTerminalEvidence = authorizeTerminalEvidence;
    let readyResolve!: (value: Awaited<ReturnType<RuntimeChild["waitReady"]>>) => void;
    let readyReject!: (reason: unknown) => void;
    this.#ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    this.#readyResolve = readyResolve;
    this.#readyReject = readyReject;
    child.on("message", (candidate) => this.#receive(candidate));
    child.once("exit", () => {
      this.#exited = true;
      this.#readyReject(new Error("utility process exited before readiness"));
      const exitError = new Error("utility process exited before lifecycle acknowledgement");
      this.#quiescePending?.reject(exitError);
      this.#drainPending?.reject(exitError);
      this.#retirePending?.reject(exitError);
      this.#quiescePending = undefined;
      this.#drainPending = undefined;
      this.#retirePending = undefined;
      for (const pending of this.#desktopRequests.values()) {
        pending.reject(new Error("Desktop runtime unavailable."));
      }
      this.#desktopRequests.clear();
      for (const pending of this.#evidenceRequests.values()) {
        pending.reject(new Error("Host terminal evidence authority unavailable."));
      }
      this.#evidenceRequests.clear();
    });
  }

  get pid(): number {
    if (this.#child.pid === undefined) throw new TypeError("utility process has no pid");
    return this.#child.pid;
  }

  #receive(candidate: unknown): void {
    if (isQuiesceAcknowledgement(candidate)) {
      this.#quiescePending?.resolve(candidate);
      this.#quiescePending = undefined;
      return;
    }
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as TerminalEvidenceAuthorizedResponse).schemaVersion === 1 &&
      (candidate as TerminalEvidenceAuthorizedResponse).type === "terminal-evidence.authorized"
    ) {
      const response = candidate as TerminalEvidenceAuthorizedResponse;
      const pending = this.#evidenceRequests.get(response.requestId);
      if (pending === undefined) return;
      this.#evidenceRequests.delete(response.requestId);
      if (response.ok) pending.resolve();
      else pending.reject(new Error("Host terminal evidence authorization failed."));
      return;
    }
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as TerminalEvidenceAuthorizeRequest).schemaVersion === 1 &&
      (candidate as TerminalEvidenceAuthorizeRequest).type === "terminal-evidence.authorize"
    ) {
      void this.#forwardTerminalEvidence(candidate as TerminalEvidenceAuthorizeRequest);
      return;
    }
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as DesktopResponse).schemaVersion === 1 &&
      (candidate as DesktopResponse).type === "desktop.response"
    ) {
      const response = candidate as DesktopResponse;
      const pending = this.#desktopRequests.get(response.requestId);
      if (pending === undefined) return;
      this.#desktopRequests.delete(response.requestId);
      if (response.ok) pending.resolve(response.response);
      else pending.reject(new Error("Desktop local operation failed."));
      return;
    }
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as RepositoryResolveRequest).schemaVersion === 1 &&
      (candidate as RepositoryResolveRequest).type === "repository.resolve"
    ) {
      void this.#resolveRepositoryRequest(candidate as RepositoryResolveRequest);
      return;
    }
    const readiness =
      this.#service === "host"
        ? HostReadinessRecordSchema.safeParse(candidate)
        : ControlPlaneReadinessRecordSchema.safeParse(candidate);
    if (readiness.success) {
      this.#readyResolve(readiness.data);
      return;
    }
    const drained =
      this.#service === "host"
        ? HostDrainedMessageSchema.safeParse(candidate)
        : ControlPlaneDrainedMessageSchema.safeParse(candidate);
    if (drained.success) {
      this.#drainPending?.resolve(drained.data);
      this.#drainPending = undefined;
      return;
    }
    if (isRetiredGeneration(candidate)) {
      this.#retirePending?.resolve(candidate);
      this.#retirePending = undefined;
    }
  }

  async #resolveRepositoryRequest(request: RepositoryResolveRequest): Promise<void> {
    try {
      const id = RepositoryCapabilityIdSchema.parse(request.repositoryCapabilityId);
      const path = await this.#resolveRepository(id);
      this.#child.postMessage({
        schemaVersion: 1,
        type: "repository.resolved",
        requestId: request.requestId,
        ok: true,
        path
      });
    } catch {
      this.#child.postMessage({
        schemaVersion: 1,
        type: "repository.resolved",
        requestId: request.requestId,
        ok: false
      });
    }
  }

  async #forwardTerminalEvidence(request: TerminalEvidenceAuthorizeRequest): Promise<void> {
    try {
      await this.#authorizeTerminalEvidence(request.request);
      this.#child.postMessage({
        schemaVersion: 1,
        type: "terminal-evidence.authorized",
        requestId: request.requestId,
        ok: true
      });
    } catch {
      this.#child.postMessage({
        schemaVersion: 1,
        type: "terminal-evidence.authorized",
        requestId: request.requestId,
        ok: false
      });
    }
  }

  postMessage(message: unknown): void {
    this.#child.postMessage(message);
  }

  async waitReady(): Promise<Awaited<ReturnType<RuntimeChild["waitReady"]>>> {
    return await this.#ready;
  }

  async requestDesktop(request: unknown): Promise<unknown> {
    if (this.#service !== "control-plane" || this.#exited) {
      throw new Error("Desktop local-operation dispatcher unavailable.");
    }
    const requestId = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      this.#desktopRequests.set(requestId, { resolve, reject });
    });
    this.#child.postMessage({
      schemaVersion: 1,
      type: "desktop.request",
      requestId,
      request
    });
    return await response;
  }

  async authorizeTerminalEvidence(request: unknown): Promise<void> {
    if (this.#service !== "host" || this.#exited) {
      throw new Error("Host terminal evidence authority unavailable.");
    }
    const requestId = randomUUID();
    const result = new Promise<void>((resolve, reject) => {
      this.#evidenceRequests.set(requestId, { resolve, reject });
    });
    this.#child.postMessage({
      schemaVersion: 1,
      type: "terminal-evidence.authorize",
      requestId,
      request
    });
    await result;
  }

  async sendLifecycle(type: Parameters<RuntimeChild["sendLifecycle"]>[0]): Promise<unknown> {
    if (this.#exited) throw new Error("utility process is unavailable");
    if (type === "quiesce") {
      if (this.#service !== "control-plane") {
        throw new TypeError("only the control plane can quiesce desktop ingress");
      }
      const result = new Promise<unknown>((resolve, reject) => {
        this.#quiescePending = { resolve, reject };
      });
      this.#child.postMessage({ schemaVersion: 1, type });
      return await result;
    }
    if (type === "interrupt-and-drain") {
      const result = new Promise<unknown>((resolve, reject) => {
        this.#drainPending = { resolve, reject };
      });
      this.#child.postMessage({ schemaVersion: 1, type });
      return await result;
    }
    if (type === "retire-generation") {
      if (this.#service !== "control-plane") {
        throw new TypeError("only the control plane can retire a generation");
      }
      const result = new Promise<unknown>((resolve, reject) => {
        this.#retirePending = { resolve, reject };
      });
      this.#child.postMessage({ schemaVersion: 1, type });
      return await result;
    }
    this.#child.postMessage({ schemaVersion: 1, type });
    return undefined;
  }

  async close(): Promise<void> {
    if (this.#exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill();
        resolve();
      }, 2_000);
      timer.unref();
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onExit(listener: () => void): () => void {
    this.#child.on("exit", listener);
    return () => this.#child.off("exit", listener);
  }
}

export const createElectronUtilityLauncher =
  (options: ElectronUtilityLauncherOptions): RuntimeSupervisorOptions["launch"] =>
  async (service, environment) => {
    const utilityRoot = options.utilityRoot ?? join(import.meta.dirname, "../utility");
    const modulePath = join(utilityRoot, service === "host" ? "host.js" : "control-plane.js");
    // `stdio: "ignore"` discarded the only account a utility child can give of itself. The host
    // daemon reports a startup failure as an exit code and nothing else, so with the streams thrown
    // away a git-executable rejection -- or any other fail-closed startup -- reached the e2e pipe
    // and nowhere else, leaving the shipped application undiagnosable. Piping obliges us to drain:
    // the forwarder below reads both streams, redacts every line, and holds them to a fixed budget,
    // which is the plan's "child logs are redacted and bounded".
    const child = utilityProcess.fork(modulePath, [], {
      env: environment,
      serviceName: service === "host" ? "AutoStack Host Daemon" : "AutoStack Control Plane",
      stdio: "pipe"
    });
    const forwarder = createChildLogForwarder({
      service,
      write: options.writeChildLog ?? ((line) => console.error(line))
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => forwarder.push(chunk));
    }
    child.once("exit", () => forwarder.flush());
    return new ElectronRuntimeChild(
      service,
      child,
      options.resolveRepository,
      options.authorizeTerminalEvidence
    );
  };
