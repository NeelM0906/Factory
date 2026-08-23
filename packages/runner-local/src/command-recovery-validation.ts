import { createHash } from "node:crypto";

import {
  CommandAuthorizationSchema,
  EnvironmentAuthorizationSchema,
  StartCommandRequestSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestVersionedValue,
  normalizeSafeJson,
  validateCommandAuthorizationAgainstEnvironment,
  type ArtifactDescriptor,
  type SafeJsonValue,
  type StartCommandRequest
} from "@autostack/contracts";

import {
  ReplaySpoolError,
  type CommandPhaseReceipt,
  type RecoveredCommandSpool
} from "./replay-spool.js";
import { admitGuardianPhaseEvidence } from "./command-phase-evidence.js";
import { isDarwinTerminatingSignal } from "./darwin-process-signals.js";
import { parseFrame } from "./replay-spool-codec.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Readonly<Record<string, SafeJsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const validateIntent = async (recovered: RecoveredCommandSpool): Promise<StartCommandRequest> => {
  const intent = recovered.intent;
  const request = StartCommandRequestSchema.parse(normalizeSafeJson(intent.request));
  const authorization = CommandAuthorizationSchema.parse(request.authorization);
  const environmentAuthorization = EnvironmentAuthorizationSchema.parse(
    normalizeSafeJson(intent.environmentAuthorization)
  );
  validateCommandAuthorizationAgainstEnvironment(authorization, environmentAuthorization);
  const acceptedAt = Date.parse(intent.acceptedAt);
  const credentialIds = request.command.environment.flatMap((entry) =>
    entry.kind === "credential_ref" ? [entry.credentialRefId] : []
  );
  if (
    request.workspaceId !== intent.workspaceId ||
    request.runId !== intent.runId ||
    request.environmentId !== intent.environmentId ||
    request.commandId !== intent.commandId ||
    request.environmentAuthorizationId !== intent.environmentAuthorizationId ||
    request.environmentAuthorizationDigest !== intent.environmentAuthorizationDigest ||
    environmentAuthorization.id !== intent.environmentAuthorizationId ||
    environmentAuthorization.digest !== intent.environmentAuthorizationDigest ||
    environmentAuthorization.approvalEvidenceDigest !==
      (await digestExecutionScope(environmentAuthorization.scope)) ||
    environmentAuthorization.digest !==
      (await digestEnvironmentAuthorization(environmentAuthorization)) ||
    authorization.id !== intent.commandAuthorizationId ||
    authorization.digest !== intent.commandAuthorizationDigest ||
    intent.requestDigest !==
      (await digestVersionedValue("autostack.start-command-request", request)) ||
    authorization.approvalEvidenceDigest !== (await digestCommandScope(authorization.scope)) ||
    authorization.digest !== (await digestCommandAuthorization(authorization)) ||
    authorization.scope.commandDigest !== (await digestCommandSpec(request.command)) ||
    authorization.scope.workspaceId !== request.workspaceId ||
    authorization.scope.runId !== request.runId ||
    authorization.scope.environmentId !== request.environmentId ||
    authorization.scope.commandId !== request.commandId ||
    authorization.scope.environmentAuthorizationId !== request.environmentAuthorizationId ||
    authorization.scope.environmentAuthorizationDigest !== request.environmentAuthorizationDigest ||
    request.command.cwd !== intent.cwdRelativePath ||
    request.command.timeoutSeconds > authorization.scope.resourceLimits.durationSeconds ||
    credentialIds.some(
      (credentialId) =>
        !authorization.scope.allowedCredentialRefIds.includes(credentialId) ||
        !environmentAuthorization.scope.allowedCredentialRefIds.includes(credentialId)
    ) ||
    acceptedAt < Date.parse(environmentAuthorization.createdAt) ||
    acceptedAt >= Date.parse(environmentAuthorization.expiresAt) ||
    acceptedAt < Date.parse(authorization.createdAt) ||
    acceptedAt >= Date.parse(authorization.expiresAt) ||
    Date.parse(authorization.createdAt) < Date.parse(environmentAuthorization.createdAt) ||
    Date.parse(authorization.expiresAt) > Date.parse(environmentAuthorization.expiresAt) ||
    intent.artifactCreatedAt !== intent.acceptedAt ||
    !SHA256_PATTERN.test(intent.environmentIntentDigest) ||
    !SHA256_PATTERN.test(intent.spawnEnvelopeDigest)
  ) {
    throw new TypeError();
  }
  return request;
};

