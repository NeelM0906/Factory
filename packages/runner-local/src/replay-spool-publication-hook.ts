import type { RecoveryMutationGuard } from "./replay-spool-recovery-authority.js";
import type {
  ReplaySpoolPublicationHook,
  ReplaySpoolPublicationStage
} from "./replay-spool-types.js";

export const invokeReplaySpoolPublicationHook = async (
  hook: ReplaySpoolPublicationHook | undefined,
  relativePath: string,
  stage: ReplaySpoolPublicationStage,
  mutationGuard: RecoveryMutationGuard | undefined
): Promise<void> => {
  mutationGuard?.();
  await hook?.(relativePath, stage);
  mutationGuard?.();
};
