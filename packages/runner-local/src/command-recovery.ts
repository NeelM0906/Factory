import type {
  ArtifactDescriptor,
  CommandId,
  RunnerStreamEvent,
  SafeJsonValue
} from "@autostack/contracts";

import {
  admitArtifactStoreRecoveryRoot,
  writeArtifactCapabilityUnderRecoveryGuard,
  type ArtifactStoreRecoveryCapability
} from "./artifact-mutation-authority.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  createRecoveredLeaseEvidence,
  createRecoveredSpawnFailureEvidence,
  createRecoveredUnspawnedEvidence
} from "./command-phase-evidence.js";
import type { CommandGuardianLease } from "./data-root-lock.js";
import {
  ReplaySpool,
  ReplaySpoolError,
  type DurableRunnerFrame,
  type RecoveredCommandSpool
} from "./replay-spool.js";
import { admitRecoverySpool } from "./replay-spool-recovery-authority.js";
import { validateRecoveredCommand } from "./command-recovery-validation.js";
import { snapshotRecoverCommandOptions } from "./command-recovery-options.js";
import type { RecoverySpoolOperations } from "./replay-spool-recovery-authority.js";

type RecoveryErrorCode = "protocol_failure" | "guardian_lost" | "output_quarantined";
type EventBaseKey = "workspaceId" | "runId" | "commandId" | "sequence" | "occurredAt";
type RecoveryEventInput<Event = RunnerStreamEvent> = Event extends RunnerStreamEvent
  ? Omit<Event, EventBaseKey>
  : never;
type RecoveryLeaseGuard = () => void;

const isRecord = (value: unknown): value is Readonly<Record<string, SafeJsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nextTimestamp = (value: string): string => new Date(Date.parse(value) + 1).toISOString();

const lastReceiptTime = (recovered: RecoveredCommandSpool): string => {
  const receipt = recovered.phases.at(-1);
  if (receipt === undefined) throw new ReplaySpoolError("maintenance_required");
  return receipt.phase === "intent" ? receipt.acceptedAt : receipt.recordedAt;
};

const appendEvent = async (
  spool: RecoverySpoolOperations,
  recovered: RecoveredCommandSpool,
  event: RecoveryEventInput,
  guard: RecoveryLeaseGuard
): Promise<DurableRunnerFrame> => {
  guard();
  return await spool.appendEvent({
    ...event,
    workspaceId: spool.intent.workspaceId,
    runId: spool.intent.runId,
    commandId: spool.intent.commandId,
    sequence: recovered.events.length + 1,
    occurredAt: nextTimestamp(lastReceiptTime(recovered))
  } as RunnerStreamEvent);
};

const writeTranscriptArtifact = async (
  spool: RecoverySpoolOperations,
  artifacts: ArtifactStoreRecoveryCapability,
  recovered: RecoveredCommandSpool,
  guard: RecoveryLeaseGuard
): Promise<ArtifactDescriptor> => {
  guard();
  return await writeArtifactCapabilityUnderRecoveryGuard(
    artifacts,
    {
      metadata: {
        artifactId: spool.intent.transcriptArtifactId,
        workspaceId: spool.intent.workspaceId,
        runId: spool.intent.runId,
        commandId: spool.intent.commandId,
        kind: "command_transcript",
        mediaType: "text/plain; charset=utf-8",
        createdAt: spool.intent.artifactCreatedAt
      },
      content: (async function* () {
        for (const chunk of recovered.transcriptChunks) yield Uint8Array.from(chunk.bytes);
      })(),
      maximumBytes: spool.intent.limits.transcriptBytes,
      sensitiveValues: []
    },
    guard
  );
};

