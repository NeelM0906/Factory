import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { EnvironmentIdSchema, type EnvironmentId } from "@autostack/contracts";

import {
  OwnedEnvironmentRegistryError,
  isOwnedEnvironmentRegistryError
} from "./environment-registry-errors.js";
import {
  admitPhaseRequest,
  assertRecoveredPhase,
  disposalBindingsEqual,
  phasePublicationContextMatches,
  type RecordedPhase,
  type RecordedSequence
} from "./environment-registry-lifecycle-validation.js";
import { EnvironmentRegistryPublications } from "./environment-registry-publication.js";
import {
  ATTEMPT_PATTERN,
  MAXIMUM_ENVIRONMENTS,
  MAXIMUM_ENVIRONMENT_ROOT_ENTRIES,
  MAXIMUM_EVIDENCE_BYTES,
  MAXIMUM_INTENT_BYTES,
  PHASES,
  decodeEnvironmentIdComponent,
  deriveRepositoryDigest,
  digestRecord,
  environmentIdComponent,
  intentRelative,
  isCanonicalTimestamp,
  parseEvidence,
  parseIntent,
  phaseRelative,
  snapshotInput,
  type EnvironmentDisposalIntentRequest,
  type EnvironmentDisposalVerificationRequest,
  type EnvironmentIntentInput,
  type EnvironmentPhaseEvidence,
  type EnvironmentPhaseRequest,
  type EnvironmentRegistryState,
  type EvidenceWithoutDigest,
  type IntentWithoutDigest
} from "./environment-registry-records.js";
import { KeyedLock } from "./keyed-lock.js";
import { DataPathPolicy } from "./path-policy.js";
import { isNodeError } from "./path-security.js";

export class EnvironmentRegistryLifecycle {
  readonly #paths: DataPathPolicy;
  readonly #publications: EnvironmentRegistryPublications;
  readonly #createAttemptId: () => unknown;
  readonly #now: () => unknown;
  readonly #environmentLocks = new KeyedLock();
  readonly #rootLocks = new KeyedLock();

  constructor(
    paths: DataPathPolicy,
    publications: EnvironmentRegistryPublications,
    createAttemptId: () => unknown,
    now: () => unknown
  ) {
    this.#paths = paths;
    this.#publications = publications;
    this.#createAttemptId = createAttemptId;
    this.#now = now;
  }

