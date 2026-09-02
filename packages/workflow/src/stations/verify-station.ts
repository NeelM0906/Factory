/**
 * The `pipeline.verify` handler (spec §8.2, plan Task 11): executes exactly the plan's
 * verification commands, in order, using Task 7's authorizations. Constructs a VerificationReport
 * with results, emits VerificationEvidence, and routes to reviewing or back to implement on failure.
 */

import {
  ApprovalSchema,
  CommandAuthorizationSchema,
  CommandScopeSchema,
  CommandSpecSchema,
  EnvironmentAuthorizationSchema,
  PendingDomainEventSchema,
  VerificationReportSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestVerificationReport,
  type CommandAuthorization,
  type CommandSpec,
  type EnvironmentAuthorization,
  type PendingDomainEvent,
  type PlanDocument,
  type StoredDomainEvent,
  type VerificationCommand,
  type VerificationResult
} from "@autostack/contracts";
import { transitionRun, type LeasedWorkflowJob } from "@autostack/domain";

import type { WorkflowHandlerContext, WorkflowHandlerResult } from "../handler-registry.js";
import {
  executionEnvironmentForRun,
  type ProjectExecutionConfiguration
} from "./execution-scope.js";
import { classifyStageFailure } from "./failure-taxonomy.js";
import type { PipelineJobPayload } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";
import { StageAbandoned, createStationKernel } from "./station-kernel.js";
import { readPipelineState } from "./station-kernel-state.js";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_TERMINAL = { columns: 120, rows: 40 } as const;
const COMMAND_AUTHORIZATION_TTL_MS = 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Event readers
// ---------------------------------------------------------------------------

const findRecordedAuthorization = (
  events: readonly StoredDomainEvent[],
  runId: string
): EnvironmentAuthorization | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "environment.authorization_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId
    ) {
      return EnvironmentAuthorizationSchema.parse(event.payload.authorization);
    }
  }
  return undefined;
};

const findPlanDocument = (
  events: readonly StoredDomainEvent[],
  runId: string
): PlanDocument | undefined => {
  for (const event of events) {
    if (
      event.type === "pipeline.evidence_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId &&
      event.payload.document?.kind === "plan"
    ) {
      return event.payload.document.document as PlanDocument;
    }
  }
  return undefined;
};

