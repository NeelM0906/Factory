import {
  ApprovalSchema,
  CommandAuthorizationSchema,
  CommandScopeSchema,
  PendingDomainEventSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestLocalExecutionPhase,
  type Actor,
  type Approval,
  type CommandAuthorization,
  type CommandId,
  type CommandSpec,
  type EnvironmentAuthorization,
  type IdFactory,
  type PendingDomainEvent
} from "@autostack/contracts";

/**
 * The three durable records one in-envelope command mints: a `permission` approval, the command
 * authorization it covers, and the `command.authorization_recorded` event that seals both onto the
 * run stream. They live apart from the decision in `command-authorization.ts` for the same reason
 * `pipeline-approval-records.ts` lives apart from `pipeline-approval.ts` — these are sealed values
 * with their own digest rules, and getting a digest wrong makes `admitStartCommand` refuse a
 * perfectly valid derivation, while the refusals themselves are ordinary control flow.
 *
 * Nothing here decides anything. Every guard runs before this module is reached.
 */

/**
 * How long a derived command authorization stays admissible, in milliseconds. Much shorter than the
 * environment's window: a command authorization is minted immediately before the command runs, so a
 * long window buys nothing and widens the replay surface. The effective expiry is never later than
 * the environment authorization's own.
 */
export const COMMAND_AUTHORIZATION_TTL_MS = 60 * 60 * 1_000;

/** `digestCommandAuthorization` parses under the full schema, which requires a `digest` to drop. */
const PLACEHOLDER_DIGEST = "0".repeat(64);

export interface DerivedCommandAuthorization {
  readonly commandId: CommandId;
  readonly command: CommandSpec;
  readonly approval: Approval;
  readonly authorization: CommandAuthorization;
  readonly event: PendingDomainEvent;
}

export interface CommandAuthorizationRecordInput {
  readonly commandId: CommandId;
  /** Already validated against the approved plan and pinned to the environment's cwd root. */
  readonly command: CommandSpec;
  readonly action: "implement" | "verify";
  readonly environmentAuthorization: EnvironmentAuthorization;
  /** The credentials this command actually references — never the environment's whole set. */
  readonly allowedCredentialRefIds: readonly string[];
  /** The human who approved the plan, read from its durable decision (D13). */
  readonly approver: NonNullable<Approval["decision"]>;
  readonly eligibleApproverIds: readonly string[];
  /** Who caused the derivation — the station. Recorded on the event, never on the approval. */
  readonly actor: Actor;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ids: Pick<IdFactory, "approval" | "commandAuthorization">;
}

/**
 * Seals one command's records.
 *
 * `admitStartCommand` requires the permission approval's `evidenceDigest` to equal the command
 * authorization's `approvalEvidenceDigest`, which must equal `digestCommandScope(scope)` — and every
 * scope carries its own `commandDigest`. So **each command necessarily gets its own approval**, and
 * one approval can never be made to cover two commands.
 */
export const sealCommandAuthorizationRecords = async (
  input: CommandAuthorizationRecordInput
): Promise<DerivedCommandAuthorization> => {
  const environment = input.environmentAuthorization;
  const scope = environment.scope;
  const commandScope = CommandScopeSchema.parse({
    environmentAuthorizationId: environment.id,
    environmentAuthorizationDigest: environment.digest,
    workspaceId: scope.workspaceId,
    runId: scope.runId,
    environmentId: scope.environmentId,
    commandId: input.commandId,
    action: input.action,
    commandDigest: await digestCommandSpec(input.command),
    repositoryIdentity: scope.repositoryIdentity,
    sourceCommit: scope.sourceCommit,
    branch: scope.branch,
    cwdRoot: scope.cwdRoot,
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    // Narrowing only: cpu and memory are the environment's ceilings, and the duration is this
    // command's own timeout rather than the whole environment's budget.
    resourceLimits: {
      cpu: scope.resourceLimits.cpu,
      memoryMb: scope.resourceLimits.memoryMb,
      durationSeconds: input.command.timeoutSeconds
    },
    allowedCredentialRefIds: [...input.allowedCredentialRefIds]
  });

  const approvalEvidenceDigest = await digestCommandScope(commandScope);
  const approvalId = input.ids.approval();
  const approval = ApprovalSchema.parse({
    schemaVersion: 1,
    id: approvalId,
    workspaceId: scope.workspaceId,
    runId: scope.runId,
    kind: "permission",
    status: "approved",
    evidenceDigest: approvalEvidenceDigest,
    eligibleApproverIds: [...input.eligibleApproverIds],
    decision: {
      decision: "approved",
      actor: input.approver.actor,
      origin: input.approver.origin,
      decidedAt: input.createdAt
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });

  const draft = {
    id: input.ids.commandAuthorization(),
    approvalId,
    approvalEvidenceDigest,
    scope: commandScope,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    digest: PLACEHOLDER_DIGEST
  };
  const authorization = CommandAuthorizationSchema.parse({
    ...draft,
    digest: await digestCommandAuthorization(draft)
  });

  const payload = {
    runId: scope.runId,
    environmentId: scope.environmentId,
    commandId: input.commandId,
    authorization,
    phaseKey: `command:${input.commandId}:authorization`
  };
  const event = PendingDomainEventSchema.parse({
    workspaceId: scope.workspaceId,
    actor: input.actor,
    correlationId: input.correlationId,
    occurredAt: input.createdAt,
    type: "command.authorization_recorded",
    payload: {
      ...payload,
      phaseDigest: await digestLocalExecutionPhase("command.authorization_recorded", payload)
    }
  });

  return { commandId: input.commandId, command: input.command, approval, authorization, event };
};
