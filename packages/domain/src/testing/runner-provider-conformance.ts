import { describe, expect, it } from "vitest";

import {
  CancelCommandResponseSchema,
  CommandAcceptedSchema,
  DisposeEnvironmentResponseSchema,
  PreparedEnvironmentSchema,
  ReadArtifactChunkResponseSchema,
  RepositoryInspectionSchema,
  RunnerCapabilitiesSchema,
  RunnerDrainResultSchema,
  RunnerSubscriptionItemSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  validateArtifactChunkResponse,
  validateCommandAuthorizationAgainstEnvironment,
  validateRunnerStream,
  type ArtifactDescriptor,
  type ArtifactId,
  type CancelCommandRequest,
  type CommandAuthorizationId,
  type CommandId,
  type DisposeEnvironmentRequest,
  type EnvironmentAuthorizationId,
  type EnvironmentId,
  type InspectRepositoryRequest,
  type PrepareEnvironmentRequest,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest,
  type RunId,
  type RunnerStreamEvent,
  type RunnerSubscriptionItem,
  type StartCommandRequest,
  type TerminalRunEvidence,
  type WorkspaceId
} from "@autostack/contracts";

import type { LocalRunnerLifecycle, RunnerProvider } from "../ports/runner-provider.js";

const ARTIFACT_CHUNK_LIMIT = 1_048_576;
const MAX_STREAM_ITEMS = 10_000;

/**
 * Provider-specific hooks are deliberately limited to external state and safe
 * inspection. They never substitute for a RunnerProvider operation.
 */
export interface RunnerProviderConformanceControl {
  readonly completeCommand: (commandId: CommandId) => Promise<void>;
  readonly recordTerminalRunEvidence: (
    environmentId: EnvironmentId,
    evidence: TerminalRunEvidence
  ) => Promise<void>;
  readonly inspectRetainedCommand: (
    commandId: CommandId
  ) => Promise<StartCommandRequest | undefined>;
  readonly guardianLeaseCount: () => Promise<number>;
}

export interface RunnerProviderConformanceInstance {
  readonly provider: RunnerProvider;
  readonly control: RunnerProviderConformanceControl;
}

export interface RunnerProviderConformanceForeignValues {
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly environmentId: EnvironmentId;
  readonly commandId: CommandId;
  readonly environmentAuthorizationId: EnvironmentAuthorizationId;
  readonly commandAuthorizationId: CommandAuthorizationId;
  readonly artifactId: ArtifactId;
  readonly digest: string;
}

export interface RunnerProviderConformanceFixture {
  readonly create: () => Promise<RunnerProviderConformanceInstance>;
  readonly inspectionRequest: InspectRepositoryRequest;
  readonly prepare: PrepareEnvironmentRequest;
  /** Same environment ID and idempotency key, but a different valid request digest. */
  readonly conflictingPrepare: PrepareEnvironmentRequest;
  readonly nextPrepare: PrepareEnvironmentRequest;
  readonly start: StartCommandRequest;
  /** Same command ID and idempotency key, but a different valid request digest. */
  readonly conflictingStart: StartCommandRequest;
  readonly nextStart: StartCommandRequest;
  readonly events: ReadCommandEventsRequest;
  readonly cancel: CancelCommandRequest;
  readonly artifact: ReadArtifactChunkRequest;
  readonly dispose: DisposeEnvironmentRequest;
  readonly expectedArtifactBytes: Uint8Array;
  readonly foreign: RunnerProviderConformanceForeignValues;
  readonly tampered: {
    readonly prepareWrongAuthorizationDigest: PrepareEnvironmentRequest;
    readonly prepareWrongApprovalEvidence: PrepareEnvironmentRequest;
    readonly startWrongAuthorizationDigest: StartCommandRequest;
    readonly startWrongApprovalEvidence: StartCommandRequest;
    readonly startCommandSpecMismatch: StartCommandRequest;
    readonly startBroadenedAuthorization: StartCommandRequest;
  };
}

