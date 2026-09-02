/**
 * Command and path traversal security fixtures (spec section 17.5).
 *
 * Tests that contract-level schemas reject path traversal attempts in metadata fields,
 * and that delivery payloads cannot smuggle path components that would escape containment
 * boundaries. Filesystem-level path traversal tests for DataPathPolicy live in
 * packages/runner-local/test/path-policy.test.ts (macOS-only).
 */
import { describe, expect, it } from "vitest";

import { IngressDeliverySchema, SafeMetadataStringSchema } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const githubDelivery = (overrides: {
  title?: string;
  body?: string;
  repositoryFullName?: string;
  event?: string;
}) => ({
  schemaVersion: 1,
  provider: "github" as const,
  deliveryId: "delivery-traversal-test",
  deduplicationKey: "github:123:1:issues.opened",
  receivedAt: new Date().toISOString(),
  event: overrides.event ?? ("issues.opened" as const),
  repository: {
    id: "123",
    fullName: overrides.repositoryFullName ?? "org/repo"
  },
  issue: {
    number: 1,
    title: overrides.title ?? "Legitimate title",
    body: overrides.body ?? "Legitimate body",
    authorId: "456"
  }
});

// ---------------------------------------------------------------------------
// 1. Path traversal in metadata fields
// ---------------------------------------------------------------------------

describe("path traversal: metadata field attacks", () => {
  const traversalPayloads = [
    "../../../etc/passwd",
    "..\\..\\..\\Windows\\System32\\config\\SAM",
    "....//....//etc/shadow",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "..%252f..%252f..%252fetc%252fpasswd",
    "/absolute/path/to/secret",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "file:///etc/passwd",
    "\0/etc/passwd",
    "legitimate/../../../etc/passwd"
  ];

  it.each(traversalPayloads)(
    "path traversal in issue body is accepted as inert text (not interpreted): %j",
    (payload) => {
      const delivery = githubDelivery({ body: payload });
      const parsed = IngressDeliverySchema.parse(delivery);

      // Path traversal text in the body is just text -- it's never used as a filesystem path
      // at the contract layer. The body is bounded by max(100_000) and schema is strict.
      if (parsed.provider !== "github") throw new Error("Expected GitHub delivery");
      expect(parsed.issue.body).toBe(payload);
    }
  );

  // Null byte is a special case -- it can truncate strings in C-based path operations
  it("null bytes in body do not cause parsing failures", () => {
    const delivery = githubDelivery({ body: "before\0after" });
    const parsed = IngressDeliverySchema.parse(delivery);
    if (parsed.provider !== "github") throw new Error("Expected GitHub delivery");
    expect(parsed.issue.body).toContain("\0");
  });
});

// ---------------------------------------------------------------------------
// 2. Repository fullName traversal
// ---------------------------------------------------------------------------

describe("path traversal: repository name attacks", () => {
  it("rejects repository fullName with path traversal components", () => {
    const delivery = githubDelivery({ repositoryFullName: "../../../etc/passwd" });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("rejects repository fullName with whitespace", () => {
    const delivery = githubDelivery({ repositoryFullName: "org /repo" });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("rejects repository fullName missing the slash separator", () => {
    const delivery = githubDelivery({ repositoryFullName: "orgrepo" });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("rejects repository fullName with multiple slashes", () => {
    const delivery = githubDelivery({ repositoryFullName: "org/sub/repo" });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("accepts a valid repository fullName", () => {
    const delivery = githubDelivery({ repositoryFullName: "autostack-org/my-repo" });
    const parsed = IngressDeliverySchema.parse(delivery);
    if (parsed.provider !== "github") throw new Error("Expected GitHub delivery");
    expect(parsed.repository.fullName).toBe("autostack-org/my-repo");
  });
});

// ---------------------------------------------------------------------------
// 3. Strict schema prevents extra fields (command injection via hidden fields)
// ---------------------------------------------------------------------------

describe("command injection: smuggled fields", () => {
  it("rejects delivery with smuggled command field at top level", () => {
    const delivery = {
      ...githubDelivery({}),
      command: "rm -rf /",
      exec: "curl https://evil.example.com"
    };
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("rejects delivery with smuggled fields in repository", () => {
    const base = githubDelivery({});
    const delivery = {
      ...base,
      repository: {
        ...base.repository,
        path: "/opt/autostack/data",
        shellCommand: "cat /etc/passwd"
      }
    };
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("rejects delivery with smuggled fields in issue", () => {
    const base = githubDelivery({});
    const delivery = {
      ...base,
      issue: {
        ...base.issue,
        workingDirectory: "/tmp",
        executeOnMerge: "deploy --force"
      }
    };
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Event field validation (prevent unknown event routing)
// ---------------------------------------------------------------------------

describe("command injection: event field attacks", () => {
  it("rejects unknown event types that could route to unintended handlers", () => {
    const delivery = githubDelivery({ event: "admin.grant_access" });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("rejects empty event string", () => {
    const delivery = githubDelivery({ event: "" });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("accepts only the defined event enum values", () => {
    const validEvents = [
      "issues.opened",
      "issues.edited",
      "issues.labeled",
      "issue_comment.created"
    ];

    for (const event of validEvents) {
      const delivery = githubDelivery({ event });
      // Should not throw
      IngressDeliverySchema.parse(delivery);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Oversized field attacks (resource exhaustion)
// ---------------------------------------------------------------------------

describe("resource exhaustion: oversized fields", () => {
  it("rejects body exceeding 100,000 characters", () => {
    const delivery = githubDelivery({ body: "x".repeat(100_001) });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("rejects title exceeding 240 characters", () => {
    const delivery = githubDelivery({ title: "x".repeat(241) });
    expect(() => IngressDeliverySchema.parse(delivery)).toThrow();
  });

  it("accepts body at exactly 100,000 characters", () => {
    const delivery = githubDelivery({ body: "x".repeat(100_000) });
    const parsed = IngressDeliverySchema.parse(delivery);
    if (parsed.provider !== "github") throw new Error("Expected GitHub delivery");
    expect(parsed.issue.body).toHaveLength(100_000);
  });
});
