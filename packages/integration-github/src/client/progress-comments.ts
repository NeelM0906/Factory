import { z } from "zod";

import {
  GitHubProgressCommentRequestSchema,
  GitHubProgressCommentResultSchema,
  type GitHubProgressCommentRequest,
  type GitHubProgressCommentResult
} from "@autostack/contracts";

import { GitHubRequestError } from "../errors.js";
import type { IdempotencyRecordStore } from "../idempotency.js";
import type { GitHubTransport } from "./transport.js";

/** Keys stored under `IdempotencyRecordStore` are namespaced per operation (decision D4). */
const IDEMPOTENCY_NAMESPACE = "github.progress-comment";
const namespacedIdempotencyKey = (idempotencyKey: string): string =>
  `${IDEMPOTENCY_NAMESPACE}:${idempotencyKey}`;

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/**
 * Splits `owner/repo` and URL-encodes each segment separately, exactly like
 * `client/pull-requests.ts` and `client/branch-refs.ts` do -- a joined-string encoding would
 * leave a literal "/" inside a segment unescaped. Duplicated locally rather than imported: those
 * two modules are on the do-not-touch list for this task, and consolidating this helper is a
 * deliberate Task 9 cleanup, not something to do while tasks are landing in parallel.
 */
const encodeRepositoryPath = (repositoryFullName: string): string => {
  if (!REPOSITORY_FULL_NAME_PATTERN.test(repositoryFullName)) {
    throw new GitHubRequestError(
      `Repository full name "${repositoryFullName}" is not a valid "owner/repo" pair.`,
      0,
      "invalid_request",
      false
    );
  }
  const slashIndex = repositoryFullName.indexOf("/");
  const owner = repositoryFullName.slice(0, slashIndex);
  const repo = repositoryFullName.slice(slashIndex + 1);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
};

// GitHub's issue-comment payload (create response and edit response share this shape) carries
// many more fields than this; only the ones the result needs are modeled. Zod ignores unmodeled
// fields by default, so this is not `.strict()`.
const gitHubIssueCommentResponseSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.url(),
  updated_at: z.string()
});

export interface GitHubProgressCommentsClient {
  upsertProgressComment(
    request: GitHubProgressCommentRequest
  ): Promise<GitHubProgressCommentResult>;
}

export interface CreateProgressCommentsClientOptions {
  readonly transport: GitHubTransport;
  readonly idempotencyStore: IdempotencyRecordStore;
}

/**
 * Creates or edits AutoStack's one editable progress comment per run (spec §4.4).
 *
 * Ordering, matching `createFakeDeliveryIntegration.upsertProgressComment` exactly: parse/admit
 * the request first (`GitHubProgressCommentRequestSchema.parse`, whose `body` field is
 * `SafeMetadataStringSchema.max(60_000)` -- so an over-budget body or one carrying sensitive
 * material, per `containsSensitiveMaterial`, throws right here, before any network call), THEN
 * check the idempotency table, and only after both of those does any network call happen. A
 * replay therefore short-circuits before a stubbed-to-fail transport is ever reached.
 *
 * With no `commentId`, this POSTs a new comment. With a `commentId`, this PATCHes that exact
 * comment in place -- never a second POST -- so a caller retrying an edit can never end up with
 * two comments. A `404` on the edit (the comment was deleted by a human between runs) is not
 * recovered by falling back to create: `transport.request` throws `GitHubRequestError` with
 * `code: "not_found"` and that propagates unchanged, so the human's deletion is never silently
 * undone. The caller decides what to do next.
 */
export const createProgressCommentsClient = (
  options: CreateProgressCommentsClientOptions
): GitHubProgressCommentsClient => {
  const { transport, idempotencyStore } = options;

  const upsertProgressComment = async (
    request: GitHubProgressCommentRequest
  ): Promise<GitHubProgressCommentResult> => {
    const admitted = GitHubProgressCommentRequestSchema.parse(request);
    const key = namespacedIdempotencyKey(admitted.idempotencyKey);

    const replayed = await idempotencyStore.get<GitHubProgressCommentResult>(key);
    if (replayed !== undefined) return replayed;

    const repoPath = encodeRepositoryPath(admitted.repositoryFullName);
    const isEdit = admitted.commentId !== undefined;

    const response = isEdit
      ? await transport.request({
          method: "PATCH",
          path: `/repos/${repoPath}/issues/comments/${admitted.commentId}`,
          body: { body: admitted.body },
          schema: gitHubIssueCommentResponseSchema
        })
      : await transport.request({
          method: "POST",
          path: `/repos/${repoPath}/issues/${admitted.issueNumber}/comments`,
          body: { body: admitted.body },
          schema: gitHubIssueCommentResponseSchema
        });

    const result = GitHubProgressCommentResultSchema.parse({
      schemaVersion: 1,
      idempotencyKey: admitted.idempotencyKey,
      repositoryFullName: admitted.repositoryFullName,
      issueNumber: admitted.issueNumber,
      commentId: response.id,
      url: response.html_url,
      updated: isEdit,
      postedAt: response.updated_at
    });

    await idempotencyStore.set(key, result);
    return result;
  };

  return { upsertProgressComment };
};
