import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RelativeWorkspacePathSchema, redactSensitiveText } from "@autostack/contracts";
import type { SessionEventTemplate } from "@autostack/agent-runtime";

import { NativeAgentError } from "../src/errors.js";
import {
  assembleContext,
  type AssembledContext,
  type ContextAssemblyDeps,
  type NativeContextReader,
  type OutOfScopeRead
} from "../src/context-assembly.js";
import { isPathInScope, type ContextScope } from "../src/context-scope.js";

type ToolCallTemplate = Extract<SessionEventTemplate, { readonly type: "tool_call" }>;
type PermissionRequestedTemplate = Extract<
  SessionEventTemplate,
  { readonly type: "permission_requested" }
>;
type PermissionResolvedTemplate = Extract<
  SessionEventTemplate,
  { readonly type: "permission_resolved" }
>;

/** AWS-access-key shaped: the `AKIA` + 16 upper-alphanumeric spec in KNOWN_CREDENTIAL_SPECS. */
const AWS_KEY_SHAPED = `AKIA${"B".repeat(16)}`;

const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };

const DEFAULT_LIMITS = { maxFiles: 10, maxBytes: 100_000 } as const;

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Yields the macrotask queue so pending microtasks (reads, emits) settle before we assert. */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

interface ScriptedReader {
  readonly reader: NativeContextReader;
  readonly readCalls: readonly string[];
}

/** Call-logging fake reader: per-path scripted content, with selected paths scripted to reject. */
const scriptReader = (
  files: Readonly<Record<string, string>>,
  failingPaths: readonly string[] = []
): ScriptedReader => {
  const readCalls: string[] = [];
  const reader: NativeContextReader = {
    list: (request) =>
      Promise.resolve(
        Object.keys(files)
          .filter((path) => path.startsWith(request.prefix))
          .sort()
      ),
    read: (request) => {
      readCalls.push(request.path);
      if (failingPaths.includes(request.path)) {
        return Promise.reject(new Error(`scripted read failure for ${request.path}`));
      }
      const content = files[request.path];
      return content === undefined
        ? Promise.reject(new Error(`scripted reader has no file at ${request.path}`))
        : Promise.resolve(content);
    }
  };
  return { reader, readCalls };
};

interface ScriptedRefs {
  readonly newRef: () => string;
  readonly minted: readonly string[];
}

/** Deterministic injected ref factory; `minted` records every ref it ever produced. */
const scriptRefs = (): ScriptedRefs => {
  const minted: string[] = [];
  const newRef = (): string => {
    const ref = `test-ref-${String(minted.length + 1)}`;
    minted.push(ref);
    return ref;
  };
  return { newRef, minted };
};

interface Harness {
  readonly deps: ContextAssemblyDeps;
  readonly events: readonly SessionEventTemplate[];
  readonly readCalls: readonly string[];
  readonly minted: readonly string[];
}

const harness = (options: {
  readonly files: Readonly<Record<string, string>>;
  readonly failingPaths?: readonly string[];
  readonly requestPermission?: (request: OutOfScopeRead) => Promise<"allow" | "deny">;
  readonly limits?: ContextAssemblyDeps["limits"];
}): Harness => {
  const { reader, readCalls } = scriptReader(options.files, options.failingPaths ?? []);
  const { newRef, minted } = scriptRefs();
  const events: SessionEventTemplate[] = [];
  const deps: ContextAssemblyDeps = {
    reader,
    emit: (template) => {
      events.push(template);
    },
    limits: options.limits ?? DEFAULT_LIMITS,
    newRef,
    ...(options.requestPermission === undefined
      ? {}
      : { requestPermission: options.requestPermission })
  };
  return { deps, events, readCalls, minted };
};

const toolCalls = (events: readonly SessionEventTemplate[]): readonly ToolCallTemplate[] =>
  events.filter((event): event is ToolCallTemplate => event.type === "tool_call");

const toolCallsFor = (
  events: readonly SessionEventTemplate[],
  path: string
): readonly ToolCallTemplate[] => toolCalls(events).filter((event) => event.detail === path);

const permissionRequests = (
  events: readonly SessionEventTemplate[]
): readonly PermissionRequestedTemplate[] =>
  events.filter(
    (event): event is PermissionRequestedTemplate => event.type === "permission_requested"
  );

