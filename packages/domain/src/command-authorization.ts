import {
  ApprovalSchema,
  CommandAuthorizationSchema,
  CommandScopeSchema,
  CommandSpecSchema,
  PendingDomainEventSchema,
  RelativeWorkspacePathSchema,
  admitPlanDocument,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestLocalExecutionPhase,
  type Actor,
  type Approval,
  type CommandAuthorization,
  type CommandId,
  type CommandSpec,
  type EnvironmentAuthorization,
  type IdFactory,
  type PendingDomainEvent,
  type PipelineEvidence,
  type PlanDocument,
  type VerificationCommand
} from "@autostack/contracts";

import { StaleApprovalEvidenceError } from "./errors.js";
import { futureTimestamp } from "./pipeline-approval-records.js";

/**
 * Derives the per-command `permission` approvals an already-approved plan covers (spec §14.2 gate 2,
 * §14.4; orchestrator ruling E5).
 *
 * This module writes `status: "approved"` approval records **without a fresh human act**, on the
 * strength of the plan approval a human already gave. `admitStartCommand` re-reads those records and
 * cannot tell a derived one from a clicked one — so the whole distinction lives here, in what this
 * function refuses to derive. Its threat analysis is `.superpowers/sdd/task-7-threat-analysis.md`.
 *
 * Refusal is the base case. A wrongly-refused command costs one trip through the out-of-envelope
 * permission route, which exists; a wrongly-derived one runs an attacker-chosen process on the
 * developer's machine and leaves a durable record claiming a human authorized it.
 */

/** Environment entries are declared on `CommandSpecSchema`; contracts exports no standalone type. */
type CommandEnvironmentEntry = CommandSpec["environment"][number];

export type CommandAuthorizationRefusalCode =
  /** No entry in the approved plan matches this command's four fields exactly. */
  | "not_named_by_plan"
  /** The plan named it, but as a shell command, and `CommandSpec` cannot express one. */
  | "shell_not_derivable"
  /** The request named a working directory other than the environment's own cwd root. */
  | "cwd_not_pinned"
  /** A literal environment variable, which no plan approves and which redefines the command. */
  | "literal_environment"
  /** A credential the approved plan or the environment authorization does not name. */
  | "credential_not_named"
  /** A timeout above the environment authorization's own duration ceiling. */
  | "timeout_exceeds_environment";

/**
 * One requested command was outside the approved plan. Carries a stable code and the index of the
 * request that was refused, so a station can record *which* command was refused and why without
 * parsing a message. There is deliberately no "authorized" code: permission is carried only by a
 * returned record.
 */
export class CommandOutsideApprovedPlanError extends Error {
  readonly code: CommandAuthorizationRefusalCode;
  readonly index: number;

  constructor(code: CommandAuthorizationRefusalCode, index: number) {
    super(`Requested command ${index} is outside the approved plan (${code}).`);
    this.name = "CommandOutsideApprovedPlanError";
    this.code = code;
    this.index = index;
  }
}

/**
 * One command a station wants to run. `command` is the plan's own four-field shape so `usesShell` is
 * part of the match key; the remaining fields are execution parameters the plan never named, and
 * each one is separately constrained below.
 */
export interface PlanNamedCommandRequest {
  readonly commandId: CommandId;
  readonly command: VerificationCommand;
  /**
   * The working directory. Absent is not a wildcard: `RelativeWorkspacePathSchema` defaults to `"."`,
   * so omission produces a real value that is refused whenever the environment root is not `"."`.
   */
  readonly cwd?: string | undefined;
  readonly environment: readonly CommandEnvironmentEntry[];
  readonly timeoutSeconds: number;
  readonly terminal: { readonly columns: number; readonly rows: number };
}

