import type { DeliveryIntegrationPort, GitHubProgressIntegrationPort } from "@autostack/contracts";

import type { GitHubAuthStrategy } from "./auth/types.js";
import {
  createBranchRefsClient,
  type CreateBranchRequest,
  type DeleteBranchRequest,
  type GetRefRequest,
  type PutFileOnBranchRequest,
  type PutFileOnBranchResult
} from "./client/branch-refs.js";
import {
  createChecksClient,
  type GitHubCheckRun,
  type ListCheckRunsRequest
} from "./client/checks.js";
import { createDraftPullRequestsClient } from "./client/pull-requests.js";
import { createProgressCommentsClient } from "./client/progress-comments.js";
import { createGitHubTransport } from "./client/transport.js";
import { createMemoryIdempotencyStore, type IdempotencyRecordStore } from "./idempotency.js";

export interface GitHubIntegrationDependencies {
  readonly auth: GitHubAuthStrategy;
  readonly fetch: typeof globalThis.fetch;
  /** Transport clock, epoch milliseconds -- matches {@link createGitHubTransport}'s `now`. */
  readonly now: () => number;
  readonly userAgent: string;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  /**
   * Shared between `createDraftPullRequest` and `upsertProgressComment` (each namespaces its own
   * keys, see `idempotency.ts`). Defaults to {@link createMemoryIdempotencyStore}() when omitted
   * (decision D4) -- Task 6 deliberately left this wiring decision to Task 9.
   *
   * An in-memory store is per-process only: it does not survive a process restart, so on its own
   * it cannot prevent a duplicate side effect across a crash/restart boundary. Restart-durable
   * idempotency storage is the pipeline's concern (S4), not this adapter's; a caller that needs
   * that durability supplies its own `IdempotencyRecordStore` implementation here instead of
   * relying on the default.
   */
  readonly idempotency?: IdempotencyRecordStore;
  readonly baseUrl?: string;
}

/**
 * The GitHub half of `DeliveryIntegrationPort` (decision D1) plus the GitHub-only branch/check
 * operations. The Slack half (`postSlackProgress`) and the two-provider facade that composes both
 * halves into a whole `DeliveryIntegrationPort` belong to the composition root (Wave 2 / I1), not
 * to this package -- see decision D1 in the stream plan.
 */
export interface GitHubIntegration
  extends Pick<DeliveryIntegrationPort, "createDraftPullRequest">, GitHubProgressIntegrationPort {
  getRef(request: GetRefRequest): Promise<string>;
  createBranch(request: CreateBranchRequest): Promise<void>;
  deleteBranch(request: DeleteBranchRequest): Promise<void>;
  putFileOnBranch(request: PutFileOnBranchRequest): Promise<PutFileOnBranchResult>;
  listCheckRuns(request: ListCheckRunsRequest): Promise<readonly GitHubCheckRun[]>;
}

/**
 * Assembles the GitHub delivery integration: one {@link GitHubTransport} (shared across every
 * operation, so backoff, header hygiene, and redirect handling apply uniformly) and one
 * `IdempotencyRecordStore` (shared between the two idempotent operations), wired into the
 * already-committed clients under `client/`. This function does not reimplement any client's
 * behaviour -- it only builds the transport and store and hands them off.
 */
export const createGitHubIntegration = (deps: GitHubIntegrationDependencies): GitHubIntegration => {
  const transport = createGitHubTransport({
    fetch: deps.fetch,
    userAgent: deps.userAgent,
    authorization: () => deps.auth.authorization(),
    now: deps.now,
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.random !== undefined ? { random: deps.random } : {}),
    ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {})
  });

  const idempotencyStore = deps.idempotency ?? createMemoryIdempotencyStore();

  const branchRefs = createBranchRefsClient(transport);
  const checks = createChecksClient(transport);
  const pullRequests = createDraftPullRequestsClient({ transport, idempotencyStore });
  const progressComments = createProgressCommentsClient({ transport, idempotencyStore });

  return {
    createDraftPullRequest: pullRequests.createDraftPullRequest,
    upsertProgressComment: progressComments.upsertProgressComment,
    getRef: branchRefs.getRef,
    createBranch: branchRefs.createBranch,
    deleteBranch: branchRefs.deleteBranch,
    putFileOnBranch: branchRefs.putFileOnBranch,
    listCheckRuns: checks.listCheckRuns
  };
};
