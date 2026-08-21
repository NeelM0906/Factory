import { describe, expect, it } from "vitest";

import {
  HostApiRouteSchema,
  HostArtifactContentRequestSchema,
  HostCommandEventFrameSchema,
  HostErrorSchema
} from "../src/index.js";

describe("host daemon API contracts", () => {
  it("admits only the versioned local-runner route surface", () => {
    expect(HostApiRouteSchema.options).toEqual([
      "GET /v1/health",
      "GET /v1/environments",
      "POST /v1/repositories/inspect",
      "POST /v1/environments",
      "POST /v1/environments/:environmentId/commands",
      "GET /v1/environments/:environmentId/commands/:commandId/events",
      "POST /v1/environments/:environmentId/commands/:commandId/cancel",
      "GET /v1/artifacts/:artifactId/content",
      "DELETE /v1/environments/:environmentId"
    ]);
  });

  it("bounds artifact byte ranges and validates newline event frames", () => {
    expect(
      HostArtifactContentRequestSchema.parse({
        artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
        range: { start: 0, end: 1_048_575 }
      })
    ).toMatchObject({ range: { end: 1_048_575 } });
    expect(() =>
      HostArtifactContentRequestSchema.parse({
        artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
        range: { start: 0, end: 1_048_576 }
      })
    ).toThrow();
    expect(
      HostCommandEventFrameSchema.parse({
        type: "subscription.lagged",
        lastDurableSequence: 2,
        resumeCursor: 2
      })
    ).toMatchObject({ type: "subscription.lagged" });
    expect(
      HostErrorSchema.parse({ error: { code: "unsupported_policy", message: "host only" } })
    ).toBeDefined();
  });
});