const sameArtifactOwner = (
  artifact: ArtifactDescriptor,
  recovered: RecoveredCommandSpool
): boolean =>
  artifact.artifactId === recovered.intent.transcriptArtifactId &&
  artifact.workspaceId === recovered.intent.workspaceId &&
  artifact.runId === recovered.intent.runId &&
  artifact.commandId === recovered.intent.commandId &&
  artifact.kind === "command_transcript" &&
  artifact.mediaType === "text/plain; charset=utf-8" &&
  artifact.createdAt === recovered.intent.artifactCreatedAt;

const exactTerminalSignal = (cause: unknown, exitCode: unknown, signal: unknown): boolean => {
  const isProcessResult =
    (signal === null &&
      Number.isSafeInteger(exitCode) &&
      (exitCode as number) >= 0 &&
      (exitCode as number) <= 255) ||
    (exitCode === null && isDarwinTerminatingSignal(signal));
  if (
    cause === "cancelled" ||
    cause === "timeout" ||
    cause === "interrupted" ||
    cause === "protocol_failure" ||
    cause === "output_quarantined"
  ) {
    return isProcessResult;
  }
  if (cause === "guardian_lost") return exitCode === 1 && signal === null;
  return cause === "natural" && isProcessResult;
};

const validateStateTruthTable = (recovered: RecoveredCommandSpool): void => {
  const highest = recovered.phases.at(-1)?.phase;
  const preRunning =
    highest === "intent" || highest === "lease_transferred" || highest === "spawned";
  if (
    preRunning &&
    (recovered.events.length !== 0 ||
      recovered.transcriptChunks.length !== 0 ||
      recovered.transcriptByteSize !== 0 ||
      recovered.cancel !== undefined ||
      recovered.cancelAck !== undefined)
  ) {
    throw new TypeError();
  }
  if (
    recovered.cancelAck !== undefined &&
    (recovered.cancel === undefined ||
      recovered.cancelAck.claimDigest !== recovered.cancel.claimDigest ||
      recovered.cancelAck.signalDispatched !== true)
  ) {
    throw new TypeError();
  }
  if (highest === "running") {
    if (
      recovered.events.some(
        (frame) =>
          frame.event.type !== "command.started" &&
          frame.event.type !== "terminal.output" &&
          frame.event.type !== "terminal.truncated"
      )
    ) {
      throw new TypeError();
    }
  }
  const artifactIndexes = recovered.events.flatMap((frame, index) =>
    frame.event.type === "artifact.created" ? [index] : []
  );
  const terminalIndexes = recovered.events.flatMap((frame, index) =>
    frame.event.type === "command.completed" || frame.event.type === "stream.error" ? [index] : []
  );
  if (
    (highest !== "finalizing" &&
      highest !== "terminal" &&
      (artifactIndexes.length > 0 || terminalIndexes.length > 0)) ||
    artifactIndexes.length > 1 ||
    terminalIndexes.length > 1 ||
    (artifactIndexes[0] !== undefined &&
      artifactIndexes[0] !==
        recovered.events.length - (terminalIndexes[0] === undefined ? 1 : 2)) ||
    (terminalIndexes[0] !== undefined && terminalIndexes[0] !== recovered.events.length - 1)
  ) {
    throw new TypeError();
  }
  if (highest === "finalizing" || highest === "terminal") {
    const outputBytes = recovered.events.reduce((total, frame) => {
      if (frame.event.type === "terminal.output")
        return total + Buffer.byteLength(frame.event.text);
      if (frame.event.type === "terminal.truncated") return total + frame.event.droppedBytes;
      return total;
    }, 0);
    if (outputBytes !== recovered.transcriptByteSize) throw new TypeError();
  }
};

