export {
  SlackRequestError,
  classifySlackFailure,
  type SlackFailureClassification,
  type SlackFailureClassificationInput,
  type SlackFailureCode,
  type SlackRequestErrorOptions
} from "./errors.js";
export { verifySlackSignature, type VerifySlackSignatureInput } from "./http/signature.js";
