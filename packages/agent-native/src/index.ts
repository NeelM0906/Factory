export {
  assembleContext,
  type AssembledContext,
  type AssembledContextFile,
  type ContextAssemblyDeps,
  type ContextAssemblyRequest,
  type ContextOmission,
  type ContextOmissionReason,
  type ContextTruncation,
  type ContextTruncationReason,
  type NativeContextReader,
  type OutOfScopePermissionOption,
  type OutOfScopeRead
} from "./context-assembly.js";
export { isPathInScope, type ContextScope } from "./context-scope.js";
export {
  admitPlanEvidence,
  admitTriageEvidence,
  digestPlanEvidence,
  digestTriageEvidence
} from "./evidence.js";
export {
  NATIVE_AGENT_FAILURES,
  NativeAgentError,
  type NativeAgentFailure,
  type NativeAgentFailureCode
} from "./errors.js";
export {
  classifyThrowable,
  MODEL_ROUTING_FAILURE_CLASSIFICATIONS,
  type ModelRoutingClassificationEntry
} from "./failure-classification.js";
export {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeContextConfig,
  type NativeHarnessConfig,
  type NativeHarnessDeps,
  type NativeRoleInput,
  type NativeRoleInputsProvider
} from "./native-harness.js";
export {
  NATIVE_ROLE_CONFIGS,
  type NativeRoleConfig,
  type NativeRoleDocumentIdentity,
  type NativeRoleDocumentInput,
  type NativeRolePlanEvent
} from "./roles/role-config.js";
export { PLAN_ROLE_CONFIG } from "./roles/plan-role.js";
export { TRIAGE_ROLE_CONFIG } from "./roles/triage-role.js";
export {
  admitStructuredOutput,
  type StructuredOutputOutcome,
  type StructuredOutputPolicy,
  type StructuredOutputRequest
} from "./structured-output.js";
