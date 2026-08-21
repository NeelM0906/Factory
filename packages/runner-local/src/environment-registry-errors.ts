import { isArtifactStoreError } from "./artifact-types.js";
import { isPathPolicyError } from "./path-types.js";

export type EnvironmentRegistryErrorCode =
  | "invalid_input"
  | "conflicting_record"
  | "invalid_transition"
  | "maintenance_required"
  | "unsafe_state"
  | "filesystem_error";

export const ENVIRONMENT_REGISTRY_ERROR_MESSAGES = Object.freeze({
  invalid_input: "The environment registry input is invalid.",
  conflicting_record: "The environment already has conflicting durable state.",
  invalid_transition: "The environment phase transition is invalid.",
  maintenance_required: "The environment registry requires maintenance.",
  unsafe_state: "The environment registry state is unsafe.",
  filesystem_error: "The environment registry operation failed safely."
} satisfies Readonly<Record<EnvironmentRegistryErrorCode, string>>);

const ownedErrors = new WeakSet<object>();

export class EnvironmentRegistryError extends Error {
  readonly code: EnvironmentRegistryErrorCode;

  constructor(code: EnvironmentRegistryErrorCode, message: string) {
    super(message);
    this.name = "EnvironmentRegistryError";
    this.code = code;
  }
}

export class OwnedEnvironmentRegistryError extends EnvironmentRegistryError {
  constructor(code: EnvironmentRegistryErrorCode) {
    super(code, ENVIRONMENT_REGISTRY_ERROR_MESSAGES[code]);
    ownedErrors.add(this);
    Object.freeze(this);
  }
}

export const isOwnedEnvironmentRegistryError = (
  value: unknown
): value is EnvironmentRegistryError =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  ownedErrors.has(value);

export const normalizeEnvironmentRegistryError = (error: unknown): EnvironmentRegistryError => {
  if (isOwnedEnvironmentRegistryError(error)) return error;
  if (isPathPolicyError(error)) return new OwnedEnvironmentRegistryError("unsafe_state");
  if (isArtifactStoreError(error)) {
    return new OwnedEnvironmentRegistryError(
      error.code === "unsafe_state" || error.code === "integrity_mismatch"
        ? "unsafe_state"
        : "filesystem_error"
    );
  }
  return new OwnedEnvironmentRegistryError("filesystem_error");
};
