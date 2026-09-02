export {
  ClaudeHarness,
  type ClaudeHarnessOptions
} from "./claude-harness.js";

export {
  buildStreamingProfile,
  buildBatchProfile,
  CLAUDE_AUTH_VARIABLES,
  type ClaudeLaunchProfile,
  type StreamingProfileOptions,
  type BatchProfileOptions
} from "./claude-launch-profile.js";

export {
  mapClaudeFrame,
  type ClaudeMapperContext
} from "./claude-event-mapper.js";

export {
  classifyClaudeFailure,
  type ClaudeFailureInput,
  type ClassifiedClaudeFailure
} from "./claude-failures.js";

export {
  classifyClaudeFrame,
  ClaudeSystemInitFrameSchema,
  ClaudeAssistantFrameSchema,
  ClaudeUserFrameSchema,
  ClaudeResultFrameSchema,
  ClaudePermissionRequestSchema
} from "./claude-frames.js";

export {
  probeClaudeAvailability,
  type AvailabilityResult,
  type AvailabilityProbeOptions
} from "./availability.js";
