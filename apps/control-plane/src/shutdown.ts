import {
  ControlPlaneParentLifecycleMessageSchema,
  type ControlPlaneParentLifecycleMessage
} from "@autostack/contracts";

export interface ControlPlaneShutdownDependencies {
  readonly quiesceIngress: () => Promise<void>;
  readonly drainReconciliation: () => Promise<void>;
  readonly closeListener: () => Promise<void>;
  readonly closeExecutor: () => Promise<void>;
  readonly closePersistence: () => Promise<void>;
}

export class ControlPlaneShutdown {
  readonly #dependencies: ControlPlaneShutdownDependencies;
  #quiesce: Promise<void> | undefined;
  #drain: Promise<void> | undefined;
  #close: Promise<void> | undefined;

  constructor(dependencies: ControlPlaneShutdownDependencies) {
    this.#dependencies = dependencies;
  }

  handle(candidate: unknown): Promise<void> {
    const message: ControlPlaneParentLifecycleMessage =
      ControlPlaneParentLifecycleMessageSchema.parse(candidate);
    if (message.type === "quiesce") return this.quiesce();
    if (message.type === "interrupt-and-drain") return this.drain();
    return this.close();
  }

  quiesce(): Promise<void> {
    this.#quiesce ??= this.#dependencies.quiesceIngress();
    return this.#quiesce;
  }

  drain(): Promise<void> {
    this.#drain ??= (async () => {
      await this.quiesce();
      await this.#dependencies.drainReconciliation();
    })();
    return this.#drain;
  }

  close(): Promise<void> {
    this.#close ??= (async () => {
      await this.drain();
      let firstError: unknown;
      for (const close of [
        this.#dependencies.closeListener,
        this.#dependencies.closeExecutor,
        this.#dependencies.closePersistence
      ]) {
        try {
          await close();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    })();
    return this.#close;
  }
}