const validateTerminalEvent = (
  evidence: Readonly<Record<string, SafeJsonValue>>,
  terminalFrame: RecoveredCommandSpool["events"][number],
  artifactFrame: RecoveredCommandSpool["events"][number]
): void => {
  if (artifactFrame.event.type !== "artifact.created") throw new TypeError();
  if (terminalFrame.event.type === "command.completed") {
    if (
      terminalFrame.event.exitCode !== evidence.exitCode ||
      terminalFrame.event.signal !== evidence.signal ||
      terminalFrame.event.durationMs !== evidence.durationMs ||
      terminalFrame.event.cancelled !== evidence.cancelled ||
      terminalFrame.event.interrupted !== evidence.interrupted ||
      JSON.stringify(terminalFrame.event.transcript) !==
        JSON.stringify(artifactFrame.event.artifact)
    ) {
      throw new TypeError();
    }
    return;
  }
  if (terminalFrame.event.type !== "stream.error") throw new TypeError();
  const expectedCode =
    evidence.cause === "output_quarantined"
      ? "output_quarantined"
      : evidence.cause === "guardian_lost"
        ? "guardian_lost"
        : "protocol_failure";
  const expectedMessage =
    expectedCode === "output_quarantined"
      ? "The supervised PTY command output was quarantined."
      : "The supervised PTY command failed safely.";
  if (
    terminalFrame.event.code !== expectedCode ||
    terminalFrame.event.message !== expectedMessage
  ) {
    throw new TypeError();
  }
};

const validatePhaseEvidence = (recovered: RecoveredCommandSpool): void => {
  const phases = recovered.phases;
  const started = recovered.events[0];
  const highest = phases.at(-1)?.phase;
  if (
    (highest === "running" || highest === "finalizing" || highest === "terminal") &&
    (started?.event.type !== "command.started" ||
      recovered.events.filter((frame) => frame.event.type === "command.started").length !== 1)
  ) {
    throw new TypeError();
  }
  for (const receipt of phases.slice(1)) {
    if (
      receipt.phase !== "lease_transferred" &&
      receipt.phase !== "spawned" &&
      receipt.phase !== "running"
    )
      continue;
    if (receipt.phase === "running" && started?.event.type !== "command.started") {
      throw new TypeError();
    }
    admitGuardianPhaseEvidence({
      phase: receipt.phase,
      evidence: receipt.evidence,
      identity: recovered.intent,
      ...(receipt.phase === "running" && started?.event.type === "command.started"
        ? { startedFrameDigest: started.frameDigest }
        : {})
    });
  }
};

