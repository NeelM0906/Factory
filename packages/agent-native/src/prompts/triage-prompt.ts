import { TriageReportSchema } from "@autostack/contracts";

import {
  buildSystemText,
  deepFreeze,
  jsonShapeText,
  pickModelAuthoredShape,
  renderPromptMessages,
  type NativePromptArtifact
} from "./prompt-artifact.js";

/**
 * The model-authored subset of `TriageReportSchema`: identity and provenance fields are supplied
 * by the harness and are never offered to the model.
 */
const TRIAGE_MODEL_AUTHORED_FIELDS = [
  "taskType",
  "priority",
  "complexity",
  "actionable",
  "rationale",
  "duplicates",
  "clarificationRef"
] as const;

const TRIAGE_SYSTEM = buildSystemText({
  role: "triage",
  mission:
    "Classify the task described by the delimited user input and judge whether it is actionable.",
  modelAuthoredFields: TRIAGE_MODEL_AUTHORED_FIELDS,
  jsonShape: jsonShapeText(
    pickModelAuthoredShape(TriageReportSchema.shape, TRIAGE_MODEL_AUTHORED_FIELDS)
  ),
  refusalRules: [
    "Never report the same duplicate reference twice.",
    "When the task cannot be acted on, set actionable to false and name a clarificationRef instead of guessing."
  ]
});

export const TRIAGE_PROMPT: NativePromptArtifact = deepFreeze({
  promptRef: "autostack.native.triage",
  version: 1,
  system: TRIAGE_SYSTEM,
  modelAuthoredFields: TRIAGE_MODEL_AUTHORED_FIELDS,
  render: (input) => renderPromptMessages(TRIAGE_SYSTEM, input)
});
