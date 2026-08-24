import {
  PrepareEnvironmentRequestSchema,
  type HostResponseBodyByRoute,
  type PrepareEnvironmentRequest,
  type ReadCommandEventsRequest,
  type StartCommandRequest
} from "@autostack/contracts";

interface RecoveryState {
  listPendingPreparations?(): Promise<readonly PrepareEnvironmentRequest[]>;
  listPendingCommandStarts(): Promise<readonly StartCommandRequest[]>;
  resolveReconciliationEvents(
    environmentId: StartCommandRequest["environmentId"],
    commandId: StartCommandRequest["commandId"]
  ): Promise<ReadCommandEventsRequest>;
  recordPrepared?(
    request: PrepareEnvironmentRequest,
    result: HostResponseBodyByRoute["POST /v1/environments"]
  ): Promise<void>;
}

interface RecoveryHost {
  prepareEnvironment?(
    request: PrepareEnvironmentRequest
  ): Promise<HostResponseBodyByRoute["POST /v1/environments"]>;
  startCommand(request: StartCommandRequest): Promise<unknown>;
}

interface BoundedReconciler {
  reconcile(request: ReadCommandEventsRequest): Promise<"completed" | "pending">;
}

export interface CommandReconciliationSupervisorDependencies {
  readonly recovery: RecoveryState;
  readonly host: RecoveryHost;
  readonly reconciler: BoundedReconciler;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maximumFailures?: number;
}

export class CommandReconciliationSupervisor {
  readonly #dependencies: CommandReconciliationSupervisorDependencies;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #maximumFailures: number;
  readonly #active = new Map<
    string,
    { readonly canonicalRequest: string; readonly operation: Promise<void> }
  >();
  readonly #failed = new Set<string>();
  #quiesced = false;
  #stopping = false;
  #recovery: Promise<void> | undefined;
  #drain: Promise<void> | undefined;
  #stop: Promise<void> | undefined;

  constructor(dependencies: CommandReconciliationSupervisorDependencies) {
    this.#dependencies = dependencies;
    const maximumFailures = dependencies.maximumFailures ?? 3;
    if (!Number.isSafeInteger(maximumFailures) || maximumFailures < 0)
      throw new TypeError("Reconciliation failure limit is invalid.");
    this.#maximumFailures = maximumFailures;
    this.#sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  recover(): Promise<void> {
    this.#recovery ??= (async () => {
      const preparations = await this.#dependencies.recovery.listPendingPreparations?.();
      for (const request of preparations ?? []) this.#trackPreparation(request);
      const commands = await this.#dependencies.recovery.listPendingCommandStarts();
      for (const request of commands) this.#trackCommand(request, true);
    })();
    return this.#recovery;
  }

  trackAccepted(requestCandidate: StartCommandRequest): Promise<void> {
    return this.#trackCommand(requestCandidate, false);
  }

  quiesce(): void {
    if (this.#quiesced) return;
    this.#quiesced = true;
  }

  drain(): Promise<void> {
    this.#drain ??= (async () => {
      this.quiesce();
      await this.recover();
      while (this.#active.size > 0) {
        await Promise.all([...this.#active.values()].map(({ operation }) => operation));
      }
      if (this.#failed.size > 0) throw new Error("Reconciliation drain failed.");
    })();
    return this.#drain;
  }

  stop(): Promise<void> {
    this.#stop ??= (async () => {
      this.#quiesced = true;
      this.#stopping = true;
      await this.#recovery;
      await Promise.all([...this.#active.values()].map(({ operation }) => operation));
    })();
    return this.#stop;
  }

  #trackPreparation(requestCandidate: PrepareEnvironmentRequest): Promise<void> {
    const request = PrepareEnvironmentRequestSchema.parse(structuredClone(requestCandidate));
    return this.#track(`environment:${request.environmentId}`, JSON.stringify(request), () =>
      this.#followPreparation(request)
    );
  }

  #trackCommand(requestCandidate: StartCommandRequest, replayStart: boolean): Promise<void> {
    const request = structuredClone(requestCandidate);
    return this.#track(`command:${request.commandId}`, JSON.stringify(request), () =>
      this.#followCommand(request, replayStart)
    );
  }

  #track(key: string, canonicalRequest: string, follow: () => Promise<void>): Promise<void> {
    const current = this.#active.get(key);
    if (current !== undefined) {
      if (current.canonicalRequest !== canonicalRequest) this.#failed.add(key);
      return current.operation;
    }
    const operation = Promise.resolve()
      .then(follow)
      .catch(() => void this.#failed.add(key))
      .finally(() => {
        if (this.#active.get(key)?.operation === operation) this.#active.delete(key);
      });
    this.#active.set(key, { canonicalRequest, operation });
    return operation;
  }

  async #followPreparation(request: PrepareEnvironmentRequest): Promise<void> {
    let failures = 0;
    while (!this.#stopping) {
      try {
        const result = await this.#dependencies.host.prepareEnvironment?.(request);
        if (result === undefined || this.#dependencies.recovery.recordPrepared === undefined)
          throw new TypeError("Preparation recovery is unavailable.");
        await this.#dependencies.recovery.recordPrepared(request, result);
        return;
      } catch {
        if (this.#stopping) return;
        failures += 1;
        if (failures > this.#maximumFailures) throw new Error("Reconciliation task failed.");
        await this.#sleep(100);
      }
    }
  }

  async #followCommand(request: StartCommandRequest, replayStart: boolean): Promise<void> {
    let failures = 0;
    if (replayStart) {
      while (!this.#stopping) {
        try {
          await this.#dependencies.host.startCommand(request);
          break;
        } catch {
          if (this.#stopping) return;
          failures += 1;
          if (failures > this.#maximumFailures) throw new Error("Reconciliation task failed.");
          await this.#sleep(100);
        }
      }
    }
    while (!this.#stopping) {
      try {
        const events = await this.#dependencies.recovery.resolveReconciliationEvents(
          request.environmentId,
          request.commandId
        );
        if ((await this.#dependencies.reconciler.reconcile(events)) === "completed") return;
        failures = 0;
        await this.#sleep(100);
      } catch {
        if (this.#stopping) return;
        failures += 1;
        if (failures > this.#maximumFailures) throw new Error("Reconciliation task failed.");
        await this.#sleep(100);
      }
    }
  }
}
