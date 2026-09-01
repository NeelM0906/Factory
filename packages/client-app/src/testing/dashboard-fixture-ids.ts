import { createDeterministicIdFactory } from "./deterministic-ids.js";

/**
 * Every branded identifier the seeded dashboard fixture uses, minted once here so every seeding
 * module (`dashboard-fixture-entities.ts`, `-stages.ts`, `-detail-events.ts`) references the same
 * run/work-item/job/etc. by name instead of a re-derived or duplicated ID. IDs are branded types
 * (`packages/contracts/src/ids.ts`) only the schema can produce, so minting them via the existing
 * deterministic factory (never `crypto.randomUUID()`) is plumbing, not part of the fixture's
 * hand-written narrative — see `seed-dashboard-events.ts` for that.
 */
const nextId = createDeterministicIdFactory();

export const WORKSPACE_ID = nextId("workspace");

// Work items: 3 github, 2 slack, 1 manual, 1 api.
export const WI_GITHUB_1 = nextId("workItem");
export const WI_GITHUB_2 = nextId("workItem");
export const WI_GITHUB_3 = nextId("workItem");
export const WI_SLACK_1 = nextId("workItem");
export const WI_SLACK_2 = nextId("workItem");
export const WI_MANUAL_1 = nextId("workItem");
export const WI_API_1 = nextId("workItem");

// Runs: 2 active, 1 waiting on approval, 1 blocked on clarification, 1 failed, 2 completed.
export const RUN_COMPLETED_FAST = nextId("run");
export const RUN_COMPLETED_SLOW = nextId("run");
export const RUN_FAILED = nextId("run");
export const RUN_ACTIVE_IMPLEMENTING = nextId("run");
export const RUN_ACTIVE_REVIEWING = nextId("run");
export const RUN_AWAITING_PLAN_APPROVAL = nextId("run");
export const RUN_NEEDS_CLARIFICATION = nextId("run");

/** Named for the fixture-integrity test: every run this fixture seeds, keyed by its final status. */
export const DASHBOARD_RUN_IDS = {
  completedFast: RUN_COMPLETED_FAST,
  completedSlow: RUN_COMPLETED_SLOW,
  failed: RUN_FAILED,
  activeImplementing: RUN_ACTIVE_IMPLEMENTING,
  activeReviewing: RUN_ACTIVE_REVIEWING,
  awaitingPlanApproval: RUN_AWAITING_PLAN_APPROVAL,
  needsClarification: RUN_NEEDS_CLARIFICATION
} as const;

/**
 * Jobs backing the 19 stage triples, grouped by run then stage so each triple's call site in
 * `dashboard-fixture-stages.ts` reads as "this run, this stage" rather than an opaque array index.
 */
export const jobIds = {
  completedFast: {
    triage: nextId("job"),
    plan: nextId("job"),
    implement: nextId("job"),
    verify: nextId("job"),
    review: nextId("job"),
    publish: nextId("job")
  },
  failed: {
    triage: nextId("job"),
    plan: nextId("job"),
    implement: nextId("job"),
    verify: nextId("job")
  },
  activeImplementing: {
    triage: nextId("job"),
    plan: nextId("job")
  },
  activeReviewing: {
    triage: nextId("job"),
    plan: nextId("job"),
    implement: nextId("job"),
    verify: nextId("job")
  },
  awaitingPlanApproval: {
    triage: nextId("job"),
    plan: nextId("job")
  },
  needsClarification: {
    triage: nextId("job")
  }
} as const;

// Approvals: 4 total, 3 decided (known request -> decide gaps), 1 pending.
export const APR_PLAN_FAST = nextId("approval");
export const APR_PUBLISH_FAST = nextId("approval");
export const APR_PERMISSION_REVIEWING = nextId("approval");
export const APR_PLAN_PENDING = nextId("approval");

// Commands: 5 `command.completed` events, spread across 4 runs, each with its own environment.
export const CMD_FAST_IMPLEMENT = nextId("command");
export const CMD_FAST_PUBLISH = nextId("command");
export const CMD_FAILED_IMPLEMENT = nextId("command");
export const CMD_ACTIVE_IMPLEMENTING = nextId("command");
export const CMD_ACTIVE_REVIEWING = nextId("command");
export const ENV_FAST = nextId("environment");
export const ENV_FAILED = nextId("environment");
export const ENV_ACTIVE_IMPLEMENTING = nextId("environment");
export const ENV_ACTIVE_REVIEWING = nextId("environment");

// Agent sessions carrying the three `agent.session_event` usage detail events (D4 revised).
export const AGT_FAST = nextId("agentSession");
export const AGT_ACTIVE_IMPLEMENTING = nextId("agentSession");
export const AGT_ACTIVE_REVIEWING = nextId("agentSession");
