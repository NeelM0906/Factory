import type {
  AgentInvocationRequest,
  ModelRouteContext,
  RunId,
  StationProvenance,
  WorkItemId,
  WorkspaceId
} from "@autostack/contracts";
import type { z } from "zod";

import type { NativeAgentFailure } from "../errors.js";
import type { NativeAgentRole, NativePromptArtifact } from "../prompts/index.js";
import { PLAN_ROLE_CONFIG } from "./plan-role.js";
import { REVIEW_ROLE_CONFIG } from "./review-role.js";
import type { NativeRoleInputs } from "./role-inputs.js";
import { TRIAGE_ROLE_CONFIG } from "./triage-role.js";

/** The document identity the harness owns; the model never authors any of these (spec §14.1). */
export interface NativeRoleDocumentIdentity {
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId;
  readonly runId: RunId;
}

/** Everything a role needs to turn an admitted model response into its station document. */
export interface NativeRoleDocumentInput {
  readonly identity: NativeRoleDocumentIdentity;
  /** The model-authored fields, already admitted through the role's narrowed output schema. */
  readonly modelAuthored: unknown;
  readonly producedAt: string;
  readonly producedBy: StationProvenance;
  /**
   * The ADMITTED role inputs (T10): present when the role declares `admitRoleInputs`, so a
   * builder that binds its document to upstream evidence reads the admitted documents and never
   * the provider's raw ones.
   */
  readonly roleInputs?: NativeRoleInputs;
}

/** The `plan` detail event a role's admitted document announces (contract: `{planDigest, summary}`). */
export interface NativeRolePlanEvent {
  readonly planDigest: string;
  readonly summary: string;
}

/**
 * One native station role as DATA (plan Task 8): the engine in `native-session.ts` is generic and
 * consumes exactly this shape, so the three roles differ in what they declare, never in control
 * flow. `buildDocument`, `digestDocument`, and `admitDocument` are the role's evidence pipeline,
 * delegating to the contracts helpers via `evidence.ts` for all three roles (T8-T10).
 *
 * The document-handling members are declared as methods deliberately: method parameter bivariance
 * is what lets `NativeRoleConfig<TriageReport>` sit in a `Record` of `NativeRoleConfig<unknown>`
 * without a cast, and the engine only ever feeds a config documents that config itself built.
 * Converting them to arrow-function properties makes the registry assignment a LOUD compile error
 * (strict function-property variance) — do not "tidy" them into properties.
 */
export interface NativeRoleConfig<TDocument = unknown> {
  readonly role: NativeAgentRole;
  readonly prompt: NativePromptArtifact;
  /** The station stage this role bills its model routing under. */
  readonly stage: ModelRouteContext["stage"];
  readonly requiredCapabilities: readonly string[];
  readonly maxOutputTokens: number;
  /** The model-authored subset of the role's document schema; identity is never offered. */
  readonly outputSchema: z.ZodType;
  /**
   * Pre-model admission of the provider's inputs (T10): awaited by the engine AFTER
   * `roleInputs.forInvocation` and BEFORE prompt render, route resolution, and the model call.
   * Returns the ADMITTED inputs the rest of the session runs on; any rejection fails the session
   * closed as `native_context_unavailable` with zero inference calls — unadmitted evidence is
   * unavailable context, never a model fault.
   */
  admitRoleInputs?(
    inputs: NativeRoleInputs,
    invocation: AgentInvocationRequest
  ): Promise<NativeRoleInputs>;
  /**
   * May return a promise (T9 lead ruling): the plan document carries a self-`planDigest` the
   * builder must compute with the async contracts digest helper before the document exists, so
   * the engine awaits every build. Triage's synchronous return stays assignable.
   */
  buildDocument(input: NativeRoleDocumentInput): TDocument | Promise<TDocument>;
  digestDocument(document: TDocument): Promise<string>;
  admitDocument(document: unknown, expectedDigest: string): Promise<TDocument>;
  /**
   * Invocation-scoped admission the static `outputSchema` cannot express (e.g. the plan role's
   * credential scoping against the invocation's authorized `credentialRefIds`, or the review
   * role's finding-location scoping against the admitted inputs' reviewed-diff paths — the third
   * parameter, added by T10; triage and plan ignore it). Runs after structured-output admission
   * and BEFORE any echo, evidence, or detail event exists; a returned failure terminates the
   * session `failed` with exactly that code and nothing else is emitted.
   */
  validateModelAuthored?(
    modelAuthored: unknown,
    invocation: AgentInvocationRequest,
    roleInputs?: NativeRoleInputs
  ): NativeAgentFailure | undefined;
  /**
   * The `plan` detail event this role's ADMITTED document announces. Declared only by the plan
   * role — presence of the method is the signal, so the engine stays role-agnostic control flow
   * and the roles differ in data.
   */
  planEvent?(document: TDocument): NativeRolePlanEvent;
}

/** The role registry the engine consumes: one configuration per role, exhaustive over the roles. */
export const NATIVE_ROLE_CONFIGS: Readonly<Record<NativeAgentRole, NativeRoleConfig>> =
  Object.freeze({
    triage: TRIAGE_ROLE_CONFIG,
    plan: PLAN_ROLE_CONFIG,
    review: REVIEW_ROLE_CONFIG
  });
