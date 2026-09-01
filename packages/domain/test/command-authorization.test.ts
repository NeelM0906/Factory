import {
  ApprovalIdSchema,
  RunIdSchema,
  ApprovalSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  CredentialRefIdSchema,
  EnvironmentAuthorizationIdSchema,
  ExecutionScopeSchema,
  PipelineEvidenceSchema,
  PlanDocumentSchema,
  admitStartCommand,
  digestExecutionScope,
  digestPlanDocument,
  digestVersionedValue,
  validateCommandAuthorizationAgainstEnvironment,
  type Actor,
  type Approval,
  type CommandSpec,
  type EnvironmentAuthorization,
  type ExecutionScope,
  type PipelineEvidence,
  type PlanDocument,
  type TrustedRunnerAdmissionDependencies,
  type VerificationCommand
} from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import {
  CommandOutsideApprovedPlanError,
  derivePlanNamedCommandAuthorizations,
  type DerivePlanNamedCommandAuthorizationsCommand,
  type DerivePlanNamedCommandAuthorizationsDependencies,
  type DerivedCommandAuthorization,
  type DerivedCommandAuthorizations,
  type PlanNamedCommandRequest
} from "../src/command-authorization.js";
import { StaleApprovalEvidenceError } from "../src/errors.js";
import {
  PIPELINE_EVIDENCE_DIGEST_DOMAIN,
  authorizeEnvironment,
  sealPlanApprovalEvidence
} from "../src/pipeline-approval-records.js";

const PLAN_PRODUCED_AT = "2026-08-26T12:00:00.000Z";
const DECIDED_AT = "2026-08-26T12:05:00.000Z";
const DERIVED_AT = "2026-08-26T12:10:00.000Z";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174001";
/** A second run and approval, used only to prove the evidence chain is bound to identity. */
const OTHER_RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-4266141740aa");
const OTHER_APPROVAL_ID = ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-4266141740bb");
const WORK_ITEM_ID = "wi_123e4567-e89b-42d3-a456-426614174002";
const PLAN_APPROVAL_ID = "apr_123e4567-e89b-42d3-a456-426614174003";
const PERMISSION_APPROVAL_ID = "apr_123e4567-e89b-42d3-a456-426614174004";
const ENVIRONMENT_AUTHORIZATION_ID = "envauth_123e4567-e89b-42d3-a456-426614174005";
const COMMAND_AUTHORIZATION_ID = "cmdauth_123e4567-e89b-42d3-a456-426614174006";
const COMMAND_ID = "cmd_123e4567-e89b-42d3-a456-426614174007";
const ENVIRONMENT_ID = "env_123e4567-e89b-42d3-a456-426614174008";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174009";
const CREDENTIAL_REF_ID = "cred_123e4567-e89b-42d3-a456-42661417400a";
const OTHER_CREDENTIAL_REF_ID = "cred_123e4567-e89b-42d3-a456-42661417400b";
const REPOSITORY = "github.com/autostack/factory";
const SOURCE_COMMIT = "a".repeat(40);
const PLACEHOLDER_DIGEST = "0".repeat(64);
const HUMAN: Actor = { kind: "user", id: "local-user", displayName: "Local User" };
const STATION: Actor = { kind: "system", id: "pipeline.verify" };

/**
 * The command a human approved. Three arguments, so "reordered", "one extra" and "one removed" are
 * each distinguishable from the approved form and from each other.
 */
const APPROVED_COMMAND: VerificationCommand = {
  executable: "pnpm",
  args: ["test", "--filter", "@autostack/domain"],
  usesShell: false,
  required: true
};

const scopeFor = (cwdRoot = ".", credentialRefIds: readonly string[] = []): ExecutionScope =>
  ExecutionScopeSchema.parse({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId: ENVIRONMENT_ID,
    repositoryIdentity: REPOSITORY,
    sourceCommit: SOURCE_COMMIT,
    branch: "autostack/run/123e4567-e89b-42d3-a456-426614174001",
    cwdRoot,
    resourceLimits: { cpu: 2, memoryMb: 4_096, durationSeconds: 1_800 },
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    allowedCredentialRefIds: [...credentialRefIds]
  });

