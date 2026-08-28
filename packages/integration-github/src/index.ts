export {
  GitHubBranchConflictError,
  GitHubBranchPolicyError,
  GitHubRequestError,
  classifyGitHubFailure,
  type GitHubBranchConflictErrorOptions,
  type GitHubBranchPolicyErrorOptions,
  type GitHubFailureClassification,
  type GitHubFailureCode,
  type GitHubRequestErrorOptions
} from "./errors.js";

export { assertAutoStackBranch } from "./branch-policy.js";

export {
  createBranchRefsClient,
  type CreateBranchRequest,
  type DeleteBranchRequest,
  type GetRefRequest,
  type GitHubBranchRefsClient,
  type PutFileOnBranchRequest,
  type PutFileOnBranchResult
} from "./client/branch-refs.js";

export {
  createGitHubTransport,
  type GitHubTransport,
  type GitHubTransportOptions
} from "./client/transport.js";

export {
  type GitHubAuthDescription,
  type GitHubAuthKind,
  type GitHubAuthorizationOptions,
  type GitHubAuthStrategy
} from "./auth/types.js";

export { createUserTokenAuth, type CreateUserTokenAuthOptions } from "./auth/user-token.js";

export {
  createAppInstallationAuth,
  type CreateAppInstallationAuthOptions
} from "./auth/app-installation.js";
