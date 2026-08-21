import {
  PendingDomainEventSchema,
  RunSchema,
  type Actor,
  type PendingDomainEvent,
  type Run,
  type RunStage,
  type RunStatus
} from "@autostack/contracts";

import { InvalidRunTransitionError } from "./errors.js";

const TERMINAL = new Set<RunStatus>(["completed", "cancelled", "failed"]);
const RESUMABLE = new Set<RunStatus>(["waiting_for_user", "retry_scheduled"]);

const DECLARED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["triaging"],
  triaging: ["needs_clarification", "planning"],
  needs_clarification: ["triaging"],
  planning: ["awaiting_plan_approval"],
  awaiting_plan_approval: ["provisioning", "planning"],
  provisioning: ["implementing"],
  implementing: ["verifying"],
  verifying: ["reviewing", "implementing"],
  reviewing: ["awaiting_publish_approval", "implementing"],
  awaiting_publish_approval: ["publishing", "reviewing"],
  publishing: ["completed"],
  completed: [],
  waiting_for_user: [],
  retry_scheduled: [],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  failed: []
};

const STAGE_BY_STATUS: Partial<Record<RunStatus, RunStage>> = {
  triaging: "triage",
  needs_clarification: "triage",
  planning: "plan",
  awaiting_plan_approval: "plan",
  provisioning: "implement",
  implementing: "implement",
  verifying: "verify",
  reviewing: "review",
  awaiting_publish_approval: "review",
  publishing: "publish"
};

export interface TransitionRunCommand {
  readonly run: Run;
  readonly to: RunStatus;
  readonly reason: string;
  readonly resumeStatus?: RunStatus;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly occurredAt: string;
}

const isAllowed = (command: TransitionRunCommand): boolean => {
  const { run, to, resumeStatus } = command;
  const from = run.status;

  if (TERMINAL.has(from)) return false;
  if (to === "failed" || to === "cancelling") return to !== from;
  if (from === "cancelling") return to === "cancelled";

  if (RESUMABLE.has(to)) {
    return !RESUMABLE.has(from) && resumeStatus === from;
  }

  if (RESUMABLE.has(from)) {
    return run.resumeStatus !== undefined && to === run.resumeStatus;
  }

  return DECLARED_TRANSITIONS[from].includes(to);
};

const updateRun = (command: TransitionRunCommand): Run => {
  const { run, to, resumeStatus, occurredAt } = command;
  const {
    resumeStatus: ignoredResumeStatus,
    currentStage: ignoredCurrentStage,
    completedAt: ignoredCompletedAt,
    ...base
  } = run;
  void ignoredResumeStatus;
  void ignoredCurrentStage;
  void ignoredCompletedAt;

  const terminal = TERMINAL.has(to);
  const stage = RESUMABLE.has(to) || to === "cancelling" ? run.currentStage : STAGE_BY_STATUS[to];

  return RunSchema.parse({
    ...base,
    status: to,
    updatedAt: occurredAt,
    ...(RESUMABLE.has(to) ? { resumeStatus } : {}),
    ...(stage === undefined || terminal ? {} : { currentStage: stage }),
    ...(terminal ? { completedAt: occurredAt } : {})
  });
};

export function transitionRun(command: TransitionRunCommand): {
  readonly run: Run;
  readonly events: readonly PendingDomainEvent[];
} {
  if (!isAllowed(command)) {
    throw new InvalidRunTransitionError(command.run.status, command.to);
  }

  const run = updateRun(command);
  const event = PendingDomainEventSchema.parse({
    workspaceId: command.run.workspaceId,
    actor: command.actor,
    correlationId: command.correlationId,
    occurredAt: command.occurredAt,
    type: "run.transitioned",
    payload: {
      runId: command.run.id,
      from: command.run.status,
      to: command.to,
      reason: command.reason,
      ...(command.resumeStatus === undefined ? {} : { resumeStatus: command.resumeStatus })
    }
  });

  return { run, events: [event] };
}

export { InvalidRunTransitionError };
