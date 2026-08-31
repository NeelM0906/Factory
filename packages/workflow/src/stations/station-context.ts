import type {
  Actor,
  AgentHarnessPort,
  DeliveryIntegrationPort,
  IdFactory,
  RunId,
  StoredDomainEvent,
  WorkspaceId
} from "@autostack/contracts";
import type { RunnerProvider } from "@autostack/domain";

/**
 * The single injected dependency object every delivery station receives — ports and clocks only,
 * no durable store and no station state. A station is a decision function over what it is given.
 *
 * Two omissions are deliberate (plan F20). There is no `ModelRouterPort`: no station resolves a
 * model route, because routing happens inside the harness implementation and a station that could
 * choose a route could choose a different one from the one its evidence claims. And `ids` omits
 * `stageRun`: stations address agent work by `AgentSessionId`, and a `StageRunId` minted here would
 * be an identifier nothing in the pipeline reads.
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
  >;
  readonly harness: AgentHarnessPort;
  readonly runner: RunnerProvider;
  readonly delivery: DeliveryIntegrationPort;
  readonly readRunEvents: (runId: RunId) => Promise<readonly StoredDomainEvent[]>;
  readonly workspaceId: WorkspaceId;
  readonly actor: Actor;
}
