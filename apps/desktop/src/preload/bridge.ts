import {
  DesktopApiRequestSchemaByOperation,
  DesktopApiResponseSchemaByOperation,
  DesktopCommandStreamRequestSchema,
  DesktopRepositoryPickerResponseSchema,
  DesktopRuntimeStatusSchema,
  RunnerSubscriptionItemSchema,
  type DesktopApiOperationMap,
  type DesktopCommandStreamRequest,
  type DesktopRuntimeStatus,
  type RepositoryCapability,
  type RunnerStreamEvent
} from "@autostack/contracts";

interface IpcAdapter {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): void;
  off(channel: string, listener: (event: unknown, value: unknown) => void): void;
}

export interface AutoStackDesktopBridge {
  runtimeStatus(): Promise<DesktopRuntimeStatus>;
  request<K extends keyof DesktopApiOperationMap>(
    input: DesktopApiOperationMap[K]["request"]
  ): Promise<DesktopApiOperationMap[K]["response"]>;
  pickRepository(): Promise<RepositoryCapability>;
  subscribeCommand(
    input: DesktopCommandStreamRequest,
    listener: (event: RunnerStreamEvent) => void
  ): () => void;
  subscribeRuntimeStatus(listener: (status: DesktopRuntimeStatus) => void): () => void;
}

export const createDesktopBridge = (ipc: IpcAdapter): AutoStackDesktopBridge =>
  Object.freeze({
    async runtimeStatus() {
      return DesktopRuntimeStatusSchema.parse(await ipc.invoke("autostack:runtime-status"));
    },
    async request<K extends keyof DesktopApiOperationMap>(
      input: DesktopApiOperationMap[K]["request"]
    ): Promise<DesktopApiOperationMap[K]["response"]> {
      const operation = input.operation as K;
      const request = DesktopApiRequestSchemaByOperation[operation].parse(input);
      const result = await ipc.invoke("autostack:request", request);
      return DesktopApiResponseSchemaByOperation[operation].parse(
        result
      ) as DesktopApiOperationMap[K]["response"];
    },
    async pickRepository() {
      const response = DesktopRepositoryPickerResponseSchema.parse(
        await ipc.invoke("autostack:pick-repository")
      );
      if (response.repository === null) throw new Error("repository selection cancelled");
      return response.repository;
    },
    subscribeCommand(
      input: DesktopCommandStreamRequest,
      listener: (event: RunnerStreamEvent) => void
    ) {
      const request = DesktopCommandStreamRequestSchema.parse(input);
      const subscriptionId = crypto.randomUUID();
      const channel = `autostack:command:${subscriptionId}`;
      const handler = (_event: unknown, candidate: unknown): void => {
        const item = RunnerSubscriptionItemSchema.parse(candidate);
        if (item.type === "runner.event") listener(item.event);
      };
      ipc.on(channel, handler);
      void ipc.invoke("autostack:subscribe-command", { subscriptionId, request });
      return () => {
        ipc.off(channel, handler);
        void ipc.invoke("autostack:detach-command", { subscriptionId });
      };
    },
    subscribeRuntimeStatus(listener: (status: DesktopRuntimeStatus) => void) {
      const channel = "autostack:runtime-status-changed";
      const handler = (_event: unknown, candidate: unknown): void => {
        listener(DesktopRuntimeStatusSchema.parse(candidate));
      };
      ipc.on(channel, handler);
      return () => ipc.off(channel, handler);
    }
  });
