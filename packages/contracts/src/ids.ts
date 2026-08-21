import { z } from "zod";

export const ID_PREFIX = {
  workspace: "ws",
  project: "prj",
  workItem: "wi",
  run: "run",
  stageRun: "stage",
  agentSession: "agt",
  environment: "env",
  command: "cmd",
  environmentAuthorization: "envauth",
  commandAuthorization: "cmdauth",
  repositoryCapability: "repocap",
  inspectedSourceCapability: "inspsrc",
  approval: "apr",
  artifact: "art",
  automation: "aut",
  credentialRef: "cred",
  event: "evt",
  job: "job"
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const schemaFor = <Brand extends string>(prefix: string, brand: Brand) => {
  void brand;
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${UUID_PATTERN}$`, "i"))
    .brand<Brand>();
};

export const WorkspaceIdSchema = schemaFor(ID_PREFIX.workspace, "WorkspaceId");
export const ProjectIdSchema = schemaFor(ID_PREFIX.project, "ProjectId");
export const WorkItemIdSchema = schemaFor(ID_PREFIX.workItem, "WorkItemId");
export const RunIdSchema = schemaFor(ID_PREFIX.run, "RunId");
export const StageRunIdSchema = schemaFor(ID_PREFIX.stageRun, "StageRunId");
export const AgentSessionIdSchema = schemaFor(ID_PREFIX.agentSession, "AgentSessionId");
export const EnvironmentIdSchema = schemaFor(ID_PREFIX.environment, "EnvironmentId");
export const CommandIdSchema = schemaFor(ID_PREFIX.command, "CommandId");
export const EnvironmentAuthorizationIdSchema = schemaFor(
  ID_PREFIX.environmentAuthorization,
  "EnvironmentAuthorizationId"
);
export const CommandAuthorizationIdSchema = schemaFor(
  ID_PREFIX.commandAuthorization,
  "CommandAuthorizationId"
);
export const RepositoryCapabilityIdSchema = schemaFor(
  ID_PREFIX.repositoryCapability,
  "RepositoryCapabilityId"
);
export const InspectedSourceCapabilityIdSchema = schemaFor(
  ID_PREFIX.inspectedSourceCapability,
  "InspectedSourceCapabilityId"
);
export const ApprovalIdSchema = schemaFor(ID_PREFIX.approval, "ApprovalId");
export const ArtifactIdSchema = schemaFor(ID_PREFIX.artifact, "ArtifactId");
export const AutomationIdSchema = schemaFor(ID_PREFIX.automation, "AutomationId");
export const CredentialRefIdSchema = schemaFor(ID_PREFIX.credentialRef, "CredentialRefId");
export const EventIdSchema = schemaFor(ID_PREFIX.event, "EventId");
export const JobIdSchema = schemaFor(ID_PREFIX.job, "JobId");

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type WorkItemId = z.infer<typeof WorkItemIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type StageRunId = z.infer<typeof StageRunIdSchema>;
export type AgentSessionId = z.infer<typeof AgentSessionIdSchema>;
export type EnvironmentId = z.infer<typeof EnvironmentIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type EnvironmentAuthorizationId = z.infer<typeof EnvironmentAuthorizationIdSchema>;
export type CommandAuthorizationId = z.infer<typeof CommandAuthorizationIdSchema>;
export type RepositoryCapabilityId = z.infer<typeof RepositoryCapabilityIdSchema>;
export type InspectedSourceCapabilityId = z.infer<typeof InspectedSourceCapabilityIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type AutomationId = z.infer<typeof AutomationIdSchema>;
export type CredentialRefId = z.infer<typeof CredentialRefIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type JobId = z.infer<typeof JobIdSchema>;

export interface IdTypeMap {
  readonly workspace: WorkspaceId;
  readonly project: ProjectId;
  readonly workItem: WorkItemId;
  readonly run: RunId;
  readonly stageRun: StageRunId;
  readonly agentSession: AgentSessionId;
  readonly environment: EnvironmentId;
  readonly command: CommandId;
  readonly environmentAuthorization: EnvironmentAuthorizationId;
  readonly commandAuthorization: CommandAuthorizationId;
  readonly repositoryCapability: RepositoryCapabilityId;
  readonly inspectedSourceCapability: InspectedSourceCapabilityId;
  readonly approval: ApprovalId;
  readonly artifact: ArtifactId;
  readonly automation: AutomationId;
  readonly credentialRef: CredentialRefId;
  readonly event: EventId;
  readonly job: JobId;
}

export type IdFor<K extends IdKind> = IdTypeMap[K];

const ID_SCHEMAS = {
  workspace: WorkspaceIdSchema,
  project: ProjectIdSchema,
  workItem: WorkItemIdSchema,
  run: RunIdSchema,
  stageRun: StageRunIdSchema,
  agentSession: AgentSessionIdSchema,
  environment: EnvironmentIdSchema,
  command: CommandIdSchema,
  environmentAuthorization: EnvironmentAuthorizationIdSchema,
  commandAuthorization: CommandAuthorizationIdSchema,
  repositoryCapability: RepositoryCapabilityIdSchema,
  inspectedSourceCapability: InspectedSourceCapabilityIdSchema,
  approval: ApprovalIdSchema,
  artifact: ArtifactIdSchema,
  automation: AutomationIdSchema,
  credentialRef: CredentialRefIdSchema,
  event: EventIdSchema,
  job: JobIdSchema
} as const;

const secureRandomUuid = (): string => globalThis.crypto.randomUUID();

export function createId<K extends IdKind>(kind: K, uuid: string = secureRandomUuid()): IdFor<K> {
  const validUuid = z.uuid().parse(uuid);
  return ID_SCHEMAS[kind].parse(`${ID_PREFIX[kind]}_${validUuid}`) as IdFor<K>;
}

export interface IdFactory {
  workspace(): WorkspaceId;
  project(): ProjectId;
  workItem(): WorkItemId;
  run(): RunId;
  stageRun(): StageRunId;
  agentSession(): AgentSessionId;
  environment(): EnvironmentId;
  command(): CommandId;
  environmentAuthorization(): EnvironmentAuthorizationId;
  commandAuthorization(): CommandAuthorizationId;
  repositoryCapability(): RepositoryCapabilityId;
  inspectedSourceCapability(): InspectedSourceCapabilityId;
  approval(): ApprovalId;
  artifact(): ArtifactId;
  automation(): AutomationId;
  credentialRef(): CredentialRefId;
  event(): EventId;
  job(): JobId;
}

export function createIdFactory(random: () => string = secureRandomUuid): IdFactory {
  const generate =
    <K extends IdKind>(kind: K) =>
    () =>
      createId(kind, random());

  return {
    workspace: generate("workspace"),
    project: generate("project"),
    workItem: generate("workItem"),
    run: generate("run"),
    stageRun: generate("stageRun"),
    agentSession: generate("agentSession"),
    environment: generate("environment"),
    command: generate("command"),
    environmentAuthorization: generate("environmentAuthorization"),
    commandAuthorization: generate("commandAuthorization"),
    repositoryCapability: generate("repositoryCapability"),
    inspectedSourceCapability: generate("inspectedSourceCapability"),
    approval: generate("approval"),
    artifact: generate("artifact"),
    automation: generate("automation"),
    credentialRef: generate("credentialRef"),
    event: generate("event"),
    job: generate("job")
  };
}
