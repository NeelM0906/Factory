import {
  PlanDocumentSchema,
  ReviewReportSchema,
  digestVersionedValue,
  type ModelRouteContext,
  type RunId,
  type StationProvenance,
  type WorkItemId,
  type WorkspaceId
} from "@autostack/contracts";
import type { z } from "zod";

import {
  NATIVE_PROMPTS,
  type NativeAgentRole,
  type NativePromptArtifact
} from "../prompts/index.js";
import { pickModelAuthoredShape } from "../prompts/prompt-artifact.js";
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
}

/**
 * One native station role as DATA (plan Task 8): the engine in `native-session.ts` is generic and
 * consumes exactly this shape, so the three roles differ in what they declare, never in control
 * flow. `buildDocument`, `digestDocument`, and `admitDocument` are the role's evidence pipeline;
 * for triage they delegate to the contracts helpers via `evidence.ts`, while plan and review carry
 * the T6 placeholder digest until T9/T10 replace them the same way.
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
  buildDocument(input: NativeRoleDocumentInput): TDocument;
  digestDocument(document: TDocument): Promise<string>;
  admitDocument(document: unknown, expectedDigest: string): Promise<TDocument>;
}

/**
 * INTERNAL-ONLY digest domain for the roles whose evidence pipeline is still the T6 placeholder.
 * Plan and review keep it until T9/T10 give them their contracts digest functions; the
 * runtime-composition and conformance suites pin this domain for the review role and must keep
 * passing unchanged until then.
 */
const STRUCTURED_OUTPUT_DIGEST_DOMAIN = "autostack.native-structured-output";

interface PlaceholderRoleOptions {
  readonly role: NativeAgentRole;
  readonly stage: ModelRouteContext["stage"];
  readonly maxOutputTokens: number;
  readonly documentShape: Readonly<Record<string, z.ZodType | undefined>>;
}

/**
 * A role still on the placeholder pipeline: the "document" is the admitted model-authored value
 * unchanged, digested under the internal domain, and admitted by recomputing that same digest.
 * `requiredCapabilities` stays at the T6 interim `["structured_output"]` pin; formalizing it is
 * part of each role's own task (T9/T10), exactly as T8 formalized triage's.
 */
const placeholderRoleConfig = (options: PlaceholderRoleOptions): NativeRoleConfig => {
  const digestDocument = (document: unknown): Promise<string> =>
    digestVersionedValue(STRUCTURED_OUTPUT_DIGEST_DOMAIN, { role: options.role, document });
  return Object.freeze({
    role: options.role,
    prompt: NATIVE_PROMPTS[options.role],
    stage: options.stage,
    requiredCapabilities: Object.freeze(["structured_output"]),
    maxOutputTokens: options.maxOutputTokens,
    outputSchema: pickModelAuthoredShape(
      options.documentShape,
      NATIVE_PROMPTS[options.role].modelAuthoredFields
    ),
    buildDocument: (input: NativeRoleDocumentInput): unknown => input.modelAuthored,
    digestDocument,
    admitDocument: async (document: unknown, expectedDigest: string): Promise<unknown> => {
      if ((await digestDocument(document)) !== expectedDigest) {
        throw new TypeError("Structured output does not match the digest it was recorded under.");
      }
      return document;
    }
  });
};

/** The role registry the engine consumes: one configuration per role, exhaustive over the roles. */
export const NATIVE_ROLE_CONFIGS: Readonly<Record<NativeAgentRole, NativeRoleConfig>> =
  Object.freeze({
    triage: TRIAGE_ROLE_CONFIG,
    plan: placeholderRoleConfig({
      role: "plan",
      stage: "plan",
      maxOutputTokens: 32_768,
      documentShape: PlanDocumentSchema.shape
    }),
    review: placeholderRoleConfig({
      role: "review",
      stage: "isolated_review",
      maxOutputTokens: 16_384,
      documentShape: ReviewReportSchema.shape
    })
  });
