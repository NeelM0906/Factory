import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CreateRunRequest,
  CreateRunResponse,
  HealthResponse,
  RunSummary
} from "@autostack/contracts";

import type { AutoStackApiClient } from "./api-client.js";

export interface FactoryState {
  readonly status: "disconnected" | "loading" | "ready" | "error";
  readonly health?: HealthResponse;
  readonly runs: readonly RunSummary[];
  readonly message?: string;
  readonly creating: boolean;
}

const disconnectedState: FactoryState = {
  status: "disconnected",
  runs: [],
  creating: false
};

export interface FactoryController {
  readonly state: FactoryState;
  refresh(): Promise<void>;
  createRun(input: CreateRunRequest): Promise<CreateRunResponse>;
}

export function useFactory(
  client: AutoStackApiClient | null,
  pollIntervalMs = 5_000
): FactoryController {
  const [state, setState] = useState<FactoryState>(disconnectedState);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) {
      setState(disconnectedState);
      return;
    }

    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState((current) => {
      const { message, ...withoutMessage } = current;
      void message;
      return {
        ...withoutMessage,
        status: current.runs.length === 0 ? "loading" : current.status
      };
    });

    try {
      const [health, runs] = await Promise.all([
        client.health(controller.signal),
        client.listRuns(controller.signal)
      ]);
      if (controller.signal.aborted) return;
      setState({ status: "ready", health, runs: runs.items, creating: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        status: "error",
        message: "Factory data is unavailable. Check the control plane and try again.",
        creating: false
      }));
      void error;
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, [client]);

  useEffect(() => {
    if (client === null) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      setState(disconnectedState);
      return;
    }

    void refresh();
    const poll = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(poll, pollIntervalMs);
    document.addEventListener("visibilitychange", poll);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [client, pollIntervalMs, refresh]);

  const createRun = useCallback(
    async (input: CreateRunRequest): Promise<CreateRunResponse> => {
      if (client === null) throw new TypeError("The factory is disconnected.");
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setState((current) => {
        const { message, ...withoutMessage } = current;
        void message;
        return { ...withoutMessage, creating: true };
      });
      try {
        const response = await client.createRun(input, controller.signal);
        if (!controller.signal.aborted) await refresh();
        return response;
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((current) => ({
            ...current,
            status: "error",
            message: "The run could not be created. Try again.",
            creating: false
          }));
        }
        throw error;
      }
    },
    [client, refresh]
  );

  return { state, refresh, createRun };
}
