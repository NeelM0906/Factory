import type { CommandGuardianProtocolRuntime } from "./command-guardian-child-runtime.js";

export interface CommandGuardianChildRetentionAudit {
  transientCleared: boolean;
  guardianCleared: boolean;
}

const controls = new WeakMap<CommandGuardianProtocolRuntime, CommandGuardianChildRetentionAudit>();

export const registerCommandGuardianChildRuntime = (
  runtime: CommandGuardianProtocolRuntime,
  audit: CommandGuardianChildRetentionAudit
): void => {
  controls.set(runtime, audit);
};

export const inspectCommandGuardianChildRuntime = (
  runtime: CommandGuardianProtocolRuntime
): Readonly<CommandGuardianChildRetentionAudit> => {
  const audit = controls.get(runtime);
  if (audit === undefined) throw new TypeError("Guardian child runtime is unavailable.");
  return Object.freeze({
    transientCleared: audit.transientCleared,
    guardianCleared: audit.guardianCleared
  });
};
