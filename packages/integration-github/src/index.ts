export {
  GitHubBranchPolicyError,
  GitHubRequestError,
  classifyGitHubFailure,
  type GitHubBranchPolicyErrorOptions,
  type GitHubFailureClassification,
  type GitHubFailureCode,
  type GitHubRequestErrorOptions
} from "./errors.js";

export {
  createGitHubTransport,
  type GitHubTransport,
  type GitHubTransportOptions
} from "./client/transport.js";
