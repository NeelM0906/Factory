import { IngressDeliverySchema, type IngressDelivery } from "@autostack/contracts";
import { z } from "zod";

/** The GitHub member of the `IngressDelivery` discriminated union. */
export type GitHubIngressDelivery = Extract<IngressDelivery, { readonly provider: "github" }>;

export type GitHubUnsupportedEventReason = "unsupported_event" | "not_actionable";

/**
 * Thrown when an inbound GitHub delivery must be silently ignored rather than turned into an
 * `IngressDelivery` -- either an event/action combination AutoStack does not process at all
 * (`"unsupported_event"`), or a processed event that fails its trigger condition, e.g. an
 * `issues.labeled` delivery whose label is not `autostack` (`"not_actionable"`). This is
 * deliberately a plain `Error`, not a `GitHubRequestError`: it is not an API-call failure, it is
 * a routing decision. The ingress route (Task 15) catches it and answers `202 ignored`, never a
 * `500` -- GitHub's redelivery treats a `5xx` as "try again", and retrying a delivery we
 * intentionally ignore would just make AutoStack loop on it forever.
 */
export class GitHubUnsupportedEventError extends Error {
  readonly event: string;
  readonly reason: GitHubUnsupportedEventReason;

  constructor(event: string, reason: GitHubUnsupportedEventReason) {
    super(`GitHub webhook delivery "${event}" is unsupported and safely ignored (${reason}).`);
    this.name = "GitHubUnsupportedEventError";
    this.event = event;
    this.reason = reason;
    Object.freeze(this);
  }
}

// The only issue label whose presence makes an `issues.labeled` delivery actionable (spec §4.4:
// "An issue labeled `autostack`"). A labeled event carrying any other label is not-actionable.
const TRIGGER_LABEL = "autostack";

/**
 * The mention that makes an `issue_comment.created` delivery actionable (spec §4.4: "An
 * authorized `@AutoStack` mention on an issue or pull request").
 *
 * This gate is the exact counterpart of {@link TRIGGER_LABEL}, and it lives here for the same
 * reason: both answer *addressing* — is this event directed at AutoStack at all? Without it every
 * comment on every issue in the repository becomes an `IngressDelivery`, which is both a flood on
 * any busy repository and a §14.1 concern, since untrusted third-party text would be driving work
 * creation. Gating a labeled event but not a comment would be an asymmetry with no justification.
 *
 * Deliberately NOT decided here: the "authorized" half of the spec's phrase. Whether *this actor*
 * may start a run is an authorization question requiring workspace and actor policy that this
 * adapter does not have and must not invent — a mention is an address, never a grant (§14.1).
 * That check belongs downstream, on `issue.authorId`, which for a comment delivery is the
 * commenter. Actionability beyond addressing — duplicate detection, task typing, clarification —
 * likewise remains triage's job.
 */
const TRIGGER_MENTION = "@autostack";

/**
 * True when `text` mentions the AutoStack handle. Case-insensitive, because GitHub handles are,
 * and bounded on the right so `@autostack-bot` or `@autostackery` — different handles entirely —
 * do not count as a mention of this one.
 */
const mentionsAutoStack = (text: string): boolean => {
  const haystack = text.toLowerCase();
  let index = haystack.indexOf(TRIGGER_MENTION);
  while (index !== -1) {
    const next = haystack[index + TRIGGER_MENTION.length];
    if (next === undefined || !/[a-z0-9-]/.test(next)) return true;
    index = haystack.indexOf(TRIGGER_MENTION, index + 1);
  }
  return false;
};

const SUPPORTED_EVENTS = new Set([
  "issues.opened",
  "issues.edited",
  "issues.labeled",
  "issue_comment.created"
]);

const GitHubUserPayloadSchema = z.object({ id: z.union([z.number(), z.string()]) });

const GitHubRepositoryPayloadSchema = z.object({
  id: z.union([z.number(), z.string()]),
  full_name: z.string().min(1)
});

const GitHubIssuePayloadSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  user: GitHubUserPayloadSchema
});

const GitHubIssuesEventPayloadSchema = z.object({
  action: z.string().min(1),
  repository: GitHubRepositoryPayloadSchema,
  issue: GitHubIssuePayloadSchema,
  label: z.object({ name: z.string() }).optional()
});

const GitHubIssueCommentEventPayloadSchema = z.object({
  action: z.string().min(1),
  repository: GitHubRepositoryPayloadSchema,
  issue: GitHubIssuePayloadSchema,
  comment: z.object({
    body: z.string(),
    user: GitHubUserPayloadSchema
  })
});

const ActionEnvelopeSchema = z.object({ action: z.string().min(1) });

