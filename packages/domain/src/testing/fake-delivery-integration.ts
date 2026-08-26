import {
  DraftPullRequestResultSchema,
  GitHubProgressCommentRequestSchema,
  GitHubProgressCommentResultSchema,
  SlackProgressRequestSchema,
  admitDraftPullRequestRequest,
  type DeliveryIntegrationPort,
  type DraftPullRequestRequest,
  type DraftPullRequestResult,
  type GitHubProgressCommentRequest,
  type GitHubProgressCommentResult,
  type GitHubProgressIntegrationPort,
  type SlackProgressRequest
} from "@autostack/contracts";

export type FakeDeliveryOperation =
  "createDraftPullRequest" | "postSlackProgress" | "upsertProgressComment";

export interface FakeDeliveryIntegrationOptions {
  readonly now: () => string;
  readonly pullRequestNumber: () => number;
  readonly commentId: () => number;
  readonly providerEvidenceDigest: () => string;
  /** Errors are consumed in order per operation, so a retry after an injected failure succeeds. */
  readonly failures?: Partial<Record<FakeDeliveryOperation, readonly Error[]>>;
}

/** The head branch a publication targeted, recorded once per approved scope. */
export interface FakeDeliveryBranch {
  readonly repositoryFullName: string;
  readonly base: string;
  readonly head: string;
}

/** One editable GitHub progress comment, keyed by the contract's comment identity (spec §4.4). */
export interface FakeProgressComment {
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly commentId: number;
  readonly body: string;
  readonly evidenceDigest: string;
  readonly updatedAt: string;
}

export interface FakeDeliveryIntegration
  extends DeliveryIntegrationPort, GitHubProgressIntegrationPort {
  readonly branches: readonly FakeDeliveryBranch[];
  readonly pullRequests: readonly DraftPullRequestResult[];
  readonly comments: readonly FakeProgressComment[];
  readonly slackProgress: readonly SlackProgressRequest[];
}

const commentIdentity = (repositoryFullName: string, issueNumber: number, id: number): string =>
  `${repositoryFullName}#${issueNumber}#${id}`;

export const createFakeDeliveryIntegration = (
  options: FakeDeliveryIntegrationOptions
): FakeDeliveryIntegration => {
  const branches: FakeDeliveryBranch[] = [];
  const pullRequests = new Map<string, DraftPullRequestResult>();
  const slackProgress = new Map<string, SlackProgressRequest>();
  const comments = new Map<string, FakeProgressComment>();
  const commentResults = new Map<string, GitHubProgressCommentResult>();
  const consumedFailures = new Map<FakeDeliveryOperation, number>();

  const injectFailure = (operation: FakeDeliveryOperation): void => {
    const queued = options.failures?.[operation] ?? [];
    const consumed = consumedFailures.get(operation) ?? 0;
    const failure = queued[consumed];
    if (failure === undefined) return;
    consumedFailures.set(operation, consumed + 1);
    throw failure;
  };

  const createDraftPullRequest = async (
    request: DraftPullRequestRequest
  ): Promise<DraftPullRequestResult> => {
    const admitted = await admitDraftPullRequestRequest(request);
    injectFailure("createDraftPullRequest");

    const replayed = pullRequests.get(admitted.idempotencyKey);
    if (replayed !== undefined) return replayed;

    const number = options.pullRequestNumber();
    const result = DraftPullRequestResultSchema.parse({
      schemaVersion: 1,
      idempotencyKey: admitted.idempotencyKey,
      repositoryFullName: admitted.repositoryFullName,
      number,
      url: `https://github.com/${admitted.repositoryFullName}/pull/${number}`,
      draft: true,
      providerEvidenceDigest: options.providerEvidenceDigest(),
      createdAt: options.now()
    });
    pullRequests.set(admitted.idempotencyKey, result);
    if (
      !branches.some(
        (branch) =>
          branch.repositoryFullName === admitted.repositoryFullName &&
          branch.base === admitted.base &&
          branch.head === admitted.head
      )
    ) {
      branches.push({
        repositoryFullName: admitted.repositoryFullName,
        base: admitted.base,
        head: admitted.head
      });
    }
    return result;
  };

  const postSlackProgress = async (request: SlackProgressRequest): Promise<void> => {
    const parsed = SlackProgressRequestSchema.parse(request);
    injectFailure("postSlackProgress");
    if (slackProgress.has(parsed.idempotencyKey)) return;
    slackProgress.set(parsed.idempotencyKey, parsed);
  };

  const upsertProgressComment = async (
    request: GitHubProgressCommentRequest
  ): Promise<GitHubProgressCommentResult> => {
    const parsed = GitHubProgressCommentRequestSchema.parse(request);
    injectFailure("upsertProgressComment");

    const replayed = commentResults.get(parsed.idempotencyKey);
    if (replayed !== undefined) return replayed;

    const edited = parsed.commentId;
    if (
      edited !== undefined &&
      !comments.has(commentIdentity(parsed.repositoryFullName, parsed.issueNumber, edited))
    ) {
      throw new TypeError(
        `The fake delivery integration never created comment ${edited} on ${parsed.repositoryFullName}#${parsed.issueNumber}.`
      );
    }

    const updated = edited !== undefined;
    const commentId = edited ?? options.commentId();
    const postedAt = options.now();
    const result = GitHubProgressCommentResultSchema.parse({
      schemaVersion: 1,
      idempotencyKey: parsed.idempotencyKey,
      repositoryFullName: parsed.repositoryFullName,
      issueNumber: parsed.issueNumber,
      commentId,
      url: `https://github.com/${parsed.repositoryFullName}/issues/${parsed.issueNumber}#issuecomment-${commentId}`,
      updated,
      postedAt
    });
    comments.set(commentIdentity(parsed.repositoryFullName, parsed.issueNumber, commentId), {
      repositoryFullName: parsed.repositoryFullName,
      issueNumber: parsed.issueNumber,
      commentId,
      body: parsed.body,
      evidenceDigest: parsed.evidenceDigest,
      updatedAt: postedAt
    });
    commentResults.set(parsed.idempotencyKey, result);
    return result;
  };

  return {
    get branches() {
      return [...branches];
    },
    get pullRequests() {
      return [...pullRequests.values()];
    },
    get comments() {
      return [...comments.values()];
    },
    get slackProgress() {
      return [...slackProgress.values()];
    },
    createDraftPullRequest,
    postSlackProgress,
    upsertProgressComment
  };
};