const validateFinalizingAndTerminal = (recovered: RecoveredCommandSpool): void => {
  const finalizing = recovered.phases.find(
    (receipt): receipt is CommandPhaseReceipt => receipt.phase === "finalizing"
  );
  if (finalizing === undefined || !isRecord(finalizing.evidence)) throw new TypeError();
  const evidence = finalizing.evidence;
  if (
    !exactKeys(evidence, [
      "cause",
      "exitCode",
      "signal",
      "durationMs",
      "cancelled",
      "interrupted",
      "processTreeTerminated",
      "ptyEofObserved",
      "transcriptByteSize",
      "transcriptHeadDigest"
    ]) ||
    !new Set([
      "natural",
      "cancelled",
      "timeout",
      "interrupted",
      "protocol_failure",
      "guardian_lost",
      "output_quarantined"
    ]).has(evidence.cause as string) ||
    (evidence.exitCode !== null && !Number.isSafeInteger(evidence.exitCode)) ||
    (evidence.signal !== null && typeof evidence.signal !== "string") ||
    !Number.isSafeInteger(evidence.durationMs) ||
    (evidence.durationMs as number) < 0 ||
    typeof evidence.cancelled !== "boolean" ||
    typeof evidence.interrupted !== "boolean" ||
    !exactTerminalSignal(evidence.cause, evidence.exitCode, evidence.signal) ||
    evidence.processTreeTerminated !== true ||
    typeof evidence.ptyEofObserved !== "boolean" ||
    evidence.transcriptByteSize !== recovered.transcriptByteSize ||
    evidence.transcriptHeadDigest !== (recovered.transcriptChunks.at(-1)?.chunkDigest ?? null) ||
    evidence.cancelled !== (evidence.cause === "cancelled") ||
    evidence.interrupted !== (evidence.cause === "interrupted")
  ) {
    throw new TypeError();
  }
  const artifactFrames = recovered.events.filter(
    (frame) => frame.event.type === "artifact.created"
  );
  const terminalFrames = recovered.events.filter(
    (frame) => frame.event.type === "command.completed" || frame.event.type === "stream.error"
  );
  if (artifactFrames.length > 1 || terminalFrames.length > 1) throw new TypeError();
  const artifactFrame = artifactFrames[0];
  const terminalFrame = terminalFrames[0];
  if (
    terminalFrame !== undefined &&
    (artifactFrame === undefined ||
      terminalFrame !== recovered.events.at(-1) ||
      artifactFrame !== recovered.events.at(-2))
  ) {
    throw new TypeError();
  }
  if (artifactFrame !== undefined) {
    if (
      artifactFrame.event.type !== "artifact.created" ||
      (terminalFrame === undefined && artifactFrame !== recovered.events.at(-1)) ||
      !sameArtifactOwner(artifactFrame.event.artifact, recovered)
    ) {
      throw new TypeError();
    }
    const transcriptDigest = createHash("sha256");
    for (const chunk of recovered.transcriptChunks) transcriptDigest.update(chunk.bytes);
    if (
      artifactFrame.event.artifact.byteSize !== recovered.transcriptByteSize ||
      artifactFrame.event.artifact.digest !== transcriptDigest.digest("hex")
    ) {
      throw new TypeError();
    }
  }
  if (terminalFrame !== undefined && artifactFrame !== undefined) {
    validateTerminalEvent(evidence, terminalFrame, artifactFrame);
  }
  if (recovered.phases.at(-1)?.phase !== "terminal") return;
  const penultimateFrame = recovered.events.at(-2);
  const finalFrame = recovered.events.at(-1);
  const terminalReceipt = recovered.phases.at(-1) as CommandPhaseReceipt;
  if (
    artifactFrames.length !== 1 ||
    terminalFrames.length !== 1 ||
    penultimateFrame !== artifactFrame ||
    finalFrame !== terminalFrame ||
    artifactFrame?.event.type !== "artifact.created" ||
    terminalFrame === undefined ||
    (terminalFrame.event.type !== "command.completed" &&
      terminalFrame.event.type !== "stream.error") ||
    !isRecord(terminalReceipt.evidence) ||
    !exactKeys(terminalReceipt.evidence, [
      "artifactFrameDigest",
      "terminalFrameDigest",
      "artifactId",
      "artifactDigest",
      "processTreeTerminated"
    ]) ||
    terminalReceipt.evidence.artifactFrameDigest !== artifactFrame.frameDigest ||
    terminalReceipt.evidence.terminalFrameDigest !== terminalFrame.frameDigest ||
    terminalReceipt.evidence.artifactId !== artifactFrame.event.artifact.artifactId ||
    terminalReceipt.evidence.artifactDigest !== artifactFrame.event.artifact.digest ||
    terminalReceipt.evidence.processTreeTerminated !== true
  ) {
    throw new TypeError();
  }
  validateTerminalEvent(evidence, terminalFrame, artifactFrame);
};

export const validateRecoveredCommand = async (recovered: RecoveredCommandSpool): Promise<void> => {
  try {
    await validateIntent(recovered);
    for (const frame of recovered.events) {
      const authenticated = parseFrame(frame);
      if (
        authenticated.frameDigest !== frame.frameDigest ||
        authenticated.event.workspaceId !== recovered.intent.workspaceId ||
        authenticated.event.runId !== recovered.intent.runId ||
        authenticated.event.commandId !== recovered.intent.commandId
      ) {
        throw new TypeError();
      }
    }
    if (
      (recovered.cancel !== undefined &&
        recovered.cancel.commandId !== recovered.intent.commandId) ||
      (recovered.cancelAck !== undefined &&
        recovered.cancelAck.commandId !== recovered.intent.commandId)
    ) {
      throw new TypeError();
    }
    validateStateTruthTable(recovered);
    validatePhaseEvidence(recovered);
    if (recovered.phases.some((receipt) => receipt.phase === "finalizing")) {
      validateFinalizingAndTerminal(recovered);
      const finalizing = recovered.phases.find((receipt) => receipt.phase === "finalizing");
      const cause =
        finalizing?.phase === "finalizing" && isRecord(finalizing.evidence)
          ? finalizing.evidence.cause
          : undefined;
      const completeCancel =
        recovered.cancel !== undefined &&
        recovered.cancelAck !== undefined &&
        recovered.cancel.cancelled === true &&
        recovered.cancelAck.claimDigest === recovered.cancel.claimDigest;
      if (cause === "cancelled" && !completeCancel) throw new TypeError();
    }
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
};