const recoverableFinalizingEvidence = (
  recovered: RecoveredCommandSpool
): Readonly<{
  cause: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  cancelled: boolean;
  interrupted: boolean;
}> => {
  const receipt = recovered.phases.at(-1);
  const evidence = receipt?.phase === "finalizing" ? receipt.evidence : undefined;
  if (!isRecord(evidence)) throw new ReplaySpoolError("maintenance_required");
  const expectedHead = recovered.transcriptChunks.at(-1)?.chunkDigest ?? null;
  const cause = evidence.cause;
  const exitCode = evidence.exitCode;
  const signal = evidence.signal;
  const durationMs = evidence.durationMs;
  const cancelled = evidence.cancelled;
  const interrupted = evidence.interrupted;
  if (
    typeof cause !== "string" ||
    (exitCode !== null && (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)) ||
    (signal !== null && typeof signal !== "string") ||
    !Number.isSafeInteger(durationMs) ||
    (durationMs as number) < 0 ||
    typeof cancelled !== "boolean" ||
    typeof interrupted !== "boolean" ||
    evidence.processTreeTerminated !== true ||
    evidence.transcriptByteSize !== recovered.transcriptByteSize ||
    evidence.transcriptHeadDigest !== expectedHead
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  return {
    cause,
    exitCode: exitCode as number | null,
    signal: signal as string | null,
    durationMs: durationMs as number,
    cancelled,
    interrupted
  };
};

const failureCode = (cause: string): RecoveryErrorCode | undefined => {
  if (cause === "protocol_failure" || cause === "guardian_lost" || cause === "output_quarantined") {
    return cause;
  }
  return undefined;
};

const expectedTerminalEvent = (
  spool: RecoverySpoolOperations,
  evidence: ReturnType<typeof recoverableFinalizingEvidence>,
  artifact: ArtifactDescriptor,
  sequence: number,
  occurredAt: string
): RunnerStreamEvent => {
  const code = failureCode(evidence.cause);
  if (code !== undefined) {
    return {
      type: "stream.error",
      workspaceId: spool.intent.workspaceId,
      runId: spool.intent.runId,
      commandId: spool.intent.commandId,
      sequence,
      occurredAt,
      code,
      message:
        code === "output_quarantined"
          ? "The supervised PTY command output was quarantined."
          : "The supervised PTY command failed safely."
    };
  }
  if (!new Set(["natural", "cancelled", "timeout", "interrupted"]).has(evidence.cause)) {
    throw new ReplaySpoolError("maintenance_required");
  }
  return {
    type: "command.completed",
    workspaceId: spool.intent.workspaceId,
    runId: spool.intent.runId,
    commandId: spool.intent.commandId,
    sequence,
    occurredAt,
    exitCode: evidence.exitCode,
    signal: evidence.signal,
    durationMs: evidence.durationMs,
    cancelled: evidence.cancelled,
    interrupted: evidence.interrupted,
    transcript: artifact
  };
};

const sameDescriptor = (left: ArtifactDescriptor, right: ArtifactDescriptor): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const finishFinalizing = async (
  spool: RecoverySpoolOperations,
  artifacts: ArtifactStoreRecoveryCapability,
  recoveredInput: RecoveredCommandSpool,
  guard: RecoveryLeaseGuard
): Promise<RecoveredCommandSpool> => {
  const evidence = recoverableFinalizingEvidence(recoveredInput);
  const artifact = await writeTranscriptArtifact(spool, artifacts, recoveredInput, guard);
  let recovered = await spool.recover();
  const artifactFrames = recovered.events.filter(
    (frame) => frame.event.type === "artifact.created"
  );
  if (artifactFrames.length === 0) {
    await appendEvent(spool, recovered, { type: "artifact.created", artifact }, guard);
    recovered = await spool.recover();
  } else if (
    artifactFrames.length !== 1 ||
    artifactFrames[0]?.event.type !== "artifact.created" ||
    !sameDescriptor(artifactFrames[0].event.artifact, artifact)
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  const terminalFrames = recovered.events.filter(
    (frame) => frame.event.type === "command.completed" || frame.event.type === "stream.error"
  );
  if (terminalFrames.length === 0) {
    const expected = expectedTerminalEvent(
      spool,
      evidence,
      artifact,
      recovered.events.length + 1,
      nextTimestamp(lastReceiptTime(recovered))
    );
    guard();
    await spool.appendEvent(expected);
    recovered = await spool.recover();
  } else {
    const terminal = terminalFrames[0];
    if (
      terminalFrames.length !== 1 ||
      terminal === undefined ||
      terminal !== recovered.events.at(-1)
    ) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const expected = expectedTerminalEvent(
      spool,
      evidence,
      artifact,
      terminal.sequence,
      terminal.event.occurredAt
    );
    if (JSON.stringify(terminal.event) !== JSON.stringify(expected)) {
      throw new ReplaySpoolError("maintenance_required");
    }
  }
  const artifactFrame = recovered.events.at(-2);
  const terminalFrame = recovered.events.at(-1);
  if (artifactFrame?.event.type !== "artifact.created" || terminalFrame === undefined) {
    throw new ReplaySpoolError("maintenance_required");
  }
  if (recovered.phases.at(-1)?.phase !== "terminal") {
    guard();
    await spool.recordPhase("terminal", {
      recordedAt: nextTimestamp(lastReceiptTime(recovered)),
      evidence: {
        artifactFrameDigest: artifactFrame.frameDigest,
        terminalFrameDigest: terminalFrame.frameDigest,
        artifactId: artifact.artifactId,
        artifactDigest: artifact.digest,
        processTreeTerminated: true
      }
    });
  }
  return await spool.recover();
};

const advanceUnspawned = async (
  spool: RecoverySpoolOperations,
  recoveredInput: RecoveredCommandSpool,
  guard: RecoveryLeaseGuard
): Promise<RecoveredCommandSpool> => {
  let recovered = recoveredInput;
  const original = recovered.phases.at(-1)?.phase;
  const failure: RecoveryErrorCode = original === "intent" ? "protocol_failure" : "guardian_lost";
  if (original === "intent") {
    guard();
    await spool.recordPhase("lease_transferred", {
      recordedAt: nextTimestamp(lastReceiptTime(recovered)),
      evidence: createRecoveredLeaseEvidence()
    });
    recovered = await spool.recover();
  }
  guard();
  await spool.recordPhase("spawned", {
    recordedAt: nextTimestamp(lastReceiptTime(recovered)),
    evidence: createRecoveredUnspawnedEvidence()
  });
  recovered = await spool.recover();
  if (recovered.events.length === 0) {
    await appendEvent(spool, recovered, { type: "command.started", pty: true }, guard);
    recovered = await spool.recover();
  }
  guard();
  await spool.recordPhase("running", {
    recordedAt: nextTimestamp(lastReceiptTime(recovered)),
    evidence: createRecoveredSpawnFailureEvidence()
  });
  recovered = await spool.recover();
  guard();
  await spool.recordPhase("finalizing", {
    recordedAt: nextTimestamp(lastReceiptTime(recovered)),
    evidence: {
      cause: failure,
      exitCode: 1,
      signal: null,
      durationMs: 0,
      cancelled: false,
      interrupted: false,
      processTreeTerminated: true,
      ptyEofObserved: false,
      transcriptByteSize: recovered.transcriptByteSize,
      transcriptHeadDigest: recovered.transcriptChunks.at(-1)?.chunkDigest ?? null
    }
  });
  return await spool.recover();
};

export const recoverCommandUnderLease = async (options: {
  readonly dataRoot: string;
  readonly commandId: CommandId;
  readonly spool: ReplaySpool;
  readonly artifactStore: ArtifactStore;
  readonly acquiredLease: CommandGuardianLease;
}): Promise<RecoveredCommandSpool> => {
  try {
    const admitted = snapshotRecoverCommandOptions(options);
    const authority = await admitRecoverySpool({
      spool: admitted.spool,
      dataRoot: admitted.dataRoot,
      commandId: admitted.commandId,
      lease: admitted.acquiredLease
    });
    const artifacts = await admitArtifactStoreRecoveryRoot(
      admitted.artifactStore,
      authority.canonicalRoot
    );
    const { guard } = authority;
    const spool = authority.operations;
    let recovered = await spool.recover();
    await validateRecoveredCommand(recovered);
    const phase = recovered.phases.at(-1)?.phase;
    if (phase === "spawned" || phase === "running") {
      throw new ReplaySpoolError("maintenance_required");
    }
    if (phase === "intent" || phase === "lease_transferred") {
      recovered = await advanceUnspawned(spool, recovered, guard);
      await validateRecoveredCommand(recovered);
    }
    if (recovered.phases.at(-1)?.phase === "finalizing") {
      recovered = await finishFinalizing(spool, artifacts, recovered, guard);
      await validateRecoveredCommand(recovered);
    }
    if (recovered.phases.at(-1)?.phase === "terminal") {
      const artifactFrame = recovered.events.at(-2);
      if (artifactFrame?.event.type !== "artifact.created") {
        throw new ReplaySpoolError("maintenance_required");
      }
      const committed = await artifacts.findArtifact(artifactFrame.event.artifact.artifactId);
      if (committed === undefined || !sameDescriptor(committed, artifactFrame.event.artifact)) {
        throw new ReplaySpoolError("maintenance_required");
      }
    }
    return recovered;
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};