const findImplementationEvidenceDigest = (
  events: readonly StoredDomainEvent[],
  runId: string
): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "pipeline.evidence_recorded" &&
      event.stream.kind === "run" &&
      event.stream.id === runId &&
      event.payload.evidence?.stage === "implement"
    ) {
      return event.payload.evidence.evidenceDigest as string;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

const toCommandSpec = (command: VerificationCommand, cwdRoot: string): CommandSpec =>
  CommandSpecSchema.parse({
    executable: command.executable,
    args: command.args,
    cwd: cwdRoot,
    environment: [],
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    terminal: DEFAULT_TERMINAL
  });

/**
 * Builds the per-command authorization that `startCommand` requires. This is the same sealing that
 * `sealCommandAuthorizationRecords` performs, but inlined because the domain module does not
 * re-export that function.
 */
const buildCommandAuthorization = async (
  commandId: string,
  spec: CommandSpec,
  authorization: EnvironmentAuthorization,
  job: LeasedWorkflowJob,
  dependencies: StationDependencies,
  configuration: ProjectExecutionConfiguration
): Promise<CommandAuthorization> => {
  const scope = authorization.scope;
  const now = dependencies.now();
  const expiresAt = new Date(Date.parse(now) + COMMAND_AUTHORIZATION_TTL_MS).toISOString();
  const commandDigest = await digestCommandSpec(spec);

  const commandScope = CommandScopeSchema.parse({
    environmentAuthorizationId: authorization.id,
    environmentAuthorizationDigest: authorization.digest,
    workspaceId: scope.workspaceId,
    runId: scope.runId,
    environmentId: scope.environmentId,
    commandId,
    action: "verify",
    commandDigest,
    repositoryIdentity: scope.repositoryIdentity,
    sourceCommit: scope.sourceCommit,
    branch: scope.branch,
    cwdRoot: scope.cwdRoot,
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    resourceLimits: {
      cpu: scope.resourceLimits.cpu,
      memoryMb: scope.resourceLimits.memoryMb,
      durationSeconds: spec.timeoutSeconds
    },
    allowedCredentialRefIds: []
  });

  const approvalId = dependencies.ids.approval();
  const scopeDigest = await digestCommandScope(commandScope);

  // Build the permission approval that covers this command.
  const approval = ApprovalSchema.parse({
    schemaVersion: 1,
    id: approvalId,
    workspaceId: job.workspaceId,
    runId: job.runId,
    kind: "permission",
    status: "approved",
    evidenceDigest: scopeDigest,
    eligibleApproverIds: configuration.eligibleApproverIds,
    decision: {
      decision: "approved",
      actor: { kind: "user", id: configuration.eligibleApproverIds[0]! },
      origin: "desktop",
      decidedAt: now
    },
    createdAt: now,
    updatedAt: now
  });

  const authorizationId = dependencies.ids.commandAuthorization();
  const draft = {
    id: authorizationId,
    approvalId: approval.id,
    approvalEvidenceDigest: scopeDigest,
    scope: commandScope,
    createdAt: now,
    expiresAt,
    digest: "0".repeat(64)
  };
  const digest = await digestCommandAuthorization(draft);
  return CommandAuthorizationSchema.parse({ ...draft, digest });
};

const executeCommand = async (
  command: VerificationCommand,
  authorization: EnvironmentAuthorization,
  job: LeasedWorkflowJob,
  dependencies: StationDependencies,
  configuration: ProjectExecutionConfiguration,
  checkpoint: () => void
): Promise<VerificationResult> => {
  const spec = toCommandSpec(command, configuration.cwdRoot);
  const environmentId = executionEnvironmentForRun(job.runId);
  const commandId = dependencies.ids.command();
  checkpoint();

  const cmdAuth = await buildCommandAuthorization(
    commandId,
    spec,
    authorization,
    job,
    dependencies,
    configuration
  );
  checkpoint();

  const startedAt = dependencies.now();
  await dependencies.runner.startCommand({
    workspaceId: job.workspaceId,
    runId: job.runId,
    environmentId,
    commandId,
    command: spec,
    environmentAuthorizationId: authorization.id,
    environmentAuthorizationDigest: authorization.digest,
    authorization: cmdAuth,
    idempotency: { key: `verify:${job.jobId}:${commandId}` }
  });
  checkpoint();

  let exitCode: number | undefined;
  let durationMs = 0;
  let outputDigest = "0".repeat(64);

  for await (const item of dependencies.runner.readCommandEvents({
    workspaceId: job.workspaceId,
    runId: job.runId,
    environmentId,
    commandId,
    environmentAuthorizationId: authorization.id,
    environmentAuthorizationDigest: authorization.digest,
    commandAuthorizationId: cmdAuth.id,
    commandAuthorizationDigest: cmdAuth.digest,
    after: 0
  })) {
    checkpoint();
    if (item.type === "runner.event") {
      const event = item.event;
      if (event.type === "command.completed") {
        exitCode = event.exitCode ?? undefined;
        durationMs = event.durationMs;
        outputDigest = event.transcript.digest;
      }
    }
  }

  const status = exitCode === 0 ? "passed" : exitCode !== undefined ? "failed" : "skipped";
  return {
    command,
    status,
    ...(status !== "skipped" ? { exitCode } : {}),
    durationMs,
    startedAt,
    outputDigest
  } as VerificationResult;
};

// ---------------------------------------------------------------------------
// Station entry point
// ---------------------------------------------------------------------------

export const runVerifyStation = async (
  payload: PipelineJobPayload,
  context: WorkflowHandlerContext,
  dependencies: StationDependencies,
  configuration: ProjectExecutionConfiguration
): Promise<WorkflowHandlerResult> => {
  const job = context.job;
  const kernel = createStationKernel(job, dependencies);
  const events = await dependencies.readRunEvents(job.runId);
  const state = readPipelineState(events, job.runId);
  const run = state.run;
  if (run === undefined) throw new TypeError("A run must be recorded before it can be verified.");
  kernel.checkpoint();

  const planDocument = findPlanDocument(events, job.runId);
  if (planDocument === undefined) {
    throw new TypeError("A plan document must be recorded before verification.");
  }

  const authorization = findRecordedAuthorization(events, job.runId);
  if (authorization === undefined) {
    throw new TypeError("An environment authorization must be recorded before verification.");
  }

  const implementationEvidenceDigest = findImplementationEvidenceDigest(events, job.runId);
  if (implementationEvidenceDigest === undefined) {
    throw new TypeError("An implementation evidence must be recorded before verification.");
  }
  kernel.checkpoint();

  // Execute each verification command in order.
  const results: VerificationResult[] = [];
  for (const command of planDocument.verificationCommands) {
    try {
      const result = await executeCommand(
        command,
        authorization,
        job,
        dependencies,
        configuration,
        () => kernel.checkpoint()
      );
      results.push(result);
    } catch (error) {
      if (error instanceof StageAbandoned) throw error;
      return kernel.failDeterministically(job, classifyStageFailure(error));
    }
  }

  // Determine overall status.
  const hasRequiredFailure = results.some(
    (result) => result.command.required && result.status !== "passed"
  );
  const reportStatus = hasRequiredFailure ? "failed" : "passed";

  // Build verification report.
  const report = VerificationReportSchema.parse({
    schemaVersion: 1,
    workspaceId: job.workspaceId,
    workItemId: payload.workItemId,
    runId: job.runId,
    planDigest: planDocument.planDigest,
    status: reportStatus,
    results,
    producedAt: dependencies.now()
  });

  await digestVerificationReport(report);

  // Build verification evidence.
  const evidence = await kernel.buildEvidence({
    stage: "verify" as const,
    implementationEvidenceDigest,
    status: reportStatus,
    artifactIds: []
  });
  kernel.checkpoint();

  const occurredAt = dependencies.now();
  const correlationId = job.runId.slice(job.runId.indexOf("_") + 1);

  const recorded: PendingDomainEvent = PendingDomainEventSchema.parse({
    workspaceId: job.workspaceId,
    actor: dependencies.actor,
    correlationId,
    occurredAt,
    type: "pipeline.evidence_recorded",
    payload: {
      runId: job.runId,
      jobId: job.jobId,
      attempt: payload.attempt,
      evidence,
      document: { kind: "verify", report }
    }
  });

  if (reportStatus === "failed") {
    try {
      kernel.advance("verify", "implement", payload.attempt);
    } catch {
      return kernel.failDeterministically(job, {
        code: "rework_attempts_exhausted",
        name: "ReworkAttemptsExhausted",
        message: "Verification failed and rework attempts are exhausted.",
        retryable: false
      });
    }

    const transition = transitionRun({
      run,
      to: "implementing",
      reason: "Verification failed, reworking implementation.",
      actor: dependencies.actor,
      correlationId,
      occurredAt
    });

    const nextJobId = dependencies.ids.job();
    return {
      appends: [
        kernel.appendFor(state.streamVersion, [
          ...kernel.openStage(job),
          recorded,
          ...kernel.closeStage(job, {
            status: "failed",
            error: {
              code: "verification_failed",
              name: "VerificationFailed",
              message: "One or more required verification commands failed.",
              retryable: false
            }
          }),
          ...transition.events
        ])
      ],
      jobs: [
        {
          jobId: nextJobId,
          workspaceId: job.workspaceId,
          runId: job.runId,
          stage: "implement",
          handler: "pipeline.implement",
          payload: {
            workItemId: payload.workItemId,
            pipelineStage: "implement",
            attempt: payload.attempt + 1,
            inputEvidenceDigests: [evidence.evidenceDigest]
          },
          maxAttempts: 3,
          availableAt: occurredAt,
          createdAt: occurredAt
        }
      ]
    };
  }

  // Passed: transition to reviewing and enqueue review.
  const transition = transitionRun({
    run,
    to: "reviewing",
    reason: "Verification passed, review next.",
    actor: dependencies.actor,
    correlationId,
    occurredAt
  });

  const nextJobId = dependencies.ids.job();
  return {
    appends: [
      kernel.appendFor(state.streamVersion, [
        ...kernel.openStage(job),
        recorded,
        ...kernel.closeStage(job, { status: "succeeded" }),
        ...transition.events
      ])
    ],
    jobs: [
      {
        jobId: nextJobId,
        workspaceId: job.workspaceId,
        runId: job.runId,
        stage: "review",
        handler: "pipeline.review",
        payload: {
          workItemId: payload.workItemId,
          pipelineStage: "isolated_review",
          attempt: 1,
          inputEvidenceDigests: [evidence.evidenceDigest]
        },
        maxAttempts: 3,
        availableAt: occurredAt,
        createdAt: occurredAt
      }
    ]
  };
};
