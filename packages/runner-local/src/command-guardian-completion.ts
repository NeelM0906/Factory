import type { ArtifactStore } from "./artifact-store.js";
import { publishGuardianTerminal } from "./command-guardian-finalization.js";
import { appendTranscriptSegments } from "./command-guardian-output.js";
import { proveProcessTreeExit } from "./command-guardian-process.js";
import { GuardianDurableRecorder } from "./command-guardian-recorder.js";
import type { GuardianTerminalEvidence } from "./command-guardian-types.js";
import type { BoundProcessTreeAuthority } from "./pty.js";
import type { ProcessTreeExitProof } from "./pty.js";
import { RedactedTranscript } from "./redacted-transcript.js";
import type { DurableRunnerFrame, ReplaySpool } from "./replay-spool.js";

export type GuardianCompletionResult =
  | Readonly<{ readonly status: "unsafe"; readonly retryAfter?: Promise<void> }>
  | Readonly<{ readonly status: "terminal"; readonly frame: DurableRunnerFrame }>;

export const completeGuardianCommand = async (input: {
  readonly artifactStore: ArtifactStore;
  readonly spool: ReplaySpool;
  readonly recorder: GuardianDurableRecorder;
  readonly transcript: RedactedTranscript;
  readonly transcriptFailed: boolean;
  readonly processTree?: BoundProcessTreeAuthority;
  readonly observedExit?: GuardianTerminalEvidence["exit"];
  readonly observedExitConflict: boolean;
  readonly sensitiveValues: readonly string[];
  readonly initialEvidence: GuardianTerminalEvidence;
  readonly emittedOutputBytes: number;
  readonly durationMs: number;
  readonly acceptReplayText: (output: string, flush: boolean) => Promise<void>;
  readonly admitAuthoritativeProof: (proof: ProcessTreeExitProof) => boolean;
  readonly assertAuthoritativeProof: () => void;
}): Promise<GuardianCompletionResult> => {
  if (input.observedExitConflict) return Object.freeze({ status: "unsafe" });
  let evidence = input.initialEvidence;
  if (!evidence.processTreeTerminated && input.processTree !== undefined) {
    const proof = await proveProcessTreeExit(input.processTree, input.sensitiveValues);
    if (proof.retryAfter !== undefined) {
      return Object.freeze({ status: "unsafe", retryAfter: proof.retryAfter });
    }
    if (proof.completed && proof.value?.processTreeTerminated === true) {
      if (
        input.observedExit !== undefined &&
        (input.observedExit.exitCode !== proof.value.exit.exitCode ||
          input.observedExit.signal !== proof.value.exit.signal)
      ) {
        return Object.freeze({ status: "unsafe" });
      }
      if (!input.admitAuthoritativeProof(proof.value)) {
        return Object.freeze({ status: "unsafe" });
      }
      evidence = {
        ...evidence,
        exit: proof.value.exit,
        processTreeTerminated: true
      };
    }
  }
  if (!evidence.processTreeTerminated) return Object.freeze({ status: "unsafe" });
  let transcriptFailed = input.transcriptFailed;
  if (transcriptFailed) evidence = { ...evidence, cause: "output_quarantined" };
  let final: Readonly<{ durable: Buffer; replayOutput: readonly string[] }> = {
    durable: Buffer.alloc(0),
    replayOutput: []
  };
  if (!transcriptFailed) {
    try {
      final = input.transcript.finalize();
    } catch {
      transcriptFailed = true;
      evidence = { ...evidence, cause: "output_quarantined" };
    }
  }
  if (final.durable.byteLength > 0) await appendTranscriptSegments(input.spool, final.durable);
  for (const output of final.replayOutput) await input.acceptReplayText(output, false);
  if (!transcriptFailed) await input.acceptReplayText("", true);
  const recovered = await input.spool.recover();
  const droppedBytes = Math.max(0, recovered.transcriptByteSize - input.emittedOutputBytes);
  if (droppedBytes > 0) {
    await input.recorder.appendEvent({ type: "terminal.truncated", stream: "pty", droppedBytes });
  }
  const frame = await publishGuardianTerminal({
    artifactStore: input.artifactStore,
    spool: input.spool,
    recorder: input.recorder,
    sensitiveValues: input.sensitiveValues,
    evidence,
    recovered,
    durationMs: input.durationMs,
    assertAuthoritativeProof: input.assertAuthoritativeProof
  });
  return Object.freeze({ status: "terminal", frame });
};
