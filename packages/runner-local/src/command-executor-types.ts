import type {
  ArtifactId,
  CommandId,
  CredentialRefId,
  EnvironmentId,
  RunId,
  WorkspaceId
} from "@autostack/contracts";

import type { ActiveCommandLease } from "./command-activity.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { GuardianHostObserver, GuardianHostSession } from "./command-guardian.js";
import type { PtyEnvironmentValue, PtySpawnRequest } from "./pty.js";
import type {
  EnvironmentQuiescenceLease,
  ResolvedPreparedEnvironment
} from "./worktree-manager.js";

export interface CommandSecretResolutionRequest {
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
  readonly commandId: CommandId;
  readonly credentialRefIds: readonly CredentialRefId[];
}

export interface ResolvedCommandCredential {
  readonly credentialRefId: CredentialRefId;
  readonly value: string;
}

export type CommandSecretResolver = (
  request: CommandSecretResolutionRequest
) => Promise<readonly ResolvedCommandCredential[]>;

export interface ResolvedExecutable {
  readonly canonicalPath: string;
  readonly identityDigest: string;
  revalidate(): Promise<boolean>;
}

export interface ExecutableResolver {
  resolve(request: {
    readonly executable: string;
    readonly cwd: string;
    readonly environment: readonly PtyEnvironmentValue[];
  }): Promise<ResolvedExecutable>;
}

export interface GuardianSessionMaterial {
  readonly sessionId: string;
  readonly secret: Uint8Array;
  readonly bindingDigest: string;
}

export interface GuardianBootstrap {
  readonly dataRoot: string;
  readonly commandId: CommandId;
  readonly intentRelativePath: string;
  readonly envelope: PtySpawnRequest;
  readonly sensitiveValues: readonly string[];
  readonly timeoutMs: number;
  readonly cancellationGraceMs: number;
  readonly eofSettleMs: number;
  readonly executableIdentityDigest: string;
  readonly cwdIdentityDigest: string;
  readonly session: GuardianSessionMaterial;
}

export interface GuardianLauncher {
  launch(
    bootstrap: GuardianBootstrap,
    observer: GuardianHostObserver
  ): Promise<GuardianHostSession>;
}

export interface CommandExecutionLimits {
  readonly eventBytes: number;
  readonly replayBytes: number;
  readonly transcriptBytes: number;
  readonly artifactBytes: number;
  readonly cancellationGraceMs: number;
  readonly eofSettleMs: number;
  readonly subscriberQueueFrames: number;
  readonly subscriberQueueBytes: number;
}

export interface CommandActivityBoundary {
  reserveCommand(environmentId: EnvironmentId, commandId: CommandId): Promise<ActiveCommandLease>;
  acquireEnvironmentQuiescence(
    environmentId: EnvironmentId
  ): Promise<EnvironmentQuiescenceLease | undefined> | EnvironmentQuiescenceLease | undefined;
  closeAdmission(): void;
}

export interface CommandExecutorOptions {
  readonly dataRoot: string;
  readonly worktrees: {
    resolvePreparedEnvironment(environmentId: EnvironmentId): Promise<ResolvedPreparedEnvironment>;
  };
  readonly artifactStore: ArtifactStore;
  readonly activity: CommandActivityBoundary;
  readonly guardianLauncher: GuardianLauncher;
  readonly resolveCredentials: CommandSecretResolver;
  readonly executableResolver: ExecutableResolver;
  readonly trustedBaseEnvironment: readonly PtyEnvironmentValue[];
  readonly limits: CommandExecutionLimits;
  readonly now: () => string;
  readonly monotonicNowMs: () => number;
  readonly createArtifactId: () => ArtifactId;
  readonly createGuardianSession: () => GuardianSessionMaterial;
}
