import { PlanDocumentSchema } from "@autostack/contracts";

import {
  buildSystemText,
  deepFreeze,
  jsonShapeText,
  pickModelAuthoredShape,
  renderPromptMessages,
  type NativePromptArtifact
} from "./prompt-artifact.js";

/**
 * The model-authored subset of `PlanDocumentSchema`: identity, the plan's own digest, and
 * provenance are supplied by the harness and are never offered to the model.
 */
const PLAN_MODEL_AUTHORED_FIELDS = [
  "summary",
  "acceptanceCriteria",
  "affectedAreas",
  "risks",
  "verificationCommands",
  "requiredPermissions",
  "requiredCredentialRefIds"
] as const;

const PLAN_SYSTEM = buildSystemText({
  role: "plan",
  mission: "Draft the implementation plan for the objective described by the delimited user input.",
  modelAuthoredFields: PLAN_MODEL_AUTHORED_FIELDS,
  jsonShape: jsonShapeText(
    pickModelAuthoredShape(PlanDocumentSchema.shape, PLAN_MODEL_AUTHORED_FIELDS)
  ),
  refusalRules: [
    "Name at least one verification command with required set to true.",
    "Declare every permission and credential reference the plan needs; never assume implicit access."
  ]
});

export const PLAN_PROMPT: NativePromptArtifact = deepFreeze({
  promptRef: "autostack.native.plan",
  version: 1,
  system: PLAN_SYSTEM,
  modelAuthoredFields: PLAN_MODEL_AUTHORED_FIELDS,
  render: (input) => renderPromptMessages(PLAN_SYSTEM, input)
});
