import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  containsSensitiveMaterial,
  InspectRepositoryRequestSchema,
  RepositoryInspectionSchema,
  type InspectRepositoryRequest
} from "@autostack/contracts";

import {
  admitAddRequest,
  assertSupportedGitVersion,
  createPrivateConfiguration,
  exactCommit,
  exactDigest,
  executableIdentity,
  fileIdentity,
  isWithin,
  safeGeneratedBranch,
  sameDirectoryIdentity,
  snapshotAbsolutePath,
  snapshotManagedRequest,
  snapshotString,
  validateExecutableIdentity,
  validatePrivateConfiguration
} from "./git-client-admission.js";
import { readStableLocalConfiguration } from "./git-client-config.js";
import {
  mutationBroker,
  pinAbsentManagedTarget,
  validatePinnedAbsentManagedTarget,
  type PinnedAbsentManagedTarget
} from "./git-client-mutation.js";
import {
  decodeSingleLine,
  parseWorktreePorcelainZInternal,
  processResult
} from "./git-client-parsers.js";
import {
  gitError,
  isOwnedGitError,
  materializeGitError,
  type AddLockedWorktreeRequest,
  type AdmittedAddRequest,
  type FileIdentity,
  type GitClientOptions,
  type GitWorktreeInspection,
  type GitWorktreeRecord,
  type InspectedGitRepository,
  type LocalConfiguration,
  type ManagedWorktreeRequest,
  type PrivateConfiguration
} from "./git-client-types.js";
import {
  BoundedProcessRunner,
  trustedProcessRunErrorCode,
  type ProcessRunRequest,
  type ProcessRunResult
} from "./process-runner.js";
import { RepositoryInspectionPathPolicy } from "./repository-path-policy.js";
import { isPathPolicyError } from "./path-types.js";

export { parseWorktreePorcelainZ } from "./git-client-parsers.js";
export { GitClientError } from "./git-client-types.js";
export type {
  AddLockedWorktreeRequest,
  GitClientErrorCode,
  GitClientOptions,
  GitProcessRunner,
  GitWorktreeInspection,
  GitWorktreeRecord,
  InspectedGitRepository,
  ManagedWorktreeRequest
} from "./git-client-types.js";

const MAXIMUM_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const SYSTEM_GIT_EXECUTABLE = "/usr/bin/git";
const SAFE_GIT_CONFIGURATION = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "submodule.recurse=false"
]);

export class GitClient {
  readonly #managedWorktreeRoot: string;
  readonly #managedWorktreeIdentity: FileIdentity;
  readonly #pathPolicy: RepositoryInspectionPathPolicy;
  readonly #privateConfiguration: PrivateConfiguration;
  readonly #gitExecutable: string;
  readonly #gitExecutableIdentity: FileIdentity;
  readonly #runProcess: (request: ProcessRunRequest) => Promise<ProcessRunResult>;
  #operationTail: Promise<void> = Promise.resolve();
  #processQuarantined = false;

  private constructor(input: {
    managedWorktreeRoot: string;
    managedWorktreeIdentity: FileIdentity;
    pathPolicy: RepositoryInspectionPathPolicy;
    privateConfiguration: PrivateConfiguration;
    gitExecutable: string;
    gitExecutableIdentity: FileIdentity;
    runProcess: (request: ProcessRunRequest) => Promise<ProcessRunResult>;
  }) {
    this.#managedWorktreeRoot = input.managedWorktreeRoot;
    this.#managedWorktreeIdentity = input.managedWorktreeIdentity;
    this.#pathPolicy = input.pathPolicy;
    this.#privateConfiguration = input.privateConfiguration;
    this.#gitExecutable = input.gitExecutable;
    this.#gitExecutableIdentity = input.gitExecutableIdentity;
    this.#runProcess = input.runProcess;
  }

