import { z } from "zod";

import {
  DraftPullRequestResultSchema,
  admitDraftPullRequestRequest,
  digestVersionedValue,
  type DraftPullRequestRequest,
  type DraftPullRequestResult
} from "@autostack/contracts";

import { assertAutoStackBranch } from "../branch-policy.js";
import { GitHubRequestError } from "../errors.js";
import type { IdempotencyRecordStore } from "../idempotency.js";
import { encodeRepositoryPath } from "./repository-path.js";
import type { GitHubTransport } from "./transport.js";

/**
 * The domain label passed to the contracts' `digestVersionedValue` when hashing a provider PR
 * response into `DraftPullRequestResult.providerEvidenceDigest`. Exported so tests can compute the
 * same digest independently, through the real contracts helper, rather than hand-writing hex.
 */
export const PULL_REQUEST_EVIDENCE_DIGEST_DOMAIN = "autostack.github.draft-pull-request";

/** Keys stored under `IdempotencyRecordStore` are namespaced per operation (decision D4). */
const IDEMPOTENCY_NAMESPACE = "github.draft-pull-request";
const namespacedIdempotencyKey = (idempotencyKey: string): string =>
  `${IDEMPOTENCY_NAMESPACE}:${idempotencyKey}`;

// GitHub's pull-request payload (create response and list-item shape) carries many more fields
// than this; only the ones the canonical evidence digest and the result need are modeled. Zod
// ignores unmodeled fields by default, so this is not `.strict()`.
const gitHubPullRequestResponseSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  draft: z.boolean(),
  created_at: z.string(),
  head: z.object({ sha: z.string() })
});
type GitHubPullRequestResponse = z.infer<typeof gitHubPullRequestResponseSchema>;

const gitHubPullRequestListResponseSchema = z.array(gitHubPullRequestResponseSchema);

export interface GitHubDraftPullRequestsClient {
  createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequestResult>;
}

export interface CreateDraftPullRequestsClientOptions {
  readonly transport: GitHubTransport;
  readonly idempotencyStore: IdempotencyRecordStore;
}

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/**
 * Splits `owner/repo` and URL-encodes each segment separately, exactly like
 * `client/branch-refs.ts` does -- a joined-string encoding would leave a literal "/" unescaped.
 * `DraftPullRequestRequestSchema.repositoryFullName` already enforces this shape, so admission has
 * always run before this is called; the check here is a second, independent guarantee.
 */
const splitRepositoryFullName = (repositoryFullName: string): { owner: string; repo: string } => {
  if (!REPOSITORY_FULL_NAME_PATTERN.test(repositoryFullName)) {
    throw new GitHubRequestError(
      `Repository full name "${repositoryFullName}" is not a valid "owner/repo" pair.`,
      0,
      "invalid_request",
      false
    );
  }
  const slashIndex = repositoryFullName.indexOf("/");
  return {
    owner: repositoryFullName.slice(0, slashIndex),
    repo: repositoryFullName.slice(slashIndex + 1)
  };
};

/**
 * Builds the GitHub list-pulls path used to recover from a "PR already exists" 422. `head` MUST be
 * `owner:branch` (a bare branch name silently matches nothing in GitHub's filter) and `state` MUST
 * be `all` (the existing PR may already be closed) -- see the module doc comment on
 * {@link createDraftPullRequestsClient} for why both matter.
 */
const buildDuplicateLookupPath = (
  repositoryFullName: string,
  owner: string,
  branch: string,
  base: string
): string => {
  const query = new URLSearchParams();
  query.set("head", `${owner}:${branch}`);
  query.set("state", "all");
  query.set("base", base);
  return `/repos/${encodeRepositoryPath(repositoryFullName)}/pulls?${query.toString()}`;
};

interface CanonicalGitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly createdAt: string;
}

const toCanonicalPullRequest = (
  response: GitHubPullRequestResponse
): CanonicalGitHubPullRequest => ({
  number: response.number,
  url: response.html_url,
  headSha: response.head.sha,
  createdAt: response.created_at
});

