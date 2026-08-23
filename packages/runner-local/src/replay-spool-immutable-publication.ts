import type { DataPathPolicy } from "./path-policy.js";
import { readBounded, readBoundedInspection } from "./replay-spool-codec.js";
import { ReplaySpoolError } from "./replay-spool-error.js";
import { invokeReplaySpoolPublicationHook } from "./replay-spool-publication-hook.js";
import type { RecoveryMutationGuard } from "./replay-spool-recovery-authority.js";
import type { ReplaySpoolPublicationHook } from "./replay-spool-types.js";

export const publishImmutable = async (
  paths: DataPathPolicy,
  canonicalRelativePath: string,
  bytes: Buffer,
  attempt: string,
  publicationHook?: ReplaySpoolPublicationHook,
  mutationGuard?: RecoveryMutationGuard
): Promise<"created" | "existing"> => {
  if (!/^[0-9a-f]{32}$/.test(attempt)) throw new ReplaySpoolError("invalid_input");
  const slash = canonicalRelativePath.lastIndexOf("/");
  const parent = slash === -1 ? "." : canonicalRelativePath.slice(0, slash);
  const name = canonicalRelativePath.slice(slash + 1);
  const temporary = `${parent}/.${name}.${attempt}.tmp`;
  mutationGuard?.();
  const handle = await paths.openFile(temporary, "wx", mutationGuard === undefined);
  try {
    await invokeReplaySpoolPublicationHook(
      publicationHook,
      canonicalRelativePath,
      "temp-created",
      mutationGuard
    );
    await handle.writeFile(bytes);
    mutationGuard?.();
    await handle.sync();
  } finally {
    await handle.close();
  }
  await invokeReplaySpoolPublicationHook(
    publicationHook,
    canonicalRelativePath,
    "file-synced",
    mutationGuard
  );
  await paths.syncDirectory(parent, mutationGuard === undefined);
  await invokeReplaySpoolPublicationHook(
    publicationHook,
    canonicalRelativePath,
    "temp-directory-synced",
    mutationGuard
  );
  const linked = await paths.linkFileNoReplace(
    temporary,
    canonicalRelativePath,
    mutationGuard === undefined
  );
  if (linked) {
    await invokeReplaySpoolPublicationHook(
      publicationHook,
      canonicalRelativePath,
      "canonical-linked",
      mutationGuard
    );
    await paths.syncDirectory(parent, mutationGuard === undefined);
    await invokeReplaySpoolPublicationHook(
      publicationHook,
      canonicalRelativePath,
      "canonical-directory-synced",
      mutationGuard
    );
    if (
      !(await paths.healLinkedAlias(
        temporary,
        canonicalRelativePath,
        async () => {
          await invokeReplaySpoolPublicationHook(
            publicationHook,
            canonicalRelativePath,
            "alias-unlinked",
            mutationGuard
          );
        },
        mutationGuard === undefined
      ))
    ) {
      throw new ReplaySpoolError("unsafe_state");
    }
    await invokeReplaySpoolPublicationHook(
      publicationHook,
      canonicalRelativePath,
      "alias-directory-synced",
      mutationGuard
    );
    return "created";
  }
  const existing = await (mutationGuard === undefined ? readBounded : readBoundedInspection)(
    paths,
    canonicalRelativePath,
    bytes.byteLength + 1
  );
  if (!existing.equals(bytes)) throw new ReplaySpoolError("command_conflict");
  mutationGuard?.();
  if (!(await paths.unlinkFile(temporary, mutationGuard === undefined))) {
    throw new ReplaySpoolError("unsafe_state");
  }
  await invokeReplaySpoolPublicationHook(
    publicationHook,
    canonicalRelativePath,
    "alias-unlinked",
    mutationGuard
  );
  await paths.syncDirectory(parent, mutationGuard === undefined);
  await invokeReplaySpoolPublicationHook(
    publicationHook,
    canonicalRelativePath,
    "alias-directory-synced",
    mutationGuard
  );
  return "existing";
};