  static async create(options: GitClientOptions): Promise<GitClient> {
    try {
      if (typeof options !== "object" || options === null) throw gitError("invalid_request");
      const managedWorktreeRoot = snapshotAbsolutePath(options.managedWorktreeRoot);
      const privateConfigRoot = snapshotAbsolutePath(options.privateConfigRoot);
      const trustedGitExecutable = options.trustedGitExecutable;
      const processRunner = options.processRunner;
      let injectedRun: ((request: ProcessRunRequest) => Promise<ProcessRunResult>) | undefined;
      if (processRunner !== undefined) {
        const run = processRunner.run;
        if (typeof run !== "function") throw gitError("invalid_request");
        injectedRun = (request) =>
          Reflect.apply(run, processRunner, [request]) as Promise<ProcessRunResult>;
      }
      const canonicalManagedRoot = await realpath(managedWorktreeRoot);
      if (canonicalManagedRoot !== managedWorktreeRoot) throw gitError("invalid_request");
      const managedStatus = await lstat(canonicalManagedRoot);
      if (
        managedStatus.isSymbolicLink() ||
        !managedStatus.isDirectory() ||
        managedStatus.uid !== process.getuid?.() ||
        (managedStatus.mode & 0o077) !== 0
      ) {
        throw gitError("invalid_request");
      }
      const pathPolicy = await RepositoryInspectionPathPolicy.create(canonicalManagedRoot);
      const privateConfiguration = await createPrivateConfiguration(privateConfigRoot);
      const defaultRunner =
        injectedRun === undefined
          ? new BoundedProcessRunner({
              timeoutMs: 10_000,
              maximumOutputBytes: MAXIMUM_GIT_OUTPUT_BYTES
            })
          : undefined;
      const runProcess =
        injectedRun ??
        (defaultRunner === undefined
          ? undefined
          : (request: ProcessRunRequest) => defaultRunner.run(request));
      if (runProcess === undefined) throw gitError("invalid_request");
      const executable = await executableIdentity(
        trustedGitExecutable ?? SYSTEM_GIT_EXECUTABLE,
        trustedGitExecutable === undefined
      );
      const client = new GitClient({
        managedWorktreeRoot: canonicalManagedRoot,
        managedWorktreeIdentity: fileIdentity(managedStatus),
        pathPolicy,
        privateConfiguration,
        gitExecutable: executable.path,
        gitExecutableIdentity: executable.identity,
        runProcess
      });
      await assertSupportedGitVersion((args) => client.#runRequired(args));
      return client;
    } catch (error) {
      throw materializeGitError(error, "invalid_request");
    }
  }

  async inspectRepository(requestInput: InspectRepositoryRequest): Promise<InspectedGitRepository> {
    try {
      return await this.#runOperation(async () => {
        const request = this.#inspectRequest(requestInput);
        const sourcePath = await this.#pathPolicy.resolveSource(request.sourcePath);
        const configuration = await this.#readLocalConfiguration(sourcePath);
        const inside = await this.#runGit(["-C", sourcePath, "rev-parse", "--is-inside-work-tree"]);
        const bare = await this.#runGit(["-C", sourcePath, "rev-parse", "--is-bare-repository"]);
        if (
          inside.exitCode !== 0 ||
          bare.exitCode !== 0 ||
          decodeSingleLine(inside.stdout, 5) !== "true" ||
          decodeSingleLine(bare.stdout, 5) !== "false"
        ) {
          throw gitError("invalid_repository");
        }
        const shallow = await this.#runGit([
          "-C",
          sourcePath,
          "rev-parse",
          "--is-shallow-repository"
        ]);
        if (shallow.exitCode !== 0) throw gitError("invalid_repository");
        if (decodeSingleLine(shallow.stdout, 5) === "true") throw gitError("shallow_repository");
        const resolved = await this.#resolveRef(sourcePath, request.baseRef);
        const common = await this.#runRequired([
          "-C",
          sourcePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir"
        ]);
        const commonPath = decodeSingleLine(common.stdout);
        if (!isAbsolute(commonPath)) throw gitError("malformed_output");
        const canonicalCommonDirectory = await realpath(commonPath);
        await this.#validateManagedRoot();
        if (isWithin(this.#managedWorktreeRoot, canonicalCommonDirectory)) {
          throw gitError("invalid_repository");
        }
        const commonStatus = await lstat(canonicalCommonDirectory);
        if (!commonStatus.isDirectory() || commonStatus.isSymbolicLink()) {
          throw gitError("invalid_repository");
        }
        const status = await this.#runRequired([
          "-C",
          sourcePath,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all"
        ]);
        const dirty = status.stdout.length > 0;
        const inspection = RepositoryInspectionSchema.parse({
          repositoryIdentity: `local-sha256:${createHash("sha256").update(canonicalCommonDirectory).digest("hex")}`,
          canonicalSourcePath: sourcePath,
          repositoryCommonDirectory: canonicalCommonDirectory,
          ...(configuration.remoteIdentity === undefined
            ? {}
            : { remoteIdentity: configuration.remoteIdentity }),
          resolvedBaseRef: resolved.reference,
          sourceCommit: resolved.commit,
          dirty,
          diagnostics: dirty ? ["The source checkout has local changes."] : []
        });
        return Object.freeze({ inspection, safeConfigDigest: configuration.digest });
      });
    } catch (error) {
      if (isOwnedGitError(error)) throw materializeGitError(error, "invalid_repository");
      if (isPathPolicyError(error)) throw error;
      throw materializeGitError(error, "invalid_repository");
    }
  }

  async assertSafeConfigDigest(
    sourcePathInput: string,
    expectedDigestInput: string
  ): Promise<void> {
    try {
      await this.#runOperation(async () => {
        const sourcePath = await this.#pathPolicy.resolveSource(
          snapshotAbsolutePath(sourcePathInput)
        );
        const expectedDigest = exactDigest(expectedDigestInput);
        const actual = await this.#readLocalConfiguration(sourcePath);
        if (actual.digest !== expectedDigest) throw gitError("config_changed");
      });
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  async listWorktrees(sourcePathInput: string): Promise<readonly GitWorktreeRecord[]> {
    try {
      return await this.#runOperation(() => this.#listWorktrees(sourcePathInput));
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  async resolveBranchCommit(
    sourcePathInput: string,
    branchInput: string
  ): Promise<string | undefined> {
    try {
      return await this.#runOperation(() =>
        this.#resolveBranchCommit(sourcePathInput, branchInput)
      );
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  async addLockedWorktree(requestInput: AddLockedWorktreeRequest): Promise<void> {
    try {
      await this.#runOperation(async () => {
        const request = admitAddRequest(requestInput);
        await mutationBroker.run(() => this.#addLockedWorktree(request));
      });
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  async attachExistingLockedWorktree(requestInput: AddLockedWorktreeRequest): Promise<void> {
    try {
      await this.#runOperation(async () => {
        const request = admitAddRequest(requestInput);
        await mutationBroker.run(() => this.#attachExistingLockedWorktree(request));
      });
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  async #addLockedWorktree(request: AdmittedAddRequest): Promise<void> {
    const sourcePath = await this.#safeSource(request.sourcePath);
    const configuration = await this.#readLocalConfiguration(sourcePath);
    if (configuration.digest !== request.expectedSafeConfigDigest) {
      throw gitError("config_changed");
    }
    const target = await this.#pinAbsentManagedTarget(request.worktreePath);
    await this.#assertExactCommit(sourcePath, request.commit);
    if ((await this.#resolveBranchCommit(sourcePath, request.branch)) !== undefined) {
      throw gitError("branch_conflict");
    }
    await this.#runWorktreeMutation(sourcePath, request.expectedSafeConfigDigest, target, [
      "-C",
      sourcePath,
      "worktree",
      "add",
      "--lock",
      "--reason",
      "AutoStack",
      "-b",
      request.branch,
      request.worktreePath,
      request.commit
    ]);
    await this.#validateManagedTarget(request.worktreePath, true);
  }

  async #attachExistingLockedWorktree(request: AdmittedAddRequest): Promise<void> {
    const sourcePath = await this.#safeSource(request.sourcePath);
    const configuration = await this.#readLocalConfiguration(sourcePath);
    if (configuration.digest !== request.expectedSafeConfigDigest) {
      throw gitError("config_changed");
    }
    const target = await this.#pinAbsentManagedTarget(request.worktreePath);
    const branchCommit = await this.#resolveBranchCommit(sourcePath, request.branch);
    if (branchCommit !== request.commit) throw gitError("branch_conflict");
    const branchRef = `refs/heads/${request.branch}`;
    const records = await this.#listWorktrees(sourcePath);
    if (records.some((record) => record.branch === branchRef)) {
      throw gitError("branch_conflict");
    }
    await this.#runWorktreeMutation(sourcePath, request.expectedSafeConfigDigest, target, [
      "-C",
      sourcePath,
      "worktree",
      "add",
      "--lock",
      "--reason",
      "AutoStack",
      request.worktreePath,
      request.branch
    ]);
    await this.#validateManagedTarget(request.worktreePath, true);
  }

  async inspectWorktree(worktreePathInput: string): Promise<GitWorktreeInspection> {
    try {
      return await this.#runOperation(async () => {
        const worktreePath = await this.#validateManagedTarget(
          snapshotAbsolutePath(worktreePathInput),
          true
        );
        await this.#readLocalConfiguration(worktreePath);
        const head = await this.#runRequired(["-C", worktreePath, "rev-parse", "HEAD"]);
        const branch = await this.#runRequired([
          "-C",
          worktreePath,
          "symbolic-ref",
          "--short",
          "HEAD"
        ]);
        const status = await this.#runRequired([
          "-C",
          worktreePath,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all"
        ]);
        return Object.freeze({
          head: exactCommit(decodeSingleLine(head.stdout, 40)),
          branch: safeGeneratedBranch(decodeSingleLine(branch.stdout, 250)),
          dirty: status.stdout.length > 0
        });
      });
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  async unlockWorktree(requestInput: ManagedWorktreeRequest): Promise<void> {
    try {
      await this.#runOperation(async () => {
        const snapshot = snapshotManagedRequest(requestInput);
        await mutationBroker.run(async () => {
          const request = await this.#managedRequest(snapshot);
          await this.#safeSource(request.sourcePath);
          await this.#runRequired([
            "-C",
            request.sourcePath,
            "worktree",
            "unlock",
            request.worktreePath
          ]);
        });
      });
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  async removeWorktree(requestInput: ManagedWorktreeRequest): Promise<void> {
    try {
      await this.#runOperation(async () => {
        const snapshot = snapshotManagedRequest(requestInput);
        await mutationBroker.run(async () => {
          const request = await this.#managedRequest(snapshot);
          await this.#safeSource(request.sourcePath);
          await this.#runRequired([
            "-C",
            request.sourcePath,
            "worktree",
            "remove",
            request.worktreePath
          ]);
        });
      });
    } catch (error) {
      throw materializeGitError(error, "git_failed");
    }
  }

  #inspectRequest(requestInput: InspectRepositoryRequest): InspectRepositoryRequest {
    try {
      if (typeof requestInput !== "object" || requestInput === null) {
        throw gitError("invalid_request");
      }
      const sourcePath = snapshotAbsolutePath(requestInput.sourcePath);
      const baseRef = snapshotString(requestInput.baseRef, 512);
      return InspectRepositoryRequestSchema.parse({ sourcePath, baseRef });
    } catch (error) {
      if (isOwnedGitError(error)) throw error;
      throw gitError("invalid_request");
    }
  }

  #assertProcessSafe(): void {
    if (this.#processQuarantined) throw gitError("unsafe_process_state");
  }

  async #runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      this.#assertProcessSafe();
      return await operation();
    } finally {
      release();
    }
  }

  async #listWorktrees(sourcePathInput: string): Promise<readonly GitWorktreeRecord[]> {
    const sourcePath = await this.#safeSource(sourcePathInput);
    const result = await this.#runRequired([
      "-C",
      sourcePath,
      "worktree",
      "list",
      "--porcelain",
      "-z"
    ]);
    return parseWorktreePorcelainZInternal(result.stdout);
  }

  async #resolveBranchCommit(
    sourcePathInput: string,
    branchInput: string
  ): Promise<string | undefined> {
    const sourcePath = await this.#safeSource(sourcePathInput);
    const branch = safeGeneratedBranch(branchInput);
    const result = await this.#runGit([
      "-C",
      sourcePath,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `refs/heads/${branch}`
    ]);
    if (result.exitCode === 1) return undefined;
    if (result.exitCode !== 0) throw gitError("git_failed");
    return exactCommit(decodeSingleLine(result.stdout, 40));
  }

  async #resolveRef(
    sourcePath: string,
    baseRef: string
  ): Promise<{ readonly reference: string; readonly commit: string }> {
    const commitResult = await this.#runGit([
      "-C",
      sourcePath,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseRef}^{commit}`
    ]);
    if (commitResult.exitCode !== 0) throw gitError("missing_ref");
    if (commitResult.stderr.length > 0) throw gitError("ambiguous_ref");
    const commit = exactCommit(decodeSingleLine(commitResult.stdout, 40));
    const referenceResult = await this.#runGit([
      "-C",
      sourcePath,
      "rev-parse",
      "--symbolic-full-name",
      "--verify",
      "--end-of-options",
      baseRef
    ]);
    if (referenceResult.exitCode !== 0 || referenceResult.stderr.length > 0) {
      throw gitError("ambiguous_ref");
    }
    const rawReference = referenceResult.stdout.trim();
    const reference =
      rawReference.length === 0 ? commit : decodeSingleLine(referenceResult.stdout, 512);
    if (containsSensitiveMaterial(reference)) throw gitError("malformed_output");
    return Object.freeze({ reference, commit });
  }

  async #assertExactCommit(sourcePath: string, commit: string): Promise<void> {
    const result = await this.#runGit([
      "-C",
      sourcePath,
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${commit}^{commit}`
    ]);
    if (result.exitCode === 1) throw gitError("missing_ref");
    if (result.exitCode !== 0 || exactCommit(decodeSingleLine(result.stdout, 40)) !== commit) {
      throw gitError("missing_ref");
    }
  }

  async #readLocalConfiguration(sourcePath: string): Promise<LocalConfiguration> {
    return readStableLocalConfiguration(sourcePath, (args) => this.#runGit(args));
  }

  async #safeSource(sourcePathInput: string): Promise<string> {
    try {
      const sourcePath = await this.#pathPolicy.resolveSource(
        snapshotAbsolutePath(sourcePathInput)
      );
      await this.#readLocalConfiguration(sourcePath);
      return sourcePath;
    } catch (error) {
      if (isOwnedGitError(error)) throw error;
      if (isPathPolicyError(error)) throw gitError("invalid_request");
      throw error;
    }
  }

  async #runRequired(args: readonly string[]): Promise<ProcessRunResult> {
    const result = await this.#runGit(args);
    if (result.exitCode !== 0 || result.signal !== null) throw gitError("git_failed");
    return result;
  }

  async #runGit(args: readonly string[]): Promise<ProcessRunResult> {
    try {
      await validateExecutableIdentity(this.#gitExecutable, this.#gitExecutableIdentity);
      await validatePrivateConfiguration(this.#privateConfiguration);
      return await this.#invokeGit(args);
    } catch (error) {
      if (isOwnedGitError(error)) throw error;
      throw gitError("git_failed");
    }
  }

  async #invokeGit(args: readonly string[]): Promise<ProcessRunResult> {
    try {
      this.#assertProcessSafe();
      const result = await this.#runProcess(
        Object.freeze({
          executable: this.#gitExecutable,
          args: Object.freeze([
            "--no-optional-locks",
            "--no-pager",
            ...SAFE_GIT_CONFIGURATION,
            ...args
          ]),
          cwd: this.#privateConfiguration.root,
          environment: this.#privateConfiguration.environment
        })
      );
      return processResult(result);
    } catch (error) {
      if (trustedProcessRunErrorCode(error) === "termination_failed") {
        this.#processQuarantined = true;
        throw gitError("unsafe_process_state");
      }
      if (isOwnedGitError(error)) throw error;
      throw gitError("git_failed");
    }
  }

  async #runWorktreeMutation(
    sourcePath: string,
    expectedSafeConfigDigest: string,
    target: PinnedAbsentManagedTarget,
    args: readonly string[]
  ): Promise<void> {
    await validateExecutableIdentity(this.#gitExecutable, this.#gitExecutableIdentity);
    await validatePrivateConfiguration(this.#privateConfiguration);
    const finalConfiguration = await this.#readLocalConfiguration(sourcePath);
    if (finalConfiguration.digest !== expectedSafeConfigDigest) {
      throw gitError("config_changed");
    }
    await this.#validatePinnedAbsentManagedTarget(target);
    const result = await this.#invokeGit(args);
    if (result.exitCode !== 0 || result.signal !== null) throw gitError("git_failed");
  }

  async #validateManagedRoot(): Promise<void> {
    try {
      const canonical = await realpath(this.#managedWorktreeRoot);
      const status = await lstat(canonical);
      if (
        canonical !== this.#managedWorktreeRoot ||
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        !sameDirectoryIdentity(fileIdentity(status), this.#managedWorktreeIdentity)
      ) {
        throw gitError("invalid_request");
      }
    } catch (error) {
      if (isOwnedGitError(error)) throw error;
      throw gitError("invalid_request");
    }
  }

  async #validateManagedTarget(pathInput: string, mustExist: boolean): Promise<string> {
    await this.#validateManagedRoot();
    const requested = snapshotAbsolutePath(pathInput);
    if (requested === this.#managedWorktreeRoot) throw gitError("invalid_request");
    if (mustExist) {
      const status = await lstat(requested);
      if (status.isSymbolicLink() || !status.isDirectory()) throw gitError("invalid_request");
      const canonical = await realpath(requested);
      if (canonical !== requested || !isWithin(this.#managedWorktreeRoot, canonical)) {
        throw gitError("invalid_request");
      }
      await this.#validateManagedRoot();
      return canonical;
    }
    const parent = resolve(requested, "..");
    const canonicalParent = await realpath(parent);
    if (!isWithin(this.#managedWorktreeRoot, canonicalParent)) throw gitError("invalid_request");
    const canonicalTarget = resolve(canonicalParent, requested.slice(parent.length + 1));
    if (canonicalTarget !== requested || !isWithin(this.#managedWorktreeRoot, canonicalTarget)) {
      throw gitError("invalid_request");
    }
    try {
      await lstat(requested);
      throw gitError("invalid_request");
    } catch (error) {
      if (isOwnedGitError(error)) throw error;
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "ENOENT"
      ) {
        throw gitError("invalid_request");
      }
    }
    await this.#validateManagedRoot();
    return requested;
  }

  async #pinAbsentManagedTarget(pathInput: string): Promise<PinnedAbsentManagedTarget> {
    return pinAbsentManagedTarget(pathInput, (path) => this.#validateManagedTarget(path, false));
  }

  async #validatePinnedAbsentManagedTarget(target: PinnedAbsentManagedTarget): Promise<void> {
    await validatePinnedAbsentManagedTarget(target, () => this.#validateManagedRoot());
  }

  async #managedRequest(requestInput: ManagedWorktreeRequest): Promise<ManagedWorktreeRequest> {
    try {
      const sourcePath = await this.#pathPolicy.resolveSource(requestInput.sourcePath);
      const worktreePath = await this.#validateManagedTarget(requestInput.worktreePath, true);
      return Object.freeze({ sourcePath, worktreePath });
    } catch (error) {
      if (isOwnedGitError(error)) throw error;
      throw gitError("invalid_request");
    }
  }
}
