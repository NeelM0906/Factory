export {
  AgentLaunchConfigSchema,
  admitExecutableWithinRoots,
  MAX_LAUNCH_ARGS,
  MAX_LAUNCH_ARG_BYTES,
  MAX_LAUNCH_ENVIRONMENT_ENTRIES,
  type AgentLaunchConfig
} from "./launch-config.js";

export {
  buildChildEnvironment,
  COMMON_ALLOWLIST,
  type ProviderAuthVariables
} from "./child-environment.js";

export {
  LineFrameReader,
  DEFAULT_MAX_LINE_BYTES,
  type FrameReaderResult,
  type LineFrameReaderOptions
} from "./line-frames.js";

export {
  ChildSession,
  type ChildSessionOptions,
  type ChildSessionEvent,
  type CloseResult
} from "./child-session.js";

export { EventSequencer } from "./event-sequencer.js";

export {
  InMemoryEvidenceSink,
  type AgentEvidenceSink
} from "./evidence-sink.js";

export { sanitizeTextField, type SanitizeOptions } from "./text-boundary.js";

export {
  FAILURE_TAXONOMY,
  classifyFailure,
  type TaxonomyCode,
  type ClassifiedFailure
} from "./failure-taxonomy.js";

export {
  classifyJsonRpcError,
  type JsonRpcError
} from "./jsonrpc-failures.js";
