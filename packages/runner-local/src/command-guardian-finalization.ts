import type { ArtifactStore } from "./artifact-store.js";
import { publishTranscriptArtifact } from "./command-guardian-output.js";
import { GuardianDurableRecorder } from "./command-guardian-recorder.js";
import type { GuardianTerminalEvidence } from "./command-guardian-types.js";
import type { DurableRunnerFrame, RecoveredCommandSpool, ReplaySpool } from "./replay-spool.js";

const CAUSE_PRIORITY: Readonly<Record<GuardianTerminalEvidence["cause"], number>> = Object.freeze({
  natural: 1,
  cancelled: 2,
  timeout: 2,
  interrupted: 3,
  protocol_failure: 4,
  output_quarantined: 5
});

export class GuardianTerminalCauseArbiter {
  #winning: GuardianTerminalEvidence["cause"] | undefined;

  get winning(): GuardianTerminalEvidence["cause"] | undefined {
    return this.#winning;
  }

  claim(cause: GuardianTerminalEvidence["cause"], locked: boolean): boolean {
    if (
      this.#winning !== undefined &&
      (locked || CAUSE_PRIORITY[cause] <= CAUSE_PRIORITY[this.#winning])
    ) {
      return this.#winning === cause;
    }
    this.#winning = cause;
    return true;
  }
}

export const publishGuardianTerminal = async (options: {
  readonly artifactStore: ArtifactStore;
  readonly spool: ReplaySpool;
  readonly recorder: GuardianDurableRecorder;
  readonly sensitiveValues: readonly string[];
  readonly evidence: GuardianTerminalEvidence;
  readonly recovered: RecoveredCommandSpool;
  readonly durationMs: number;
  readonly assertAuthoritativeProof: () => void;
}): Promise<DurableRunnerFrame> => {
  const { evidence, recovered, durationMs } = options;
  options.assertAuthoritativeProof();
  const finalizing = await options.spool.recordPhase("finalizing", {
    recordedAt: options.recorder.receiptTime(),
    evidence: {
      cause: evidence.cause,
      exitCode: evidence.exit.exitCode,
      signal: evidence.exit.signal,
      durationMs,
      cancelled: evidence.cause === "cancelled",
      interrupted: evidence.cause === "interrupted",
      processTreeTerminated: evidence.processTreeTerminated,
      ptyEofObserved: evidence.ptyEofObserved,
      transcriptByteSize: recovered.transcriptByteSize,
      transcriptHeadDigest: recovered.transcriptChunks.at(-1)?.chunkDigest ?? null
    }
  });
  await options.recorder.notifyPhase("finalizing", finalizing.receiptDigest);
  const artifact = await publishTranscriptArtifact({
    artifactStore: options.artifactStore,
    spool: options.spool,
    chunks: recovered.transcriptChunks.map((chunk) => chunk.bytes),
    sensitiveValues: options.sensitiveValues
  });
  const artifactFrame = await options.recorder.appendEvent({
    type: "artifact.created",
    artifact
  });
  const failedSafely =
    !evidence.processTreeTerminated ||
    evidence.cause === "protocol_failure" ||
    evidence.cause === "output_quarantined";
  const terminalFrame = failedSafely
    ? await options.recorder.appendEvent({
        type: "stream.error",
        code: evidence.cause === "output_quarantined" ? "output_quarantined" : "protocol_failure",
        message:
          evidence.cause === "output_quarantined"
            ? "The supervised PTY command output was quarantined."
            : "The supervised PTY command failed safely."
      })
    : await options.recorder.appendEvent({
        type: "command.completed",
        exitCode: evidence.exit.exitCode,
        signal: evidence.exit.signal,
        durationMs,
        cancelled: evidence.cause === "cancelled",
        interrupted: evidence.cause === "interrupted",
        transcript: artifact
      });
  const terminal = await options.spool.recordPhase("terminal", {
    recordedAt: options.recorder.receiptTime(),
    evidence: {
      artifactFrameDigest: artifactFrame.frameDigest,
      terminalFrameDigest: terminalFrame.frameDigest,
      artifactId: artifact.artifactId,
      artifactDigest: artifact.digest,
      processTreeTerminated: evidence.processTreeTerminated
    }
  });
  await options.recorder.notifyPhase("terminal", terminal.receiptDigest);
  return terminalFrame;
};
