import { createHash } from "node:crypto";

import {
  DisposeEnvironmentRequestSchema,
  DisposeEnvironmentResponseSchema,
  EnvironmentIdSchema,
  PrepareEnvironmentRequestSchema,
  canonicalizeEnvironmentAuthorizationForDigest,
  normalizeSafeJson,
  type DisposeEnvironmentRequest,
  type DisposeEnvironmentResponse,
  type EnvironmentId,
  type PrepareEnvironmentRequest,
  type PreparedEnvironment,
  type TerminalRunEvidence
} from "@autostack/contracts";

import { DataRootLockError, acquireDataRootLock, type DataRootLock } from "./data-root-lock.js";
import {
  EnvironmentRegistry,
  EnvironmentRegistryError,
  type EnvironmentRegistryState
} from "./environment-registry.js";
import { GitClient, GitClientError } from "./git-client.js";
import { DataPathPolicy } from "./path-policy.js";
import { WorktreeDisposal } from "./worktree-manager-disposal.js";
import { PreparedEnvironmentReconciler } from "./worktree-manager-reconcile.js";
import { assertManagedRoot } from "./worktree-manager-root.js";
import {
  WorktreeManagerError,
  deepFreezeManagerValue,
  digestManagerValue,
  disposalEvidenceFromState,
  preparedFromRegistryState,
  resolvedPreparedFromState,
  snapshotManagerOptions,
  type AdmittedWorktreeManagerOptions,
  type EnvironmentQuiescenceLease,
  type ResolvedPreparedEnvironment,
  type TerminalEvidenceVerification,
  type WorktreeManagerDisposalBoundary,
  type WorktreeManagerErrorCode,
  type WorktreeManagerOptions
} from "./worktree-manager-shared.js";

export {
  WorktreeManagerError,
  type EnvironmentQuiescenceLease,
  type ResolvedPreparedEnvironment,
  type TerminalEvidenceVerification,
  type WorktreeManagerDisposalBoundary,
  type WorktreeManagerErrorCode,
  type WorktreeManagerOptions
};

export class WorktreeManager {
  readonly #registry: EnvironmentRegistry;
  readonly #git: GitClient;
  readonly #lock: DataRootLock;
  readonly #reconciler: PreparedEnvironmentReconciler;
  readonly #disposal: WorktreeDisposal;
  readonly #verifyTerminalEvidence: AdmittedWorktreeManagerOptions["verifyTerminalEvidence"];
  readonly #acquireEnvironmentQuiescence: AdmittedWorktreeManagerOptions["acquireEnvironmentQuiescence"];
  #operationTail: Promise<void> = Promise.resolve();
  #admissionClosed = false;
  #closed = false;
  #leaseSafetyQuarantined = false;
  #processUnsafe = false;

  private constructor(input: {
    readonly registry: EnvironmentRegistry;
    readonly git: GitClient;
    readonly lock: DataRootLock;
    readonly reconciler: PreparedEnvironmentReconciler;
    readonly disposal: WorktreeDisposal;
    readonly options: AdmittedWorktreeManagerOptions;
  }) {
    this.#registry = input.registry;
    this.#git = input.git;
    this.#lock = input.lock;
    this.#reconciler = input.reconciler;
    this.#disposal = input.disposal;
    this.#verifyTerminalEvidence = input.options.verifyTerminalEvidence;
    this.#acquireEnvironmentQuiescence = input.options.acquireEnvironmentQuiescence;
  }

