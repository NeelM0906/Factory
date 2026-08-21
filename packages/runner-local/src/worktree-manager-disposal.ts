import type { DisposeEnvironmentRequest } from "@autostack/contracts";

import type { EnvironmentRegistry, EnvironmentRegistryState } from "./environment-registry.js";
import type { GitClient } from "./git-client.js";
import { managedPathPresent } from "./worktree-manager-root.js";
import type { PreparedEnvironmentReconciler } from "./worktree-manager-reconcile.js";
import {
  WorktreeManagerError,
  assertTargetRecord,
  digestManagerValue,
  disposalEvidenceFromState,
  exactTargetRecord,
  type AdmittedWorktreeManagerOptions,
  type WorktreeManagerDisposalBoundary
} from "./worktree-manager-shared.js";

export class WorktreeDisposal {
  readonly #registry: EnvironmentRegistry;
  readonly #git: GitClient;
  readonly #reconciler: PreparedEnvironmentReconciler;
  readonly #now: () => string;
  readonly #onBoundary: AdmittedWorktreeManagerOptions["onDisposalBoundary"];

  constructor(input: {
    readonly registry: EnvironmentRegistry;
    readonly git: GitClient;
    readonly reconciler: PreparedEnvironmentReconciler;
    readonly options: AdmittedWorktreeManagerOptions;
  }) {
    this.#registry = input.registry;
    this.#git = input.git;
    this.#reconciler = input.reconciler;
    this.#now = input.options.now;
    this.#onBoundary = input.options.onDisposalBoundary;
  }

  async recordReadyDisposal(
    state: EnvironmentRegistryState,
    request: DisposeEnvironmentRequest,
    disposalRequestDigest: string
  ): Promise<EnvironmentRegistryState> {
    await this.#invokeBoundary("before_ready_source_revalidation");
    const records = await this.#git.listWorktrees(state.intent.canonicalSourcePath);
    const record = exactTargetRecord(records, state);
    if (record === undefined) throw new WorktreeManagerError("environment_conflict");
    assertTargetRecord(record, state);
    const inspection = await this.#git.inspectWorktree(state.intent.managedPath);
    if (inspection.dirty) throw new WorktreeManagerError("dirty_worktree");
    await this.#reconciler.assertSourceBinding(state);
    const recorded = await this.#registry.recordDisposalIntent({
      environmentId: state.intent.environmentId,
      creationAttemptId: state.intent.creationAttemptId,
      disposalRequestDigest,
      environmentAuthorizationId: request.environmentAuthorizationId,
      environmentAuthorizationDigest: request.environmentAuthorizationDigest,
      terminalRunEvidence: request.terminalRunEvidence
    });
    await this.#invokeBoundary("after_disposal_recorded");
    return recorded;
  }

  async finish(state: EnvironmentRegistryState): Promise<EnvironmentRegistryState> {
    const disposal = disposalEvidenceFromState(state);
    await this.#invokeBoundary("before_final_source_revalidation");
    let records = await this.#git.listWorktrees(state.intent.canonicalSourcePath);
    let record = exactTargetRecord(records, state);
    if (record !== undefined) {
      assertTargetRecord(record, state, true);
      const inspection = await this.#git.inspectWorktree(state.intent.managedPath);
      if (inspection.dirty) throw new WorktreeManagerError("dirty_worktree");
      if (record.lockedReason === "AutoStack") {
        await this.#reconciler.assertSourceBinding(state);
        await this.#git.unlockWorktree({
          sourcePath: state.intent.canonicalSourcePath,
          worktreePath: state.intent.managedPath
        });
        await this.#invokeBoundary("after_worktree_unlock");
      }
      await this.#reconciler.assertSourceBinding(state);
      await this.#git.removeWorktree({
        sourcePath: state.intent.canonicalSourcePath,
        worktreePath: state.intent.managedPath
      });
      await this.#invokeBoundary("after_worktree_remove");
      records = await this.#git.listWorktrees(state.intent.canonicalSourcePath);
      record = exactTargetRecord(records, state);
    } else {
      await this.#reconciler.assertSourceBinding(state);
    }
    if (record !== undefined || (await managedPathPresent(state.intent.managedPath))) {
      throw new WorktreeManagerError("maintenance_required");
    }
    const branchCommit = await this.#git.resolveBranchCommit(
      state.intent.canonicalSourcePath,
      state.intent.branch
    );
    if (branchCommit !== state.intent.sourceCommit) {
      throw new WorktreeManagerError("environment_conflict");
    }
    const worktreeListDigest = this.#proofDigest(state);
    await this.#invokeBoundary("before_disposed_publication");
    return this.#registry.recordDisposed({
      environmentId: state.intent.environmentId,
      creationAttemptId: state.intent.creationAttemptId,
      disposalRequestDigest: disposal.disposalRequestDigest!,
      environmentAuthorizationId: disposal.environmentAuthorizationId!,
      environmentAuthorizationDigest: disposal.environmentAuthorizationDigest!,
      terminalRunEvidence: disposal.terminalRunEvidence!,
      worktreeListDigest,
      retainedBranchCommit: branchCommit,
      verifiedAt: this.#safeNow()
    });
  }

  async assertDisposed(state: EnvironmentRegistryState): Promise<void> {
    const disposed = state.evidence[4];
    if (
      disposed?.phase !== "disposed" ||
      disposed.retainedBranchCommit !== state.intent.sourceCommit ||
      disposed.worktreeListDigest !== this.#proofDigest(state)
    ) {
      throw new WorktreeManagerError("maintenance_required");
    }
    await this.#reconciler.assertSourceBinding(state);
    const records = await this.#git.listWorktrees(state.intent.canonicalSourcePath);
    if (
      exactTargetRecord(records, state) !== undefined ||
      (await managedPathPresent(state.intent.managedPath)) ||
      (await this.#git.resolveBranchCommit(
        state.intent.canonicalSourcePath,
        state.intent.branch
      )) !== state.intent.sourceCommit
    ) {
      throw new WorktreeManagerError("maintenance_required");
    }
  }

  #proofDigest(state: EnvironmentRegistryState): string {
    return digestManagerValue("autostack.worktree-disposal-proof", {
      repositoryIdentity: state.intent.repositoryIdentity,
      managedPath: state.intent.managedPath,
      pathAbsent: true,
      branch: state.intent.branch,
      retainedBranchCommit: state.intent.sourceCommit
    });
  }

  #safeNow(): string {
    let value: unknown;
    try {
      value = this.#now();
    } catch {
      throw new WorktreeManagerError("unsafe_state");
    }
    if (typeof value !== "string" || new Date(value).toISOString() !== value) {
      throw new WorktreeManagerError("unsafe_state");
    }
    return value;
  }

  async #invokeBoundary(boundary: WorktreeManagerDisposalBoundary): Promise<void> {
    try {
      await this.#onBoundary(boundary);
    } catch {
      throw new WorktreeManagerError("unsafe_state");
    }
  }
}
