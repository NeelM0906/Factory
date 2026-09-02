import { describe, expect, it } from "vitest";

import { safeAttributes, type AttributeValue } from "../src/attributes.js";

const fakeToken = ["ghp", "a".repeat(36)].join("_");

describe("safe attributes", () => {
  it("passes through plain string, number, and boolean attributes", () => {
    const attrs = safeAttributes({
      "http.method": "GET",
      "http.status_code": 200,
      "http.ok": true
    });
    expect(attrs).toEqual({
      "http.method": "GET",
      "http.status_code": 200,
      "http.ok": true
    });
  });

  it("refuses to attach an attribute whose value carries credential material", () => {
    expect(() => safeAttributes({ "http.url": `https://x/?token=${fakeToken}` })).toThrow(
      /redact/i
    );
  });

  it("refuses an attribute key that carries credential material", () => {
    expect(() => safeAttributes({ [fakeToken]: "value" })).toThrow(/redact/i);
  });

  it("fails closed when a value cannot be serialized safely", () => {
    expect(() =>
      safeAttributes({
        payload: {
          toJSON() {
            throw new Error("nope");
          }
        } as never
      })
    ).toThrow();
  });

  it("truncates an oversized attribute value and marks it truncated", () => {
    const longValue = "x".repeat(5000);
    const attrs = safeAttributes({ "long.attr": longValue });
    const value = attrs["long.attr"] as string;
    expect(value.length).toBeLessThan(longValue.length);
    expect(value).toContain("[truncated]");
  });

  it("accepts an array of strings as an attribute value", () => {
    const attrs = safeAttributes({ tags: ["a", "b", "c"] });
    expect(attrs.tags).toEqual(["a", "b", "c"]);
  });

  it("refuses an array containing credential material", () => {
    expect(() => safeAttributes({ tokens: [fakeToken] })).toThrow(/redact/i);
  });

  it("returns a frozen object", () => {
    const attrs = safeAttributes({ key: "value" });
    expect(Object.isFrozen(attrs)).toBe(true);
  });

  it("accepts an empty attributes map", () => {
    const attrs = safeAttributes({});
    expect(attrs).toEqual({});
  });
});