const permissionResolutions = (
  events: readonly SessionEventTemplate[]
): readonly PermissionResolvedTemplate[] =>
  events.filter(
    (event): event is PermissionResolvedTemplate => event.type === "permission_resolved"
  );

/** Asserts a `started` → `completed` pair for `path` with one stable ref, and returns the ref. */
const expectCompletedPair = (events: readonly SessionEventTemplate[], path: string): string => {
  const pair = toolCallsFor(events, path);
  expect(pair.map((event) => event.phase)).toEqual(["started", "completed"]);
  for (const event of pair) expect(event.name).toBe("read_file");
  const refs = new Set(pair.map((event) => event.toolCallRef));
  expect(refs.size).toBe(1);
  const [ref] = [...refs];
  if (ref === undefined) throw new Error(`No tool_call pair was emitted for ${path}.`);
  return ref;
};

const expectRejectsAsNativeContextUnavailable = async (
  assembly: Promise<AssembledContext>
): Promise<void> => {
  let caught: unknown;
  try {
    await assembly;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeAgentError);
  if (!(caught instanceof NativeAgentError)) {
    throw new Error("Expected the assembly to reject with a NativeAgentError.");
  }
  expect(caught.code).toBe("native_context_unavailable");
};

interface ControlledDecision {
  readonly decision: Promise<"allow" | "deny">;
  readonly resolve: (decision: "allow" | "deny") => void;
}

/** A permission decision the test resolves explicitly, so "blocks until decided" is observable. */
const controlledDecision = (): ControlledDecision => {
  let resolveDecision: (decision: "allow" | "deny") => void = () => undefined;
  const decision = new Promise<"allow" | "deny">((resolve) => {
    resolveDecision = resolve;
  });
  return {
    decision,
    resolve: (value) => {
      resolveDecision(value);
    }
  };
};

describe("isPathInScope", () => {
  it("admits a path equal to an include prefix and a path nested under it", () => {
    const scope: ContextScope = { includePrefixes: ["docs", "src/app.ts"] };
    expect(isPathInScope(scope, "src/app.ts")).toBe(true);
    expect(isPathInScope(scope, "docs/guide/setup.md")).toBe(true);
  });

  it("rejects a sibling that merely shares the prefix string — rejects a raw startsWith check without a segment boundary", () => {
    const scope: ContextScope = { includePrefixes: ["docs"] };
    // Positive companion in the same run: the genuine child of the prefix IS in scope.
    expect(isPathInScope(scope, "docs/notes.md")).toBe(true);
    expect(isPathInScope(scope, "docs2/notes.md")).toBe(false);
    expect(isPathInScope(scope, "private/notes.md")).toBe(false);
  });
});

