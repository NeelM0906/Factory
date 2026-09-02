export {
  createCorrelation,
  currentCorrelation,
  parseTraceparent,
  serializeTraceparent,
  withCorrelation,
  type CorrelationContext,
  type CreateCorrelationOptions,
  type IdFactory,
  type TraceparentFields
} from "./correlation.js";

export { safeAttributes, type AttributeValue, type Attributes } from "./attributes.js";
