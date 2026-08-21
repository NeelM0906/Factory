export const RUN_STATUSES = [
  "queued",
  "triaging",
  "needs_clarification",
  "planning",
  "awaiting_plan_approval",
  "provisioning",
  "implementing",
  "verifying",
  "reviewing",
  "awaiting_publish_approval",
  "publishing",
  "completed",
  "waiting_for_user",
  "retry_scheduled",
  "cancelling",
  "cancelled",
  "failed"
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

type StatusTone = "neutral" | "active" | "waiting" | "success" | "failed";

const PRESENTATION: Record<RunStatus, { label: string; tone: StatusTone; cue: string }> = {
  queued: { label: "Queued", tone: "neutral", cue: "○" },
  triaging: { label: "Triaging", tone: "active", cue: "◐" },
  needs_clarification: { label: "Needs clarification", tone: "waiting", cue: "◆" },
  planning: { label: "Planning", tone: "active", cue: "◐" },
  awaiting_plan_approval: { label: "Awaiting plan approval", tone: "waiting", cue: "◆" },
  provisioning: { label: "Provisioning", tone: "active", cue: "◐" },
  implementing: { label: "Implementing", tone: "active", cue: "◐" },
  verifying: { label: "Verifying", tone: "active", cue: "◐" },
  reviewing: { label: "Reviewing", tone: "active", cue: "◐" },
  awaiting_publish_approval: {
    label: "Awaiting publish approval",
    tone: "waiting",
    cue: "◆"
  },
  publishing: { label: "Publishing", tone: "active", cue: "◐" },
  completed: { label: "Completed", tone: "success", cue: "✓" },
  waiting_for_user: { label: "Waiting for user", tone: "waiting", cue: "◆" },
  retry_scheduled: { label: "Retry scheduled", tone: "waiting", cue: "↻" },
  cancelling: { label: "Cancelling", tone: "active", cue: "◐" },
  cancelled: { label: "Cancelled", tone: "neutral", cue: "—" },
  failed: { label: "Failed", tone: "failed", cue: "!" }
};

export interface RunStatusBadgeProps {
  readonly status: RunStatus;
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const presentation = PRESENTATION[status];
  return (
    <span
      className="as-status"
      data-tone={presentation.tone}
      role="status"
      aria-label={`Run status: ${presentation.label}`}
    >
      <span className="as-status__cue" aria-hidden="true">
        {presentation.cue}
      </span>
      <span>{presentation.label}</span>
    </span>
  );
}