export interface DerivePlanNamedCommandAuthorizationsCommand {
  /** The durable plan approval. Its decision supplies the approver — never `actor` below (D13). */
  readonly planApproval: Approval;
  /** The `plan_approval` evidence envelope, which chains the approval to the plan it accepted. */
  readonly planApprovalEvidence: PipelineEvidence;
  /** The `plan` evidence envelope, which names the plan document by digest. */
  readonly planEvidence: PipelineEvidence;
  /** Re-read at derivation time and therefore untrusted: bound to the evidence above by digest. */
  readonly planDocument: PlanDocument;
  readonly environmentAuthorization: EnvironmentAuthorization;
  readonly action: "implement" | "verify";
  readonly requests: readonly PlanNamedCommandRequest[];
  /** Who caused the derivation — the station. Recorded on the event, never on the approval. */
  readonly actor: Actor;
  readonly correlationId: string;
}

export interface DerivePlanNamedCommandAuthorizationsDependencies {
  readonly now: () => string;
  readonly ids: Pick<IdFactory, "approval" | "commandAuthorization">;
  /** Overrides `COMMAND_AUTHORIZATION_TTL_MS`. Composition should set it deliberately. */
  readonly authorizationTtlMs?: number;
}

export interface DerivedCommandAuthorization {
  readonly commandId: CommandId;
  readonly command: CommandSpec;
  readonly approval: Approval;
  readonly authorization: CommandAuthorization;
  readonly event: PendingDomainEvent;
}

export interface DerivedCommandAuthorizations {
  /** The plan evidence every record below descends from — the binding, recorded once. */
  readonly planEvidenceDigest: string;
  readonly derived: readonly DerivedCommandAuthorization[];
}

/**
 * How long a derived command authorization stays admissible, in milliseconds. Much shorter than the
 * environment's window: a command authorization is minted immediately before the command runs, so a
 * long window buys nothing and widens the replay surface. The effective expiry is never later than
 * the environment authorization's own.
 */
export const COMMAND_AUTHORIZATION_TTL_MS = 60 * 60 * 1_000;

/** `digestCommandAuthorization` parses under the full schema, which requires a `digest` to drop. */
const PLACEHOLDER_DIGEST = "0".repeat(64);

const earlier = (left: string, right: string): string =>
  Date.parse(left) <= Date.parse(right) ? left : right;

/**
 * Positional and length-checked, deliberately. A set or multiset comparison would accept reordered
 * arguments, and `every` without the length check accepts an extra trailing argument on whichever
 * side it does not iterate.
 */
const namesCommand = (approved: VerificationCommand, requested: VerificationCommand): boolean =>
  approved.executable === requested.executable &&
  approved.usesShell === requested.usesShell &&
  approved.required === requested.required &&
  approved.args.length === requested.args.length &&
  approved.args.every((argument, index) => argument === requested.args[index]);

/** The human's decision, and the plan bytes it provably accepted. */
interface ApprovedPlan {
  readonly decision: NonNullable<Approval["decision"]>;
  readonly planDocument: PlanDocument;
}

/** The digest chain from the human's decision to the bytes in hand. Every link is checked. */
const assertPlanBinding = async (
  command: DerivePlanNamedCommandAuthorizationsCommand
): Promise<ApprovedPlan> => {
  const { planApproval, planApprovalEvidence, planEvidence } = command;
  const decision = planApproval.decision;
  if (planApproval.kind !== "plan" || planApproval.status !== "approved") {
    throw new TypeError("Commands are derived only from an approved plan approval.");
  }
  if (
    decision === undefined ||
    decision.decision !== "approved" ||
    !planApproval.eligibleApproverIds.includes(decision.actor.id)
  ) {
    throw new TypeError("The plan approval carries no eligible approval decision.");
  }
  if (planApprovalEvidence.stage !== "plan_approval" || planEvidence.stage !== "plan") {
    throw new TypeError("A plan approval and a plan evidence envelope are both required.");
  }
  if (
    planApprovalEvidence.approvalId !== planApproval.id ||
    planApprovalEvidence.actorId !== decision.actor.id
  ) {
    throw new TypeError("The plan approval evidence names a different approval.");
  }
  // Binding by digest, not by id: a matching approval id over changed plan bytes does not authorize.
  if (planApprovalEvidence.approvedEvidenceDigest !== planEvidence.evidenceDigest) {
    throw new StaleApprovalEvidenceError();
  }
  // `admitPlanDocument` recomputes `planDigest` rather than reading it, so a mutated document with a
  // fixed-up self-digest still fails against the evidence envelope, which lives on the run stream.
  const planDocument = await admitPlanDocument(command.planDocument);
  if (planDocument.planDigest !== planEvidence.planDigest) throw new StaleApprovalEvidenceError();
  if (
    planDocument.workspaceId !== planApproval.workspaceId ||
    planDocument.runId !== planApproval.runId
  ) {
    throw new TypeError("The approved plan belongs to a different run.");
  }
  return { decision, planDocument };
};

