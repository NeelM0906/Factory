import type {
  Actor,
  AgentHarnessPort,
  DeliveryIntegrationPort,
  IdFactory,
  RunId,
  SourceAuthorizationPolicy,
  StoredDomainEvent,
  WorkspaceId
} from "@autostack/contracts";

import type { RunnerProvider } from "@autostack/domain";

/**
 * The single injected dependency object every delivery station receives — ports and clocks only,
 * no durable store and no station state. A station is a decision function over what it is given.
 *
 * One omission is deliberate (plan F20). There is no `ModelRouterPort`: no station resolves a model
 * route, because routing happens inside the harness implementation and a station that could choose
 * a route could choose a different one from the one its evidence claims.
 *
 * `stageRun` was removed under the same rule and is now restored, because F20's test was "drop it
 * unless exercised" and it *is* exercised: `AgentInvocationRequestSchema` requires a `stageRunId` on
 * every invocation. Without the factory a station has to fabricate one, and the only material at
 * hand is another entity's uuid — which yields a `StageRunId` and an `AgentSessionId` sharing a
 * uuid. That is identifier aliasing: it looks minted, is not traceable to the factory, and collides
 * two distinct entities for anything that ever correlates by uuid.
 */
export interface StationDependencies {
  readonly now: () => string;
  readonly random: () => number;
  /** From `WorkflowHandlerContext`: an aborted lease is abandoned, never committed (plan F1). */
  readonly signal: AbortSignal;
  readonly ids: Pick<
    IdFactory,
    | "approval"
    | "agentSession"
    | "environment"
    | "command"
    | "environmentAuthorization"
    | "commandAuthorization"
    | "artifact"
    | "job"
    | "stageRun"
  >;
  readonly harness: AgentHarnessPort;
  readonly runner: RunnerProvider;
  readonly delivery: DeliveryIntegrationPort;
  readonly readRunEvents: (runId: RunId) => Promise<readonly StoredDomainEvent[]>;
  readonly workspaceId: WorkspaceId;
  readonly actor: Actor;
  /**
   * Who may start a run from an external source, declared in workspace configuration and parsed at
   * composition. Optional, and its absence is not permission: a station that consults it treats
   * `undefined` as "no policy is in force", which refuses (spec §8.2, §14.1). It is injected rather
   * than read from the run stream because the decision must be made against durable policy the
   * delivery cannot influence, and because a policy is workspace state, not run state.
   */
  readonly sourceAuthorizationPolicy?: SourceAuthorizationPolicy | undefined;
}
