import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, type CommitRequest, type CommitResult } from "@autostack/domain";

import { decodeCommitResult, encodeCommitResult } from "./codecs.js";

type Row = Readonly<Record<string, unknown>>;

export type IdempotencyBinding =
  | { readonly kind: "commit"; readonly requestDigest?: string }
  | {
      readonly kind: "job_completion";
      readonly jobId: string;
      readonly leaseDigest: string;
      readonly requestDigest: string;
    };

export interface IdempotencyRecord {
  readonly result: CommitResult;
  readonly binding: IdempotencyBinding;
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new TypeError(`${field} is not text.`);
  return value;
};

const nullableText = (value: unknown, field: string): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return text(value, field);
};

export const digestText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const digestCommitRequest = (request: CommitRequest): string =>
  digestText(canonicalJson({ appends: request.appends, jobs: request.jobs }));

export class IdempotencyStore {
  readonly #connection: DatabaseSync;
  readonly #now: () => string;

  constructor(connection: DatabaseSync, now: () => string) {
    this.#connection = connection;
    this.#now = now;
  }

  find(scope: string, key: string): IdempotencyRecord | null {
    if (scope.trim() === "" || key.trim() === "") {
      throw new TypeError("Idempotency scope and key must be non-empty.");
    }
    const row = this.#connection
      .prepare(
        `SELECT result_json, operation_kind, completion_job_id,
                completion_lease_digest, completion_request_digest, commit_request_digest
         FROM idempotency_records WHERE scope = ? AND key = ?`
      )
      .get(scope, key) as Row | undefined;
    if (row === undefined) return null;
    const result = decodeCommitResult(text(row.result_json, "result_json"));
    const operationKind = text(row.operation_kind, "operation_kind");
    if (operationKind === "commit") {
      const requestDigest = nullableText(row.commit_request_digest, "commit_request_digest");
      return {
        result,
        binding:
          requestDigest === undefined ? { kind: "commit" } : { kind: "commit", requestDigest }
      };
    }
    if (operationKind !== "job_completion") {
      throw new TypeError("The stored idempotency operation kind is invalid.");
    }
    return {
      result,
      binding: {
        kind: "job_completion",
        jobId: text(row.completion_job_id, "completion_job_id"),
        leaseDigest: text(row.completion_lease_digest, "completion_lease_digest"),
        requestDigest: text(row.completion_request_digest, "completion_request_digest")
      }
    };
  }

  save(scope: string, key: string, result: CommitResult, binding: IdempotencyBinding): void {
    this.#connection
      .prepare(
        `INSERT INTO idempotency_records (
           scope, key, result_json, created_at, operation_kind,
           completion_job_id, completion_lease_digest, completion_request_digest,
           commit_request_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        scope,
        key,
        encodeCommitResult(result),
        this.#now(),
        binding.kind,
        binding.kind === "job_completion" ? binding.jobId : null,
        binding.kind === "job_completion" ? binding.leaseDigest : null,
        binding.kind === "job_completion" ? binding.requestDigest : null,
        binding.kind === "commit" ? (binding.requestDigest ?? null) : null
      );
  }
}