  async recordIntent(candidate: EnvironmentIntentInput): Promise<EnvironmentRegistryState> {
    const input = snapshotInput(candidate);
    const repositoryDigest = deriveRepositoryDigest(
      input.repositoryIdentity,
      input.repositoryCommonDirectory,
      "invalid_input"
    );
    return this.#rootLocks.run("registry-root", () =>
      this.#environmentLocks.run(input.environmentId, async () => {
        const component = environmentIdComponent(input.environmentId);
        await this.#assertEnvironmentCapacity(input.environmentId);
        let intent = await this.#publications.readPublication(
          intentRelative(input.environmentId),
          MAXIMUM_INTENT_BYTES,
          "intent",
          parseIntent,
          (candidate) =>
            candidate.environmentId === input.environmentId &&
            candidate.managedPath ===
              resolve(
                this.#paths.root,
                "worktrees",
                candidate.repositoryDigest,
                environmentIdComponent(input.environmentId)
              )
        );
        const needsIntentPublication = intent === undefined;
        if (intent !== undefined) {
          const comparable = {
            workspaceId: intent.workspaceId,
            runId: intent.runId,
            environmentId: intent.environmentId,
            repositoryIdentity: intent.repositoryIdentity,
            canonicalSourcePath: intent.canonicalSourcePath,
            repositoryCommonDirectory: intent.repositoryCommonDirectory,
            sourceCommit: intent.sourceCommit,
            branch: intent.branch,
            safeConfigDigest: intent.safeConfigDigest,
            authorization: intent.authorization,
            prepareRequestDigest: intent.prepareRequestDigest
          };
          const expectedManagedPath = resolve(
            this.#paths.root,
            "worktrees",
            intent.repositoryDigest,
            component
          );
          if (
            JSON.stringify(comparable) !== JSON.stringify(input) ||
            intent.repositoryDigest !== repositoryDigest ||
            intent.managedPath !== expectedManagedPath
          ) {
            throw new OwnedEnvironmentRegistryError("conflicting_record");
          }
        } else {
          const creationAttemptId = this.#safeAttemptId();
          const withoutDigest: IntentWithoutDigest = {
            version: 1,
            kind: "environment_intent",
            ...input,
            repositoryDigest,
            authorizationDigest: input.authorization.digest,
            managedPath: resolve(this.#paths.root, "worktrees", repositoryDigest, component),
            creationAttemptId
          };
          intent = Object.freeze({
            ...withoutDigest,
            intentDigest: digestRecord("autostack.environment-intent.v1", withoutDigest)
          });
          this.#publications.assertPublicationSize(intent, "intent");
        }
        await this.#paths.ensureDirectory(`environments/journal/${component}`);
        if (needsIntentPublication) {
          await this.#publications.writeImmutable(
            intentRelative(input.environmentId),
            intent,
            "intent",
            intent.creationAttemptId
          );
        }
        let evidence = await this.#publications.readPublication(
          phaseRelative(input.environmentId, 1),
          MAXIMUM_EVIDENCE_BYTES,
          "intent_recorded",
          parseEvidence,
          (candidate) =>
            candidate.environmentId === input.environmentId &&
            candidate.phase === "intent_recorded" &&
            candidate.sequence === 1 &&
            candidate.creationAttemptId === intent.creationAttemptId &&
            candidate.intentDigest === intent.intentDigest &&
            candidate.previousEvidenceDigest === null
        );
        if (evidence === undefined) {
          const evidenceWithoutDigest: EvidenceWithoutDigest = {
            version: 1,
            kind: "environment_phase",
            phase: "intent_recorded",
            sequence: 1,
            environmentId: input.environmentId,
            creationAttemptId: intent.creationAttemptId,
            intentDigest: intent.intentDigest,
            previousEvidenceDigest: null,
            recordedAt: this.#safeTimestamp()
          };
          evidence = Object.freeze({
            ...evidenceWithoutDigest,
            evidenceDigest: digestRecord("autostack.environment-phase.v1", evidenceWithoutDigest)
          });
          await this.#publications.writeImmutable(
            phaseRelative(input.environmentId, 1),
            evidence,
            "intent_recorded",
            intent.creationAttemptId
          );
        }
        if (
          evidence.phase !== "intent_recorded" ||
          evidence.sequence !== 1 ||
          evidence.environmentId !== intent.environmentId ||
          evidence.creationAttemptId !== intent.creationAttemptId ||
          evidence.intentDigest !== intent.intentDigest ||
          evidence.previousEvidenceDigest !== null
        ) {
          throw new OwnedEnvironmentRegistryError("maintenance_required");
        }
        const recovered = await this.#recoverEnvironmentLocked(input.environmentId);
        if (recovered === undefined) {
          throw new OwnedEnvironmentRegistryError("maintenance_required");
        }
        return recovered;
      })
    );
  }

  async recordWorktreeAdded(request: EnvironmentPhaseRequest): Promise<EnvironmentRegistryState> {
    return this.#recordPhase(request, "worktree_added", 2);
  }

  async recordReady(request: EnvironmentPhaseRequest): Promise<EnvironmentRegistryState> {
    return this.#recordPhase(request, "ready", 3);
  }

  async recordDisposalIntent(
    request: EnvironmentDisposalIntentRequest
  ): Promise<EnvironmentRegistryState> {
    return this.#recordPhase(request, "disposal_recorded", 4);
  }

  async recordDisposed(
    request: EnvironmentDisposalVerificationRequest
  ): Promise<EnvironmentRegistryState> {
    return this.#recordPhase(request, "disposed", 5);
  }

  async recoverEnvironment(
    environmentIdInput: EnvironmentId
  ): Promise<EnvironmentRegistryState | undefined> {
    const parsedEnvironmentId = EnvironmentIdSchema.safeParse(environmentIdInput);
    if (!parsedEnvironmentId.success) throw new OwnedEnvironmentRegistryError("invalid_input");
    const environmentId = parsedEnvironmentId.data;
    return this.#environmentLocks.run(environmentId, () =>
      this.#recoverEnvironmentLocked(environmentId)
    );
  }

  async recoverAll(): Promise<readonly EnvironmentRegistryState[]> {
    return this.#rootLocks.run("registry-root", async () => {
      const rootEntries = await this.#publications.listDirectoryBounded(
        "environments",
        MAXIMUM_ENVIRONMENT_ROOT_ENTRIES
      );
      if (rootEntries.length > MAXIMUM_ENVIRONMENT_ROOT_ENTRIES) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      const rootIds = new Set<EnvironmentId>();
      for (const entry of rootEntries) {
        if (entry.name === "journal" && entry.type === "directory") continue;
        if (entry.type !== "file") throw new OwnedEnvironmentRegistryError("maintenance_required");
        const canonicalMatch = /^([0-9a-f]+)\.json$/.exec(entry.name);
        const transactionMatch = /^\.([0-9a-f]+)\.json\.intent\.[0-9a-f]{32}\.tmp$/.exec(
          entry.name
        );
        const component = canonicalMatch?.[1] ?? transactionMatch?.[1];
        if (component === undefined) {
          throw new OwnedEnvironmentRegistryError("maintenance_required");
        }
        rootIds.add(decodeEnvironmentIdComponent(component));
      }

      const journalEntries = await this.#publications.listDirectoryBounded(
        "environments/journal",
        MAXIMUM_ENVIRONMENTS
      );
      if (journalEntries.length > MAXIMUM_ENVIRONMENTS) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      const journalIds = new Set<EnvironmentId>();
      for (const entry of journalEntries) {
        if (entry.type !== "directory") {
          throw new OwnedEnvironmentRegistryError("maintenance_required");
        }
        const environmentId = decodeEnvironmentIdComponent(entry.name);
        journalIds.add(environmentId);
        await this.#publications.validateEnvironmentJournal(environmentId);
      }
      if (
        rootIds.size > MAXIMUM_ENVIRONMENTS ||
        rootIds.size !== journalIds.size ||
        [...rootIds].some((environmentId) => !journalIds.has(environmentId))
      ) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      const states: EnvironmentRegistryState[] = [];
      for (const environmentId of [...rootIds].sort()) {
        const state = await this.#environmentLocks.run(environmentId, () =>
          this.#recoverEnvironmentLocked(environmentId)
        );
        if (state === undefined) throw new OwnedEnvironmentRegistryError("maintenance_required");
        states.push(state);
      }
      return Object.freeze(states);
    });
  }

  async #recoverEnvironmentLocked(
    environmentId: EnvironmentId
  ): Promise<EnvironmentRegistryState | undefined> {
    const intent = await this.#publications.readPublication(
      intentRelative(environmentId),
      MAXIMUM_INTENT_BYTES,
      "intent",
      parseIntent,
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.managedPath ===
          resolve(
            this.#paths.root,
            "worktrees",
            candidate.repositoryDigest,
            environmentIdComponent(environmentId)
          )
    );
    if (intent === undefined) return undefined;
    const expectedManagedPath = resolve(
      this.#paths.root,
      "worktrees",
      intent.repositoryDigest,
      environmentIdComponent(environmentId)
    );
    if (intent.environmentId !== environmentId || intent.managedPath !== expectedManagedPath) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    await this.#publications.validateEnvironmentJournal(environmentId);
    const evidence: EnvironmentPhaseEvidence[] = [];
    for (const phase of PHASES) {
      const previous = evidence.at(-1);
      const durableDisposal = evidence[3];
      const current = await this.#publications.readPublication(
        phaseRelative(environmentId, phase.sequence),
        MAXIMUM_EVIDENCE_BYTES,
        phase.phase,
        parseEvidence,
        (candidate) =>
          phasePublicationContextMatches(candidate, intent, phase, previous, durableDisposal)
      );
      if (current === undefined) {
        if (phase.sequence === 1) {
          throw new OwnedEnvironmentRegistryError("maintenance_required");
        }
        for (const later of PHASES.slice(phase.sequence)) {
          await this.#publications.readPublication(
            phaseRelative(environmentId, later.sequence),
            MAXIMUM_EVIDENCE_BYTES,
            later.phase,
            parseEvidence,
            () => false
          );
        }
        break;
      }
      assertRecoveredPhase(current, intent, phase, previous, durableDisposal);
      evidence.push(current);
    }
    const last = evidence.at(-1);
    if (last === undefined) throw new OwnedEnvironmentRegistryError("maintenance_required");
    const managedPathPresent = await this.#managedPathPresent(intent.managedPath);
    if (
      (last.phase === "ready" && !managedPathPresent) ||
      (last.phase === "disposed" && managedPathPresent)
    ) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
    return Object.freeze({ intent, phase: last.phase, evidence: Object.freeze(evidence) });
  }

  async #recordPhase(
    request:
      | EnvironmentPhaseRequest
      | EnvironmentDisposalIntentRequest
      | EnvironmentDisposalVerificationRequest,
    phase: RecordedPhase,
    sequence: RecordedSequence
  ): Promise<EnvironmentRegistryState> {
    const admitted = admitPhaseRequest(request, sequence);
    return this.#environmentLocks.run(admitted.environmentId, async () => {
      const current = await this.#recoverEnvironmentLocked(admitted.environmentId);
      if (
        current === undefined ||
        current.intent.creationAttemptId !== admitted.creationAttemptId
      ) {
        throw new OwnedEnvironmentRegistryError("invalid_transition");
      }
      if (
        admitted.disposal !== undefined &&
        (admitted.disposal.environmentAuthorizationId !== current.intent.authorization.id ||
          admitted.disposal.environmentAuthorizationDigest !== current.intent.authorization.digest)
      ) {
        throw new OwnedEnvironmentRegistryError("invalid_transition");
      }
      const currentSequence = current.evidence.length;
      const durableDisposal = current.evidence[3];
      if (
        currentSequence >= 4 &&
        admitted.disposal !== undefined &&
        !disposalBindingsEqual(durableDisposal, admitted.disposal)
      ) {
        throw new OwnedEnvironmentRegistryError("invalid_transition");
      }
      if (currentSequence >= sequence) {
        const durable = current.evidence[sequence - 1];
        if (
          sequence === 5 &&
          (durable?.worktreeListDigest !== admitted.verification?.worktreeListDigest ||
            durable?.retainedBranchCommit !== admitted.verification?.retainedBranchCommit ||
            durable?.verifiedAt !== admitted.verification?.verifiedAt)
        ) {
          throw new OwnedEnvironmentRegistryError("invalid_transition");
        }
        return current;
      }
      if (currentSequence !== sequence - 1) {
        throw new OwnedEnvironmentRegistryError("invalid_transition");
      }
      const previous = current.evidence.at(-1);
      if (previous === undefined) throw new OwnedEnvironmentRegistryError("invalid_transition");
      const managedPathPresent = await this.#managedPathPresent(current.intent.managedPath);
      if (
        (sequence === 3 && !managedPathPresent) ||
        (sequence === 4 && !managedPathPresent) ||
        (sequence === 5 && managedPathPresent)
      ) {
        throw new OwnedEnvironmentRegistryError("invalid_transition");
      }
      const recordedAt = this.#safeTimestampAfter(previous.recordedAt);
      if (
        sequence === 5 &&
        (Date.parse(admitted.verification?.verifiedAt ?? "") < Date.parse(previous.recordedAt) ||
          Date.parse(admitted.verification?.verifiedAt ?? "") > Date.parse(recordedAt))
      ) {
        throw new OwnedEnvironmentRegistryError("invalid_input");
      }
      const withoutDigest: EvidenceWithoutDigest = {
        version: 1,
        kind: "environment_phase",
        phase,
        sequence,
        environmentId: admitted.environmentId,
        creationAttemptId: admitted.creationAttemptId,
        intentDigest: current.intent.intentDigest,
        previousEvidenceDigest: previous.evidenceDigest,
        recordedAt,
        ...(admitted.disposal ?? {}),
        ...(admitted.verification ?? {})
      };
      const evidence = Object.freeze({
        ...withoutDigest,
        evidenceDigest: digestRecord("autostack.environment-phase.v1", withoutDigest)
      });
      await this.#publications.writeImmutable(
        phaseRelative(admitted.environmentId, sequence),
        evidence,
        phase,
        admitted.creationAttemptId
      );
      return Object.freeze({
        intent: current.intent,
        phase,
        evidence: Object.freeze([...current.evidence, evidence])
      });
    });
  }

  async #managedPathPresent(managedPath: string): Promise<boolean> {
    try {
      const status = await lstat(managedPath);
      if (
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        (await realpath(managedPath)) !== managedPath
      ) {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      return true;
    } catch (error) {
      if (isOwnedEnvironmentRegistryError(error)) throw error;
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async #assertEnvironmentCapacity(environmentId: EnvironmentId): Promise<void> {
    const target = environmentIdComponent(environmentId);
    const entries = await this.#publications.listDirectoryBounded(
      "environments/journal",
      MAXIMUM_ENVIRONMENTS
    );
    let targetPresent = false;
    for (const entry of entries) {
      if (entry.type !== "directory") {
        throw new OwnedEnvironmentRegistryError("maintenance_required");
      }
      decodeEnvironmentIdComponent(entry.name);
      if (entry.name === target) targetPresent = true;
    }
    if (!targetPresent && entries.length >= MAXIMUM_ENVIRONMENTS) {
      throw new OwnedEnvironmentRegistryError("maintenance_required");
    }
  }

  #safeAttemptId(): string {
    let attemptId: unknown;
    try {
      attemptId = this.#createAttemptId();
    } catch {
      throw new OwnedEnvironmentRegistryError("invalid_input");
    }
    if (typeof attemptId !== "string" || !ATTEMPT_PATTERN.test(attemptId)) {
      throw new OwnedEnvironmentRegistryError("invalid_input");
    }
    return attemptId;
  }

  #safeTimestamp(): string {
    let timestamp: unknown;
    try {
      timestamp = this.#now();
    } catch {
      throw new OwnedEnvironmentRegistryError("invalid_input");
    }
    if (!isCanonicalTimestamp(timestamp)) {
      throw new OwnedEnvironmentRegistryError("invalid_input");
    }
    return timestamp;
  }

  #safeTimestampAfter(previous: string): string {
    const current = this.#safeTimestamp();
    if (Date.parse(current) <= Date.parse(previous)) {
      throw new OwnedEnvironmentRegistryError("invalid_input");
    }
    return current;
  }
}