  static async create(optionsInput: WorktreeManagerOptions): Promise<WorktreeManager> {
    let lock: DataRootLock | undefined;
    try {
      const options = snapshotManagerOptions(optionsInput);
      lock = await acquireDataRootLock(options.dataRoot);
      const paths = await DataPathPolicy.create(lock.root);
      const managedWorktreeRoot = await paths.ensureDirectory("worktrees");
      const privateConfigRoot = await paths.ensureDirectory("git-config");
      await paths.ensureDirectory("git-config/home");
      await paths.ensureDirectory("git-config/xdg");
      const registry = await EnvironmentRegistry.create({
        dataRoot: lock.root,
        now: options.now,
        ...(options.onRegistryBoundary === undefined
          ? {}
          : { onBoundary: options.onRegistryBoundary }),
        ...(options.createAttemptId === undefined
          ? {}
          : { createAttemptId: options.createAttemptId })
      });
      const git = await GitClient.create({
        managedWorktreeRoot,
        privateConfigRoot,
        ...(options.trustedGitExecutable === undefined
          ? {}
          : { trustedGitExecutable: options.trustedGitExecutable }),
        ...(options.gitProcessRunner === undefined
          ? {}
          : { processRunner: options.gitProcessRunner })
      });
      const reconciler = new PreparedEnvironmentReconciler({ paths, registry, git });
      const disposal = new WorktreeDisposal({ registry, git, reconciler, options });
      const manager = new WorktreeManager({
        registry,
        git,
        lock,
        reconciler,
        disposal,
        options
      });
      const states = await registry.recoverAll();
      await assertManagedRoot(paths, states);
      for (const state of states) {
        if (state.phase === "disposal_recorded" && options.deferStartupDisposal) continue;
        await manager.#recoverStartupState(state);
      }
      lock = undefined;
      return manager;
    } catch (error) {
      try {
        lock?.close();
      } catch {
        // Preserve the original stable failure.
      }
      throw WorktreeManager.#normalizeError(error);
    }
  }