const planDocumentFor = async (
  commands: readonly VerificationCommand[] = [APPROVED_COMMAND],
  requiredCredentialRefIds: readonly string[] = []
): Promise<PlanDocument> => {
  const body = {
    schemaVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    summary: "Derive command authorizations from the approved plan.",
    acceptanceCriteria: ["No command outside the approved plan is ever authorized."],
    affectedAreas: [],
    risks: [],
    verificationCommands: [...commands],
    requiredPermissions: [],
    requiredCredentialRefIds: [...requiredCredentialRefIds],
    producedAt: PLAN_PRODUCED_AT
  };
  const planDigest = await digestPlanDocument({ ...body, planDigest: PLACEHOLDER_DIGEST });
  return PlanDocumentSchema.parse({ ...body, planDigest });
};

const planEvidenceFor = async (document: PlanDocument): Promise<PipelineEvidence> => {
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "plan",
    artifactIds: [],
    planDigest: document.planDigest,
    producedAt: PLAN_PRODUCED_AT
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const planApprovalFor = async (scope: ExecutionScope): Promise<Approval> =>
  ApprovalSchema.parse({
    schemaVersion: 1,
    id: PLAN_APPROVAL_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    kind: "plan",
    status: "approved",
    evidenceDigest: await digestExecutionScope(scope),
    eligibleApproverIds: [HUMAN.id],
    decision: { decision: "approved", actor: HUMAN, origin: "desktop", decidedAt: DECIDED_AT },
    createdAt: PLAN_PRODUCED_AT,
    updatedAt: DECIDED_AT
  });

const environmentAuthorizationFor = async (
  scope: ExecutionScope,
  ttlMs?: number
): Promise<EnvironmentAuthorization> =>
  authorizeEnvironment({
    id: EnvironmentAuthorizationIdSchema.parse(ENVIRONMENT_AUTHORIZATION_ID),
    approvalId: ApprovalIdSchema.parse(PLAN_APPROVAL_ID),
    approvalEvidenceDigest: await digestExecutionScope(scope),
    scope,
    createdAt: DECIDED_AT,
    ...(ttlMs === undefined ? {} : { ttlMs })
  });

const requestFor = (overrides: Partial<PlanNamedCommandRequest> = {}): PlanNamedCommandRequest => ({
  commandId: CommandIdSchema.parse(COMMAND_ID),
  command: APPROVED_COMMAND,
  cwd: ".",
  environment: [],
  timeoutSeconds: 900,
  terminal: { columns: 120, rows: 40 },
  ...overrides
});

const dependencies = (): DerivePlanNamedCommandAuthorizationsDependencies => ({
  now: () => DERIVED_AT,
  ids: {
    approval: () => ApprovalIdSchema.parse(PERMISSION_APPROVAL_ID),
    commandAuthorization: () => CommandAuthorizationIdSchema.parse(COMMAND_AUTHORIZATION_ID)
  }
});

interface CommandOverrides {
  readonly scope?: ExecutionScope;
  readonly planCommands?: readonly VerificationCommand[];
  readonly requiredCredentialRefIds?: readonly string[];
  readonly requests?: readonly PlanNamedCommandRequest[];
  readonly planDocument?: PlanDocument;
  readonly environmentAuthorization?: EnvironmentAuthorization;
}

const commandFor = async (
  overrides: CommandOverrides = {}
): Promise<DerivePlanNamedCommandAuthorizationsCommand> => {
  const scope = overrides.scope ?? scopeFor();
  const approvedDocument = await planDocumentFor(
    overrides.planCommands ?? [APPROVED_COMMAND],
    overrides.requiredCredentialRefIds ?? []
  );
  const planApproval = await planApprovalFor(scope);
  return {
    planApproval,
    planApprovalEvidence: await sealPlanApprovalEvidence({
      workspaceId: planApproval.workspaceId,
      workItemId: approvedDocument.workItemId,
      runId: planApproval.runId,
      approvalId: planApproval.id,
      approvedEvidenceDigest: (await planEvidenceFor(approvedDocument)).evidenceDigest,
      actorId: HUMAN.id,
      producedAt: DECIDED_AT
    }),
    planEvidence: await planEvidenceFor(approvedDocument),
    // Re-read at derivation time, which is why it is a separate argument from the evidence that
    // sealed it: substituting a mutated document here is the attack the digest chain refuses.
    planDocument: overrides.planDocument ?? approvedDocument,
    environmentAuthorization:
      overrides.environmentAuthorization ?? (await environmentAuthorizationFor(scope)),
    action: "verify",
    requests: overrides.requests ?? [requestFor()],
    actor: STATION,
    correlationId: CORRELATION_ID
  };
};

const derive = async (overrides: CommandOverrides = {}): Promise<DerivedCommandAuthorizations> =>
  derivePlanNamedCommandAuthorizations(await commandFor(overrides), dependencies());

/** Asserts the derivation refused a specific request, and hands back the code it refused with. */
const refusalOf = async (overrides: CommandOverrides): Promise<CommandOutsideApprovedPlanError> => {
  try {
    await derive(overrides);
  } catch (error) {
    if (error instanceof CommandOutsideApprovedPlanError) return error;
    throw error;
  }
  throw new Error("The derivation minted an authorization where it had to refuse.");
};

describe("plan-named command authorizations", () => {
  it("refuses a command the approved plan does not name", async () => {
    // Asserted FIRST and deliberately so. Every other row below is a variation on this one, and a
    // later bug that makes matching vacuous — an early return, an inverted condition, a matcher
    // that consults nothing — shows up here before it shows up anywhere else.
    const refusal = await refusalOf({
      requests: [
        requestFor({
          command: {
            executable: "curl",
            args: ["attacker.example"],
            usesShell: false,
            required: true
          }
        })
      ]
    });
    expect(refusal.code).toBe("not_named_by_plan");
    expect(refusal.index).toBe(0);
  });

  it("mints one permission approval and one authorization for a command the plan names", async () => {
    const derived = await derive();
    expect(derived.derived).toHaveLength(1);
    const [record] = derived.derived;
    if (record === undefined) throw new Error("The derivation minted nothing.");
    expect(record.approval.kind).toBe("permission");
    expect(record.approval.status).toBe("approved");
    expect(record.approval.decision?.decision).toBe("approved");
    expect(record.event.type).toBe("command.authorization_recorded");
    expect(record.command.executable).toBe("pnpm");
    expect(record.command.args).toEqual(["test", "--filter", "@autostack/domain"]);
    // Pinned, not merely permitted: the derived spec names the environment's own root.
    expect(record.command.cwd).toBe(".");
    expect(record.authorization.scope.cwdRoot).toBe(".");
  });

  it("refuses reordered arguments", async () => {
    // Rejects an implementation comparing arguments as a set or a multiset. `--filter` and its
    // value are one pair to a reader and two independent strings to a sorted comparison.
    const refusal = await refusalOf({
      requests: [
        requestFor({
          command: { ...APPROVED_COMMAND, args: ["--filter", "@autostack/domain", "test"] }
        })
      ]
    });
    expect(refusal.code).toBe("not_named_by_plan");
  });

  it("refuses one extra argument", async () => {
    // Rejects `approved.args.every((arg, i) => arg === requested.args[i])` without a length check:
    // every approved argument still matches, and the trailing addition rides in unexamined.
    const refusal = await refusalOf({
      requests: [
        requestFor({
          command: { ...APPROVED_COMMAND, args: [...APPROVED_COMMAND.args, "--reporter=./evil.js"] }
        })
      ]
    });
    expect(refusal.code).toBe("not_named_by_plan");
  });

  it("refuses one removed argument", async () => {
    // The mirror defect: `requested.args.every((arg, i) => arg === approved.args[i])` passes for
    // any prefix, so dropping `--filter @autostack/domain` would widen `pnpm test` to every package.
    const refusal = await refusalOf({
      requests: [requestFor({ command: { ...APPROVED_COMMAND, args: ["test"] } })]
    });
    expect(refusal.code).toBe("not_named_by_plan");
  });

  it("refuses a different executable carrying the same arguments", async () => {
    // Rejects an implementation matching on arguments alone.
    const refusal = await refusalOf({
      requests: [requestFor({ command: { ...APPROVED_COMMAND, executable: "npm" } })]
    });
    expect(refusal.code).toBe("not_named_by_plan");
  });

  it("refuses a usesShell:true variant of a usesShell:false approved command", async () => {
    // The code assertion is the point. An implementation that leaves `usesShell` out of the match
    // key reaches the shell-derivability guard instead and refuses with `shell_not_derivable`, so
    // this row stays discriminating rather than passing on a blanket refusal of shell commands.
    const refusal = await refusalOf({
      requests: [requestFor({ command: { ...APPROVED_COMMAND, usesShell: true } })]
    });
    expect(refusal.code).toBe("not_named_by_plan");
  });

  it("refuses a shell command even when the approved plan names it as a shell command", async () => {
    // `CommandSpec` cannot express shell interpretation and the contracts forbid shell command
    // strings outright, so there is no spec to derive. Refusing beats silently dropping the shell.
    const shellCommand: VerificationCommand = { ...APPROVED_COMMAND, usesShell: true };
    const refusal = await refusalOf({
      planCommands: [shellCommand],
      requests: [requestFor({ command: shellCommand })]
    });
    expect(refusal.code).toBe("shell_not_derivable");
  });

  it("refuses a working directory other than the environment's cwd root", async () => {
    // Byte-identical executable and arguments, different program: `pnpm test` inside a vendored
    // submodule runs that submodule's scripts.
    const refusal = await refusalOf({
      requests: [requestFor({ cwd: "vendor/submodule" })]
    });
    expect(refusal.code).toBe("cwd_not_pinned");
  });

  it("refuses an omitted cwd when the environment root is not the workspace root", async () => {
    // The standing question. `RelativeWorkspacePathSchema` defaults to ".", so an absent `cwd`
    // produces a real value rather than `undefined` — and a guard written
    // `cwd !== undefined && cwd !== root` passes vacuously here while the default quietly
    // supplies "." for a root of "packages/app".
    const scope = scopeFor("packages/app");
    const request = requestFor();
    const refusal = await refusalOf({
      scope,
      environmentAuthorization: await environmentAuthorizationFor(scope),
      requests: [{ ...request, cwd: undefined }]
    });
    expect(refusal.code).toBe("cwd_not_pinned");
  });

  it("pins the derived spec to a non-default cwd root when the request names it", async () => {
    const scope = scopeFor("packages/app");
    const derived = await derive({
      scope,
      environmentAuthorization: await environmentAuthorizationFor(scope),
      requests: [requestFor({ cwd: "packages/app" })]
    });
    expect(derived.derived[0]?.command.cwd).toBe("packages/app");
    expect(derived.derived[0]?.authorization.scope.cwdRoot).toBe("packages/app");
  });

  it("refuses a plan document mutated after the approval that names it", async () => {
    // Binding is by digest, not by id: the approval id, the approval evidence and the environment
    // authorization are all untouched here, and only the document's bytes changed.
    const mutated = await planDocumentFor([
      APPROVED_COMMAND,
      { executable: "curl", args: ["attacker.example"], usesShell: false, required: false }
    ]);
    await expect(derive({ planDocument: mutated })).rejects.toBeInstanceOf(
      StaleApprovalEvidenceError
    );
  });

  it("refuses a mutated plan whose self-declared planDigest was fixed up to match", async () => {
    // `planDigest` is recomputed rather than read, and compared against the sealed plan evidence
    // on the run stream — which an editor with repository access cannot reach.
    const mutated = await planDocumentFor([{ ...APPROVED_COMMAND, args: ["test"] }]);
    expect(await digestPlanDocument(mutated)).toBe(mutated.planDigest);
    await expect(derive({ planDocument: mutated })).rejects.toBeInstanceOf(
      StaleApprovalEvidenceError
    );
  });

  it("authorizes nothing from a plan that names no verification commands", async () => {
    // The empty-list vector. `[].find(match)` is `undefined` and refuses; a matcher written
    // `commands.length === 0 || commands.some(match)` authorizes EVERYTHING, and no non-empty plan
    // separates the two. Refusal here is doubly enforced — the plan document is admitted under
    // `PlanDocumentSchema`, which requires at least one command, before matching runs at all — and
    // the wrong implementation this rejects is one that matches before it validates and binds.
    const approved = await planDocumentFor();
    const empty: PlanDocument = { ...approved, verificationCommands: [] };
    await expect(derive({ planDocument: empty })).rejects.toThrow();
  });

  it("takes the approving actor from the durable plan approval, never from the caller", async () => {
    // Doctrine D13. The command carries the *station* as its event actor; an implementation that
    // reused it as the approver would let a caller name itself the human who approved.
    const derived = await derive();
    expect(derived.derived[0]?.approval.decision?.actor.id).toBe(HUMAN.id);
    expect(derived.derived[0]?.approval.eligibleApproverIds).toContain(HUMAN.id);
    expect(derived.derived[0]?.event.actor.id).toBe(STATION.id);
  });

  it("records the plan evidence every derived authorization descends from", async () => {
    const document = await planDocumentFor();
    const derived = await derive();
    expect(derived.planEvidenceDigest).toBe((await planEvidenceFor(document)).evidenceDigest);
  });

  it("refuses a literal environment entry the plan never approved", async () => {
    // NODE_OPTIONS=--require ./evil.js turns an approved `pnpm test` into arbitrary execution
    // without changing one byte of executable or arguments.
    const refusal = await refusalOf({
      requests: [
        requestFor({
          environment: [{ kind: "literal", name: "NODE_OPTIONS", value: "--require ./evil.js" }]
        })
      ]
    });
    expect(refusal.code).toBe("literal_environment");
  });

  it("refuses a credential reference the approved plan does not name", async () => {
    const scope = scopeFor(".", [CREDENTIAL_REF_ID, OTHER_CREDENTIAL_REF_ID]);
    const refusal = await refusalOf({
      scope,
      environmentAuthorization: await environmentAuthorizationFor(scope),
      requiredCredentialRefIds: [CREDENTIAL_REF_ID],
      requests: [
        requestFor({
          environment: [
            {
              kind: "credential_ref",
              name: "NPM_TOKEN",
              credentialRefId: CredentialRefIdSchema.parse(OTHER_CREDENTIAL_REF_ID)
            }
          ]
        })
      ]
    });
    expect(refusal.code).toBe("credential_not_named");
  });

  it("narrows the authorized credentials to the ones the derived command actually references", async () => {
    const scope = scopeFor(".", [CREDENTIAL_REF_ID, OTHER_CREDENTIAL_REF_ID]);
    const derived = await derive({
      scope,
      environmentAuthorization: await environmentAuthorizationFor(scope),
      requiredCredentialRefIds: [CREDENTIAL_REF_ID, OTHER_CREDENTIAL_REF_ID],
      requests: [
        requestFor({
          environment: [
            {
              kind: "credential_ref",
              name: "NPM_TOKEN",
              credentialRefId: CredentialRefIdSchema.parse(CREDENTIAL_REF_ID)
            }
          ]
        })
      ]
    });
    expect(derived.derived[0]?.authorization.scope.allowedCredentialRefIds).toEqual([
      CREDENTIAL_REF_ID
    ]);
  });

  it("refuses a timeout above the environment's own duration ceiling", async () => {
    const refusal = await refusalOf({ requests: [requestFor({ timeoutSeconds: 3_600 })] });
    expect(refusal.code).toBe("timeout_exceeds_environment");
  });

  it("narrows the authorized duration to the command's own timeout", async () => {
    const derived = await derive();
    expect(derived.derived[0]?.authorization.scope.resourceLimits.durationSeconds).toBe(900);
  });

  it("never outlives the environment authorization it descends from", async () => {
    const scope = scopeFor();
    const authorization = await environmentAuthorizationFor(scope, 10 * 60 * 1_000);
    const derived = await derive({ scope, environmentAuthorization: authorization });
    expect(Date.parse(derived.derived[0]?.authorization.expiresAt ?? "")).toBeLessThanOrEqual(
      Date.parse(authorization.expiresAt)
    );
  });

  it("derives nothing from an environment authorization that has already expired", async () => {
    const scope = scopeFor();
    await expect(
      derive({ scope, environmentAuthorization: await environmentAuthorizationFor(scope, 60_000) })
    ).rejects.toBeInstanceOf(StaleApprovalEvidenceError);
  });

  it("refuses an environment authorization whose scope was edited after it was sealed", async () => {
    // Its `digest` is recomputed here rather than trusted, so widening the scope in place fails.
    const scope = scopeFor();
    const sealed = await environmentAuthorizationFor(scope);
    const forged: EnvironmentAuthorization = {
      ...sealed,
      scope: { ...sealed.scope, cwdRoot: "vendor" }
    };
    await expect(derive({ scope, environmentAuthorization: forged })).rejects.toBeInstanceOf(
      StaleApprovalEvidenceError
    );
  });

  it("refuses an environment authorization that does not descend from the plan approval", async () => {
    // Sealed correctly — its own digest is valid — but under a different approval, so the
    // wrong implementation this rejects is one that trusts a well-formed record's provenance.
    const scope = scopeFor();
    const foreign = await authorizeEnvironment({
      id: EnvironmentAuthorizationIdSchema.parse(ENVIRONMENT_AUTHORIZATION_ID),
      approvalId: ApprovalIdSchema.parse(PERMISSION_APPROVAL_ID),
      approvalEvidenceDigest: await digestExecutionScope(scope),
      scope,
      createdAt: DECIDED_AT
    });
    await expect(derive({ scope, environmentAuthorization: foreign })).rejects.toThrow();
  });

  it("refuses a plan approval that a human never approved", async () => {
    const scope = scopeFor();
    const command = await commandFor({ scope });
    const pending: Approval = { ...command.planApproval, status: "pending", decision: undefined };
    await expect(
      derivePlanNamedCommandAuthorizations({ ...command, planApproval: pending }, dependencies())
    ).rejects.toThrow();
  });
});

/**
 * Asserted against the REAL admitters. A local restatement of their rules would agree with itself
 * and prove nothing: the failure this guards against is a derivation that satisfies this file's
 * idea of `admitStartCommand` and not the one `packages/contracts` actually ships.
 */
const deriveWith = async (
  overrides: CommandOverrides = {}
): Promise<{
  readonly command: DerivePlanNamedCommandAuthorizationsCommand;
  readonly record: DerivedCommandAuthorization;
}> => {
  const command = await commandFor(overrides);
  const result = await derivePlanNamedCommandAuthorizations(command, dependencies());
  const record = result.derived[0];
  if (record === undefined) throw new Error("The derivation minted nothing.");
  return { command, record };
};

const admissionDependencies = (
  command: DerivePlanNamedCommandAuthorizationsCommand,
  record: DerivedCommandAuthorization,
  overrides: { readonly withoutPermissionApproval?: boolean } = {}
): TrustedRunnerAdmissionDependencies => ({
  resolveApproval: async (approvalId) => {
    if (approvalId === command.planApproval.id) return command.planApproval;
    if (approvalId === record.approval.id) {
      return overrides.withoutPermissionApproval === true ? undefined : record.approval;
    }
    return undefined;
  },
  resolveEnvironmentAuthorization: async (authorizationId) =>
    authorizationId === command.environmentAuthorization.id
      ? command.environmentAuthorization
      : undefined,
  resolveCommandAuthorization: async (authorizationId) =>
    authorizationId === record.authorization.id ? record.authorization : undefined
});

const startRequestFor = (
  command: DerivePlanNamedCommandAuthorizationsCommand,
  record: DerivedCommandAuthorization,
  spec: CommandSpec = record.command
): Readonly<Record<string, unknown>> => ({
  workspaceId: record.authorization.scope.workspaceId,
  runId: record.authorization.scope.runId,
  environmentId: record.authorization.scope.environmentId,
  commandId: record.commandId,
  command: spec,
  environmentAuthorizationId: command.environmentAuthorization.id,
  environmentAuthorizationDigest: command.environmentAuthorization.digest,
  authorization: record.authorization,
  idempotency: { key: "start-command-1" }
});

describe("derived command authorizations at the runner boundary", () => {
  it("is admitted by admitStartCommand", async () => {
    const { command, record } = await deriveWith();
    const admission = await admitStartCommand(
      startRequestFor(command, record),
      DERIVED_AT,
      admissionDependencies(command, record)
    );
    expect(admission.approval.kind).toBe("permission");
    expect(admission.approval.status).toBe("approved");
    expect(admission.commandAuthorization.id).toBe(record.authorization.id);
  });

  it("narrows its environment authorization rather than widening it", async () => {
    const { command, record } = await deriveWith();
    expect(() =>
      validateCommandAuthorizationAgainstEnvironment(
        record.authorization,
        command.environmentAuthorization
      )
    ).not.toThrow();
    const environmentLimits = command.environmentAuthorization.scope.resourceLimits;
    const commandLimits = record.authorization.scope.resourceLimits;
    expect(commandLimits.durationSeconds).toBeLessThanOrEqual(environmentLimits.durationSeconds);
    expect(commandLimits.cpu).toBeLessThanOrEqual(environmentLimits.cpu);
    expect(commandLimits.memoryMb).toBeLessThanOrEqual(environmentLimits.memoryMb);
  });

  it("is admitted for no command other than the one it was derived for", async () => {
    // The authorization is genuine and the spec is a byte-level variation on the approved one, so
    // the only thing refusing here is `scope.commandDigest` against `digestCommandSpec`.
    const { command, record } = await deriveWith();
    const reordered: CommandSpec = {
      ...record.command,
      args: ["--filter", "@autostack/domain", "test"]
    };
    await expect(
      admitStartCommand(
        startRequestFor(command, record, reordered),
        DERIVED_AT,
        admissionDependencies(command, record)
      )
    ).rejects.toThrow("Command specification digest is invalid.");
  });

  it("is admitted for no working directory other than the pinned one", async () => {
    const scope = scopeFor("packages/app");
    const { command, record } = await deriveWith({
      scope,
      environmentAuthorization: await environmentAuthorizationFor(scope),
      requests: [requestFor({ cwd: "packages/app" })]
    });
    const moved: CommandSpec = { ...record.command, cwd: "packages/app/vendor" };
    await expect(
      admitStartCommand(
        startRequestFor(command, record, moved),
        DERIVED_AT,
        admissionDependencies(command, record)
      )
    ).rejects.toThrow("Command specification digest is invalid.");
  });

  it("is admitted only while the permission approval it names is durable", async () => {
    // The permission approval is not decoration: without it the runner refuses, which is what makes
    // minting one the security-critical act rather than a bookkeeping one.
    const { command, record } = await deriveWith();
    await expect(
      admitStartCommand(
        startRequestFor(command, record),
        DERIVED_AT,
        admissionDependencies(command, record, { withoutPermissionApproval: true })
      )
    ).rejects.toThrow("A trusted approved authorization is required.");
  });
});

// The evidence chain that must hold BEFORE any command is matched. Task 7's implementer died while
// adding these; every one of them was uncovered, which is the gap that matters most in this module:
// the matching rules below decide WHICH commands get minted, but these decide whether minting is
// permitted at all. A break here mints correctly-shaped authorizations from an approval that was
// never granted.
//
// Each case mutates exactly one link of a fixture that is otherwise valid — so the red comes from
// that specific defect and not from a malformed input the function would reject anyway.
describe("plan-named command authorizations reject a broken evidence chain", () => {
  const deriveFrom = async (
    mutate: (
      command: DerivePlanNamedCommandAuthorizationsCommand
    ) => DerivePlanNamedCommandAuthorizationsCommand
  ): Promise<DerivedCommandAuthorizations> =>
    derivePlanNamedCommandAuthorizations(mutate(await commandFor()), dependencies());

  it("refuses an approval that was never granted", async () => {
    // Rejects an implementation that reads `decision` without checking `status` — the record still
    // carries an approved decision, so only the status separates granted from pending.
    await expect(
      deriveFrom((c) => ({ ...c, planApproval: { ...c.planApproval, status: "pending" } }))
    ).rejects.toThrow(/approved plan approval/);
  });

  it("refuses an approval decided by someone not eligible to decide it", async () => {
    // Rejects an implementation that trusts `decision.actor` without checking it against
    // `eligibleApproverIds`. A decision signed by a stranger is not a grant.
    await expect(
      deriveFrom((c) => ({
        ...c,
        planApproval: { ...c.planApproval, eligibleApproverIds: ["someone-else"] }
      }))
    ).rejects.toThrow(/no eligible approval decision/);
  });

  it("refuses evidence naming a different approval", async () => {
    // Rejects an implementation that checks the digest but not the identity: the approval and the
    // evidence must be about the same decision, not merely about equal bytes.
    await expect(
      deriveFrom((c) => ({
        ...c,
        planApprovalEvidence: { ...c.planApprovalEvidence, actorId: "a-different-approver" }
      }))
    ).rejects.toThrow(/names a different approval/);
  });

  it("refuses a plan approved under a different run", async () => {
    // Rejects an implementation that binds by digest alone. Digests travel; run identity does not,
    // and a plan approved for one run must not authorize commands in another.
    await expect(
      deriveFrom((c) => ({
        ...c,
        planApproval: { ...c.planApproval, runId: OTHER_RUN_ID }
      }))
    ).rejects.toThrow(/different run/);
  });

  it("refuses an environment authorization that descends from another approval", async () => {
    // Mutating `planApproval.id` would trip the earlier evidence-identity guard instead, so the
    // authorization itself is repointed: the plan chain stays intact and only the environment's
    // parentage is wrong. Rejects an implementation that validates the environment authorization
    // in isolation — it is well-formed here and simply belongs to a different grant.
    await expect(
      deriveFrom((c) => ({
        ...c,
        environmentAuthorization: {
          ...c.environmentAuthorization,
          approvalId: OTHER_APPROVAL_ID
        }
      }))
    ).rejects.toThrow(/does not descend from this plan approval/);
  });
});
