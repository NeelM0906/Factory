import { describe, expect, it } from "vitest";

import {
  ApprovalIdSchema,
  ArtifactIdSchema,
  AutomationIdSchema,
  CredentialRefIdSchema,
  EventIdSchema,
  ID_PREFIX,
  JobIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  StageRunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  createId,
  createIdFactory
} from "../src/ids.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("AutoStack identifiers", () => {
  it.each([
    ["workspace", WorkspaceIdSchema, "ws_"],
    ["project", ProjectIdSchema, "prj_"],
    ["workItem", WorkItemIdSchema, "wi_"],
    ["run", RunIdSchema, "run_"],
    ["stageRun", StageRunIdSchema, "stage_"],
    ["approval", ApprovalIdSchema, "apr_"],
    ["artifact", ArtifactIdSchema, "art_"],
    ["automation", AutomationIdSchema, "aut_"],
    ["credentialRef", CredentialRefIdSchema, "cred_"],
    ["event", EventIdSchema, "evt_"],
    ["job", JobIdSchema, "job_"]
  ] as const)("creates and validates a %s ID", (kind, schema, prefix) => {
    const id = createId(kind, UUID);

    expect(id).toBe(`${prefix}${UUID}`);
    expect(schema.parse(id)).toBe(id);
  });

  it("rejects an identifier from the wrong namespace", () => {
    expect(() => RunIdSchema.parse(`wi_${UUID}`)).toThrow();
  });

  it("rejects a malformed UUID before prefixing it", () => {
    expect(() => createId("run", "not-a-uuid")).toThrow();
  });

  it("builds deterministic factories for tests", () => {
    const factory = createIdFactory(() => UUID);

    expect(factory.workspace()).toBe(`ws_${UUID}`);
    expect(factory.run()).toBe(`run_${UUID}`);
    expect(factory.job()).toBe(`job_${UUID}`);
    expect(ID_PREFIX.agentSession).toBe("agt");
  });
});
