import { createHash } from "node:crypto";

import { DataPathPolicy } from "./path-policy.js";
import { ReplaySpoolError } from "./replay-spool-error.js";
import { invokeReplaySpoolPublicationHook } from "./replay-spool-publication-hook.js";
import type { RecoveryMutationGuard } from "./replay-spool-recovery-authority.js";
import type { ReplaySpoolPublicationHook, TranscriptChunkEvidence } from "./replay-spool-types.js";

const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;

export const publishTranscriptImmutable = async (options: {
  readonly paths: DataPathPolicy;
  readonly canonicalRelativePath: string;
  readonly bytes: Uint8Array;
  readonly evidence: TranscriptChunkEvidence;
  readonly attempt: string;
  readonly publicationHook?: ReplaySpoolPublicationHook;
  readonly mutationGuard?: RecoveryMutationGuard;
}): Promise<void> => {
  if (!ATTEMPT_PATTERN.test(options.attempt)) throw new ReplaySpoolError("invalid_input");
  const slash = options.canonicalRelativePath.lastIndexOf("/");
  const parent = options.canonicalRelativePath.slice(0, slash);
  const name = options.canonicalRelativePath.slice(slash + 1);
  if (
    createHash("sha256").update(options.bytes).digest("hex") !== options.evidence.contentDigest ||
    options.bytes.byteLength !== options.evidence.byteSize
  ) {
    throw new ReplaySpoolError("invalid_input");
  }
  const temporary = `${parent}/.${name}.${options.evidence.contentDigest}.${options.evidence.byteSize}.${options.attempt}.tmp`;
  options.mutationGuard?.();
  const handle = await options.paths.openFile(temporary, "wx", options.mutationGuard === undefined);
  try {
    await invokeReplaySpoolPublicationHook(
      options.publicationHook,
      options.canonicalRelativePath,
      "temp-created",
      options.mutationGuard
    );
    await handle.writeFile(options.bytes);
    options.mutationGuard?.();
    await handle.sync();
  } finally {
    await handle.close();
  }
  await invokeReplaySpoolPublicationHook(
    options.publicationHook,
    options.canonicalRelativePath,
    "file-synced",
    options.mutationGuard
  );
  await options.paths.syncDirectory(parent, options.mutationGuard === undefined);
  await invokeReplaySpoolPublicationHook(
    options.publicationHook,
    options.canonicalRelativePath,
    "temp-directory-synced",
    options.mutationGuard
  );
  const linked = await options.paths.linkFileNoReplace(
    temporary,
    options.canonicalRelativePath,
    options.mutationGuard === undefined
  );
  if (!linked) throw new ReplaySpoolError("command_conflict");
  await invokeReplaySpoolPublicationHook(
    options.publicationHook,
    options.canonicalRelativePath,
    "canonical-linked",
    options.mutationGuard
  );
  await options.paths.syncDirectory(parent, options.mutationGuard === undefined);
  await invokeReplaySpoolPublicationHook(
    options.publicationHook,
    options.canonicalRelativePath,
    "canonical-directory-synced",
    options.mutationGuard
  );
  if (
    !(await options.paths.healLinkedAlias(
      temporary,
      options.canonicalRelativePath,
      async () => {
        await invokeReplaySpoolPublicationHook(
          options.publicationHook,
          options.canonicalRelativePath,
          "alias-unlinked",
          options.mutationGuard
        );
      },
      options.mutationGuard === undefined
    ))
  ) {
    throw new ReplaySpoolError("unsafe_state");
  }
  await invokeReplaySpoolPublicationHook(
    options.publicationHook,
    options.canonicalRelativePath,
    "alias-directory-synced",
    options.mutationGuard
  );
};
