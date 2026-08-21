import { describe, expect, it } from "vitest";

import {
  ApprovalIdSchema,
  ApprovalSchema,
  CommandAuthorizationSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  CredentialRefIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  RunSchema,
  WorkspaceIdSchema,
  digestCommandScope,
  digestCommandAuthorization,
  digestCommandSpec,
  digestExecutionScope,
  type Approval,
  type CommandScope,
  type ExecutionScope,
  type Run
} from "@autostack/contracts";

import {
  decideCommandStart,
  decideEnvironmentPreparation,
  issueCommandAuthorization,
  issueEnvironmentAuthorization,
  type ExecutionPolicyAuthority,
  type PolicyDecision
} from "../src/runner-policy.js";
import * as DomainApi from "../src/index.js";

const NOW = "2026-08-21T12:00:00.000Z";
const LATER = "2026-08-21T12:01:00.000Z";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000");
const ENVIRONMENT_ID = EnvironmentIdSchema.parse("env_123e4567-e89b-42d3-a456-426614174000");
const COMMAND_ID = CommandIdSchema.parse("cmd_123e4567-e89b-42d3-a456-426614174000");
const PLAN_APPROVAL_ID = ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-426614174000");
const PERMISSION_APPROVAL_ID = ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-426614174001");
const ENVIRONMENT_AUTHORIZATION_ID = EnvironmentAuthorizationIdSchema.parse(
  "envauth_123e4567-e89b-42d3-a456-426614174000"
);
const COMMAND_AUTHORIZATION_ID = CommandAuthorizationIdSchema.parse(
  "cmdauth_123e4567-e89b-42d3-a456-426614174000"
);

const scope: ExecutionScope = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  environmentId: ENVIRONMENT_ID,
  repositoryIdentity: "github:autostack/coding-factory",
  sourceCommit: "a".repeat(40),
  branch: "autostack/domain-policy",
  cwdRoot: ".",
  resourceLimits: { cpu: 2, memoryMb: 512, durationSeconds: 120 },
  networkPolicy: "host",
  filesystemDisclosure: "host_user",
  allowedCredentialRefIds: [
    CredentialRefIdSchema.parse("cred_123e4567-e89b-42d3-a456-426614174000")
  ]
};
const command = {
  executable: "/usr/bin/git",
  args: ["status", "--short"],
  cwd: ".",
  environment: [],
  timeoutSeconds: 30,
  terminal: { columns: 80, rows: 24 }
};

const run = (status: Run["status"]): Run =>
  RunSchema.parse({
    schemaVersion: 1,
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    workItemId: "wi_123e4567-e89b-42d3-a456-426614174000",
    workflowVersion: "foundation.v1",
    status,
    createdAt: NOW,
    updatedAt: NOW
  });
const approval = async (
  id: Approval["id"],
  kind: Approval["kind"],
  evidenceDigest: string
): Promise<Approval> =>
  ApprovalSchema.parse({
    schemaVersion: 1,
    id,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    kind,
    status: "approved",
    evidenceDigest,
    eligibleApproverIds: ["local-user"],
    createdAt: NOW,
    updatedAt: NOW,
    decision: {
      decision: "approved",
      actor: { kind: "user", id: "local-user" },
      origin: "desktop",
      decidedAt: NOW
    }
  });
const permitted = <Value>(decision: PolicyDecision<Value>): Value => {
  if (!decision.ok) throw new Error(`Expected allow, got ${decision.code}`);
  return decision.value;
};

