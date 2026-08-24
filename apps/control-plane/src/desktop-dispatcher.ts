import {
  DesktopApiRequestSchemaByOperation,
  DesktopApiResponseSchemaByOperation,
  type ApprovalId,
  type DesktopApiOperationMap,
  type IdFactory,
  type InspectedSourceCapabilityId,
  type LocalPrepareRequest,
  type LocalStartRequest,
  type RepositoryCapabilityId,
  type RepositoryInspection
} from "@autostack/contracts";

type SupportedOperation = "local.inspect" | "local.prepare" | "local.start";

interface RepositoryPathAuthority {
  resolve(id: RepositoryCapabilityId): string | Promise<string>;
}

interface DesktopWorkflowAuthority {
  resolvePreparationApproval(
    runId: LocalPrepareRequest["runId"],
    environmentId: LocalPrepareRequest["environmentId"],
    authorizationId: LocalPrepareRequest["environmentAuthorizationId"]
  ): Promise<ApprovalId>;
  resolveCommandApproval(
    runId: LocalStartRequest["runId"],
    environmentId: LocalStartRequest["environmentId"],
    commandId: LocalStartRequest["commandId"],
    authorizationId: LocalStartRequest["commandAuthorizationId"]
  ): Promise<ApprovalId>;
}

interface DesktopLocalOperations {
  inspect(input: {
    readonly sourcePath: string;
    readonly baseRef: string;
  }): Promise<RepositoryInspection>;
  prepare(
    input: LocalPrepareRequest,
    idempotencyKey: string
  ): Promise<DesktopApiOperationMap["local.prepare"]["response"]>;
  start(
    input: LocalStartRequest,
    idempotencyKey: string
  ): Promise<DesktopApiOperationMap["local.start"]["response"]>;
}

export interface ControlPlaneDesktopDispatcherDependencies {
  readonly ids: Pick<IdFactory, "inspectedSourceCapability">;
  readonly repositoryPaths: RepositoryPathAuthority;
  readonly authority: DesktopWorkflowAuthority;
  readonly local: DesktopLocalOperations;
}

export interface ControlPlaneDesktopDispatcher {
  dispatch<Operation extends SupportedOperation>(
    request: DesktopApiOperationMap[Operation]["request"]
  ): Promise<DesktopApiOperationMap[Operation]["response"]>;
}

interface StoredInspectedSource {
  readonly sourcePath: string;
  readonly baseRef: string;
  readonly branchSlug: string;
}

export const createControlPlaneDesktopDispatcher = (
  dependencies: ControlPlaneDesktopDispatcherDependencies
): ControlPlaneDesktopDispatcher => {
  const sources = new Map<InspectedSourceCapabilityId, StoredInspectedSource>();

  return {
    async dispatch<Operation extends SupportedOperation>(
      candidate: DesktopApiOperationMap[Operation]["request"]
    ): Promise<DesktopApiOperationMap[Operation]["response"]> {
      const operation = candidate.operation as SupportedOperation;
      if (operation === "local.inspect") {
        const request = DesktopApiRequestSchemaByOperation["local.inspect"].parse(candidate);
        const sourcePath = await dependencies.repositoryPaths.resolve(
          request.repositoryCapabilityId
        );
        const inspection = await dependencies.local.inspect({
          sourcePath,
          baseRef: request.baseRef
        });
        const capabilityId = dependencies.ids.inspectedSourceCapability();
        sources.set(capabilityId, {
          sourcePath: inspection.canonicalSourcePath,
          baseRef: inspection.resolvedBaseRef,
          branchSlug: request.branchSlug
        });
        return DesktopApiResponseSchemaByOperation["local.inspect"].parse({
          inspectedSourceCapabilityId: capabilityId
        }) as DesktopApiOperationMap[Operation]["response"];
      }
      if (operation === "local.prepare") {
        const request = DesktopApiRequestSchemaByOperation["local.prepare"].parse(candidate);
        const source = sources.get(request.inspectedSourceCapabilityId);
        if (source === undefined)
          throw new TypeError("Inspected source capability is unavailable.");
        const approvalId = await dependencies.authority.resolvePreparationApproval(
          request.runId,
          request.environmentId,
          request.environmentAuthorizationId
        );
        const response = await dependencies.local.prepare(
          {
            runId: request.runId,
            environmentId: request.environmentId,
            environmentAuthorizationId: request.environmentAuthorizationId,
            approvalId,
            ...source
          },
          request.idempotencyKey
        );
        return response as DesktopApiOperationMap[Operation]["response"];
      }
      const request = DesktopApiRequestSchemaByOperation["local.start"].parse(candidate);
      const approvalId = await dependencies.authority.resolveCommandApproval(
        request.runId,
        request.environmentId,
        request.commandId,
        request.commandAuthorizationId
      );
      const response = await dependencies.local.start(
        {
          runId: request.runId,
          environmentId: request.environmentId,
          commandId: request.commandId,
          commandAuthorizationId: request.commandAuthorizationId,
          command: request.command,
          approvalId
        },
        request.idempotencyKey
      );
      return response as DesktopApiOperationMap[Operation]["response"];
    }
  };
};
