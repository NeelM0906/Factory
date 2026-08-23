import { randomBytes } from "node:crypto";

import { CommandIdSchema } from "@autostack/contracts";

import { DataPathPolicy } from "./path-policy.js";
import {
  MAXIMUM_INTENT_BYTES,
  commandComponent,
  parseCanonicalFile,
  parseIntentReceipt
} from "./replay-spool-codec.js";
import { isReplaySpoolError, ReplaySpoolError } from "./replay-spool-error.js";
import type { CommandIntentReceipt, ReplaySpoolOpenOptions } from "./replay-spool-types.js";

export interface PreparedReplaySpoolOpen {
  readonly paths: DataPathPolicy;
  readonly commandRoot: string;
  readonly receipt: CommandIntentReceipt;
  readonly createAttemptId: () => string;
}

export const prepareReplaySpoolOpen = async (
  options: ReplaySpoolOpenOptions
): Promise<PreparedReplaySpoolOpen> => {
  try {
    const commandId = CommandIdSchema.parse(options.commandId);
    const dataRoot = options.dataRoot;
    const source = options.createAttemptId ?? (() => randomBytes(16).toString("hex"));
    if (typeof dataRoot !== "string" || typeof source !== "function") throw new TypeError();
    const createAttemptId = () => Reflect.apply(source, undefined, []) as string;
    const commandRoot = `commands/${commandComponent(commandId)}`;
    const paths = await DataPathPolicy.create(dataRoot);
    const intentRelativePath = `${commandRoot}/receipt/01-intent.json`;
    if (!(await paths.fileExists(intentRelativePath, false))) {
      throw new ReplaySpoolError("maintenance_required");
    }
    const receipt = await parseCanonicalFile(
      paths,
      intentRelativePath,
      MAXIMUM_INTENT_BYTES,
      parseIntentReceipt
    );
    if (receipt.commandId !== commandId) throw new ReplaySpoolError("maintenance_required");
    return Object.freeze({ paths, commandRoot, receipt, createAttemptId });
  } catch (error) {
    if (isReplaySpoolError(error)) throw error;
    throw new ReplaySpoolError("maintenance_required");
  }
};