  async prepareEnvironment(requestInput: PrepareEnvironmentRequest): Promise<PreparedEnvironment> {
    return this.#runOperation(async () => {
      const request = this.#admitPrepareRequest(requestInput);
      const inspected = await this.#git.inspectRepository({
        sourcePath: request.inspection.canonicalSourcePath,
        baseRef: request.inspection.resolvedBaseRef
      });
      if (
        JSON.stringify(inspected.inspection) !== JSON.stringify(request.inspection) ||
        inspected.inspection.sourceCommit !== request.sourceCommit
      ) {
        throw new WorktreeManagerError("environment_conflict");
      }
      const prepareRequestDigest = digestManagerValue(
        "autostack.prepare-environment-request",
        request
      );
      let state = await this.#registry.recordIntent({
        workspaceId: request.workspaceId,
        runId: request.runId,
        environmentId: request.environmentId,
        repositoryIdentity: request.inspection.repositoryIdentity,
        canonicalSourcePath: request.inspection.canonicalSourcePath,
        repositoryCommonDirectory: request.inspection.repositoryCommonDirectory,
        sourceCommit: request.sourceCommit,
        branch: request.branch,
        safeConfigDigest: inspected.safeConfigDigest,
        authorization: request.authorization,
        prepareRequestDigest
      });
      if (
        state.intent.prepareRequestDigest !== prepareRequestDigest ||
        state.phase === "disposal_recorded" ||
        state.phase === "disposed"
      ) {
        throw new WorktreeManagerError("environment_conflict");
      }
      state = await this.#reconciler.reconcile(state);
      if (state.phase !== "ready") throw new WorktreeManagerError("environment_conflict");
      return preparedFromRegistryState(state);
    });
  }

  async listEnvironments(): Promise<readonly PreparedEnvironment[]> {
    return this.#runOperation(async () => {
      const states = await this.#registry.recoverAll();
      const results: PreparedEnvironment[] = [];
      for (const state of states) {
        if (state.phase !== "ready") continue;
        const reconciled = await this.#reconciler.reconcile(state);
        if (reconciled.phase !== "ready") {
          throw new WorktreeManagerError("environment_conflict");
        }
        results.push(preparedFromRegistryState(reconciled));
      }
      return Object.freeze(results);
    });
  }

  async resolvePreparedEnvironment(
    environmentIdInput: EnvironmentId
  ): Promise<ResolvedPreparedEnvironment> {
    return this.#runOperation(async () => {
      const parsed = EnvironmentIdSchema.safeParse(normalizeSafeJson(environmentIdInput));
      if (!parsed.success) throw new WorktreeManagerError("invalid_request");
      const state = await this.#registry.recoverEnvironment(parsed.data);
      if (state?.phase !== "ready") throw new WorktreeManagerError("environment_conflict");
      return resolvedPreparedFromState(await this.#reconciler.reconcile(state));
    });
  }

  async disposeEnvironment(
    requestInput: DisposeEnvironmentRequest
  ): Promise<DisposeEnvironmentResponse> {
    return this.#runOperation(async () => {
      const request = this.#admitDisposeRequest(requestInput);
      const disposalRequestDigest = digestManagerValue(
        "autostack.dispose-environment-request",
        request
      );
      const recovered = await this.#registry.recoverEnvironment(request.environmentId);
      if (recovered === undefined) throw new WorktreeManagerError("environment_conflict");
      let state = recovered;
      this.#assertDisposalOwnership(state, request);
      if (state.phase === "disposed") {
        if (disposalEvidenceFromState(state).disposalRequestDigest !== disposalRequestDigest) {
          throw new WorktreeManagerError("environment_conflict");
        }
        await this.#disposal.assertDisposed(state);
        return this.#disposeResponse(state.intent.environmentId, true);
      }
      const lease = await this.#acquireLease(request.environmentId);
      return this.#withLease(lease, async () => {
        if (!(await this.#verifyEvidence(state, request.terminalRunEvidence))) {
          throw new WorktreeManagerError("terminal_evidence_invalid");
        }
        if (state.phase === "ready") {
          state = await this.#disposal.recordReadyDisposal(state, request, disposalRequestDigest);
        } else if (
          state.phase !== "disposal_recorded" ||
          disposalEvidenceFromState(state).disposalRequestDigest !== disposalRequestDigest
        ) {
          throw new WorktreeManagerError("environment_conflict");
        }
        state = await this.#disposal.finish(state);
        return this.#disposeResponse(state.intent.environmentId, false);
      });
    });
  }

  async resumePendingDisposals(): Promise<void> {
    return this.#runOperation(async () => {
      const states = await this.#registry.recoverAll();
      for (const state of states) {
        if (state.phase === "disposal_recorded") await this.#recoverStartupState(state);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#admissionClosed = true;
    await this.#operationTail;
    if (this.#closed) return;
    try {
      this.#lock.close();
    } catch (error) {
      this.#closed = true;
      throw WorktreeManager.#normalizeError(error);
    }
    this.#closed = true;
  }

  async #recoverStartupState(state: EnvironmentRegistryState): Promise<void> {
    if (state.phase === "disposed") {
      await this.#disposal.assertDisposed(state);
      return;
    }
    if (state.phase === "disposal_recorded") {
      const lease = await this.#acquireLease(state.intent.environmentId);
      await this.#withLease(lease, async () => {
        const evidence = disposalEvidenceFromState(state).terminalRunEvidence;
        if (evidence === undefined || !(await this.#verifyEvidence(state, evidence))) {
          throw new WorktreeManagerError("terminal_evidence_invalid");
        }
        await this.#disposal.finish(state);
      });
      return;
    }
    await this.#reconciler.reconcile(state);
  }

  #admitPrepareRequest(requestInput: PrepareEnvironmentRequest): PrepareEnvironmentRequest {
    let request: PrepareEnvironmentRequest;
    try {
      request = deepFreezeManagerValue(
        PrepareEnvironmentRequestSchema.parse(normalizeSafeJson(requestInput))
      );
    } catch {
      throw new WorktreeManagerError("invalid_request");
    }
    const authorizationDigest = createHash("sha256")
      .update(canonicalizeEnvironmentAuthorizationForDigest(request.authorization), "utf8")
      .digest("hex");
    if (authorizationDigest !== request.authorization.digest) {
      throw new WorktreeManagerError("invalid_request");
    }
    return request;
  }

  #admitDisposeRequest(requestInput: DisposeEnvironmentRequest): DisposeEnvironmentRequest {
    try {
      return deepFreezeManagerValue(
        DisposeEnvironmentRequestSchema.parse(normalizeSafeJson(requestInput))
      );
    } catch {
      throw new WorktreeManagerError("invalid_request");
    }
  }

  #assertDisposalOwnership(
    state: EnvironmentRegistryState,
    request: DisposeEnvironmentRequest
  ): void {
    if (
      state.intent.workspaceId !== request.workspaceId ||
      state.intent.runId !== request.runId ||
      state.intent.environmentId !== request.environmentId ||
      state.intent.authorization.id !== request.environmentAuthorizationId ||
      state.intent.authorization.digest !== request.environmentAuthorizationDigest
    ) {
      throw new WorktreeManagerError("environment_conflict");
    }
  }

  async #runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#admissionClosed || this.#closed) throw new WorktreeManagerError("closed");
    if (this.#processUnsafe) throw new WorktreeManagerError("unsafe_process_state");
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      if (this.#leaseSafetyQuarantined || this.#closed) {
        throw new WorktreeManagerError("closed");
      }
      if (this.#processUnsafe) throw new WorktreeManagerError("unsafe_process_state");
      return await operation();
    } catch (error) {
      const normalized = WorktreeManager.#normalizeError(error);
      if (normalized.code === "unsafe_process_state") this.#processUnsafe = true;
      throw normalized;
    } finally {
      release();
    }
  }

  async #verifyEvidence(
    state: EnvironmentRegistryState,
    evidence: TerminalRunEvidence
  ): Promise<boolean> {
    const verification = deepFreezeManagerValue({
      workspaceId: state.intent.workspaceId,
      runId: state.intent.runId,
      environmentId: state.intent.environmentId,
      environmentAuthorizationId: state.intent.authorization.id,
      environmentAuthorizationDigest: state.intent.authorization.digest,
      terminalRunEvidence: deepFreezeManagerValue(
        normalizeSafeJson(evidence) as TerminalRunEvidence
      )
    });
    try {
      return (await this.#verifyTerminalEvidence(verification)) === true;
    } catch {
      return false;
    }
  }

  async #acquireLease(environmentId: EnvironmentId): Promise<{
    readonly close: () => Promise<void>;
  }> {
    let candidate: EnvironmentQuiescenceLease | undefined;
    try {
      candidate = await this.#acquireEnvironmentQuiescence(environmentId);
    } catch {
      throw new WorktreeManagerError("unsafe_state");
    }
    if (candidate === undefined) throw new WorktreeManagerError("active_commands");
    let close: unknown;
    try {
      close = candidate.close;
    } catch {
      this.#quarantineLeaseSafety();
      throw new WorktreeManagerError("unsafe_state");
    }
    if (typeof close !== "function") {
      this.#quarantineLeaseSafety();
      throw new WorktreeManagerError("unsafe_state");
    }
    let closed = false;
    return Object.freeze({
      close: async () => {
        if (closed) return;
        try {
          await Reflect.apply(close, candidate, []);
        } catch {
          throw new WorktreeManagerError("unsafe_state");
        }
        closed = true;
      }
    });
  }

  async #withLease<T>(
    lease: { readonly close: () => Promise<void> },
    operation: () => Promise<T>
  ): Promise<T> {
    let result!: T;
    let primaryError: unknown;
    let succeeded = false;
    try {
      result = await operation();
      succeeded = true;
    } catch (error) {
      primaryError = error;
    }
    try {
      await lease.close();
    } catch {
      this.#quarantineLeaseSafety();
      if (!succeeded) throw primaryError;
      throw new WorktreeManagerError("unsafe_state");
    }
    if (!succeeded) throw primaryError;
    return result;
  }

  #quarantineLeaseSafety(): void {
    this.#leaseSafetyQuarantined = true;
    this.#admissionClosed = true;
  }

  #disposeResponse(environmentId: EnvironmentId, replayed: boolean): DisposeEnvironmentResponse {
    return deepFreezeManagerValue(
      DisposeEnvironmentResponseSchema.parse({ environmentId, disposed: true, replayed })
    );
  }

  static #normalizeError(error: unknown): WorktreeManagerError {
    if (error instanceof WorktreeManagerError) return new WorktreeManagerError(error.code);
    if (error instanceof DataRootLockError) {
      return new WorktreeManagerError(error.code === "root_busy" ? "root_busy" : "unsafe_state");
    }
    if (error instanceof GitClientError) {
      if (error.code === "unsafe_process_state") {
        return new WorktreeManagerError("unsafe_process_state");
      }
      if (error.code === "branch_conflict" || error.code === "config_changed") {
        return new WorktreeManagerError("environment_conflict");
      }
      return new WorktreeManagerError("unsafe_state");
    }
    if (error instanceof EnvironmentRegistryError) {
      if (
        error.code === "conflicting_record" ||
        error.code === "invalid_transition" ||
        error.code === "invalid_input"
      ) {
        return new WorktreeManagerError("environment_conflict");
      }
      if (error.code === "maintenance_required") {
        return new WorktreeManagerError("maintenance_required");
      }
    }
    return new WorktreeManagerError("unsafe_state");
  }
}
