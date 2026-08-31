import { describe, expect, it } from "vitest";

import {
  containsSensitiveMaterial,
  digestVersionedValue,
  ModelMessageSchema,
  StationProvenanceSchema,
  type ModelMessage
} from "@autostack/contracts";

import {
  NATIVE_AGENT_ROLES,
  NATIVE_PROMPTS,
  PROMPT_DIGESTS,
  PROMPT_SAMPLE_INPUTS,
  UNTRUSTED_INPUT_BLOCK_CLOSE,
  UNTRUSTED_INPUT_BLOCK_OPEN,
  type NativeAgentRole,
  type NativePromptArtifact,
  type NativePromptRenderInput
} from "../src/prompts/index.js";

/** Mirrors the StableRefSchema alphabet in `@autostack/contracts` (agent.ts). */
const STABLE_REF_ALPHABET = /^[A-Za-z0-9._:/-]+$/;

const EXPECTED_PROMPT_REFS: Readonly<Record<NativeAgentRole, string>> = {
  triage: "autostack.native.triage",
  plan: "autostack.native.plan",
  review: "autostack.native.review"
};

/**
 * The model-authored subset of `TriageReportSchema`: everything except the identity fields the
 * harness supplies (`workspaceId`, `workItemId`, `runId`, `schemaVersion`) and the provenance
 * fields (`producedAt`, `producedBy`).
 */
const TRIAGE_MODEL_AUTHORED_FIELDS = [
  "taskType",
  "priority",
  "complexity",
  "actionable",
  "rationale",
  "duplicates",
  "clarificationRef"
] as const;

/**
 * Identity, digest, and timestamp field names the model is never invited to author (review
 * finding 2a): the harness supplies all of them, so none may appear in any rendered prompt text.
 */
const FORBIDDEN_PROMPT_FIELD_NAMES = [
  "workspaceId",
  "workItemId",
  "runId",
  "schemaVersion",
  "planDigest",
  "reviewedDiffDigest",
  "verificationReportDigest",
  "producedAt",
  "producedBy"
] as const;

const BENIGN_INPUT: NativePromptRenderInput = {
  objective: "Investigate the reported checkout regression and describe its blast radius.",
  repositoryContext: "A pnpm monorepo with packages under packages/ and vitest test suites."
};

/** AWS-access-key shaped: the `AKIA` + 16 upper-alphanumeric spec in KNOWN_CREDENTIAL_SPECS. */
const AWS_KEY_SHAPED = `AKIA${"A".repeat(16)}`;

const requireDefined = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new Error(`Expected ${label} to be defined.`);
  }
  return value;
};

const renderedText = (messages: readonly ModelMessage[]): string =>
  messages.map((message) => message.content).join("\n");

const artifactFor = (role: NativeAgentRole): NativePromptArtifact => NATIVE_PROMPTS[role];

