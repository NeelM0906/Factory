import type { CommandId, StoredDomainEvent } from "@autostack/contracts";

export const deriveDurableCommandCursor = (
  events: readonly StoredDomainEvent[],
  commandId: CommandId
): number => {
  let cursor = 0;
  for (const event of events) {
    if (event.type === "command.started" && event.payload.commandId === commandId) {
      cursor = Math.max(cursor, event.payload.hostSequence ?? 1);
    }
    if (event.type === "artifact.recorded" && event.payload.commandId === commandId) {
      cursor = Math.max(cursor, event.payload.hostSequence ?? 0);
    }
  }
  return cursor;
};
