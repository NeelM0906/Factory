import { RunnerDrainResultSchema, type RunnerDrainResult } from "@autostack/contracts";
import type { LocalRunnerLifecycle } from "@autostack/domain";

export type HostRuntimeState =
  "serving" | "quiesced" | "draining" | "drained" | "closing" | "closed" | "failed";

export interface HostIngressState {
  acceptsMutation(): boolean;
  acceptsProviderWork(): boolean;
  state(): HostRuntimeState;
  quiesce(): void;
  draining(): void;
  drained(): void;
  closing(): void;
  closed(): void;
  failed(): void;
}

export const createHostIngressState = (): HostIngressState => {
  let current: HostRuntimeState = "serving";
  return {
    acceptsMutation: () => current === "serving",
    acceptsProviderWork: () => !["closing", "closed", "failed"].includes(current),
    state: () => current,
    quiesce: () => {
      if (current === "serving") current = "quiesced";
    },
    draining: () => {
      current = "draining";
    },
    drained: () => {
      current = "drained";
    },
    closing: () => {
      current = "closing";
    },
    closed: () => {
      current = "closed";
    },
    failed: () => {
      current = "failed";
    }
  };
};

export interface ShutdownController {
  quiesce(): Promise<void>;
  interruptAndDrain(): Promise<RunnerDrainResult>;
  close(): Promise<void>;
}

export const createShutdownController = (dependencies: {
  readonly lifecycle: LocalRunnerLifecycle;
  readonly ingress: HostIngressState;
}): ShutdownController => {
  let quiescePromise: Promise<void> | undefined;
  let drainPromise: Promise<RunnerDrainResult> | undefined;
  let closePromise: Promise<void> | undefined;
  const quiesce = (): Promise<void> => {
    dependencies.ingress.quiesce();
    return (quiescePromise ??= Promise.resolve(dependencies.lifecycle.quiesce()).catch(
      (error: unknown) => {
        dependencies.ingress.failed();
        throw error;
      }
    ));
  };
  const interruptAndDrain = (): Promise<RunnerDrainResult> =>
    (drainPromise ??= (async () => {
      await quiesce();
      dependencies.ingress.draining();
      const candidate = await dependencies.lifecycle.interruptAndDrain();
      let result: RunnerDrainResult;
      try {
        result = RunnerDrainResultSchema.parse(candidate);
      } catch {
        dependencies.ingress.failed();
        throw new TypeError("Host drain is incomplete.");
      }
      dependencies.ingress.drained();
      return result;
    })());
  return {
    quiesce,
    interruptAndDrain,
    close: () =>
      (closePromise ??= (async () => {
        await interruptAndDrain();
        dependencies.ingress.closing();
        try {
          await dependencies.lifecycle.close();
          dependencies.ingress.closed();
        } catch (error) {
          dependencies.ingress.failed();
          throw error;
        }
      })())
  };
};
