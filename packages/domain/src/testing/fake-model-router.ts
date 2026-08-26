import {
  ModelCatalogEntrySchema,
  ModelRouteContextSchema,
  ModelRouteSchema,
  ModelRouteSelectionSchema,
  ModelUsageRecordSchema,
  ModelUsageSchema,
  type ModelCatalogEntry,
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

export type FakeModelRouterOutcome =
  | {
      readonly kind: "selected";
      readonly routeRef: string;
      readonly reason: string;
      readonly usage?: FakeModelUsageTemplate;
    }
  | {
      readonly kind: "failure";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface FakeModelRouterOptions {
  readonly catalog: readonly FakeModelRouteDeclaration[];
  readonly outcomes: readonly FakeModelRouterOutcome[];
  readonly now: () => string;
}

/** A declared provider failure, carrying the taxonomy a caller needs to decide on a fallback. */
export class FakeModelRouterFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "FakeModelRouterFailure";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface FakeModelRouter extends ModelRouterPort {
  readonly catalog: readonly ModelCatalogEntry[];
  readonly requests: readonly ModelRouteContext[];
  readonly usageRecords: readonly ModelUsageRecord[];
  readonly recordedUsage: readonly ModelUsage[];
}

const CAPABILITY_UNAVAILABLE = "model.capability_unavailable";

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

  const eligibleRouteRefs = (required: readonly string[]): ReadonlySet<string> =>
    new Set(
      catalog
        .filter((declaration) => {
          if (!declaration.route.enabled) return false;
          const declared = declaredCapabilities(declaration.catalogEntry);
          return required.every((capability) => declared.has(capability));
        })
        .map((declaration) => declaration.route.routeRef)
    );

  const resolve = async (context: ModelRouteContext): Promise<ModelRouteSelection> => {
    const request = ModelRouteContextSchema.parse(context);
    requests.push(request);

    const eligible = eligibleRouteRefs(request.requiredCapabilities);
    if (eligible.size === 0) {
      throw new FakeModelRouterFailure(
        CAPABILITY_UNAVAILABLE,
        `No declared route offers every required capability: ${request.requiredCapabilities.join(", ")}.`,
        false
      );
    }

    const outcome = options.outcomes[cursor];
    if (outcome === undefined) {
      throw new TypeError("The fake model router has no scripted outcome left for this request.");
    }
    cursor += 1;

    if (outcome.kind === "failure") {
      throw new FakeModelRouterFailure(outcome.code, outcome.message, outcome.retryable);
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