/**
 * Builds the logical dedup key shared by every GitHub ingress delivery. Deliberately excludes
 * `deliveryId`: GitHub assigns a fresh `X-GitHub-Delivery` id on every redelivery, so folding it
 * in would defeat deduplication entirely -- the key must identify the real-world event (this
 * issue, this event kind, this repository), not the delivery attempt.
 */
export const buildGitHubDeliveryDeduplicationKey = (
  repositoryId: string,
  issueNumber: number,
  event: string
): string => `github:${repositoryId}:${issueNumber}:${event}`;

export interface ParseGitHubDeliveryInput {
  readonly eventHeader: string; // X-GitHub-Event, e.g. "issues" or "issue_comment"
  readonly deliveryIdHeader: string; // X-GitHub-Delivery
  readonly payload: unknown;
  readonly receivedAt: string;
}

interface DeliveryFields {
  readonly event: string;
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly authorId: string;
}

const buildDelivery = (fields: DeliveryFields): GitHubIngressDelivery => {
  const candidate = {
    schemaVersion: 1 as const,
    provider: "github" as const,
    deliveryId: fields.deliveryId,
    deduplicationKey: buildGitHubDeliveryDeduplicationKey(
      fields.repositoryId,
      fields.issueNumber,
      fields.event
    ),
    receivedAt: fields.receivedAt,
    event: fields.event,
    repository: { id: fields.repositoryId, fullName: fields.repositoryFullName },
    issue: {
      number: fields.issueNumber,
      title: fields.title,
      body: fields.body,
      authorId: fields.authorId
    }
  };

  // Boundary validation (Global constraints): the contract's own schema is the single source of
  // truth for what a valid delivery looks like, so it is applied here rather than re-implemented
  // (this is also what rejects an oversized body via `.max(100_000)` and a credential-shaped
  // title via `SafeMetadataStringSchema`, without any extra code in this module).
  const delivery = IngressDeliverySchema.parse(candidate);
  if (delivery.provider !== "github") {
    throw new Error("GitHub delivery candidate parsed as a non-GitHub delivery.");
  }
  return delivery;
};

/**
 * Maps a GitHub webhook delivery (`X-GitHub-Event` header + JSON payload) onto the
 * `IngressDelivery` contract (spec §4.4 issue-driven intake). Only `issues.opened`,
 * `issues.edited`, `issues.labeled` (with the `autostack` trigger label), and
 * `issue_comment.created` are actionable; everything else -- including a labeled issue carrying
 * a *different* label -- is rejected via {@link GitHubUnsupportedEventError} so the ingress
 * route can acknowledge and ignore it (202), never treat it as a failure (500).
 *
 * For `issue_comment.created`, `issue.body` on the resulting delivery carries the *comment's*
 * text (the actionable content, e.g. an `@AutoStack` mention) rather than the original issue
 * body, and `issue.authorId` is the comment's author. `issue.title` and `issue.number` still
 * identify the issue the comment was posted on.
 */
export const parseGitHubDelivery = (input: ParseGitHubDeliveryInput): GitHubIngressDelivery => {
  const { eventHeader, deliveryIdHeader, payload, receivedAt } = input;

  const { action } = ActionEnvelopeSchema.parse(payload);
  const event = `${eventHeader}.${action}`;

  if (!SUPPORTED_EVENTS.has(event)) {
    throw new GitHubUnsupportedEventError(event, "unsupported_event");
  }

  if (event === "issue_comment.created") {
    const commentPayload = GitHubIssueCommentEventPayloadSchema.parse(payload);

    // Addressing gate, the counterpart of the `issues.labeled` label check below. A comment that
    // does not mention AutoStack is ordinary repository conversation, not a request to this
    // system, so it is acknowledged and ignored rather than admitted as work.
    if (!mentionsAutoStack(commentPayload.comment.body)) {
      throw new GitHubUnsupportedEventError(event, "not_actionable");
    }

    return buildDelivery({
      event,
      deliveryId: deliveryIdHeader,
      receivedAt,
      repositoryId: String(commentPayload.repository.id),
      repositoryFullName: commentPayload.repository.full_name,
      issueNumber: commentPayload.issue.number,
      title: commentPayload.issue.title,
      body: commentPayload.comment.body,
      authorId: String(commentPayload.comment.user.id)
    });
  }

  const issuesPayload = GitHubIssuesEventPayloadSchema.parse(payload);

  if (event === "issues.labeled" && issuesPayload.label?.name !== TRIGGER_LABEL) {
    throw new GitHubUnsupportedEventError(event, "not_actionable");
  }

  return buildDelivery({
    event,
    deliveryId: deliveryIdHeader,
    receivedAt,
    repositoryId: String(issuesPayload.repository.id),
    repositoryFullName: issuesPayload.repository.full_name,
    issueNumber: issuesPayload.issue.number,
    title: issuesPayload.issue.title,
    body: issuesPayload.issue.body ?? "",
    authorId: String(issuesPayload.issue.user.id)
  });
};
