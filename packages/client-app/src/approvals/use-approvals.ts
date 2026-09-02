import { useCallback, useEffect, useRef, useState } from "react";

import type { ApprovalSummary } from "@autostack/contracts";

import type { AutoStackApiClient } from "../api-client.js";

export interface ApprovalsState {
  readonly status: "disconnected" | "loading" | "ready" | "error";
  readonly approvals: readonly ApprovalSummary[];
  readonly nextCursor?: number;
  readonly loadingMore: boolean;
  readonly message?: string;
  readonly paginationMessage?: string;
}

const disconnectedState: ApprovalsState = {
  status: "disconnected",
  approvals: [],
  loadingMore: false
};

const loadingState: ApprovalsState = {
  status: "loading",
  approvals: [],
  loadingMore: false
};

const INITIAL_LOAD_FAILURE_MESSAGE = "Approvals could not be loaded. Try again.";
const PAGINATION_FAILURE_MESSAGE = "More approvals could not be loaded. Try again.";

export interface ApprovalsController {
  readonly state: ApprovalsState;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
}

/**
 * Loads the approval inbox and pages past its first window, on the cursor discipline modelled on
 * `useFactory.loadMore`: an `AbortController` per request, no double-fetch while one is in
 * flight, de-duplication by `approvalId`, and a distinct `paginationMessage` for a failed page so
 * one bad page never blanks the already-loaded list.
 *
 * Unlike `useFactory.loadMore` (which loads one page per call), `loadMore` here drains every
 * remaining page in a single call — the inbox has one "load more" control, and clicking it once
 * is expected to reveal the rest of the list, not one window at a time.
 */
export function useApprovals(
  client: AutoStackApiClient | null,
  status?: ApprovalSummary["status"] | "all"
): ApprovalsController {
  const [state, setState] = useState<ApprovalsState>(
    client === null ? disconnectedState : loadingState
  );
  const activeRequest = useRef<AbortController | null>(null);
  const knownApprovals = useRef<readonly ApprovalSummary[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) {
      knownApprovals.current = [];
      activeRequest.current?.abort();
      activeRequest.current = null;
      setState(disconnectedState);
      return;
    }
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState(loadingState);

    try {
      const page = await client.listApprovals(
        status === undefined ? {} : { status },
        controller.signal
      );
      if (controller.signal.aborted) return;
      knownApprovals.current = page.items;
      setState({
        status: "ready",
        approvals: page.items,
        loadingMore: false,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      knownApprovals.current = [];
      setState({
        status: "error",
        approvals: [],
        loadingMore: false,
        message: INITIAL_LOAD_FAILURE_MESSAGE
      });
      void error;
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, [client, status]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (client === null || state.nextCursor === undefined || activeRequest.current !== null) {
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setState((current) => {
      const { paginationMessage, ...withoutPaginationMessage } = current;
      void paginationMessage;
      return { ...withoutPaginationMessage, loadingMore: true };
    });

    let cursor: number | undefined = state.nextCursor;
    try {
      while (cursor !== undefined) {
        const page = await client.listApprovals(
          status === undefined ? { cursor } : { status, cursor },
          controller.signal
        );
        if (controller.signal.aborted) return;
        const knownIds = new Set(knownApprovals.current.map((approval) => approval.approvalId));
        const uniqueNewItems = page.items.filter((approval) => {
          if (knownIds.has(approval.approvalId)) return false;
          knownIds.add(approval.approvalId);
          return true;
        });
        knownApprovals.current = [...knownApprovals.current, ...uniqueNewItems];
        cursor = page.nextCursor;
        const accumulated = knownApprovals.current;
        const stillLoadingMore = cursor !== undefined;
        setState((current) => {
          const { nextCursor: ignoredCursor, ...withoutCursor } = current;
          void ignoredCursor;
          return {
            ...withoutCursor,
            approvals: accumulated,
            loadingMore: stillLoadingMore,
            ...(cursor === undefined ? {} : { nextCursor: cursor })
          };
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        loadingMore: false,
        paginationMessage: PAGINATION_FAILURE_MESSAGE
      }));
      void error;
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, [client, status, state.nextCursor]);

  useEffect(() => {
    void refresh();
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [refresh]);

  return { state, refresh, loadMore };
}