export interface LocalRunnerLifecycleConformanceInstance extends RunnerProviderConformanceInstance {
  readonly lifecycle: LocalRunnerLifecycle;
}

export interface LocalRunnerLifecycleConformanceFixture extends Omit<
  RunnerProviderConformanceFixture,
  "create" | "conflictingPrepare" | "conflictingStart"
> {
  readonly create: () => Promise<LocalRunnerLifecycleConformanceInstance>;
}

const isTerminalEvent = (event: RunnerStreamEvent): boolean =>
  event.type === "command.completed" || event.type === "stream.error";

const collectIterator = async (
  iterator: AsyncIterator<RunnerSubscriptionItem>,
  initial: readonly RunnerSubscriptionItem[] = []
): Promise<RunnerSubscriptionItem[]> => {
  const items = [...initial];
  while (items.length <= MAX_STREAM_ITEMS) {
    const next = await iterator.next();
    if (next.done) return items;
    items.push(RunnerSubscriptionItemSchema.parse(next.value));
  }
  throw new TypeError("Runner subscription did not terminate within its frame bound.");
};

const collect = async (
  stream: AsyncIterable<RunnerSubscriptionItem>
): Promise<RunnerSubscriptionItem[]> => collectIterator(stream[Symbol.asyncIterator]());

const requireFirstItem = async (
  iterator: AsyncIterator<RunnerSubscriptionItem>
): Promise<RunnerSubscriptionItem> => {
  const first = await iterator.next();
  if (first.done) throw new TypeError("Runner subscription ended before producing an item.");
  return RunnerSubscriptionItemSchema.parse(first.value);
};