describe("assembleContext", () => {
  describe("path validation happens before the reader", () => {
    const expectRefusedBeforeAnyRead = async (invalidPath: string): Promise<void> => {
      // Grounding: the contract schema itself refuses this path.
      expect(RelativeWorkspacePathSchema.safeParse(invalidPath).success).toBe(false);
      expect(RelativeWorkspacePathSchema.safeParse("docs/valid.md").success).toBe(true);

      const refused = harness({ files: { "docs/valid.md": "valid content" } });
      await expectRejectsAsNativeContextUnavailable(
        assembleContext({
          paths: [invalidPath, "docs/valid.md"],
          scope: DOCS_SCOPE,
          deps: refused.deps
        })
      );
      // The reader is never the security boundary: validation is up-front and fail-closed, so
      // NOTHING was read — not the invalid path, and not the valid one riding in the same batch.
      expect(refused.readCalls).toEqual([]);

      // Positive companion in the same run: the valid path alone assembles and was read.
      const companion = harness({ files: { "docs/valid.md": "valid content" } });
      const assembled = await assembleContext({
        paths: ["docs/valid.md"],
        scope: DOCS_SCOPE,
        deps: companion.deps
      });
      expect(companion.readCalls).toEqual(["docs/valid.md"]);
      expect(assembled.files).toEqual([{ path: "docs/valid.md", content: "valid content" }]);
    };

    it("rejects an absolute path before the reader is ever called — rejects an assembler that lets the reader be the boundary", async () => {
      await expectRefusedBeforeAnyRead("/etc/passwd");
    });

    it("rejects a traversal path before the reader is ever called", async () => {
      await expectRefusedBeforeAnyRead("../secrets.txt");
    });

    it("rejects a NUL-byte path before the reader is ever called", async () => {
      await expectRefusedBeforeAnyRead("file\u0000.txt");
    });
  });

  describe("tool_call evidence", () => {
    it("emits a started/completed pair per read with a stable injected toolCallRef and name read_file — rejects refs minted per phase or from crypto.randomUUID", async () => {
      const run = harness({
        files: { "docs/a.md": "alpha", "docs/b.md": "bravo" }
      });
      const assembled = await assembleContext({
        paths: ["docs/a.md", "docs/b.md"],
        scope: DOCS_SCOPE,
        deps: run.deps
      });

      const refA = expectCompletedPair(run.events, "docs/a.md");
      const refB = expectCompletedPair(run.events, "docs/b.md");
      // Stable within a pair (expectCompletedPair), distinct across files, and every ref came
      // from the injected factory — an assembler minting its own UUIDs fails this containment.
      expect(refA).not.toBe(refB);
      expect(run.minted).toContain(refA);
      expect(run.minted).toContain(refB);
      expect(assembled.files.map((file) => file.path)).toEqual(["docs/a.md", "docs/b.md"]);
    });

    it("emits started/failed for a failing read and fails the assembly closed as native_context_unavailable — rejects an assembler that swallows a failed read", async () => {
      const run = harness({
        files: { "docs/a-ok.md": "fine" },
        failingPaths: ["docs/b-bad.md"]
      });
      await expectRejectsAsNativeContextUnavailable(
        assembleContext({
          paths: ["docs/b-bad.md", "docs/a-ok.md"],
          scope: DOCS_SCOPE,
          deps: run.deps
        })
      );

      // Positive companion in the same run: the earlier (sorted-first) read succeeded normally.
      expectCompletedPair(run.events, "docs/a-ok.md");

      const failedPair = toolCallsFor(run.events, "docs/b-bad.md");
      expect(failedPair.map((event) => event.phase)).toEqual(["started", "failed"]);
      const refs = new Set(failedPair.map((event) => event.toolCallRef));
      expect(refs.size).toBe(1);
      for (const event of failedPair) expect(event.name).toBe("read_file");
    });
  });

  describe("permission gating", () => {
    it("reads in-scope paths without any permission request — rejects a gate that prompts for reads already inside the scope", async () => {
      const run = harness({
        files: { "docs/in.md": "in-scope content" },
        requestPermission: () => {
          throw new Error("requestPermission must not be called for an in-scope read");
        }
      });
      const assembled = await assembleContext({
        paths: ["docs/in.md"],
        scope: DOCS_SCOPE,
        deps: run.deps
      });
      expect(permissionRequests(run.events)).toEqual([]);
      expect(permissionResolutions(run.events)).toEqual([]);
      expect(assembled.files).toEqual([{ path: "docs/in.md", content: "in-scope content" }]);
    });

    it("blocks an out-of-scope read until the allow decision, then reads and resolves in order — rejects a gate that reads before the decision", async () => {
      const controlled = controlledDecision();
      const requests: OutOfScopeRead[] = [];
      const run = harness({
        files: { "docs/in.md": "in-scope content", "private/out.md": "out-of-scope content" },
        requestPermission: (request) => {
          requests.push(request);
          return controlled.decision;
        }
      });

      const pending = assembleContext({
        paths: ["docs/in.md", "private/out.md"],
        scope: DOCS_SCOPE,
        deps: run.deps
      });
      await flush();

      // Blocked: the request is out, the decision is not, and the gated path is unread. The
      // in-scope read has already proceeded — the gate blocks one read, not the assembly's start.
      expect(run.readCalls).toContain("docs/in.md");
      expect(run.readCalls).not.toContain("private/out.md");
      const [request] = requests;
      if (request === undefined) throw new Error("requestPermission was never called.");
      expect(request.path).toBe("private/out.md");
      expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "deny_once"]);
      expect(request.options.map((option) => option.optionId)).toEqual([
        `${request.permissionRef}/allow_once`,
        `${request.permissionRef}/deny_once`
      ]);
      for (const option of request.options) expect(option.label.length).toBeGreaterThan(0);
      expect(run.minted).toContain(request.permissionRef);

      const [requested] = permissionRequests(run.events);
      if (requested === undefined) throw new Error("permission_requested was never emitted.");
      expect(requested.permissionRef).toBe(request.permissionRef);
      expect(requested.summary).toContain("private/out.md");
      expect(requested.evidenceDigest).toBe(sha256Hex("private/out.md"));
      expect(permissionResolutions(run.events)).toEqual([]);

      controlled.resolve("allow");
      const assembled = await pending;

      expect(run.readCalls).toContain("private/out.md");
      expect(assembled.files.map((file) => file.path)).toEqual(["docs/in.md", "private/out.md"]);
      const [resolved] = permissionResolutions(run.events);
      if (resolved === undefined) throw new Error("permission_resolved was never emitted.");
      expect(resolved.permissionRef).toBe(request.permissionRef);
      expect(resolved.selectedOptionId).toBe(`${request.permissionRef}/allow_once`);

      const requestedAt = run.events.indexOf(requested);
      const resolvedAt = run.events.indexOf(resolved);
      const gatedPair = toolCallsFor(run.events, "private/out.md");
      const [startedEvent] = gatedPair;
      if (startedEvent === undefined)
        throw new Error("No tool_call was emitted for the gated read.");
      const startedAt = run.events.indexOf(startedEvent);
      expect(requestedAt).toBeLessThan(resolvedAt);
      expect(resolvedAt).toBeLessThan(startedAt);
      expectCompletedPair(run.events, "private/out.md");
    });

    it("skips the read on deny, resolves the permission, and continues — a denial is a normal outcome, not a failure", async () => {
      const run = harness({
        files: { "docs/in.md": "in-scope content", "private/out.md": "out-of-scope content" },
        requestPermission: () => Promise.resolve("deny")
      });
      const assembled = await assembleContext({
        paths: ["docs/in.md", "private/out.md"],
        scope: DOCS_SCOPE,
        deps: run.deps
      });

      // Positive half: the in-scope read happened and its content is in the context.
      expect(run.readCalls).toContain("docs/in.md");
      expectCompletedPair(run.events, "docs/in.md");
      expect(assembled.files).toEqual([{ path: "docs/in.md", content: "in-scope content" }]);
      // Negative half, same run: the denied path was never read and is recorded as an omission.
      expect(run.readCalls).not.toContain("private/out.md");
      expect(assembled.omissions).toEqual([
        { path: "private/out.md", reason: "out_of_scope_denied" }
      ]);
      const [resolved] = permissionResolutions(run.events);
      if (resolved === undefined) throw new Error("permission_resolved was never emitted.");
      expect(resolved.selectedOptionId).toBe(`${resolved.permissionRef}/deny_once`);
    });

    it("denies out-of-scope reads deterministically when requestPermission is absent — rejects both a gate that prompts anyway and a dead reader that reads nothing", async () => {
      const run = harness({
        files: { "docs/in.md": "in-scope content", "private/out.md": "out-of-scope content" }
      });
      const assembled = await assembleContext({
        paths: ["docs/in.md", "private/out.md"],
        scope: DOCS_SCOPE,
        deps: run.deps
      });

      // No permission machinery at all: nothing requested, nothing resolved, nothing awaited.
      expect(permissionRequests(run.events)).toEqual([]);
      expect(permissionResolutions(run.events)).toEqual([]);
      expect(run.readCalls).not.toContain("private/out.md");
      // Mandatory companion (a dead reader must not pass): the in-scope file WAS read, its
      // tool_call pair emitted, and its (redacted) content is present in the assembled context.
      expect(run.readCalls).toEqual(["docs/in.md"]);
      expectCompletedPair(run.events, "docs/in.md");
      expect(assembled.files).toEqual([
        { path: "docs/in.md", content: redactSensitiveText("in-scope content") }
      ]);
      expect(assembled.omissions).toEqual([
        { path: "private/out.md", reason: "out_of_scope_unpermissioned" }
      ]);
    });
  });

  describe("bounds and determinism", () => {
    const WIDE_SCOPE: ContextScope = { includePrefixes: ["docs", "src"] };
    const UNORDERED_PATHS = ["src/z.ts", "docs/a.md", "src/a.ts"] as const;
    const FILES = {
      "docs/a.md": "docs alpha",
      "src/a.ts": "source alpha",
      "src/z.ts": "source zulu"
    } as const;

    it("keeps the sorted-path prefix under maxFiles and records the truncation — rejects reader-order truncation", async () => {
      const run = harness({ files: FILES, limits: { maxFiles: 2, maxBytes: 100_000 } });
      const assembled = await assembleContext({
        paths: [...UNORDERED_PATHS],
        scope: WIDE_SCOPE,
        deps: run.deps
      });

      // The kept set is the SORTED prefix, even though the request listed src/z.ts first.
      expect(run.readCalls).toEqual(["docs/a.md", "src/a.ts"]);
      expect(assembled.files.map((file) => file.path)).toEqual(["docs/a.md", "src/a.ts"]);
      expect(assembled.truncations).toEqual([{ path: "src/z.ts", reason: "max_files" }]);
      expect(toolCalls(run.events).filter((event) => event.phase === "started")).toHaveLength(
        run.readCalls.length
      );
    });

    it("truncates on maxBytes in sorted path order and records the truncation", async () => {
      const run = harness({
        files: { "docs/a.md": "aaaa", "docs/b.md": "bbbb", "docs/c.md": "cccc" },
        limits: { maxFiles: 10, maxBytes: 7 }
      });
      const assembled = await assembleContext({
        paths: ["docs/c.md", "docs/a.md", "docs/b.md"],
        scope: DOCS_SCOPE,
        deps: run.deps
      });

      // 4 bytes fit; the second 4-byte file would exceed 7, so it and everything after it in
      // sorted order are truncated. The tail file is never read at all.
      expect(assembled.files).toEqual([{ path: "docs/a.md", content: "aaaa" }]);
      expect(assembled.truncations).toEqual([
        { path: "docs/b.md", reason: "max_bytes" },
        { path: "docs/c.md", reason: "max_bytes" }
      ]);
      expect(run.readCalls).toContain("docs/a.md");
      expect(run.readCalls).not.toContain("docs/c.md");
      expect(toolCalls(run.events).filter((event) => event.phase === "started")).toHaveLength(
        run.readCalls.length
      );
    });

    it("produces byte-identical context across two runs over the same reader script", async () => {
      const buildRun = (): Harness =>
        harness({ files: FILES, limits: { maxFiles: 2, maxBytes: 100_000 } });
      const first = buildRun();
      const second = buildRun();
      const assembledFirst = await assembleContext({
        paths: [...UNORDERED_PATHS],
        scope: WIDE_SCOPE,
        deps: first.deps
      });
      const assembledSecond = await assembleContext({
        paths: [...UNORDERED_PATHS],
        scope: WIDE_SCOPE,
        deps: second.deps
      });
      expect(assembledFirst).toEqual(assembledSecond);
      expect(JSON.stringify(assembledFirst)).toBe(JSON.stringify(assembledSecond));
    });
  });

  describe("redaction", () => {
    it("stores redactSensitiveText output, never the raw credential — rejects an assembler that stores raw reader output", async () => {
      const rawSecretContent = `aws_access_key_id = ${AWS_KEY_SHAPED} trailing prose`;
      // Grounding: this vector really is one the redactor rewrites.
      const expectedRedacted = redactSensitiveText(rawSecretContent);
      expect(expectedRedacted).not.toBe(rawSecretContent);
      expect(expectedRedacted).not.toContain(AWS_KEY_SHAPED);

      const benignContent = "plain documentation prose with no credentials";
      expect(redactSensitiveText(benignContent)).toBe(benignContent);

      const run = harness({
        files: { "docs/benign.md": benignContent, "docs/leaky.md": rawSecretContent }
      });
      const assembled = await assembleContext({
        paths: ["docs/leaky.md", "docs/benign.md"],
        scope: DOCS_SCOPE,
        deps: run.deps
      });

      expect(assembled.files).toEqual([
        { path: "docs/benign.md", content: benignContent },
        { path: "docs/leaky.md", content: expectedRedacted }
      ]);
      for (const file of assembled.files) {
        expect(file.content).not.toContain(AWS_KEY_SHAPED);
      }
    });
  });
});
