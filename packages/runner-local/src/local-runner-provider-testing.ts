import {
  createLocalRunnerProviderFromTestComponents,
  type LocalRunnerProvider,
  type LocalRunnerProviderTestComponents
} from "./local-runner-provider.js";

/** Package-private deterministic composition seam; absent from the package entry export. */
export const createLocalRunnerProviderForTesting = (
  components: LocalRunnerProviderTestComponents
): LocalRunnerProvider => createLocalRunnerProviderFromTestComponents(components);