/** The environment authorization this derivation narrows. Re-digested, never taken on trust. */
const assertEnvironmentBinding = async (
  command: DerivePlanNamedCommandAuthorizationsCommand,
  now: string
): Promise<void> => {
  const { environmentAuthorization: environment, planApproval } = command;
  if (
    environment.approvalId !== planApproval.id ||
    environment.approvalEvidenceDigest !== planApproval.evidenceDigest ||
    environment.scope.workspaceId !== planApproval.workspaceId ||
    environment.scope.runId !== planApproval.runId
  ) {
    throw new TypeError("The environment authorization does not descend from this plan approval.");
  }
  if (environment.digest !== (await digestEnvironmentAuthorization(environment))) {
    throw new StaleApprovalEvidenceError();
  }
  if (Date.parse(environment.expiresAt) <= Date.parse(now)) {
    throw new StaleApprovalEvidenceError();
  }
};

/**
 * Mints one `permission` approval and one command authorization per requested command, and refuses
 * every command the approved plan does not name byte for byte in the environment's own working
 * directory with no execution parameter the plan never granted.
 *
 * Nothing here writes. The caller commits the returned events, so a refusal necessarily precedes any
 * durable record.
 */
export async function derivePlanNamedCommandAuthorizations(
  command: DerivePlanNamedCommandAuthorizationsCommand,
  dependencies: DerivePlanNamedCommandAuthorizationsDependencies
): Promise<DerivedCommandAuthorizations> {
  const now = dependencies.now();
  // The approver is read from the durable decision, never from `command.actor` (D13).
  const { decision: approver, planDocument } = await assertPlanBinding(command);
  await assertEnvironmentBinding(command, now);

  const environment = command.environmentAuthorization;
  const scope = environment.scope;
  // Never later than the environment's own window: a command must not outlive the grant it narrows.
  const expiresAt = earlier(
    futureTimestamp(now, dependencies.authorizationTtlMs ?? COMMAND_AUTHORIZATION_TTL_MS),
    environment.expiresAt
  );
  const derived: DerivedCommandAuthorization[] = [];
  for (const [index, request] of command.requests.entries()) {
    // `.find` over the plan's own list, with no length short-circuit anywhere near it: a plan naming
    // no commands authorizes no commands, and the empty list is the only input separating this from
    // `commands.length === 0 || commands.some(match)`.
    const named = planDocument.verificationCommands.find((entry) =>
      namesCommand(entry, request.command)
    );
    if (named === undefined) throw new CommandOutsideApprovedPlanError("not_named_by_plan", index);
    if (named.usesShell) throw new CommandOutsideApprovedPlanError("shell_not_derivable", index);

    const cwd = RelativeWorkspacePathSchema.parse(request.cwd ?? ".");
    if (cwd !== scope.cwdRoot) throw new CommandOutsideApprovedPlanError("cwd_not_pinned", index);
    if (request.timeoutSeconds > scope.resourceLimits.durationSeconds) {
      throw new CommandOutsideApprovedPlanError("timeout_exceeds_environment", index);
    }

    const credentialRefIds: string[] = [];
    for (const entry of request.environment) {
      // A literal redefines what a byte-identical command does — `NODE_OPTIONS=--require ./x.js`
      // turns an approved test run into arbitrary execution. No plan approves one.
      if (entry.kind === "literal") {
        throw new CommandOutsideApprovedPlanError("literal_environment", index);
      }
      // A secret needs both halves: the plan half is what a human saw, the environment half is what
      // the earlier authorization granted.
      if (
        !planDocument.requiredCredentialRefIds.includes(entry.credentialRefId) ||
        !scope.allowedCredentialRefIds.includes(entry.credentialRefId)
      ) {
        throw new CommandOutsideApprovedPlanError("credential_not_named", index);
      }
      if (!credentialRefIds.includes(entry.credentialRefId)) {
        credentialRefIds.push(entry.credentialRefId);
      }
    }

    // Built from the plan's own strings rather than the request's equal copies, and pinned to the
    // environment's root — the runner only requires the cwd to be *within* that root, which is a
    // floor rather than this function's ceiling.
    const spec = CommandSpecSchema.parse({
      executable: named.executable,
      args: named.args,
      cwd,
      environment: request.environment,
      timeoutSeconds: request.timeoutSeconds,
      terminal: request.terminal
    });
    const commandScope = CommandScopeSchema.parse({
      environmentAuthorizationId: environment.id,
      environmentAuthorizationDigest: environment.digest,
      workspaceId: scope.workspaceId,
      runId: scope.runId,
      environmentId: scope.environmentId,
      commandId: request.commandId,
      action: command.action,
      commandDigest: await digestCommandSpec(spec),
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
        durationSeconds: request.timeoutSeconds
      },
      allowedCredentialRefIds: credentialRefIds
    });

    // `admitStartCommand` requires the permission approval's `evidenceDigest` to equal the command
    // authorization's `approvalEvidenceDigest`, which must equal this scope's digest — so each
    // command necessarily gets its own approval, and one approval can never cover two commands.
    const approvalEvidenceDigest = await digestCommandScope(commandScope);
    const approvalId = dependencies.ids.approval();
    const approval = ApprovalSchema.parse({
      schemaVersion: 1,
      id: approvalId,
      workspaceId: scope.workspaceId,
      runId: scope.runId,
      kind: "permission",
      status: "approved",
      evidenceDigest: approvalEvidenceDigest,
      eligibleApproverIds: command.planApproval.eligibleApproverIds,
      decision: {
        decision: "approved",
        actor: approver.actor,
        origin: approver.origin,
        decidedAt: now
      },
      createdAt: now,
      updatedAt: now
    });
    const draft = {
      id: dependencies.ids.commandAuthorization(),
      approvalId,
      approvalEvidenceDigest,
      scope: commandScope,
      createdAt: now,
      expiresAt,
      digest: PLACEHOLDER_DIGEST
    };
    const authorization = CommandAuthorizationSchema.parse({
      ...draft,
      digest: await digestCommandAuthorization(draft)
    });

    const payload = {
      runId: scope.runId,
      environmentId: scope.environmentId,
      commandId: request.commandId,
      authorization,
      phaseKey: `command:${request.commandId}:authorization`
    };
    const event = PendingDomainEventSchema.parse({
      workspaceId: scope.workspaceId,
      actor: command.actor,
      correlationId: command.correlationId,
      occurredAt: now,
      type: "command.authorization_recorded",
      payload: {
        ...payload,
        phaseDigest: await digestLocalExecutionPhase("command.authorization_recorded", payload)
      }
    });
    derived.push({ commandId: request.commandId, command: spec, approval, authorization, event });
  }

  return { planEvidenceDigest: command.planEvidence.evidenceDigest, derived };
}
