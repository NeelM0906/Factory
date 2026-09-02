import { ReviewReportSchema } from "@autostack/contracts";

import {
  buildSystemText,
  deepFreeze,
  jsonShapeText,
  pickModelAuthoredShape,
  renderPromptMessages,
  type NativePromptArtifact
} from "./prompt-artifact.js";

/**
 * The model-authored subset of `ReviewReportSchema`: identity, the digests of the upstream
 * evidence under review, and provenance are supplied by the harness and are never offered to the
 * model.
 */
const REVIEW_MODEL_AUTHORED_FIELDS = ["verdict", "summary", "findings"] as const;

const REVIEW_SYSTEM = buildSystemText({
  role: "review",
  mission:
    "Review the prepared change described by the delimited user input and issue a verdict backed by findings.",
  modelAuthoredFields: REVIEW_MODEL_AUTHORED_FIELDS,
  jsonShape: jsonShapeText(
    pickModelAuthoredShape(ReviewReportSchema.shape, REVIEW_MODEL_AUTHORED_FIELDS)
  ),
  refusalRules: [
    "An approved verdict may not coexist with any critical or high severity finding.",
    "Never reuse a findingRef across findings."
  ]
});

export const REVIEW_PROMPT: NativePromptArtifact = deepFreeze({
  promptRef: "autostack.native.review",
  version: 1,
  system: REVIEW_SYSTEM,
  modelAuthoredFields: REVIEW_MODEL_AUTHORED_FIELDS,
  render: (input) => renderPromptMessages(REVIEW_SYSTEM, input)
});
