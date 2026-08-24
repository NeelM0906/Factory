export interface GuardianMessageRuntime<TMessage> {
  receive(message: TMessage): Promise<void>;
  disconnect(): Promise<void>;
}

interface QueuedMessage<TMessage> {
  readonly message: TMessage;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface GuardianBootstrapRouterOptions<TBootstrap, TMessage> {
  readonly bootstrap: (message: TBootstrap) => Promise<GuardianMessageRuntime<TMessage>>;
  readonly onFailure: () => void;
}

/** Keeps the single lease-transfer reply that may race a guardian runtime's bootstrap. */
export class GuardianBootstrapRouter<TBootstrap, TMessage> {
  readonly #options: GuardianBootstrapRouterOptions<TBootstrap, TMessage>;
  readonly #pending: QueuedMessage<TMessage>[] = [];
  #runtime: GuardianMessageRuntime<TMessage> | undefined;
  #state: "awaiting_bootstrap" | "bootstrapping" | "ready" | "failed" =
    "awaiting_bootstrap";

  private constructor(options: GuardianBootstrapRouterOptions<TBootstrap, TMessage>) {
    this.#options = options;
  }

  static create<TBootstrap, TMessage>(
    options: GuardianBootstrapRouterOptions<TBootstrap, TMessage>
  ): GuardianBootstrapRouter<TBootstrap, TMessage> {
    return new GuardianBootstrapRouter(options);
  }

  route(message: TBootstrap | TMessage): Promise<void> {
    if (this.#state === "awaiting_bootstrap") {
      this.#state = "bootstrapping";
      return this.#bootstrap(message as TBootstrap);
    }
    if (this.#state === "bootstrapping") {
      if (this.#pending.length !== 0) {
        const error = new TypeError("Guardian bootstrap transport is saturated.");
        this.#fail(error);
        return Promise.reject(error);
      }
      return new Promise<void>((resolve, reject) => {
        this.#pending.push({ message: message as TMessage, resolve, reject });
      });
    }
    if (this.#state === "ready") return this.#deliver(message as TMessage);
    return Promise.reject(new TypeError("Guardian bootstrap transport is closed."));
  }

  async disconnect(): Promise<void> {
    if (this.#state !== "failed") this.#fail(new TypeError("Guardian transport disconnected."));
    await this.#runtime?.disconnect();
  }

  async #bootstrap(message: TBootstrap): Promise<void> {
    try {
      const runtime = await this.#options.bootstrap(message);
      if (this.#state === "failed") {
        await runtime.disconnect();
        return;
      }
      this.#runtime = runtime;
      while (this.#pending.length !== 0) {
        const queued = this.#pending.shift()!;
        try {
          await runtime.receive(queued.message);
          queued.resolve();
        } catch (error) {
          queued.reject(error);
          throw error;
        }
      }
      this.#state = "ready";
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async #deliver(message: TMessage): Promise<void> {
    try {
      await this.#runtime!.receive(message);
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  #fail(error: unknown): void {
    if (this.#state === "failed") return;
    this.#state = "failed";
    for (const queued of this.#pending.splice(0)) queued.reject(error);
    this.#options.onFailure();
  }
}
