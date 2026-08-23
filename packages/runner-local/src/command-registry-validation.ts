import {
  CommandIdSchema,
  type CancelCommandRequest,
  type CommandId,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest
} from "@autostack/contracts";

import { createCommandRegistryError, type CommandRegistryEntry } from "./command-registry-types.js";
import type { DurableRunnerFrame, RecoveredCommandSpool } from "./replay-spool.js";

const COMMAND_DIRECTORY_PATTERN = /^[0-9a-f]+$/;

export const terminalFrame = (frame: DurableRunnerFrame): boolean =>
  frame.event.type === "command.completed" || frame.event.type === "stream.error";

export const hasConsistentTerminalEvidence = (recovered: RecoveredCommandSpool): boolean => {
  const terminalReceipt = recovered.phases.at(-1);
  const terminalEvents = recovered.events.filter(terminalFrame);
  const artifactEvents = recovered.events.filter(
    (frame) => frame.event.type === "artifact.created"
  );
  if (terminalReceipt?.phase !== "terminal") return terminalEvents.length === 0;
  const terminal = terminalEvents[0];
  const finalEvent = recovered.events.at(-1);
  const artifact = recovered.events.at(-2);
  if (
    terminalEvents.length !== 1 ||
    artifactEvents.length !== 1 ||
    terminal === undefined ||
    terminal !== finalEvent ||
    artifact?.event.type !== "artifact.created" ||
    artifact !== artifactEvents[0] ||
    typeof terminalReceipt.evidence !== "object" ||
    terminalReceipt.evidence === null ||
    Array.isArray(terminalReceipt.evidence)
  ) {
    return false;
  }
  const evidence = terminalReceipt.evidence as Readonly<Record<string, unknown>>;
  return (
    evidence.terminalFrameDigest === terminal.frameDigest &&
    evidence.artifactFrameDigest === artifact.frameDigest &&
    evidence.artifactId === artifact.event.artifact.artifactId &&
    evidence.artifactDigest === artifact.event.artifact.digest &&
    evidence.processTreeTerminated === true
  );
};

export const decodeCommandDirectory = (name: string): CommandId => {
  if (!COMMAND_DIRECTORY_PATTERN.test(name) || name.length % 2 !== 0) {
    throw createCommandRegistryError("maintenance_required");
  }
  const decoded = Buffer.from(name, "hex").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("hex") !== name) {
    throw createCommandRegistryError("maintenance_required");
  }
  const parsed = CommandIdSchema.safeParse(decoded);
  if (!parsed.success || Buffer.from(parsed.data, "utf8").toString("hex") !== name) {
    throw createCommandRegistryError("maintenance_required");
  }
  return parsed.data;
};

const sameReceiptOwnership = (
  request: ReadCommandEventsRequest | ReadArtifactChunkRequest | CancelCommandRequest,
  entry: CommandRegistryEntry
): boolean => {
  const receipt = entry.spool.intent;
  return (
    request.workspaceId === receipt.workspaceId &&
    request.runId === receipt.runId &&
    request.environmentId === receipt.environmentId &&
    request.commandId === receipt.commandId &&
    request.environmentAuthorizationId === receipt.environmentAuthorizationId &&
    request.environmentAuthorizationDigest === receipt.environmentAuthorizationDigest &&
    request.commandAuthorizationId === receipt.commandAuthorizationId &&
    request.commandAuthorizationDigest === receipt.commandAuthorizationDigest
  );
};

export const sameReadOwnership = (
  request: ReadCommandEventsRequest,
  entry: CommandRegistryEntry
): boolean => sameReceiptOwnership(request, entry);

export const sameArtifactOwnership = (
  request: ReadArtifactChunkRequest,
  entry: CommandRegistryEntry
): boolean =>
  sameReceiptOwnership(request, entry) &&
  request.artifactId === entry.spool.intent.transcriptArtifactId;

export const sameCancelOwnership = (
  request: CancelCommandRequest,
  entry: CommandRegistryEntry
): boolean => sameReceiptOwnership(request, entry);
