import { describe, expect, it } from "vitest";

import { assertSafeJson, containsSensitiveMaterial, redactSensitiveText } from "../src/index.js";

const CONFIGURED_SECRET = "configured-secret-0123456789abcdef";
const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnop";

describe("central secret safety", () => {
  it("redacts configured values and known credential formats", () => {
    const redacted = redactSensitiveText(
      `request failed for ${CONFIGURED_SECRET} and ${GITHUB_TOKEN}`,
      [CONFIGURED_SECRET]
    );

    expect(redacted).toBe("request failed for [REDACTED] and [REDACTED]");
    expect(containsSensitiveMaterial(redacted, [CONFIGURED_SECRET])).toBe(false);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["bigint", { value: 1n }],
    ["symbol", { value: Symbol("unsafe") }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["known credential", { value: GITHUB_TOKEN }],
    ["configured secret", { value: CONFIGURED_SECRET }]
  ])("rejects %s in persisted JSON", (_label, value) => {
    expect(() => assertSafeJson(value, [CONFIGURED_SECRET])).toThrow();
  });

  it("rejects cyclic JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertSafeJson(cyclic)).toThrow(/cyclic/i);
  });

  it("rejects credential material used as an object key", () => {
    expect(() => assertSafeJson({ [GITHUB_TOKEN]: "value" })).toThrow();
  });

  it("rejects symbol-keyed, non-enumerable, and sparse values that JSON would discard", () => {
    const symbolKeyed = { [Symbol("unsafe")]: "value" };
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "hidden", { value: "value", enumerable: false });
    const sparse = new Array(1);

    expect(() => assertSafeJson(symbolKeyed)).toThrow(/symbol/i);
    expect(() => assertSafeJson(nonEnumerable)).toThrow(/enumerable/i);
    expect(() => assertSafeJson(sparse)).toThrow(/sparse/i);
  });

  it("rejects array accessors without invoking them and nonstandard array prototypes", () => {
    let reads = 0;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "safe" : CONFIGURED_SECRET;
      }
    });
    accessor.length = 1;
    const customPrototype: unknown[] = [];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));

    expect(() => assertSafeJson(accessor, [CONFIGURED_SECRET])).toThrow(/accessor/i);
    expect(reads).toBe(0);
    expect(() => assertSafeJson(customPrototype)).toThrow(/plain JSON array|prototype/i);
  });

  it("captures an array length descriptor without invoking a proxy get trap", () => {
    let reads = 0;
    const proxied = new Proxy(["safe"], {
      get: (target, property, receiver) => {
        reads += 1;
        return Reflect.get(target, property, receiver);
      }
    });

    expect(() => assertSafeJson(proxied)).not.toThrow();
    expect(reads).toBe(0);
  });

  it("accepts the complete JSON value vocabulary and repeated non-cyclic references", () => {
    const shared = { ok: true };
    expect(() =>
      assertSafeJson({
        null: null,
        boolean: false,
        number: 0,
        string: "safe",
        array: [shared, shared]
      })
    ).not.toThrow();
    expect(() => assertSafeJson(new Date())).toThrow(/plain JSON object/i);
  });
});
