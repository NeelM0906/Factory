import { ControlPlaneParentLifecycleMessageSchema, normalizeSafeJson } from "@autostack/contracts";

export interface DesktopControlPlaneLifecycleRuntime {
  quiesce(): Promise<void>;
  drain(): Promise<void>;
  retireHostGeneration(): Promise<void>;
  close(): Promise<void>;
}

export interface DesktopControlPlaneLifecycleState {
  drained: boolean;
}

interface LifecycleWriter {
  postMessage(message: unknown): void;
}

const isRetireGeneration = (candidate: unknown): boolean =>
  candidate !== null &&
  typeof candidate === "object" &&
  Object.keys(candidate).length === 2 &&
  (candidate as { schemaVersion?: unknown }).schemaVersion === 1 &&
  (candidate as { type?: unknown }).type === "retire-generation";

export const applyControlPlaneLifecycle = async (
  runtime: DesktopControlPlaneLifecycleRuntime,
  writer: LifecycleWriter,
  state: DesktopControlPlaneLifecycleState,
  candidate: unknown
): Promise<"continue" | "exit"> => {
  if (isRetireGeneration(candidate)) {
    await runtime.retireHostGeneration();
    writer.postMessage({
      schemaVersion: 1,
      type: "generation.retired",
      incomplete: false
    });
    await runtime.close();
    return "exit";
  }
  const message = ControlPlaneParentLifecycleMessageSchema.parse(normalizeSafeJson(candidate));
  if (message.type === "quiesce") {
    await runtime.quiesce();
    writer.postMessage({ schemaVersion: 1, type: "lifecycle.ack", phase: "quiesce" });
    return "continue";
  }
  if (message.type === "interrupt-and-drain") {
    await runtime.drain();
    state.drained = true;
    writer.postMessage({
      schemaVersion: 1,
      type: "drained",
      remainingReconciliationCount: 0
    });
    return "continue";
  }
  if (!state.drained) throw new TypeError("control-plane close requires a completed drain");
  await runtime.close();
  return "exit";
};
