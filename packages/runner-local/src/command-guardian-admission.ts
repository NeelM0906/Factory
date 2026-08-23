import type { CommandGuardianLaunchOptions } from "./command-guardian-types.js";
import {
  digestSpawnEnvelope,
  snapshotPtySpawnRequest,
  snapshotSensitiveValues
} from "./command-spawn-envelope.js";
import { captureGuardianMethod, snapshotDataRecord } from "./command-guardian-bounds.js";

export const admitGuardianLaunchOptions = (
  options: CommandGuardianLaunchOptions
): CommandGuardianLaunchOptions => {
  const candidate = snapshotDataRecord(options, 16);
  const spool = candidate.spool as CommandGuardianLaunchOptions["spool"];
  const envelope = snapshotPtySpawnRequest(candidate.envelope as never);
  const sensitiveValues = snapshotSensitiveValues(candidate.sensitiveValues as never);
  const spawnBound = captureGuardianMethod(candidate.spawnAuthority, "spawnBound")!;
  if (
    envelope.executable !== spool.intent.executablePath ||
    candidate.timeoutMs !==
      (spool.intent.request as { readonly command: { readonly timeoutSeconds: number } }).command
        .timeoutSeconds *
        1_000 ||
    candidate.cancellationGraceMs !== spool.intent.limits.cancellationGraceMs ||
    candidate.eofSettleMs !== spool.intent.limits.eofSettleMs ||
    digestSpawnEnvelope({
      request: spool.intent.request as never,
      envelope,
      executableIdentityDigest: spool.intent.executableIdentityDigest,
      cwdIdentityDigest: spool.intent.cwdIdentityDigest,
      sensitiveValues
    }) !== spool.intent.spawnEnvelopeDigest
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(candidate as unknown as CommandGuardianLaunchOptions),
    envelope,
    sensitiveValues,
    spawnAuthority: Object.freeze({
      spawnBound: spawnBound as CommandGuardianLaunchOptions["spawnAuthority"]["spawnBound"]
    })
  });
};
