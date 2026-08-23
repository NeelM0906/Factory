import { isAbsolute, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import type { CommandId } from "@autostack/contracts";

import { assertLiveCommandGuardianLease, type CommandGuardianLease } from "./data-root-lock.js";
import { ReplaySpoolError } from "./replay-spool-error.js";
import type { ReplaySpool } from "./replay-spool.js";

export type RecoveryMutationGuard = () => void;
export interface AdmittedRecoverySpoolAuthority {
  readonly canonicalRoot: string;
  readonly guard: RecoveryMutationGuard;
  readonly operations: RecoverySpoolOperations;
}

export interface RecoverySpoolOperations {
  readonly intent: ReplaySpool["intent"];
  readonly recover: ReplaySpool["recover"];
  readonly appendEvent: ReplaySpool["appendEvent"];
  readonly recordPhase: ReplaySpool["recordPhase"];
}

interface RecoverySpoolAuthority {
  readonly canonicalRoot: string;
  readonly commandId: CommandId;
  readonly lease: CommandGuardianLease;
  readonly guard: RecoveryMutationGuard;
  readonly operations: RecoverySpoolOperations;
}

const authorities = new WeakMap<object, RecoverySpoolAuthority>();

export const brandRecoverySpool = (
  spool: ReplaySpool,
  canonicalRoot: string,
  commandId: CommandId,
  lease: CommandGuardianLease
): RecoveryMutationGuard => {
  if (authorities.has(spool)) throw new ReplaySpoolError("maintenance_required");
  const guard = (): void => assertLiveCommandGuardianLease(lease, canonicalRoot, commandId);
  guard();
  const recover = spool.recover;
  const appendEvent = spool.appendEvent;
  const recordPhase = spool.recordPhase;
  const operations = Object.freeze({
    intent: spool.intent,
    recover: () => Reflect.apply(recover, spool, []),
    appendEvent: (...args: Parameters<ReplaySpool["appendEvent"]>) =>
      Reflect.apply(appendEvent, spool, args),
    recordPhase: (...args: Parameters<ReplaySpool["recordPhase"]>) =>
      Reflect.apply(recordPhase, spool, args)
  });
  authorities.set(spool, Object.freeze({ canonicalRoot, commandId, lease, guard, operations }));
  return guard;
};

export const admitRecoverySpool = async (options: {
  readonly spool: unknown;
  readonly dataRoot: unknown;
  readonly commandId: unknown;
  readonly lease: unknown;
}): Promise<AdmittedRecoverySpoolAuthority> => {
  const candidate = options.spool;
  const authority =
    (typeof candidate === "object" && candidate !== null) || typeof candidate === "function"
      ? authorities.get(candidate)
      : undefined;
  if (
    authority === undefined ||
    typeof options.dataRoot !== "string" ||
    !isAbsolute(options.dataRoot) ||
    options.commandId !== authority.commandId ||
    options.lease !== authority.lease
  ) {
    throw new ReplaySpoolError("maintenance_required");
  }
  try {
    if ((await realpath(resolve(options.dataRoot))) !== authority.canonicalRoot) {
      throw new TypeError();
    }
    authority.guard();
  } catch {
    throw new ReplaySpoolError("maintenance_required");
  }
  return Object.freeze({
    canonicalRoot: authority.canonicalRoot,
    guard: authority.guard,
    operations: authority.operations
  });
};
