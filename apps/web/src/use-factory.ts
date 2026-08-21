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
  readonly nextCursor?: number;
  readonly loadingMore: boolean;
  readonly paginationMessage?: string;
}

const disconnectedState: FactoryState = {
  status: "disconnected",
  runs: [],
  creating: false,
  loadingMore: false
};

export interface FactoryController {
  readonly state: FactoryState;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  createRun(input: CreateRunRequest): Promise<CreateRunResponse>;
}

export function useFactory(
  client: AutoStackApiClient | null,
  pollIntervalMs = 5_000
): FactoryController {
  const [state, setState] = useState<FactoryState>(disconnectedState);
  const activeRequest = useRef<AbortController | null>(null);
  const paginationRequest = useRef<AbortController | null>(null);
  const loadedOlderPages = useRef(false);
  const previousClient = useRef(client);

  const refreshData = useCallback(
    async (preserveLoadedPages: boolean): Promise<void> => {
      paginationRequest.current?.abort();
      paginationRequest.current = null;
      if (!preserveLoadedPages) {
        loadedOlderPages.current = false;
      }
      if (client === null) {
        setState(disconnectedState);
        return;
      }

      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setState((current) => {
        const refreshBase = preserveLoadedPages ? current : disconnectedState;
        const { message, paginationMessage, ...withoutMessages } = refreshBase;
        void message;
        void paginationMessage;
        return {
          ...withoutMessages,
          status: refreshBase.runs.length === 0 ? "loading" : refreshBase.status,
          loadingMore: false
        };
      });

      try {
        const [health, runs] = await Promise.all([
          client.health(controller.signal),
          client.listRuns(undefined, controller.signal)
        ]);
        if (controller.signal.aborted) return;
        const shouldPreserve = preserveLoadedPages && loadedOlderPages.current;
        const freshRunIds = new Set(runs.items.map((run) => run.runId));
        setState((current) => {
          const reconciledRuns = shouldPreserve
            ? [...runs.items, ...current.runs.filter((run) => !freshRunIds.has(run.runId))]
            : runs.items;
          const nextCursor = shouldPreserve ? current.nextCursor : runs.nextCursor;
          return {
            status: "ready",
            health,
            runs: reconciledRuns,
            creating: false,
            loadingMore: false,
            ...(nextCursor === undefined ? {} : { nextCursor })
          };
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          status: "error",
          message: "Factory data is unavailable. Check the control plane and try again.",
          creating: false,
          loadingMore: false
        }));
        void error;
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null;
      }
    },
    [client]
  );

  const refresh = useCallback(async (): Promise<void> => refreshData(true), [refreshData]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (client === null || state.nextCursor === undefined || paginationRequest.current !== null) {
      return;
    }
    const controller = new AbortController();
    paginationRequest.current = controller;
    setState((current) => {
      const { paginationMessage, ...withoutPaginationMessage } = current;
      void paginationMessage;
      return { ...withoutPaginationMessage, loadingMore: true };
    });

    try {
      const page = await client.listRuns(state.nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      loadedOlderPages.current = true;
      setState((current) => {
        const { nextCursor: ignoredCursor, ...withoutCursor } = current;
        void ignoredCursor;
        const knownRunIds = new Set(current.runs.map((run) => run.runId));
        return {
          ...withoutCursor,
          runs: [
            ...current.runs,
            ...page.items.filter((run) => {
              if (knownRunIds.has(run.runId)) return false;
              knownRunIds.add(run.runId);
              return true;
            })
          ],
          loadingMore: false,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
        };
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        loadingMore: false,
        paginationMessage: "Older runs could not be loaded. Try again."
      }));
      void error;
    } finally {
      if (paginationRequest.current === controller) paginationRequest.current = null;
    }
  }, [client, state.nextCursor]);

  useEffect(() => {
    const clientChanged = previousClient.current !== client;
    previousClient.current = client;
    if (clientChanged) {
      loadedOlderPages.current = false;
    }

    if (client === null) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      paginationRequest.current?.abort();
      paginationRequest.current = null;
      setState(disconnectedState);
      return;
    }

    if (document.visibilityState === "visible") void refreshData(!clientChanged);
    const poll = (): void => {
      if (document.visibilityState === "visible") void refreshData(true);
    };
    const timer = window.setInterval(poll, pollIntervalMs);
    document.addEventListener("visibilitychange", poll);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      activeRequest.current?.abort();
      activeRequest.current = null;
      paginationRequest.current?.abort();
      paginationRequest.current = null;
    };
  }, [client, pollIntervalMs, refreshData]);

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

  return { state, refresh, loadMore, createRun };
}