/**
 * Turns a raw GitHub PR response into a schema-valid `DraftPullRequestResult`. `draft` is always
 * `true` on the contract (spec: AutoStack never opens a ready-for-review PR on its own), so a
 * provider response reporting `draft: false` is rejected rather than silently accepted.
 */
const buildDraftPullRequestResult = async (
  idempotencyKey: string,
  repositoryFullName: string,
  response: GitHubPullRequestResponse
): Promise<DraftPullRequestResult> => {
  if (!response.draft) {
    throw new GitHubRequestError(
      "GitHub reported the pull request as not a draft.",
      0,
      "invalid_response",
      false
    );
  }

  const canonical = toCanonicalPullRequest(response);
  const providerEvidenceDigest = await digestVersionedValue(
    PULL_REQUEST_EVIDENCE_DIGEST_DOMAIN,
    canonical
  );

  return DraftPullRequestResultSchema.parse({
    schemaVersion: 1,
    idempotencyKey,
    repositoryFullName,
    number: canonical.number,
    url: canonical.url,
    draft: true,
    providerEvidenceDigest,
    createdAt: canonical.createdAt
  });
};

/**
 * Creates a draft pull request behind an approved publish scope (decision D3/D4).
 *
 * Ordering, matching `createFakeDeliveryIntegration` exactly: admit/validate the request first
 * (schema + publication-evidence-bundle admission, then the `autostack/` branch guard -- defense
 * in depth even when the approved scope itself names a non-`autostack/` head), THEN check the
 * idempotency table, and only after both of those does any network call happen. A replay therefore
 * short-circuits before a stubbed-to-fail transport is ever reached.
 *
 * A `422` from the create call means GitHub already has a PR for this head; the recovery re-reads
 * it with `GET .../pulls?head={owner}:{branch}&state=all&base={base}` (the same postcondition-based
 * approach `createBranch` in `client/branch-refs.ts` uses for its own 422) and records whatever it
 * finds under the idempotency key. A lookup that finds nothing rethrows the original 422 rather
 * than inventing a result.
 */
export const createDraftPullRequestsClient = (
  options: CreateDraftPullRequestsClientOptions
): GitHubDraftPullRequestsClient => {
  const { transport, idempotencyStore } = options;

  const createDraftPullRequest = async (
    request: DraftPullRequestRequest
  ): Promise<DraftPullRequestResult> => {
    const admitted = await admitDraftPullRequestRequest(request);
    const branch = assertAutoStackBranch(admitted.head);
    const { owner } = splitRepositoryFullName(admitted.repositoryFullName);
    const key = namespacedIdempotencyKey(admitted.idempotencyKey);

    const replayed = await idempotencyStore.get<DraftPullRequestResult>(key);
    if (replayed !== undefined) return replayed;

    try {
      const response = await transport.request({
        method: "POST",
        path: `/repos/${encodeRepositoryPath(admitted.repositoryFullName)}/pulls`,
        body: {
          title: admitted.title,
          body: admitted.body,
          head: branch,
          base: admitted.base,
          draft: true
        },
        schema: gitHubPullRequestResponseSchema
      });
      const result = await buildDraftPullRequestResult(
        admitted.idempotencyKey,
        admitted.repositoryFullName,
        response
      );
      await idempotencyStore.set(key, result);
      return result;
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;

      let matches: readonly GitHubPullRequestResponse[];
      try {
        matches = await transport.request({
          method: "GET",
          path: buildDuplicateLookupPath(admitted.repositoryFullName, owner, branch, admitted.base),
          schema: gitHubPullRequestListResponseSchema
        });
      } catch {
        // The re-read didn't explain the 422 either -- surface the original failure rather than
        // inventing one, matching `createBranch`'s own 422-recovery convention.
        throw error;
      }

      const existing = matches[0];
      if (existing === undefined) throw error;

      const result = await buildDraftPullRequestResult(
        admitted.idempotencyKey,
        admitted.repositoryFullName,
        existing
      );
      await idempotencyStore.set(key, result);
      return result;
    }
  };

  return { createDraftPullRequest };
};
