import { createHash } from "node:crypto";

import type { SessionEventTemplate } from "@autostack/agent-runtime";
import { RelativeWorkspacePathSchema, redactSensitiveText } from "@autostack/contracts";

import { isPathInScope, type ContextScope } from "./context-scope.js";
import { NativeAgentError } from "./errors.js";

/** The native harness's view of the workspace: listing and reading, nothing else. */
export interface NativeContextReader {
  list(request: { readonly prefix: string }): Promise<readonly string[]>;
  read(request: { readonly path: string }): Promise<string>;
}

/** One choice offered to the permission decider for an out-of-scope read. */
export interface OutOfScopePermissionOption {
  readonly optionId: string;
  readonly kind: "allow_once" | "deny_once";
  readonly label: string;
}

/** The out-of-scope read put to the permission decider, with its option pair. */
export interface OutOfScopeRead {
  readonly path: string;
  readonly permissionRef: string;
  readonly options: readonly OutOfScopePermissionOption[];
}

export interface ContextAssemblyDeps {
  readonly reader: NativeContextReader;
  readonly emit: (template: SessionEventTemplate) => void;
  /** Absent when the configuration is unpermissioned; an out-of-scope read is then denied. */
  readonly requestPermission?: (request: OutOfScopeRead) => Promise<"allow" | "deny">;
  readonly limits: { readonly maxFiles: number; readonly maxBytes: number };
  /** Injected stable-ref factory minting toolCallRefs and permissionRefs; no ambient randomness. */
  readonly newRef: () => string;
}

/** One file admitted into the context; `content` has already passed `redactSensitiveText`. */
export interface AssembledContextFile {
  readonly path: string;
  readonly content: string;
}

export type ContextOmissionReason = "out_of_scope_denied" | "out_of_scope_unpermissioned";

/** A path left out by the permission gate, recorded so the prompt can say context is partial. */
export interface ContextOmission {
  readonly path: string;
  readonly reason: ContextOmissionReason;
}

export type ContextTruncationReason = "max_files" | "max_bytes";

/** A path dropped by the size bounds, recorded so the prompt can say context is partial. */
export interface ContextTruncation {
  readonly path: string;
  readonly reason: ContextTruncationReason;
}

export interface AssembledContext {
  readonly files: readonly AssembledContextFile[];
  readonly omissions: readonly ContextOmission[];
  readonly truncations: readonly ContextTruncation[];
}

export interface ContextAssemblyRequest {
  readonly paths: readonly string[];
  readonly scope: ContextScope;
  readonly deps: ContextAssemblyDeps;
}

/**
 * INTERNAL-ONLY evidence binder: the bare sha-256 of the requested path, binding the permission
 * request to the read it gates. It is never recomputed or verified outside this package; if it
 * ever crosses a package boundary it must move to `digestVersionedValue` with a named domain.
 */
const outOfScopeEvidenceDigest = (path: string): string =>
  createHash("sha256").update(path, "utf8").digest("hex");

/**
 * Every requested path is validated BEFORE any read — the reader is never the security boundary.
 * One invalid path fails the whole assembly closed: nothing in the batch is read at all.
 */
const assertRelativeWorkspacePaths = (paths: readonly string[]): void => {
  for (const path of paths) {
    const parsed = RelativeWorkspacePathSchema.safeParse(path);
    if (!parsed.success) {
      throw new NativeAgentError("native_context_unavailable", parsed.error);
    }
  }
};

/**
 * Puts an out-of-scope read to the permission decider and blocks until the decision. With no
 * decider configured, the read is denied deterministically with NO permission events — the
 * unpermissioned configuration never prompts and never waits. A denial is a normal outcome.
 */
const gateOutOfScopeRead = async (
  deps: ContextAssemblyDeps,
  path: string
): Promise<"allow" | ContextOmissionReason> => {
  const { requestPermission, emit, newRef } = deps;
  if (requestPermission === undefined) return "out_of_scope_unpermissioned";
  const permissionRef = newRef();
  const allowOption: OutOfScopePermissionOption = {
    optionId: `${permissionRef}/allow_once`,
    kind: "allow_once",
    label: "Allow this out-of-scope read once"
  };
  const denyOption: OutOfScopePermissionOption = {
    optionId: `${permissionRef}/deny_once`,
    kind: "deny_once",
    label: "Deny this out-of-scope read"
  };
  emit({
    type: "permission_requested",
    permissionRef,
    summary: `Out-of-scope context read requested for ${path}.`,
    evidenceDigest: outOfScopeEvidenceDigest(path)
  });
  const decision = await requestPermission({
    path,
    permissionRef,
    options: [allowOption, denyOption]
  });
  emit({
    type: "permission_resolved",
    permissionRef,
    selectedOptionId: decision === "allow" ? allowOption.optionId : denyOption.optionId
  });
  return decision === "allow" ? "allow" : "out_of_scope_denied";
};

/**
 * Reads one file under `tool_call` evidence: `started` then `completed` share one injected ref;
 * a rejecting reader emits `failed` on the same ref and fails the assembly closed as
 * `native_context_unavailable`, with the reader's rejection attached as the non-enumerable cause.
 */
const readWithToolCallEvidence = async (
  deps: ContextAssemblyDeps,
  path: string
): Promise<string> => {
  const toolCallRef = deps.newRef();
  deps.emit({ type: "tool_call", toolCallRef, name: "read_file", phase: "started", detail: path });
  try {
    const content = await deps.reader.read({ path });
    deps.emit({
      type: "tool_call",
      toolCallRef,
      name: "read_file",
      phase: "completed",
      detail: path
    });
    return content;
  } catch (cause) {
    deps.emit({ type: "tool_call", toolCallRef, name: "read_file", phase: "failed", detail: path });
    throw new NativeAgentError("native_context_unavailable", cause);
  }
};

/**
 * Assembles bounded, redacted role context. Paths are processed in SORTED order (code-unit sort,
 * never request or reader order), so two runs over the same reader produce byte-identical
 * context. `maxFiles` bounds actual reads; the first file whose redacted UTF-8 size would exceed
 * `maxBytes` is truncated along with everything after it in sorted order, unread.
 */
export const assembleContext = async (
  request: ContextAssemblyRequest
): Promise<AssembledContext> => {
  const { deps, scope } = request;
  assertRelativeWorkspacePaths(request.paths);
  const sortedPaths = [...request.paths].sort();
  const files: AssembledContextFile[] = [];
  const omissions: ContextOmission[] = [];
  const truncations: ContextTruncation[] = [];
  let readCount = 0;
  let totalBytes = 0;
  let bytesExhausted = false;
  for (const path of sortedPaths) {
    if (bytesExhausted) {
      truncations.push({ path, reason: "max_bytes" });
      continue;
    }
    if (readCount >= deps.limits.maxFiles) {
      truncations.push({ path, reason: "max_files" });
      continue;
    }
    if (!isPathInScope(scope, path)) {
      const outcome = await gateOutOfScopeRead(deps, path);
      if (outcome !== "allow") {
        omissions.push({ path, reason: outcome });
        continue;
      }
    }
    const rawContent = await readWithToolCallEvidence(deps, path);
    readCount += 1;
    const content = redactSensitiveText(rawContent);
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (totalBytes + contentBytes > deps.limits.maxBytes) {
      bytesExhausted = true;
      truncations.push({ path, reason: "max_bytes" });
      continue;
    }
    totalBytes += contentBytes;
    files.push({ path, content });
  }
  return { files, omissions, truncations };
};