const durableEvents = (items: readonly RunnerSubscriptionItem[]): RunnerStreamEvent[] =>
  items.flatMap((item) => (item.type === "runner.event" ? [item.event] : []));

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const concatenate = (chunks: readonly Uint8Array[]): Uint8Array => {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readWholeArtifact = async (
  provider: RunnerProvider,
  request: ReadArtifactChunkRequest
): Promise<{
  readonly bytes: Uint8Array;
  readonly descriptor: ArtifactDescriptor;
}> => {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let descriptor: ArtifactDescriptor | undefined;
  for (;;) {
    const chunkRequest = { ...request, offset, length: ARTIFACT_CHUNK_LIMIT };
    const response = validateArtifactChunkResponse(
      chunkRequest,
      await provider.readArtifactChunk(chunkRequest)
    );
    expect(response.nextOffset - response.offset).toBeLessThanOrEqual(ARTIFACT_CHUNK_LIMIT);
    descriptor ??= response.artifact;
    expect(response.artifact).toEqual(descriptor);
    chunks.push(decodeBase64(response.bytes));
    offset = response.nextOffset;
    if (response.done) break;
  }
  if (descriptor === undefined) throw new TypeError("Artifact read produced no descriptor.");
  return { bytes: concatenate(chunks), descriptor };
};

const expectStream = (
  items: readonly RunnerSubscriptionItem[],
  expected: ReadCommandEventsRequest
): readonly RunnerStreamEvent[] => {
  expect(items.every((item) => item.type === "runner.event")).toBe(true);
  const events = durableEvents(items);
  expect(events.filter(isTerminalEvent)).toHaveLength(1);
  const terminal = events.at(-1);
  if (terminal === undefined) throw new TypeError("Runner stream produced no durable events.");
  expect(isTerminalEvent(terminal)).toBe(true);
  return validateRunnerStream(events, {
    workspaceId: expected.workspaceId,
    runId: expected.runId,
    commandId: expected.commandId,
    after: expected.after
  });
};

/** Runs direct public-port assertions against a real, stateful provider. */
export const describeRunnerProviderConformance = (
  name: string,
  fixture: RunnerProviderConformanceFixture
): void => {
  describe(name, () => {
    it("reports schema-valid capabilities and repository inspection", async () => {
      const { provider } = await fixture.create();
      expect(RunnerCapabilitiesSchema.parse(await provider.capabilities())).toBeDefined();
      expect(
        RepositoryInspectionSchema.parse(
          await provider.inspectRepository(fixture.inspectionRequest)
        )
      ).toEqual(fixture.prepare.inspection);
    });

    it("retains the full prepared authorization and detects same-key request conflicts", async () => {
      const { provider } = await fixture.create();
      expect(fixture.conflictingPrepare.environmentId).toBe(fixture.prepare.environmentId);
      expect(fixture.conflictingPrepare.idempotency).toEqual(fixture.prepare.idempotency);
      expect(fixture.conflictingPrepare).not.toEqual(fixture.prepare);
      expect(await digestEnvironmentAuthorization(fixture.prepare.authorization)).toBe(
        fixture.prepare.authorization.digest
      );
      expect(await digestExecutionScope(fixture.prepare.authorization.scope)).toBe(
        fixture.prepare.authorization.approvalEvidenceDigest
      );

      const first = PreparedEnvironmentSchema.parse(
        await provider.prepareEnvironment(fixture.prepare)
      );
      const replay = PreparedEnvironmentSchema.parse(
        await provider.prepareEnvironment(fixture.prepare)
      );
      expect(replay).toEqual(first);
      expect(first).toEqual({
        environmentId: fixture.prepare.environmentId,
        workspaceId: fixture.prepare.workspaceId,
        runId: fixture.prepare.runId,
        repositoryIdentity: fixture.prepare.inspection.repositoryIdentity,
        sourceCommit: fixture.prepare.sourceCommit,
        branch: fixture.prepare.branch,
        authorization: fixture.prepare.authorization,
        state: "prepared",
        preparedAt: first.preparedAt
      });
      await expect(provider.prepareEnvironment(fixture.conflictingPrepare)).rejects.toBeDefined();
      expect(await provider.listEnvironments()).toEqual([first]);
    });

    it("rejects tampered environment authorization digests and approval evidence", async () => {
      const wrongDigest = fixture.tampered.prepareWrongAuthorizationDigest.authorization;
      expect(await digestEnvironmentAuthorization(wrongDigest)).not.toBe(wrongDigest.digest);
      expect(await digestExecutionScope(wrongDigest.scope)).toBe(
        wrongDigest.approvalEvidenceDigest
      );
      const wrongEvidence = fixture.tampered.prepareWrongApprovalEvidence.authorization;
      expect(await digestEnvironmentAuthorization(wrongEvidence)).toBe(wrongEvidence.digest);
      expect(await digestExecutionScope(wrongEvidence.scope)).not.toBe(
        wrongEvidence.approvalEvidenceDigest
      );
      for (const request of [
        fixture.tampered.prepareWrongAuthorizationDigest,
        fixture.tampered.prepareWrongApprovalEvidence
      ]) {
        const { provider } = await fixture.create();
        await expect(provider.prepareEnvironment(request)).rejects.toBeDefined();
        expect(await provider.listEnvironments()).toEqual([]);
      }
    });

    it("retains command authorization evidence and detects same-key request conflicts", async () => {
      const { provider, control } = await fixture.create();
      await provider.prepareEnvironment(fixture.prepare);
      expect(fixture.conflictingStart.commandId).toBe(fixture.start.commandId);
      expect(fixture.conflictingStart.idempotency).toEqual(fixture.start.idempotency);
      expect(fixture.conflictingStart).not.toEqual(fixture.start);
      expect(await digestCommandSpec(fixture.start.command)).toBe(
        fixture.start.authorization.scope.commandDigest
      );
      expect(await digestCommandScope(fixture.start.authorization.scope)).toBe(
        fixture.start.authorization.approvalEvidenceDigest
      );
      expect(await digestCommandAuthorization(fixture.start.authorization)).toBe(
        fixture.start.authorization.digest
      );

      const accepted = CommandAcceptedSchema.parse(await provider.startCommand(fixture.start));
      expect(accepted).toMatchObject({ commandId: fixture.start.commandId, replayed: false });
      expect(CommandAcceptedSchema.parse(await provider.startCommand(fixture.start))).toMatchObject(
        {
          commandId: fixture.start.commandId,
          replayed: true
        }
      );
      await expect(provider.startCommand(fixture.conflictingStart)).rejects.toBeDefined();
      expect(await control.inspectRetainedCommand(fixture.start.commandId)).toEqual(fixture.start);
    });

    it("rejects tampered command authorization, approval, specification, and broadened scope", async () => {
      const wrongDigest = fixture.tampered.startWrongAuthorizationDigest.authorization;
      expect(await digestCommandAuthorization(wrongDigest)).not.toBe(wrongDigest.digest);
      expect(await digestCommandScope(wrongDigest.scope)).toBe(wrongDigest.approvalEvidenceDigest);
      const wrongEvidence = fixture.tampered.startWrongApprovalEvidence.authorization;
      expect(await digestCommandAuthorization(wrongEvidence)).toBe(wrongEvidence.digest);
      expect(await digestCommandScope(wrongEvidence.scope)).not.toBe(
        wrongEvidence.approvalEvidenceDigest
      );
      const specMismatch = fixture.tampered.startCommandSpecMismatch;
      expect(await digestCommandAuthorization(specMismatch.authorization)).toBe(
        specMismatch.authorization.digest
      );
      expect(await digestCommandScope(specMismatch.authorization.scope)).toBe(
        specMismatch.authorization.approvalEvidenceDigest
      );
      expect(await digestCommandSpec(specMismatch.command)).not.toBe(
        specMismatch.authorization.scope.commandDigest
      );
      const broadened = fixture.tampered.startBroadenedAuthorization;
      expect(await digestCommandAuthorization(broadened.authorization)).toBe(
        broadened.authorization.digest
      );
      expect(await digestCommandScope(broadened.authorization.scope)).toBe(
        broadened.authorization.approvalEvidenceDigest
      );
      expect(await digestCommandSpec(broadened.command)).toBe(
        broadened.authorization.scope.commandDigest
      );
      expect(() =>
        validateCommandAuthorizationAgainstEnvironment(
          broadened.authorization,
          fixture.prepare.authorization
        )
      ).toThrow();
      for (const request of [
        fixture.tampered.startWrongAuthorizationDigest,
        fixture.tampered.startWrongApprovalEvidence,
        fixture.tampered.startCommandSpecMismatch,
        fixture.tampered.startBroadenedAuthorization
      ]) {
        const { provider, control } = await fixture.create();
        await provider.prepareEnvironment(fixture.prepare);
        await expect(provider.startCommand(request)).rejects.toBeDefined();
        expect(await control.inspectRetainedCommand(request.commandId)).toBeUndefined();
      }
    });

    it("isolates lagging subscribers and resumes exact coherent durable sequences", async () => {
      const { provider, control } = await fixture.create();
      await provider.prepareEnvironment(fixture.prepare);
      await provider.startCommand(fixture.start);

      const slowIterator = provider.readCommandEvents(fixture.events)[Symbol.asyncIterator]();
      const fastIterator = provider.readCommandEvents(fixture.events)[Symbol.asyncIterator]();
      const slowFirst = await requireFirstItem(slowIterator);
      const fastFirst = await requireFirstItem(fastIterator);
      expect(slowFirst).toEqual(fastFirst);
      const fastPromise = collectIterator(fastIterator, [fastFirst]);
      await control.completeCommand(fixture.start.commandId);
      expect(await control.guardianLeaseCount()).toBe(0);
      const fastItems = await fastPromise;
      const fastEvents = expectStream(fastItems, fixture.events);
      expect(fastEvents.map((event) => event.sequence)).toEqual(
        fastEvents.map((_event, index) => index + 1)
      );

      const slowItems = [slowFirst, ...(await collectIterator(slowIterator))];
      const lagItems = slowItems.filter((item) => item.type === "subscription.lagged");
      expect(lagItems).toHaveLength(1);
      expect(slowItems.at(-1)).toEqual(lagItems[0]);
      const slowDurable = durableEvents(slowItems);
      const lag = lagItems[0];
      if (lag?.type !== "subscription.lagged") throw new TypeError("Expected a lag marker.");
      expect(lag.lastDurableSequence).toBe(slowDurable.at(-1)?.sequence ?? fixture.events.after);
      expect(lag.resumeCursor).toBe(lag.lastDurableSequence);
      expect(lag.resumeCursor).toBeLessThan(fastEvents.at(-1)?.sequence ?? 0);

      const resumeRequest = { ...fixture.events, after: lag.resumeCursor };
      const resumed = expectStream(
        await collect(provider.readCommandEvents(resumeRequest)),
        resumeRequest
      );
      expect(resumed[0]?.sequence).toBe(lag.resumeCursor + 1);

      const arbitraryAfter = fastEvents.at(-3)?.sequence;
      if (arbitraryAfter === undefined) throw new TypeError("Conformance stream is too short.");
      const arbitraryRequest = { ...fixture.events, after: arbitraryAfter };
      const arbitrary = expectStream(
        await collect(provider.readCommandEvents(arbitraryRequest)),
        arbitraryRequest
      );
      expect(arbitrary[0]?.sequence).toBe(arbitraryAfter + 1);
    });

    it("cancels idempotently with an explicit replay response", async () => {
      const { provider } = await fixture.create();
      await provider.prepareEnvironment(fixture.prepare);
      await provider.startCommand(fixture.start);
      const first = CancelCommandResponseSchema.parse(await provider.cancelCommand(fixture.cancel));
      expect(first).toEqual({
        commandId: fixture.cancel.commandId,
        cancelled: true,
        replayed: false
      });
      expect(
        CancelCommandResponseSchema.parse(await provider.cancelCommand(fixture.cancel))
      ).toEqual({
        commandId: fixture.cancel.commandId,
        cancelled: true,
        replayed: true
      });
    });

    it("rejects foreign event subscriptions and cancellation envelopes", async () => {
      const { provider } = await fixture.create();
      await provider.prepareEnvironment(fixture.prepare);
      await provider.startCommand(fixture.start);
      const identityOverrides = [
        { workspaceId: fixture.foreign.workspaceId },
        { runId: fixture.foreign.runId },
        { environmentId: fixture.foreign.environmentId },
        { commandId: fixture.foreign.commandId },
        { environmentAuthorizationId: fixture.foreign.environmentAuthorizationId },
        { environmentAuthorizationDigest: fixture.foreign.digest },
        { commandAuthorizationId: fixture.foreign.commandAuthorizationId },
        { commandAuthorizationDigest: fixture.foreign.digest }
      ];
      for (const overrides of identityOverrides) {
        await expect(
          collect(provider.readCommandEvents({ ...fixture.events, ...overrides }))
        ).rejects.toBeDefined();
        await expect(
          provider.cancelCommand({ ...fixture.cancel, ...overrides })
        ).rejects.toBeDefined();
      }
    });

    // Digest-bound: this case reads a whole artifact chunk by chunk and re-hashes it, which has no
    // margin under the 5s default once V8 coverage instrumentation is on and the workspace's
    // packages run in parallel. Every other case in this suite finishes in tens of milliseconds.
    it(
      "reassembles and authenticates artifacts while rejecting every foreign boundary",
      { timeout: 20_000 },
      async () => {
        const { provider, control } = await fixture.create();
        await provider.prepareEnvironment(fixture.prepare);
        await provider.startCommand(fixture.start);
        await control.completeCommand(fixture.start.commandId);
        const whole = await readWholeArtifact(provider, fixture.artifact);
        expect(whole.bytes).toEqual(fixture.expectedArtifactBytes);
        expect(whole.descriptor.byteSize).toBe(fixture.expectedArtifactBytes.byteLength);
        expect(await sha256Hex(whole.bytes)).toBe(whole.descriptor.digest);
        expect(whole.descriptor).toMatchObject({
          artifactId: fixture.artifact.artifactId,
          workspaceId: fixture.artifact.workspaceId,
          runId: fixture.artifact.runId,
          commandId: fixture.artifact.commandId
        });

        const rejected = async (overrides: Partial<ReadArtifactChunkRequest>): Promise<void> => {
          await expect(
            provider.readArtifactChunk({ ...fixture.artifact, ...overrides })
          ).rejects.toBeDefined();
        };
        await rejected({ workspaceId: fixture.foreign.workspaceId });
        await rejected({ runId: fixture.foreign.runId });
        await rejected({ environmentId: fixture.foreign.environmentId });
        await rejected({ commandId: fixture.foreign.commandId });
        await rejected({ environmentAuthorizationId: fixture.foreign.environmentAuthorizationId });
        await rejected({ environmentAuthorizationDigest: fixture.foreign.digest });
        await rejected({ commandAuthorizationId: fixture.foreign.commandAuthorizationId });
        await rejected({ commandAuthorizationDigest: fixture.foreign.digest });
        await rejected({ artifactId: fixture.foreign.artifactId });
        await expect(
          Reflect.apply(provider.readArtifactChunk, provider, [{ ...fixture.artifact, offset: -1 }])
        ).rejects.toBeDefined();
        await expect(
          Reflect.apply(provider.readArtifactChunk, provider, [
            { ...fixture.artifact, length: ARTIFACT_CHUNK_LIMIT + 1 }
          ])
        ).rejects.toBeDefined();
      }
    );

    it("disposes only with exact authoritative terminal evidence and never implicitly", async () => {
      const { provider, control } = await fixture.create();
      const prepared = await provider.prepareEnvironment(fixture.prepare);
      await provider.startCommand(fixture.start);
      await expect(provider.disposeEnvironment(fixture.dispose)).rejects.toBeDefined();
      await control.completeCommand(fixture.start.commandId);
      expect(await provider.listEnvironments()).toContainEqual(prepared);
      await expect(provider.disposeEnvironment(fixture.dispose)).rejects.toBeDefined();
      await control.recordTerminalRunEvidence(
        fixture.dispose.environmentId,
        fixture.dispose.terminalRunEvidence
      );
      await expect(
        provider.disposeEnvironment({
          ...fixture.dispose,
          terminalRunEvidence: {
            ...fixture.dispose.terminalRunEvidence,
            terminalEventSequence: fixture.dispose.terminalRunEvidence.terminalEventSequence + 1
          }
        })
      ).rejects.toBeDefined();
      await expect(
        provider.disposeEnvironment({
          ...fixture.dispose,
          terminalRunEvidence: {
            ...fixture.dispose.terminalRunEvidence,
            terminalEventDigest: fixture.foreign.digest
          }
        })
      ).rejects.toBeDefined();
      const wrongStatus =
        fixture.dispose.terminalRunEvidence.status === "failed" ? "completed" : "failed";
      await expect(
        provider.disposeEnvironment({
          ...fixture.dispose,
          terminalRunEvidence: { ...fixture.dispose.terminalRunEvidence, status: wrongStatus }
        })
      ).rejects.toBeDefined();
      await expect(
        Reflect.apply(provider.disposeEnvironment, provider, [
          {
            ...fixture.dispose,
            terminalRunEvidence: { ...fixture.dispose.terminalRunEvidence, status: "running" }
          }
        ])
      ).rejects.toBeDefined();

      expect(
        DisposeEnvironmentResponseSchema.parse(await provider.disposeEnvironment(fixture.dispose))
      ).toEqual({
        environmentId: fixture.dispose.environmentId,
        disposed: true,
        replayed: false
      });
      expect(await provider.listEnvironments()).not.toContainEqual(prepared);
      await expect(provider.startCommand(fixture.start)).rejects.toBeDefined();
    });
  });
};

export const describeLocalRunnerLifecycleConformance = (
  name: string,
  fixture: LocalRunnerLifecycleConformanceFixture
): void => {
  describe(name, () => {
    it("quiesces only new work while existing recovery operations remain usable", async () => {
      const { provider, lifecycle, control } = await fixture.create();
      await provider.prepareEnvironment(fixture.prepare);
      await provider.startCommand(fixture.start);
      await control.completeCommand(fixture.start.commandId);
      await lifecycle.quiesce();
      await expect(provider.prepareEnvironment(fixture.nextPrepare)).rejects.toBeDefined();
      await expect(provider.startCommand(fixture.nextStart)).rejects.toBeDefined();
      expectStream(await collect(provider.readCommandEvents(fixture.events)), fixture.events);
      expect(
        CancelCommandResponseSchema.parse(await provider.cancelCommand(fixture.cancel))
      ).toBeDefined();
      expect(
        ReadArtifactChunkResponseSchema.parse(await provider.readArtifactChunk(fixture.artifact))
      ).toBeDefined();
      expect(await provider.listEnvironments()).toHaveLength(1);
    });

    it("interrupts active commands, terminalizes their stream, and releases every lease", async () => {
      const { provider, lifecycle, control } = await fixture.create();
      await provider.prepareEnvironment(fixture.prepare);
      await provider.startCommand(fixture.start);
      expect(await control.guardianLeaseCount()).toBeGreaterThan(0);
      const drained = RunnerDrainResultSchema.parse(await lifecycle.interruptAndDrain());
      expect(drained.interruptedCommandIds).toContain(fixture.start.commandId);
      expect(drained.remainingGuardianLeaseCount).toBe(0);
      expect(drained.releasedGuardianLeaseCount).toBeGreaterThanOrEqual(
        drained.interruptedCommandIds.length
      );
      expect(await control.guardianLeaseCount()).toBe(0);
      const postDrain = expectStream(
        await collect(provider.readCommandEvents(fixture.events)),
        fixture.events
      );
      expect(postDrain.at(-1)).toMatchObject({ type: "command.completed", interrupted: true });
    });

    it("closes idempotently and rejects every provider and lifecycle operation afterward", async () => {
      const { provider, lifecycle, control } = await fixture.create();
      await provider.prepareEnvironment(fixture.prepare);
      await provider.startCommand(fixture.start);
      await control.completeCommand(fixture.start.commandId);
      await control.recordTerminalRunEvidence(
        fixture.dispose.environmentId,
        fixture.dispose.terminalRunEvidence
      );
      await lifecycle.close();

      await expect(provider.capabilities()).rejects.toBeDefined();
      await expect(provider.inspectRepository(fixture.inspectionRequest)).rejects.toBeDefined();
      await expect(provider.prepareEnvironment(fixture.prepare)).rejects.toBeDefined();
      await expect(provider.listEnvironments()).rejects.toBeDefined();
      await expect(provider.startCommand(fixture.start)).rejects.toBeDefined();
      await expect(collect(provider.readCommandEvents(fixture.events))).rejects.toBeDefined();
      await expect(provider.cancelCommand(fixture.cancel)).rejects.toBeDefined();
      await expect(provider.readArtifactChunk(fixture.artifact)).rejects.toBeDefined();
      await expect(provider.disposeEnvironment(fixture.dispose)).rejects.toBeDefined();
      await expect(lifecycle.quiesce()).rejects.toBeDefined();
      await expect(lifecycle.interruptAndDrain()).rejects.toBeDefined();
      await expect(lifecycle.close()).resolves.toBeUndefined();
    });
  });
};
