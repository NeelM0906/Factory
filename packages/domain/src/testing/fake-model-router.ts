import {
  ModelCatalogEntrySchema,
  ModelRouteContextSchema,
  ModelRouteSchema,
  ModelRouteSelectionSchema,
  ModelUsageRecordSchema,
  ModelRoutingError,
  ModelUsageSchema,
  type ModelCatalogEntry,
  type ModelRoutingFailure,
  type ModelRoute,
  type ModelRouteContext,
  type ModelRouteSelection,
  type ModelRouterPort,
  type ModelUsage,
  type ModelUsageRecord
} from "@autostack/contracts";

/** One route paired with the capability declaration a catalog discovery would have produced. */
export interface FakeModelRouteDeclaration {
  readonly route: ModelRoute;
  readonly catalogEntry: ModelCatalogEntry;
}

/**
 * The usage a scripted completion reports. Attribution (`workspaceId`, `runId`, `stageRunId`,
 * `stage`, `routeRef`, `idempotencyKey`) comes from the resolved request and `recordedAt` from the
 * injected clock, so a script cannot record usage against the wrong run.
 */
export type FakeModelUsageTemplate = Omit<
  ModelUsageRecord,
  | "schemaVersion"
  | "idempotencyKey"
  | "workspaceId"
  | "runId"
  | "stageRunId"
  | "stage"
  | "routeRef"
  | "recordedAt"
>;

/** A declared routing failure; the fake supplies the schema version and raises it typed. */
export type FakeModelRoutingFailureTemplate = Omit<ModelRoutingFailure, "schemaVersion">;

export type FakeModelRouterOutcome =
  | {
      readonly kind: "selected";
      readonly routeRef: string;
      readonly reason: string;
      readonly usage?: FakeModelUsageTemplate;
    }
  | { readonly kind: "failure"; readonly failure: FakeModelRoutingFailureTemplate };

export interface FakeModelRouterOptions {
  readonly catalog: readonly FakeModelRouteDeclaration[];
  readonly outcomes: readonly FakeModelRouterOutcome[];
  readonly now: () => string;
}

export interface FakeModelRouter extends ModelRouterPort {
  readonly catalog: readonly ModelCatalogEntry[];
  readonly requests: readonly ModelRouteContext[];
  readonly usageRecords: readonly ModelUsageRecord[];
  readonly recordedUsage: readonly ModelUsage[];
}

const declaredCapabilities = (entry: ModelCatalogEntry): ReadonlySet<string> =>
  new Set<string>([...entry.inputModalities, ...entry.outputModalities, ...entry.features]);

export const createFakeModelRouter = (options: FakeModelRouterOptions): FakeModelRouter => {
  const catalog = options.catalog.map((declaration) => {
    const route = ModelRouteSchema.parse(declaration.route);
    const catalogEntry = ModelCatalogEntrySchema.parse(declaration.catalogEntry);
    if (catalogEntry.routeRef !== route.routeRef) {
      throw new TypeError(
        `Catalog entry ${catalogEntry.routeRef} does not describe route ${route.routeRef}.`
      );
    }
    return { route, catalogEntry };
  });

  const requests: ModelRouteContext[] = [];
  const usageRecords: ModelUsageRecord[] = [];
  const recordedUsage: ModelUsage[] = [];
  let cursor = 0;

  const eligibleRouteRefs = (required: readonly string[]): ReadonlySet<string> => {
    const capable = catalog.filter((declaration) => {
      const declared = declaredCapabilities(declaration.catalogEntry);
      return required.every((capability) => declared.has(capability));
    });
    if (capable.length === 0) {
      throw new ModelRoutingError({
        schemaVersion: 1,
        code: "capability_unavailable",
        message: `No declared route offers every required capability: ${required.join(", ")}.`,
        retryable: false
      });
    }
    const enabled = capable.filter((declaration) => declaration.route.enabled);
    if (enabled.length === 0) {
      throw new ModelRoutingError({
        schemaVersion: 1,
        code: "route_disabled",
        message: `Every route offering ${required.join(", ")} is disabled.`,
        retryable: false,
        routeRef: capable[0]?.route.routeRef
      });
    }
    return new Set(enabled.map((declaration) => declaration.route.routeRef));
  };

  const resolve = async (context: ModelRouteContext): Promise<ModelRouteSelection> => {
    const request = ModelRouteContextSchema.parse(context);
    requests.push(request);

    const eligible = eligibleRouteRefs(request.requiredCapabilities);

    const outcome = options.outcomes[cursor];
    if (outcome === undefined) {
      throw new TypeError("The fake model router has no scripted outcome left for this request.");
    }
    cursor += 1;

    if (outcome.kind === "failure") {
      throw new ModelRoutingError({ ...outcome.failure, schemaVersion: 1 });
    }
    if (!eligible.has(outcome.routeRef)) {
      throw new TypeError(
        `Scripted route ${outcome.routeRef} does not declare the required capabilities: ${request.requiredCapabilities.join(", ")}.`
      );
    }

    const selection = ModelRouteSelectionSchema.parse({
      schemaVersion: 1,
      idempotencyKey: request.idempotencyKey,
      routeRef: outcome.routeRef,
      reason: outcome.reason,
      selectedAt: options.now()
    });

    if (outcome.usage !== undefined) {
      usageRecords.push(
        ModelUsageRecordSchema.parse({
          ...outcome.usage,
          schemaVersion: 1,
          idempotencyKey: request.idempotencyKey,
          workspaceId: request.workspaceId,
          runId: request.runId,
          stageRunId: request.stageRunId,
          stage: request.stage,
          routeRef: outcome.routeRef,
          recordedAt: options.now()
        })
      );
    }

    return selection;
  };

  const getRoute = async (routeRef: string): Promise<ModelRoute | undefined> =>
    catalog.find((declaration) => declaration.route.routeRef === routeRef)?.route;

  const recordUsage = async (usage: ModelUsage): Promise<void> => {
    recordedUsage.push(ModelUsageSchema.parse(usage));
  };

  return {
    get catalog() {
      return catalog.map((declaration) => declaration.catalogEntry);
    },
    get requests() {
      return [...requests];
    },
    get usageRecords() {
      return [...usageRecords];
    },
    get recordedUsage() {
      return [...recordedUsage];
    },
    resolve,
    getRoute,
    recordUsage
  };
};