describe("runner policy authority", () => {
  it("issues frozen envelopes from persisted records and rechecks them at start", async () => {
    const records: {
      run?: Run;
      plan?: Approval;
      permission?: Approval;
      environment?: unknown;
      command?: unknown;
    } = {
      run: run("provisioning"),
      plan: await approval(PLAN_APPROVAL_ID, "plan", await digestExecutionScope(scope))
    };
    const authority: ExecutionPolicyAuthority = {
      resolveRun: async () => records.run,
      resolveApproval: async (id) => (id === PLAN_APPROVAL_ID ? records.plan : records.permission),
      resolveEnvironmentAuthorization: async () => records.environment,
      resolveCommandAuthorization: async () => records.command,
      resolveArtifact: async () => undefined,
      resolveTerminalRunEvidence: async () => undefined,
      hasActiveCommands: async () => false
    };
    const environment = permitted(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    );
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.scope)).toBe(true);
    expect(Object.isFrozen(environment.scope.resourceLimits)).toBe(true);
    expect(Object.isFrozen(environment.scope.allowedCredentialRefIds)).toBe(true);
    expect(environment.scope).not.toBe(scope);
    expect(Reflect.set(environment.scope, "branch", "autostack/tampered")).toBe(false);
    expect(environment.scope.branch).toBe(scope.branch);
    expect("allowed" in DomainApi).toBe(false);
    expect("rejected" in DomainApi).toBe(false);
    expect(
      await issueEnvironmentAuthorization({
        authority: { ...authority, resolveApproval: async () => records.plan },
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "record_identity_mismatch" });
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174099"),
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "record_identity_mismatch" });
    records.environment = environment;
    const prepareRequest = {
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      environmentId: ENVIRONMENT_ID,
      inspection: {
        repositoryIdentity: scope.repositoryIdentity,
        canonicalSourcePath: "/tmp/source",
        repositoryCommonDirectory: "/tmp/source/.git",
        resolvedBaseRef: "main",
        sourceCommit: scope.sourceCommit,
        dirty: false,
        diagnostics: []
      },
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      authorization: environment,
      idempotency: { key: "prepare-policy-1" }
    };
    expect(
      permitted(
        await decideEnvironmentPreparation({
          authority,
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: prepareRequest,
          now: NOW
        })
      )
    ).toEqual(prepareRequest);
    records.run = run("implementing");
    expect(
      await decideEnvironmentPreparation({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request: prepareRequest,
        now: NOW
      })
    ).toEqual({ ok: false, code: "run_state_mismatch" });
    records.run = run("provisioning");
    expect(
      await decideEnvironmentPreparation({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request: {
          ...prepareRequest,
          inspection: {
            ...prepareRequest.inspection,
            repositoryIdentity: "github:other/repository"
          }
        },
        now: NOW
      })
    ).toEqual({ ok: false, code: "invalid_input" });
    records.run = run("implementing");
    const commandScope: CommandScope = {
      environmentAuthorizationId: environment.id,
      environmentAuthorizationDigest: environment.digest,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      environmentId: ENVIRONMENT_ID,
      commandId: COMMAND_ID,
      action: "implement",
      commandDigest: await digestCommandSpec(command),
      repositoryIdentity: scope.repositoryIdentity,
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      cwdRoot: scope.cwdRoot,
      networkPolicy: "host",
      filesystemDisclosure: "host_user",
      resourceLimits: scope.resourceLimits,
      allowedCredentialRefIds: scope.allowedCredentialRefIds
    };
    records.permission = await approval(
      PERMISSION_APPROVAL_ID,
      "permission",
      await digestCommandScope(commandScope)
    );
    const commandAuthorization = permitted(
      await issueCommandAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        scope: commandScope,
        command,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    );
    expect(Object.isFrozen(commandAuthorization)).toBe(true);
    expect(Object.isFrozen(commandAuthorization.scope)).toBe(true);
    expect(Object.isFrozen(commandAuthorization.scope.resourceLimits)).toBe(true);
    expect(Object.isFrozen(commandAuthorization.scope.allowedCredentialRefIds)).toBe(true);
    expect(commandAuthorization.scope).not.toBe(commandScope);
    expect(Reflect.set(commandAuthorization.scope, "cwdRoot", "src")).toBe(false);
    expect(commandAuthorization.scope.cwdRoot).toBe(commandScope.cwdRoot);
    expect(
      await issueCommandAuthorization({
        authority: { ...authority, resolveEnvironmentAuthorization: async () => environment },
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: EnvironmentAuthorizationIdSchema.parse(
          "envauth_123e4567-e89b-42d3-a456-426614174099"
        ),
        scope: commandScope,
        command,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "record_identity_mismatch" });
    records.command = commandAuthorization;
    const request = {
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      environmentId: ENVIRONMENT_ID,
      commandId: COMMAND_ID,
      command,
      environmentAuthorizationId: environment.id,
      environmentAuthorizationDigest: environment.digest,
      authorization: commandAuthorization,
      idempotency: { key: "cmd-policy-1" }
    };
    expect(
      permitted(
        await decideCommandStart({
          authority,
          authenticatedWorkspaceId: WORKSPACE_ID,
          request,
          now: NOW
        })
      )
    ).toEqual(request);
    const forgedCommandAuthorization = CommandAuthorizationSchema.parse({
      ...commandAuthorization,
      approvalEvidenceDigest: "b".repeat(64),
      digest: await digestCommandAuthorization({
        ...commandAuthorization,
        approvalEvidenceDigest: "b".repeat(64)
      })
    });
    records.command = forgedCommandAuthorization;
    expect(
      await decideCommandStart({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request: { ...request, authorization: forgedCommandAuthorization },
        now: NOW
      })
    ).toEqual({ ok: false, code: "approval_evidence_mismatch" });
    records.command = commandAuthorization;
    expect(
      await decideCommandStart({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request: {
          ...request,
          authorization: {
            ...commandAuthorization,
            id: CommandAuthorizationIdSchema.parse("cmdauth_123e4567-e89b-42d3-a456-426614174099")
          }
        },
        now: NOW
      })
    ).toEqual({ ok: false, code: "record_identity_mismatch" });
    records.plan = await approval(PLAN_APPROVAL_ID, "plan", "b".repeat(64));
    expect(
      await decideCommandStart({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request,
        now: NOW
      })
    ).toEqual({ ok: false, code: "approval_evidence_mismatch" });
    records.plan = await approval(PLAN_APPROVAL_ID, "plan", await digestExecutionScope(scope));
    expect(
      await decideCommandStart({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request,
        now: LATER
      })
    ).toEqual({ ok: false, code: "authorization_expired" });
    records.run = run("verifying");
    expect(
      await decideCommandStart({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request,
        now: NOW
      })
    ).toEqual({ ok: false, code: "run_state_mismatch" });
    records.run = run("implementing");
    expect(
      await decideCommandStart({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request: { ...request, command: { ...command, timeoutSeconds: 121 } },
        now: NOW
      })
    ).toEqual({ ok: false, code: "timeout_exceeds_limit" });
    records.command = { ...commandAuthorization, digest: "b".repeat(64) };
    expect(
      await decideCommandStart({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        request,
        now: NOW
      })
    ).toEqual({ ok: false, code: "authorization_mismatch" });
    records.run = run("provisioning");
    records.plan = await approval(PLAN_APPROVAL_ID, "plan", await digestExecutionScope(scope));
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: NOW
      })
    ).toEqual({ ok: false, code: "authorization_expired" });
    records.run = run("queued");
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "run_state_mismatch" });
    records.run = run("provisioning");
    records.plan = ApprovalSchema.parse({ ...records.plan, status: "rejected" });
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_not_approved" });
    records.plan = ApprovalSchema.parse({ ...records.plan, status: "stale" });
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_stale" });
    records.plan = ApprovalSchema.parse({
      ...records.plan,
      status: "approved",
      decision: undefined
    });
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_invalid" });
    records.plan = await approval(PLAN_APPROVAL_ID, "plan", "b".repeat(64));
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_evidence_mismatch" });
    records.run = run("implementing");
    records.plan = await approval(PLAN_APPROVAL_ID, "plan", await digestExecutionScope(scope));
    records.environment = environment;
    const issueScope = async (
      candidateScope: CommandScope,
      candidateCommand: unknown = command
    ) => {
      records.permission = await approval(
        PERMISSION_APPROVAL_ID,
        "permission",
        await digestCommandScope(candidateScope)
      );
      return issueCommandAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        scope: candidateScope,
        command: candidateCommand,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      });
    };
    expect(await issueScope({ ...commandScope, commandDigest: "b".repeat(64) })).toEqual({
      ok: false,
      code: "command_scope_mismatch"
    });
    expect(await issueScope({ ...commandScope, action: "verify" })).toEqual({
      ok: false,
      code: "run_state_mismatch"
    });
    expect(
      await issueScope({ ...commandScope, environmentAuthorizationDigest: "c".repeat(64) })
    ).toEqual({ ok: false, code: "authorization_mismatch" });
    const issueWithCommand = async (requestedCommand: unknown) => {
      const scoped = { ...commandScope, commandDigest: await digestCommandSpec(requestedCommand) };
      records.permission = await approval(
        PERMISSION_APPROVAL_ID,
        "permission",
        await digestCommandScope(scoped)
      );
      return issueCommandAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        scope: scoped,
        command: requestedCommand,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      });
    };
    expect(await issueWithCommand({ ...command, timeoutSeconds: 121 })).toEqual({
      ok: false,
      code: "timeout_exceeds_limit"
    });
    expect(
      await issueWithCommand({
        ...command,
        environment: [
          {
            kind: "credential_ref",
            name: "TOKEN",
            credentialRefId: "cred_123e4567-e89b-42d3-a456-426614174099"
          }
        ]
      })
    ).toEqual({ ok: false, code: "credential_not_allowed" });
    expect(await issueWithCommand({ ...command, cwd: "src" })).toMatchObject({ ok: true });
    records.permission = ApprovalSchema.parse({
      ...(await approval(
        PERMISSION_APPROVAL_ID,
        "permission",
        await digestCommandScope(commandScope)
      )),
      status: "stale"
    });
    expect(
      await issueCommandAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        scope: commandScope,
        command,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_stale" });
    records.permission = ApprovalSchema.parse({ ...records.permission, status: "pending" });
    expect(
      await issueCommandAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        scope: commandScope,
        command,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_not_approved" });
    records.permission = ApprovalSchema.parse({ ...records.permission, status: "rejected" });
    expect(
      await issueCommandAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        scope: commandScope,
        command,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_not_approved" });
  });

  it("fails closed for a future, ineligible approval decision", async () => {
    const badApproval = await approval(PLAN_APPROVAL_ID, "plan", await digestExecutionScope(scope));
    const authority: ExecutionPolicyAuthority = {
      resolveRun: async () => run("provisioning"),
      resolveApproval: async () => ({
        ...badApproval,
        updatedAt: LATER,
        decision: {
          ...badApproval.decision!,
          actor: { kind: "user", id: "other" },
          decidedAt: LATER
        }
      }),
      resolveEnvironmentAuthorization: async () => undefined,
      resolveCommandAuthorization: async () => undefined,
      resolveArtifact: async () => undefined,
      resolveTerminalRunEvidence: async () => undefined,
      hasActiveCommands: async () => false
    };
    expect(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_ineligible" });
    const eligibleStale = ApprovalSchema.parse({
      ...badApproval,
      updatedAt: LATER,
      decision: { ...badApproval.decision!, decidedAt: LATER }
    });
    expect(
      await issueEnvironmentAuthorization({
        authority: { ...authority, resolveApproval: async () => eligibleStale },
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: NOW,
        expiresAt: LATER
      })
    ).toEqual({ ok: false, code: "approval_stale" });
    const incoherent = ApprovalSchema.parse({
      ...badApproval,
      updatedAt: LATER,
      decision: { ...badApproval.decision!, decidedAt: NOW }
    });
    expect(
      await issueEnvironmentAuthorization({
        authority: { ...authority, resolveApproval: async () => incoherent },
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: LATER,
        expiresAt: "2026-08-21T12:02:00.000Z"
      })
    ).toEqual({ ok: false, code: "approval_invalid" });
  });

  it("accepts offset authorization instants and rejects invalid or future authorization use", async () => {
    const offsetNow = "2026-08-21T08:00:00.000-04:00";
    const offsetLater = "2026-08-21T08:01:00.000-04:00";
    const records: {
      run: Run;
      plan: Approval;
      permission?: Approval;
      environment?: unknown;
    } = {
      run: run("provisioning"),
      plan: await approval(PLAN_APPROVAL_ID, "plan", await digestExecutionScope(scope))
    };
    const authority: ExecutionPolicyAuthority = {
      resolveRun: async () => records.run,
      resolveApproval: async (id) => (id === PLAN_APPROVAL_ID ? records.plan : records.permission),
      resolveEnvironmentAuthorization: async () => records.environment,
      resolveCommandAuthorization: async () => undefined,
      resolveArtifact: async () => undefined,
      resolveTerminalRunEvidence: async () => undefined,
      hasActiveCommands: async () => false
    };
    const environment = permitted(
      await issueEnvironmentAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PLAN_APPROVAL_ID,
        scope,
        authorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        now: offsetNow,
        expiresAt: offsetLater
      })
    );
    records.environment = environment;
    records.run = run("implementing");
    const commandScope: CommandScope = {
      environmentAuthorizationId: environment.id,
      environmentAuthorizationDigest: environment.digest,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      environmentId: ENVIRONMENT_ID,
      commandId: COMMAND_ID,
      action: "implement",
      commandDigest: await digestCommandSpec(command),
      repositoryIdentity: scope.repositoryIdentity,
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      cwdRoot: scope.cwdRoot,
      networkPolicy: "host",
      filesystemDisclosure: "host_user",
      resourceLimits: scope.resourceLimits,
      allowedCredentialRefIds: scope.allowedCredentialRefIds
    };
    records.permission = await approval(
      PERMISSION_APPROVAL_ID,
      "permission",
      await digestCommandScope(commandScope)
    );
    const commandAuthorization = permitted(
      await issueCommandAuthorization({
        authority,
        authenticatedWorkspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        approvalId: PERMISSION_APPROVAL_ID,
        environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
        scope: commandScope,
        command,
        authorizationId: COMMAND_AUTHORIZATION_ID,
        now: offsetNow,
        expiresAt: offsetLater
      })
    );
    const request = {
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      environmentId: ENVIRONMENT_ID,
      commandId: COMMAND_ID,
      command,
      environmentAuthorizationId: environment.id,
      environmentAuthorizationDigest: environment.digest,
      authorization: commandAuthorization,
      idempotency: { key: "offset-command" }
    };
    expect(
      await decideCommandStart({
        authority: { ...authority, resolveCommandAuthorization: async () => commandAuthorization },
        authenticatedWorkspaceId: WORKSPACE_ID,
        request,
        now: offsetNow
      })
    ).toMatchObject({ ok: true });
    expect(
      await decideCommandStart({
        authority: { ...authority, resolveCommandAuthorization: async () => commandAuthorization },
        authenticatedWorkspaceId: WORKSPACE_ID,
        request,
        now: "not-a-timestamp"
      })
    ).toEqual({ ok: false, code: "invalid_input" });
    expect(
      await decideCommandStart({
        authority: { ...authority, resolveCommandAuthorization: async () => commandAuthorization },
        authenticatedWorkspaceId: WORKSPACE_ID,
        request,
        now: "2026-08-21T07:59:00.000-04:00"
      })
    ).toEqual({ ok: false, code: "authorization_mismatch" });
  });
});
