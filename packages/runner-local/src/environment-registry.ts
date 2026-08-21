import { randomBytes } from "node:crypto";

import { containsSensitiveMaterial, type EnvironmentId } from "@autostack/contracts";

import {
  OwnedEnvironmentRegistryError,
  normalizeEnvironmentRegistryError
} from "./environment-registry-errors.js";
import { EnvironmentRegistryLifecycle } from "./environment-registry-lifecycle.js";
import {
  EnvironmentRegistryPublications,
  type EnvironmentRegistryPublicationBoundary
} from "./environment-registry-publication.js";
import {
  isRecord,
  type EnvironmentDisposalIntentRequest,
  type EnvironmentDisposalVerificationRequest,
  type EnvironmentIntentInput,
  type EnvironmentRegistryState
} from "./environment-registry-records.js";
import { DataPathPolicy } from "./path-policy.js";

export {
  ENVIRONMENT_REGISTRY_ERROR_MESSAGES,
  EnvironmentRegistryError
} from "./environment-registry-errors.js";
export type { EnvironmentRegistryErrorCode } from "./environment-registry-errors.js";
export { ENVIRONMENT_REGISTRY_PUBLICATION_BOUNDARIES } from "./environment-registry-publication.js";
export type { EnvironmentRegistryPublicationBoundary } from "./environment-registry-publication.js";
export type {
  EnvironmentDisposalIntentRequest,
  EnvironmentDisposalVerificationRequest,
  EnvironmentIntent,
  EnvironmentIntentInput,
  EnvironmentPhase,
  EnvironmentPhaseEvidence,
  EnvironmentPhaseRequest,
  EnvironmentRegistryState
} from "./environment-registry-records.js";

export interface EnvironmentRegistryOptions {
  readonly dataRoot: string;
  readonly createAttemptId?: () => string;
  readonly now?: () => string;
  readonly onBoundary?: (boundary: EnvironmentRegistryPublicationBoundary) => Promise<void> | void;
}

export class EnvironmentRegistry {
  readonly #lifecycle: EnvironmentRegistryLifecycle;

  private constructor(lifecycle: EnvironmentRegistryLifecycle) {
    this.#lifecycle = lifecycle;
  }

  static async create(options: EnvironmentRegistryOptions): Promise<EnvironmentRegistry> {
    try {
      let dataRoot: unknown;
      let createAttemptId: unknown;
      let now: unknown;
      let onBoundary: unknown;
      try {
        if (
          !isRecord(options) ||
          !Object.hasOwn(options, "dataRoot") ||
          Object.keys(options).some(
            (key) => !["dataRoot", "createAttemptId", "now", "onBoundary"].includes(key)
          )
        ) {
          throw new TypeError();
        }
        dataRoot = options.dataRoot;
        createAttemptId = options.createAttemptId ?? (() => randomBytes(16).toString("hex"));
        now = options.now ?? (() => new Date().toISOString());
        onBoundary = options.onBoundary ?? (() => undefined);
      } catch {
        throw new OwnedEnvironmentRegistryError("invalid_input");
      }
      if (
        typeof dataRoot !== "string" ||
        containsSensitiveMaterial(dataRoot) ||
        typeof createAttemptId !== "function" ||
        typeof now !== "function" ||
        typeof onBoundary !== "function"
      ) {
        throw new OwnedEnvironmentRegistryError("invalid_input");
      }
      const paths = await DataPathPolicy.create(dataRoot);
      await paths.ensureDirectory("environments");
      await paths.ensureDirectory("environments/journal");
      const publications = new EnvironmentRegistryPublications(paths, (boundary) =>
        Reflect.apply(onBoundary, undefined, [boundary])
      );
      return new EnvironmentRegistry(
        new EnvironmentRegistryLifecycle(
          paths,
          publications,
          () => Reflect.apply(createAttemptId, undefined, []),
          () => Reflect.apply(now, undefined, [])
        )
      );
    } catch (error) {
      throw normalizeEnvironmentRegistryError(error);
    }
  }

  async recordIntent(candidate: EnvironmentIntentInput): Promise<EnvironmentRegistryState> {
    return this.#run(() => this.#lifecycle.recordIntent(candidate));
  }

  async recordWorktreeAdded(request: {
    readonly environmentId: EnvironmentId;
    readonly creationAttemptId: string;
  }): Promise<EnvironmentRegistryState> {
    return this.#run(() => this.#lifecycle.recordWorktreeAdded(request));
  }

  async recordReady(request: {
    readonly environmentId: EnvironmentId;
    readonly creationAttemptId: string;
  }): Promise<EnvironmentRegistryState> {
    return this.#run(() => this.#lifecycle.recordReady(request));
  }

  async recordDisposalIntent(
    request: EnvironmentDisposalIntentRequest
  ): Promise<EnvironmentRegistryState> {
    return this.#run(() => this.#lifecycle.recordDisposalIntent(request));
  }

  async recordDisposed(
    request: EnvironmentDisposalVerificationRequest
  ): Promise<EnvironmentRegistryState> {
    return this.#run(() => this.#lifecycle.recordDisposed(request));
  }

  async recoverEnvironment(
    environmentId: EnvironmentId
  ): Promise<EnvironmentRegistryState | undefined> {
    return this.#run(() => this.#lifecycle.recoverEnvironment(environmentId));
  }

  async recoverAll(): Promise<readonly EnvironmentRegistryState[]> {
    return this.#run(() => this.#lifecycle.recoverAll());
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeEnvironmentRegistryError(error);
    }
  }
}
