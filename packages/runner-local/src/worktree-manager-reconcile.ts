import type { EnvironmentRegistry, EnvironmentRegistryState } from "./environment-registry.js";
import type { GitClient } from "./git-client.js";
import type { DataPathPolicy } from "./path-policy.js";
import { hardenManagedDirectory } from "./worktree-manager-root.js";
import {
  WorktreeManagerError,
  assertTargetRecord,
  exactTargetRecord,
  inspectionMatchesIntent
} from "./worktree-manager-shared.js";

export class PreparedEnvironmentReconciler {
  readonly #paths: DataPathPolicy;
  readonly #registry: EnvironmentRegistry;
  readonly #git: GitClient;

  constructor(input: {
    readonly paths: DataPathPolicy;
    readonly registry: EnvironmentRegistry;
    readonly git: GitClient;
  }) {
    this.#paths = input.paths;
    this.#registry = input.registry;
    this.#git = input.git;
  }

  async assertSourceBinding(state: EnvironmentRegistryState): Promise<void> {
    const inspected = await this.#git.inspectRepository({
      sourcePath: state.intent.canonicalSourcePath,
      baseRef: state.intent.sourceCommit
    });
    if (!inspectionMatchesIntent(inspected, state)) {
      throw new WorktreeManagerError("environment_conflict");
    }
    await this.#git.assertSafeConfigDigest(
      state.intent.canonicalSourcePath,
      state.intent.safeConfigDigest
    );
  }

  async reconcile(stateInput: EnvironmentRegistryState): Promise<EnvironmentRegistryState> {
    let state = stateInput;
    if (state.phase === "disposed" || state.phase === "disposal_recorded") {
      throw new WorktreeManagerError("environment_conflict");
    }
    await this.assertSourceBinding(state);
    await this.#paths.ensureDirectory(`worktrees/${state.intent.repositoryDigest}`);
    let records = await this.#git.listWorktrees(state.intent.canonicalSourcePath);
    let record = exactTargetRecord(records, state);
    if (state.phase === "intent_recorded" && record === undefined) {
      const branchCommit = await this.#git.resolveBranchCommit(
        state.intent.canonicalSourcePath,
        state.intent.branch
      );
      const request = {
        sourcePath: state.intent.canonicalSourcePath,
        expectedSafeConfigDigest: state.intent.safeConfigDigest,
        branch: state.intent.branch,
        worktreePath: state.intent.managedPath,
        commit: state.intent.sourceCommit
      };
      if (branchCommit === undefined) await this.#git.addLockedWorktree(request);
      else if (branchCommit === state.intent.sourceCommit) {
        await this.#git.attachExistingLockedWorktree(request);
      } else throw new WorktreeManagerError("environment_conflict");
      await hardenManagedDirectory(state.intent.managedPath);
      records = await this.#git.listWorktrees(state.intent.canonicalSourcePath);
      record = exactTargetRecord(records, state);
    }
    if (record === undefined) throw new WorktreeManagerError("environment_conflict");
    assertTargetRecord(record, state);
    if (state.phase === "intent_recorded" || state.phase === "worktree_added") {
      await hardenManagedDirectory(state.intent.managedPath);
    }
    const worktree = await this.#git.inspectWorktree(state.intent.managedPath);
    if (worktree.head !== state.intent.sourceCommit || worktree.branch !== state.intent.branch) {
      throw new WorktreeManagerError("environment_conflict");
    }
    if (state.phase === "intent_recorded") {
      state = await this.#registry.recordWorktreeAdded({
        environmentId: state.intent.environmentId,
        creationAttemptId: state.intent.creationAttemptId
      });
    }
    if (state.phase === "worktree_added") {
      if (worktree.dirty) throw new WorktreeManagerError("dirty_worktree");
      state = await this.#registry.recordReady({
        environmentId: state.intent.environmentId,
        creationAttemptId: state.intent.creationAttemptId
      });
    }
    return state;
  }
}
