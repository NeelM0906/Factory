// `ApiAuthenticationError` and `ApiResponseError` are defined in `api-client.ts` and re-exported
// here so callers have one import site for every AutoStack API client error. Their definitions
// stay in `api-client.ts` — this module does not own them.
export { ApiAuthenticationError, ApiResponseError } from "./api-client.js";

/**
 * A 409 from the approval-decision route — either `version_conflict` (a stale `evidenceDigest`)
 * or `idempotency_conflict` (a conflicting decision already recorded on the same approval).
 *
 * D2: these two cases are indistinguishable to the UI by design and must stay that way — "the
 * evidence changed, review again" is the only message either one produces. This type therefore
 * carries no error code and no other data one could branch on; it is a marker class only.
 */
export class ApiConflictError extends Error {
  constructor() {
    super("The evidence changed — review again.");
    this.name = "ApiConflictError";
  }
}

/**
 * A request schema rejected the input locally, before any network call was made. `field` names
 * the offending property; the message never contains the offending value, because that value may
 * itself be the credential material the schema rejected.
 */
export class ApiRequestValidationError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`The "${field}" field failed request validation.`);
    this.name = "ApiRequestValidationError";
    this.field = field;
  }
}

/**
 * D1: the desktop bridge cannot reach this operation. `DesktopApiOperationMap`
 * (`packages/contracts/src/desktop-api.ts:162-204`) has no `factory.approvals.*`,
 * `factory.runs.steer`, or `factory.runs.cancel` member — the operations land in contracts 0.12.
 * Carries the operation name and nothing else: no fake data, no silent no-op.
 */
export class ApiOperationUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`The "${operation}" operation is not available on this build.`);
    this.name = "ApiOperationUnavailableError";
    this.operation = operation;
  }
}
