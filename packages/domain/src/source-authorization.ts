import type {
  ProjectId,
  SourceAuthorizationPolicy,
  SourceRef,
  WorkspaceId
} from "@autostack/contracts";

/**
 * Why a run was refused. Codes are stable strings so a refusal can be recorded, searched, and
 * distinguished from a classification failure without parsing a message. There is deliberately no
 * `allowed` code: permission is carried by the `ok: true` branch and by the entry that granted it.
 */
export type SourceAuthorizationRefusalCode =
  | "no_policy"
  | "workspace_mismatch"
  | "project_out_of_scope"
  | "missing_actor_id"
  | "requester_not_authorized";

/** The policy entry that granted a run — recorded so a decision names what allowed it. */
export type AuthorizedRequester = SourceAuthorizationPolicy["authorizedRequesters"][number];

export type SourceAuthorizationDecision =
  | Readonly<{ readonly ok: true; readonly matched: AuthorizedRequester }>
  | Readonly<{ readonly ok: false; readonly code: SourceAuthorizationRefusalCode }>;

/**
 * Everything the decision is allowed to see. Note what is absent: no title, no description, no
 * comment body, no labels — nothing an attacker writes. A mention is an address, never a grant
 * (spec §4.4), so there is no code path from work-item text to this decision and no phrasing can
 * reach one.
 *
 * `requester` is a superset of `WorkItemSchema.requester`: `externalId` is optional here even
 * though the work-item schema requires it, because "the delivery carried no actor id" is a state
 * this function must be able to refuse rather than one it may assume away.
 */
export interface SourceAuthorizationRequest {
  readonly workspaceId: WorkspaceId;
  /** The project this run is for. Absent means the run named none — see the scope rule below. */
  readonly projectId?: ProjectId | undefined;
  /** Only `source.kind` is read: it is half the match key, and the rest is delivery detail. */
  readonly source: SourceRef;
  readonly requester: {
    readonly externalId?: string | undefined;
    /** Carried for humans to read. Never compared — display names are impersonable. */
    readonly displayName?: string | undefined;
  };
}

const refuse = (code: SourceAuthorizationRefusalCode): SourceAuthorizationDecision => ({
  ok: false,
  code
});

/**
 * May THIS actor start a run for THIS scope? Spec §8.2's first triage bullet, decided from durable
 * policy alone. Refusal is the base case and permission the exception, so every path that cannot
 * positively establish a match returns a refusal — a wrongly refused run costs an operator a
 * minute and says why, while a wrongly allowed one puts attacker text in front of a model holding
 * repository credentials and says nothing.
 *
 * The match key is `(source.kind, requester.externalId)`, compared exactly. Both halves are
 * load-bearing: a GitHub login, a Slack user id, and an API client id are minted by different
 * authorities and collide by string equality, so an entry is not portable across source kinds.
 * Comparison is not case-folded — folding is a per-platform guess whose wrong answers *grant*,
 * while exact comparison's wrong answers only refuse.
 *
 * Scope: a policy naming a `projectId` authorizes that project and no other, including a run that
 * names no project. A policy naming none is workspace-wide, and that widening is an explicit act
 * by whoever wrote the policy — never an inference drawn from a missing field at decision time.
 *
 * The policy is taken already parsed (`SourceAuthorizationPolicySchema` at composition) and
 * `undefined` when no record is in force. `undefined` is not "unrestricted": it is the most common
 * absent value in practice, and it refuses.
 */
export const authorizeRunSource = (
  request: SourceAuthorizationRequest,
  policy: SourceAuthorizationPolicy | undefined
): SourceAuthorizationDecision => {
  if (policy === undefined) return refuse("no_policy");
  if (policy.workspaceId !== request.workspaceId) return refuse("workspace_mismatch");
  if (policy.projectId !== undefined && policy.projectId !== request.projectId) {
    return refuse("project_out_of_scope");
  }

  const externalId = request.requester.externalId;
  // Presence before comparison. An implementation that compares first can be matched by a
  // malformed entry, and one that falls back to `displayName` hands the run to an impersonator.
  if (externalId === undefined || externalId.trim().length === 0) {
    return refuse("missing_actor_id");
  }

  // `.find` over the entries, with no length short-circuit anywhere near it: a policy that lists
  // nobody authorizes nobody, and the empty list is the only input that separates this from
  // `entries.length === 0 || entries.some(match)`.
  const matched = policy.authorizedRequesters.find(
    (entry) => entry.source === request.source.kind && entry.externalId === externalId
  );
  return matched === undefined
    ? refuse("requester_not_authorized")
    : { ok: true, matched: { source: matched.source, externalId: matched.externalId } };
};
