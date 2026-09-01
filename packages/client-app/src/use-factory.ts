import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CreateRunRequest,
  CreateRunResponse,
  HealthResponse,
  ListRunsResponse,
  RunSummary
} from "@autostack/contracts";

import type { AutoStackApiClient } from "./api-client.js";
import { useFactoryActions, type FactoryActionsController } from "./use-factory-actions.js";

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

const UNAVAILABLE_MESSAGE = "Factory data is unavailable. Check the control plane and try again.";

const pageFingerprint = (page: ListRunsResponse): string =>
  JSON.stringify([
    page.nextCursor ?? null,
    page.items.map((run) => [
      run.runId,
      run.workItemId,
      run.title,
      run.source,
      run.status,
      run.currentStage ?? null,
      run.lastGlobalSequence,
      run.createdAt,
      run.updatedAt
    ])
  ]);

export interface FactoryController extends FactoryActionsController {
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
  const authoritativeRuns = useRef<readonly RunSummary[]>([]);
  const observedHeadPage = useRef<ListRunsResponse | null>(null);
  const headFingerprint = useRef<string | null>(null);
  const traversalActive = useRef(false);
  const fullyLoaded = useRef(false);
  const previousClient = useRef(client);

  const refreshData = useCallback(
    async (preserveLoadedPages: boolean, skipDuringTraversal: boolean): Promise<void> => {
      if (skipDuringTraversal && activeRequest.current !== null) return;
      const observeHeadOnly =
        skipDuringTraversal && (traversalActive.current || paginationRequest.current !== null);
      if (!observeHeadOnly) {
        paginationRequest.current?.abort();
        paginationRequest.current = null;
      }
      if (!preserveLoadedPages) {
        loadedOlderPages.current = false;
        authoritativeRuns.current = [];
        observedHeadPage.current = null;
        headFingerprint.current = null;
        traversalActive.current = false;
        fullyLoaded.current = false;
      }
      if (client === null) {
        authoritativeRuns.current = [];
        observedHeadPage.current = null;
        headFingerprint.current = null;
        traversalActive.current = false;
        fullyLoaded.current = false;
        setState(disconnectedState);
        return;
      }

      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      if (!observeHeadOnly) {
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
      }

      try {
        const [healthResult, runsResult] = await Promise.allSettled([
          client.health(controller.signal),
          client.listRuns(undefined, controller.signal)
        ]);
        if (controller.signal.aborted) return;
        const health = healthResult.status === "fulfilled" ? healthResult.value : undefined;
        const runs = runsResult.status === "fulfilled" ? runsResult.value : undefined;
        if (runs === undefined) {
          setState((current) => {
            const {
              health: ignoredHealth,
              message: ignoredMessage,
              paginationMessage: ignoredPaginationMessage,
              ...withoutAvailability
            } = current;
            void ignoredHealth;
            void ignoredMessage;
            void ignoredPaginationMessage;
            if (observeHeadOnly) {
              return {
                ...withoutAvailability,
                status: "ready",
                ...(health === undefined ? {} : { health }),
                paginationMessage: UNAVAILABLE_MESSAGE,
                creating: false
              };
            }
            return {
              ...withoutAvailability,
              status: "error",
              ...(health === undefined ? {} : { health }),
              message: UNAVAILABLE_MESSAGE,
              creating: false,
              loadingMore: false
            };
          });
          return;
        }
        const availability =
          health === undefined
            ? observeHeadOnly
              ? ({ status: "ready", paginationMessage: UNAVAILABLE_MESSAGE } as const)
              : ({ status: "error", message: UNAVAILABLE_MESSAGE } as const)
            : ({ status: "ready", health } as const);
        const freshFingerprint = pageFingerprint(runs);
        const responseHeadSequence = runs.items[0]?.lastGlobalSequence ?? -1;
        const authoritativeHeadSequence = authoritativeRuns.current[0]?.lastGlobalSequence ?? -1;
        const observedHeadSequence = observedHeadPage.current?.items[0]?.lastGlobalSequence ?? -1;
        if (
          observeHeadOnly &&
          responseHeadSequence <= Math.max(authoritativeHeadSequence, observedHeadSequence)
        ) {
          setState((current) => {
            const {
              health: ignoredHealth,
              message: ignoredMessage,
              paginationMessage: ignoredPaginationMessage,
              ...withoutAvailability
            } = current;
            void ignoredHealth;
            void ignoredMessage;
            void ignoredPaginationMessage;
            return { ...withoutAvailability, ...availability };
          });
          return;
        }
        const traversalStillActive = traversalActive.current || paginationRequest.current !== null;
        if (observeHeadOnly && traversalStillActive) {
          observedHeadPage.current = runs;
          const freshRunIds = new Set(runs.items.map((run) => run.runId));
          setState((current) => {
            const {
              health: ignoredHealth,
              message: ignoredMessage,
              paginationMessage: ignoredPaginationMessage,
              ...withoutAvailability
            } = current;
            void ignoredHealth;
            void ignoredMessage;
            void ignoredPaginationMessage;
            return {
              ...withoutAvailability,
              ...availability,
              runs: [...runs.items, ...current.runs.filter((run) => !freshRunIds.has(run.runId))],
              creating: false
            };
          });
          return;
        }
        observedHeadPage.current = null;
        if (
          preserveLoadedPages &&
          fullyLoaded.current &&
          headFingerprint.current === freshFingerprint
        ) {
          setState((current) => {
            const {
              health: ignoredHealth,
              message: ignoredMessage,
              paginationMessage,
              nextCursor,
              ...withoutTransientState
            } = current;
            void ignoredHealth;
            void ignoredMessage;
            void paginationMessage;
            void nextCursor;
            return {
              ...withoutTransientState,
              ...availability,
              creating: false,
              loadingMore: false
            };
          });
          return;
        }
        const shouldPreserve =
          preserveLoadedPages && loadedOlderPages.current && runs.nextCursor !== undefined;
        const freshRunIds = new Set(runs.items.map((run) => run.runId));
        authoritativeRuns.current = runs.items;
        headFingerprint.current = freshFingerprint;
        fullyLoaded.current = runs.nextCursor === undefined;
        traversalActive.current = shouldPreserve;
        setState((current) => {
          const reconciledRuns = shouldPreserve
            ? [...runs.items, ...current.runs.filter((run) => !freshRunIds.has(run.runId))]
            : runs.items;
          return {
            ...availability,
            runs: reconciledRuns,
            creating: false,
            loadingMore: false,
            ...(runs.nextCursor === undefined ? {} : { nextCursor: runs.nextCursor })
          };
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => {
          const { health: ignoredHealth, ...withoutHealth } = current;
          void ignoredHealth;
          return {
            ...withoutHealth,
            status: "error",
            message: UNAVAILABLE_MESSAGE,
            creating: false,
            loadingMore: false
          };
        });
        void error;
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null;
      }
    },
    [client]
  );

  const refresh = useCallback(async (): Promise<void> => refreshData(true, false), [refreshData]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (
      client === null ||
      state.nextCursor === undefined ||
      activeRequest.current !== null ||
      paginationRequest.current !== null
    ) {
      return;
    }
    const controller = new AbortController();
    paginationRequest.current = controller;
    fullyLoaded.current = false;
    setState((current) => {
      const { paginationMessage, ...withoutPaginationMessage } = current;
      void paginationMessage;
      return { ...withoutPaginationMessage, loadingMore: true };
    });

    try {
      const page = await client.listRuns(state.nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      loadedOlderPages.current = true;
      const knownAuthoritativeIds = new Set(authoritativeRuns.current.map((run) => run.runId));
      const uniquePageRuns = page.items.filter((run) => {
        if (knownAuthoritativeIds.has(run.runId)) return false;
        knownAuthoritativeIds.add(run.runId);
        return true;
      });
      const nextAuthoritativeRuns = [...authoritativeRuns.current, ...uniquePageRuns];
      const pageNextCursor = page.nextCursor;
      if (pageNextCursor !== undefined) {
        authoritativeRuns.current = nextAuthoritativeRuns;
        setState((current) => {
          const observedHeadRuns = observedHeadPage.current?.items ?? [];
          const observedHeadIds = new Set(observedHeadRuns.map((run) => run.runId));
          const displayedAuthoritativeRuns = nextAuthoritativeRuns.filter(
            (run) => !observedHeadIds.has(run.runId)
          );
          const retainedRuns = current.runs.filter(
            (run) => !knownAuthoritativeIds.has(run.runId) && !observedHeadIds.has(run.runId)
          );
          return {
            ...current,
            runs: [...observedHeadRuns, ...displayedAuthoritativeRuns, ...retainedRuns],
            loadingMore: false,
            nextCursor: pageNextCursor
          };
        });
        return;
      }

      const validatedHead = await client.listRuns(undefined, controller.signal);
      if (controller.signal.aborted) return;
      const observedHead = observedHeadPage.current;
      const observedSequence = observedHead?.items[0]?.lastGlobalSequence ?? -1;
      const validatedSequence = validatedHead.items[0]?.lastGlobalSequence ?? -1;
      const effectiveValidatedHead =
        observedHead !== null && observedSequence > validatedSequence
          ? observedHead
          : validatedHead;
      const validatedFingerprint = pageFingerprint(effectiveValidatedHead);
      const traversalIsStable = validatedFingerprint === headFingerprint.current;
      headFingerprint.current = validatedFingerprint;
      observedHeadPage.current = null;

      if (traversalIsStable) {
        authoritativeRuns.current = nextAuthoritativeRuns;
        fullyLoaded.current = true;
        traversalActive.current = false;
        setState((current) => {
          const { nextCursor: ignoredCursor, ...withoutCursor } = current;
          void ignoredCursor;
          return {
            ...withoutCursor,
            runs: nextAuthoritativeRuns,
            loadingMore: false
          };
        });
        return;
      }

      const validatedRunIds = new Set(effectiveValidatedHead.items.map((run) => run.runId));
      authoritativeRuns.current = effectiveValidatedHead.items;
      fullyLoaded.current = effectiveValidatedHead.nextCursor === undefined;
      traversalActive.current = effectiveValidatedHead.nextCursor !== undefined;
      setState((current) => {
        const { nextCursor: ignoredCursor, ...withoutCursor } = current;
        void ignoredCursor;
        if (effectiveValidatedHead.nextCursor === undefined) {
          return {
            ...withoutCursor,
            runs: effectiveValidatedHead.items,
            loadingMore: false
          };
        }
        const retainedRunIds = new Set(validatedRunIds);
        const retainedRuns = [...nextAuthoritativeRuns, ...current.runs].filter((run) => {
          if (retainedRunIds.has(run.runId)) return false;
          retainedRunIds.add(run.runId);
          return true;
        });
        return {
          ...withoutCursor,
          runs: [...effectiveValidatedHead.items, ...retainedRuns],
          loadingMore: false,
          nextCursor: effectiveValidatedHead.nextCursor
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
      authoritativeRuns.current = [];
      observedHeadPage.current = null;
      headFingerprint.current = null;
      traversalActive.current = false;
      fullyLoaded.current = false;
    }

    if (client === null) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      paginationRequest.current?.abort();
      paginationRequest.current = null;
      authoritativeRuns.current = [];
      observedHeadPage.current = null;
      headFingerprint.current = null;
      traversalActive.current = false;
      fullyLoaded.current = false;
      setState(disconnectedState);
      return;
    }

    if (document.visibilityState === "visible") void refreshData(!clientChanged, false);
    const poll = (): void => {
      if (document.visibilityState === "visible") void refreshData(true, true);
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

  return { state, refresh, loadMore, createRun, ...useFactoryActions(client, refresh) };
}