describe("native prompt artifacts", () => {
  it("exposes one deeply frozen artifact per role with a stable-ref promptRef and a positive integer version", () => {
    expect(Object.isFrozen(NATIVE_PROMPTS)).toBe(true);
    for (const role of NATIVE_AGENT_ROLES) {
      const artifact = artifactFor(role);
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(Object.isFrozen(artifact.modelAuthoredFields)).toBe(true);
      expect(artifact.promptRef).toBe(EXPECTED_PROMPT_REFS[role]);
      expect(artifact.promptRef).toMatch(STABLE_REF_ALPHABET);
      expect(typeof artifact.system).toBe("string");
      expect(artifact.system.length).toBeGreaterThan(0);
      expect(Number.isInteger(artifact.version)).toBe(true);
      expect(artifact.version).toBeGreaterThan(0);
      expect(typeof artifact.render).toBe("function");
    }
  });

  it("pins String(version) as a StableRef so the version can ride StationProvenanceSchema.promptVersion", () => {
    for (const role of NATIVE_AGENT_ROLES) {
      const artifact = artifactFor(role);
      // StationProvenanceSchema.promptVersion is a StableRef STRING; the numeric artifact
      // version must survive the string projection that station documents actually carry.
      const provenance = StationProvenanceSchema.parse({
        adapterId: "autostack.native",
        promptRef: artifact.promptRef,
        promptVersion: String(artifact.version)
      });
      expect(provenance.promptVersion).toBe(String(artifact.version));
    }
  });

  it("keeps promptRef values unique and the registry exhaustive over NATIVE_AGENT_ROLES", () => {
    expect([...NATIVE_AGENT_ROLES]).toStrictEqual(["triage", "plan", "review"]);
    const registryRoles = Object.keys(NATIVE_PROMPTS).sort();
    expect(registryRoles).toStrictEqual([...NATIVE_AGENT_ROLES].sort());
    const refs = NATIVE_AGENT_ROLES.map((role) => artifactFor(role).promptRef);
    expect(new Set(refs).size).toBe(refs.length);
  });

  describe("render", () => {
    it("returns ModelMessage[] led by the artifact's system text, with untrusted inputs inside the delimited user block", () => {
      for (const role of NATIVE_AGENT_ROLES) {
        const artifact = artifactFor(role);
        const messages = artifact.render(BENIGN_INPUT);
        expect(messages.length).toBeGreaterThanOrEqual(2);
        for (const message of messages) {
          expect(ModelMessageSchema.parse(message)).toStrictEqual(message);
        }
        const first = requireDefined(messages[0], `${role} first rendered message`);
        expect(first.role).toBe("system");
        expect(first.content).toBe(artifact.system);
        expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
        const userMessage = requireDefined(
          messages.find((message) => message.role === "user"),
          `${role} user message`
        );
        const openIndex = userMessage.content.indexOf(UNTRUSTED_INPUT_BLOCK_OPEN);
        const closeIndex = userMessage.content.lastIndexOf(UNTRUSTED_INPUT_BLOCK_CLOSE);
        expect(openIndex).toBeGreaterThanOrEqual(0);
        expect(closeIndex).toBeGreaterThan(openIndex);
        const block = userMessage.content.slice(openIndex, closeIndex);
        expect(block).toContain(BENIGN_INPUT.objective);
        expect(block).toContain(BENIGN_INPUT.repositoryContext);
      }
    });

    it("asks for every declared model-authored field and never invites identity, digest, or timestamp fields", () => {
      // Rejects the wrong implementation that asks the model to author identity or evidence
      // addressing (workspaceId, runId, producedAt, ... — review finding 2a), and equally the
      // one that silently stops asking for a field its output schema demands.
      const triageFields = [...artifactFor("triage").modelAuthoredFields].sort();
      expect(triageFields).toStrictEqual([...TRIAGE_MODEL_AUTHORED_FIELDS].sort());
      for (const role of NATIVE_AGENT_ROLES) {
        const artifact = artifactFor(role);
        expect(artifact.modelAuthoredFields.length).toBeGreaterThan(0);
        const text = renderedText(artifact.render(BENIGN_INPUT));
        for (const field of artifact.modelAuthoredFields) {
          // Positive companion: every declared field is named in the rendered instruction.
          expect(text).toContain(field);
        }
        for (const forbidden of FORBIDDEN_PROMPT_FIELD_NAMES) {
          expect(artifact.modelAuthoredFields).not.toContain(forbidden);
          expect(text).not.toContain(forbidden);
        }
      }
    });

    it("keeps untrusted objective text out of the system message and inside the delimited block", () => {
      // Rejects the wrong implementation that interpolates the objective (untrusted text) into
      // the system message, where it would read as instruction rather than data.
      const marker = "UNTRUSTED-MARKER-9f2c7ab1";
      const input: NativePromptRenderInput = {
        objective: `Ship the widget. ${marker}`,
        repositoryContext: BENIGN_INPUT.repositoryContext
      };
      for (const role of NATIVE_AGENT_ROLES) {
        const messages = artifactFor(role).render(input);
        for (const message of messages) {
          if (message.role !== "user") {
            expect(message.content).not.toContain(marker);
          }
        }
        const userMessage = requireDefined(
          messages.find((message) => message.content.includes(marker)),
          `${role} message carrying the marker`
        );
        // Positive companion: the marker did arrive — as data inside the delimited user block.
        expect(userMessage.role).toBe("user");
        const openIndex = userMessage.content.indexOf(UNTRUSTED_INPUT_BLOCK_OPEN);
        const closeIndex = userMessage.content.lastIndexOf(UNTRUSTED_INPUT_BLOCK_CLOSE);
        const markerIndex = userMessage.content.indexOf(marker);
        expect(markerIndex).toBeGreaterThan(openIndex);
        expect(markerIndex).toBeLessThan(closeIndex);
        const systemMessage = requireDefined(messages[0], `${role} system message`);
        expect(systemMessage.role).toBe("system");
        // The system message must frame the delimited block as data, never instruction.
        expect(systemMessage.content).toContain(UNTRUSTED_INPUT_BLOCK_OPEN);
        expect(systemMessage.content).toMatch(/data/i);
        expect(systemMessage.content).toMatch(/instruction/i);
      }
    });

    it("fails closed on credential-shaped input instead of rendering it into a message", () => {
      // Rejects the wrong implementation that forwards an AWS-key-shaped string to the model:
      // every rendered message must pass ModelMessageSchema (whose SafeMetadataString content
      // refuses sensitive material), so render must throw rather than produce a message.
      expect(containsSensitiveMaterial(AWS_KEY_SHAPED)).toBe(true);
      const hostileInput: NativePromptRenderInput = {
        objective: `Rotate the key ${AWS_KEY_SHAPED} before release.`,
        repositoryContext: BENIGN_INPUT.repositoryContext
      };
      for (const role of NATIVE_AGENT_ROLES) {
        const artifact = artifactFor(role);
        expect(() => artifact.render(hostileInput)).toThrow();
        // Positive companion, same run: the benign input still renders schema-valid messages.
        const messages = artifact.render(BENIGN_INPUT);
        for (const message of messages) {
          expect(ModelMessageSchema.safeParse(message).success).toBe(true);
        }
      }
    });
  });

  describe("PROMPT_DIGESTS", () => {
    it("keeps frozen sample inputs beside the table, one per role", () => {
      expect(Object.isFrozen(PROMPT_SAMPLE_INPUTS)).toBe(true);
      expect(Object.keys(PROMPT_SAMPLE_INPUTS).sort()).toStrictEqual(
        [...NATIVE_AGENT_ROLES].sort()
      );
      for (const role of NATIVE_AGENT_ROLES) {
        expect(Object.isFrozen(PROMPT_SAMPLE_INPUTS[role])).toBe(true);
      }
      expect(Object.isFrozen(PROMPT_DIGESTS)).toBe(true);
      for (const row of PROMPT_DIGESTS) {
        expect(Object.isFrozen(row)).toBe(true);
        expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("pins each current artifact to its table row, so a prompt edited without a version bump fails here", async () => {
      // Names the wrong implementation this rejects: a prompt whose system text or rendering
      // changed while its version (and therefore its append-only table row) stayed the same —
      // the recomputed projection digest then no longer equals the row for (promptRef, version).
      for (const role of NATIVE_AGENT_ROLES) {
        const artifact = artifactFor(role);
        const projection = {
          promptRef: artifact.promptRef,
          version: artifact.version,
          system: artifact.system,
          renderedSample: artifact.render(PROMPT_SAMPLE_INPUTS[role])
        };
        const digest = await digestVersionedValue("autostack.native-prompt", projection);
        const row = requireDefined(
          PROMPT_DIGESTS.find(
            (candidate) =>
              candidate.promptRef === artifact.promptRef && candidate.version === artifact.version
          ),
          `digest row for ${artifact.promptRef} v${artifact.version}`
        );
        // Positive companion: the current version's row exists AND matches the recompute.
        expect(row.digest).toBe(digest);
      }
    });

    it("covers every shipped (promptRef, version) with contiguous ascending versions from 1", () => {
      const registryRefs = new Set(NATIVE_AGENT_ROLES.map((role) => artifactFor(role).promptRef));
      const versionsByRef = new Map<string, number[]>();
      for (const row of PROMPT_DIGESTS) {
        // Rejects a table row for a prompt the registry does not ship.
        expect(registryRefs.has(row.promptRef)).toBe(true);
        const versions = versionsByRef.get(row.promptRef) ?? [];
        versionsByRef.set(row.promptRef, [...versions, row.version]);
      }
      for (const role of NATIVE_AGENT_ROLES) {
        const artifact = artifactFor(role);
        const versions = requireDefined(
          versionsByRef.get(artifact.promptRef),
          `digest rows for ${artifact.promptRef}`
        );
        // Append-only history: exactly one row per version, 1..current, ascending — a deleted or
        // duplicated historical row (the wrong "rewrite the table" implementation) fails here.
        const expected = Array.from({ length: artifact.version }, (_, index) => index + 1);
        expect(versions).toStrictEqual(expected);
      }
    });
  });
});
