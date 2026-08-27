import { describe, expect, it } from "vitest";

import {
  assertSafeJson,
  CONFIGURED_SECRET_LIMITS,
  containsSensitiveMaterial,
  isEcmaScriptWhitespace,
  isKnownCredentialBodyCharacter,
  isKnownCredentialSeparatorCharacter,
  type KnownCredentialSpec,
  normalizeSafeJson,
  redactSensitiveText,
  SafeMetadataStringSchema,
  selectSensitiveRedactionMarker,
  StreamingSensitiveMaterialDetector
} from "../src/index.js";

const CONFIGURED_SECRET = "configured-secret-0123456789abcdef";
const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnop";
const HOSTILE_SECRET_SOURCE_ERROR = new Error(
  "ghp_RAW_SENSITIVE_VALUES_SECRET /private/sensitive-values/path"
);

const capturedError = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to throw.");
};

type SensitiveValuesAttack = "index getter" | "Symbol.iterator getter" | "next" | "value";

const hostileSensitiveValueSource = (attack: SensitiveValuesAttack): readonly string[] => {
  if (attack === "index getter") {
    const values = ["safe"];
    Object.defineProperty(values, "0", {
      get() {
        throw HOSTILE_SECRET_SOURCE_ERROR;
      }
    });
    return values;
  }
  if (attack === "Symbol.iterator getter") {
    const values = {};
    Object.defineProperty(values, Symbol.iterator, {
      get() {
        throw HOSTILE_SECRET_SOURCE_ERROR;
      }
    });
    return values as readonly string[];
  }
  if (attack === "next") {
    return {
      [Symbol.iterator]() {
        return {
          next(): IteratorResult<string> {
            throw HOSTILE_SECRET_SOURCE_ERROR;
          }
        };
      }
    } as unknown as readonly string[];
  }
  return {
    [Symbol.iterator]() {
      return {
        next(): IteratorResult<string> {
          const result = { done: false };
          Object.defineProperty(result, "value", {
            get() {
              throw HOSTILE_SECRET_SOURCE_ERROR;
            }
          });
          return result as IteratorResult<string>;
        }
      };
    }
  } as unknown as readonly string[];
};

describe("central secret safety", () => {
  it("fails closed for runtime-mistyped exported credential helper inputs", () => {
    const hostileCharacter = new Proxy(
      {},
      {
        get() {
          throw HOSTILE_SECRET_SOURCE_ERROR;
        }
      }
    ) as unknown as string;
    const hostileSpec = new Proxy(
      {},
      {
        get() {
          throw HOSTILE_SECRET_SOURCE_ERROR;
        }
      }
    ) as KnownCredentialSpec;
    const invalidSpec = {
      prefix: "prefix",
      minimumBodyLength: 1,
      bodyClass: "invalid",
      bodyCharacterPattern: "."
    } as unknown as KnownCredentialSpec;

    expect(isEcmaScriptWhitespace(hostileCharacter)).toBe(false);
    expect(isKnownCredentialBodyCharacter(hostileSpec, "A")).toBe(false);
    expect(isKnownCredentialBodyCharacter(invalidSpec, "A")).toBe(false);
    expect(isKnownCredentialBodyCharacter(invalidSpec, hostileCharacter)).toBe(false);
    expect(isKnownCredentialSeparatorCharacter(hostileSpec, " ")).toBe(false);
    expect(isKnownCredentialSeparatorCharacter(hostileSpec, hostileCharacter)).toBe(false);
  });

  it("fails closed for runtime-mistyped public text inputs without proxy access", () => {
    let reads = 0;
    const hostileValue = new Proxy(
      {},
      {
        get() {
          reads += 1;
          throw HOSTILE_SECRET_SOURCE_ERROR;
        }
      }
    ) as unknown as string;
    const detector = new StreamingSensitiveMaterialDetector();

    expect(redactSensitiveText(hostileValue)).toBe("");
    expect(containsSensitiveMaterial(hostileValue)).toBe(true);
    detector.write(hostileValue);

    expect(detector.finalize()).toBe(true);
    expect(reads).toBe(0);
  });

  it.each(["index getter", "Symbol.iterator getter", "next", "value"] as const)(
    "sanitizes public detector configured-values %s failures",
    (attack) => {
      const error = capturedError(
        () => new StreamingSensitiveMaterialDetector(hostileSensitiveValueSource(attack))
      );

      expect(error).not.toBe(HOSTILE_SECRET_SOURCE_ERROR);
      expect(error).toBeInstanceOf(RangeError);
      if (!(error instanceof Error)) throw new Error("Expected a detector configuration error.");
      expect(error.name).toBe("SensitiveMaterialConfigurationError");
      expect(error.message).toBe("The sensitive-material detector configuration is invalid.");
      expect(Object.hasOwn(error, "cause")).toBe(false);
      expect([error.name, error.message, error.stack].join(" ")).not.toContain(
        HOSTILE_SECRET_SOURCE_ERROR.message
      );
    }
  );

  it("counts inspected empty configured values independently of retained values", () => {
    const values = (): readonly string[] =>
      (function* emptyValues(): Generator<string> {
        for (let index = 0; index <= CONFIGURED_SECRET_LIMITS.maximumCount; index += 1) yield "";
      })() as unknown as readonly string[];

    expect(capturedError(() => new StreamingSensitiveMaterialDetector(values()))).toBeInstanceOf(
      RangeError
    );
    expect(containsSensitiveMaterial("ordinary", values())).toBe(true);
    expect(redactSensitiveText("ordinary", values())).toBe("");
    expect(selectSensitiveRedactionMarker(values())).toBe("");
    expect(() => normalizeSafeJson({ value: "ordinary" }, values())).toThrow(
      "Sensitive material is not allowed."
    );
  });

  it("bounds and closes infinite empty configured values at every public boundary", async () => {
    const trackedValues = () => {
      const state = { nextCalls: 0, returnCalls: 0, cleanupObserved: false };
      const values = {
        [Symbol.iterator]() {
          return {
            next() {
              state.nextCalls += 1;
              return { done: false, value: "" };
            },
            return() {
              state.returnCalls += 1;
              return {
                then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
                  state.cleanupObserved = true;
                  reject(HOSTILE_SECRET_SOURCE_ERROR);
                }
              };
            }
          };
        }
      } as unknown as readonly string[];
      return { state, values };
    };
    const cases = [
      (values: readonly string[]) =>
        capturedError(() => new StreamingSensitiveMaterialDetector(values)),
      (values: readonly string[]) => containsSensitiveMaterial("ordinary", values),
      (values: readonly string[]) => redactSensitiveText("ordinary", values),
      (values: readonly string[]) => selectSensitiveRedactionMarker(values),
      (values: readonly string[]) =>
        capturedError(() => normalizeSafeJson({ value: "ordinary" }, values))
    ];

    for (const run of cases) {
      const tracked = trackedValues();
      run(tracked.values);
      await Promise.resolve();
      await Promise.resolve();
      expect(tracked.state.nextCalls).toBeLessThanOrEqual(
        CONFIGURED_SECRET_LIMITS.maximumCount + 1
      );
      expect(tracked.state.returnCalls).toBe(1);
      expect(tracked.state.cleanupObserved).toBe(true);
    }
  });

  it("bounds and closes an infinite public detector configured-values iterable", async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    let cleanupObserved = false;
    const values = {
      [Symbol.iterator]() {
        return {
          next() {
            nextCalls += 1;
            return { done: false, value: `configured-${nextCalls}` };
          },
          return() {
            returnCalls += 1;
            return {
              then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
                cleanupObserved = true;
                reject(HOSTILE_SECRET_SOURCE_ERROR);
              }
            };
          }
        };
      }
    } as unknown as readonly string[];

    const error = capturedError(() => new StreamingSensitiveMaterialDetector(values));
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toBeInstanceOf(RangeError);
    expect(nextCalls).toBeLessThanOrEqual(CONFIGURED_SECRET_LIMITS.maximumCount + 1);
    expect(returnCalls).toBe(1);
    expect(cleanupObserved).toBe(true);
  });

  it.each(["index getter", "Symbol.iterator getter", "next", "value"] as const)(
    "fails closed for a hostile configured-values %s",
    (attack) => {
      expect(redactSensitiveText("ordinary", hostileSensitiveValueSource(attack))).toBe("");
      expect(containsSensitiveMaterial("ordinary", hostileSensitiveValueSource(attack))).toBe(true);
    }
  );

  it("observes a rejected asynchronous iterator cleanup while failing closed", async () => {
    let cleanupObserved = false;
    const values = {
      [Symbol.iterator]() {
        return {
          next() {
            return { done: false, value: "configured" };
          },
          return() {
            return {
              then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
                cleanupObserved = true;
                reject(HOSTILE_SECRET_SOURCE_ERROR);
              }
            };
          }
        };
      }
    } as unknown as readonly string[];

    expect(redactSensitiveText("ordinary", values)).toBe("");
    await Promise.resolve();
    await Promise.resolve();

    expect(cleanupObserved).toBe(true);
  });

  it("redacts configured values and known credential formats", () => {
    const redacted = redactSensitiveText(
      `request failed for ${CONFIGURED_SECRET} and ${GITHUB_TOKEN}`,
      [CONFIGURED_SECRET]
    );

    expect(redacted).toBe("request failed for [REDACTED] and [REDACTED]");
    expect(containsSensitiveMaterial(redacted, [CONFIGURED_SECRET])).toBe(false);
  });

  it.each(["s3cr3t", "x"])(
    "rejects every non-empty configured value, including %j, at persistence boundaries",
    (secret) => {
      expect(containsSensitiveMaterial(secret, [secret])).toBe(true);
      expect(redactSensitiveText(secret, [secret])).toBe("[REDACTED]");
      expect(() => normalizeSafeJson({ value: secret }, [secret])).toThrow(
        "Sensitive material is not allowed."
      );

      let message = "";
      try {
        normalizeSafeJson({ [secret]: "safe" }, [secret]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Sensitive material is not allowed.");
    }
  );

  it.each(["[REDACTED]", "R"])(
    "selects a collision-free redaction marker for configured value %j",
    (secret) => {
      const redacted = redactSensitiveText(`left${secret}right`, [secret]);

      expect(redacted).not.toContain(secret);
      expect([...redacted]).toHaveLength("leftright".length + 1);
      expect(containsSensitiveMaterial(redacted, [secret])).toBe(false);
    }
  );

  it.each([
    [
      "count",
      Array.from(
        { length: CONFIGURED_SECRET_LIMITS.maximumCount + 1 },
        (_, index) => `configured-${index}`
      )
    ],
    ["aggregate characters", ["q".repeat(CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters + 1)]]
  ] as const)("fails closed when configured-secret %s exceeds its work bound", (_, secrets) => {
    expect(containsSensitiveMaterial("ordinary", secrets)).toBe(true);
    expect(redactSensitiveText("ordinary", secrets)).toBe("");
    expect(capturedError(() => new StreamingSensitiveMaterialDetector(secrets))).toBeInstanceOf(
      RangeError
    );
    expect(() => normalizeSafeJson({ value: "ordinary" }, secrets)).toThrow(
      "Sensitive material is not allowed."
    );
  });

  it.each([
    ["configured ANSI", "configured\u001b[31msecret", ["configuredsecret"]],
    ["known ANSI", `ghp_${"A".repeat(10)}\u001b[31m${"A".repeat(10)}`, []],
    ["known C0", `ghp_${"B".repeat(10)}\u0000${"B".repeat(10)}`, []],
    ["known C1", `ghp_${"C".repeat(10)}\u009b31m${"C".repeat(10)}`, []],
    ["known OSC", `ghp_${"D".repeat(10)}\u001b]title\u0007${"D".repeat(10)}`, []]
  ] as const)(
    "fails closed while redacting a control-obfuscated %s secret",
    (_, value, secrets) => {
      const redacted = redactSensitiveText(value, secrets);

      expect(redacted).toBe("[REDACTED]");
      expect(redacted).not.toContain(value);
      expect(containsSensitiveMaterial(redacted, secrets)).toBe(false);
    }
  );

  it.each([
    ["fine-grained GitHub token", `github_pat_${"A".repeat(24)}`],
    ["GitLab token", `glpat-${"B".repeat(20)}`],
    ["Stripe live secret", `sk_live_${"C".repeat(24)}`],
    ["conservative JWT", `eyJ${"D".repeat(20)}.${"E".repeat(20)}.${"F".repeat(20)}`]
  ])("rejects and redacts the %s format at the central metadata boundary", (_, credential) => {
    expect(containsSensitiveMaterial(credential)).toBe(true);
    expect(redactSensitiveText(`value=${credential}`)).toBe("value=[REDACTED]");
    expect(SafeMetadataStringSchema.safeParse(credential).success).toBe(false);
  });

  it.each([
    ["two-byte escape", `ghp_\u001bA${"A".repeat(19)}`, []],
    ["parameterless C1 CSI", `ghp_\u009bm${"A".repeat(19)}`, []],
    ["ANSI-interleaved known credential", `ghp_${"B".repeat(10)}\u001b[31m${"B".repeat(10)}`, []],
    ["C0-interleaved known credential", `ghp_${"C".repeat(10)}\u0000${"C".repeat(10)}`, []],
    ["C1-interleaved known credential", `ghp_${"D".repeat(10)}\u009b31m${"D".repeat(10)}`, []],
    [
      "two-byte-escape configured credential",
      "configured\u001bAsecret-0123456789",
      ["configuredAsecret-0123456789"]
    ],
    [
      "control-interleaved configured credential",
      "configured-\u001b[31msecret\u0000-0123456789abcdef",
      [CONFIGURED_SECRET]
    ]
  ] as const)(
    "rejects %s through complete-text and JSON persistence boundaries",
    (_, value, secrets) => {
      expect(containsSensitiveMaterial(value, secrets)).toBe(true);
      expect(() => normalizeSafeJson({ value }, secrets)).toThrow(/sensitive/i);
    }
  );

  it("detects a known credential reconstructed by consuming a complete OSC sequence", () => {
    const token = `ghp_${"O".repeat(20)}`;
    const disguised = `${token.slice(0, 12)}\u001b]0;not/a-token?\u0007${token.slice(12)}`;

    expect(containsSensitiveMaterial(disguised)).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised })).toThrow(/sensitive/i);
  });

  it.each([
    ["C1 CSI", "\u009b"],
    ["ESC CSI", "\u001b["]
  ])("preserves the terminal OSC branch alongside nested %s detection", (_, introducer) => {
    const token = `ghp_${"A".repeat(20)}`;
    const disguised = `${token.slice(0, 14)}\u001b]!${introducer}\u0007${token.slice(14)}`;

    expect(containsSensitiveMaterial(disguised)).toBe(true);
    expect(SafeMetadataStringSchema.safeParse(disguised).success).toBe(false);
    expect(() => normalizeSafeJson({ value: disguised })).toThrow(/sensitive/i);
  });

  it.each([
    ["tab", "\t"],
    ["line feed", "\n"],
    ["carriage return", "\r"]
  ])("preserves rendered %s in the terminal projection", (_, whitespace) => {
    const secret = `configured${whitespace}secret`;
    const disguised = `configured\u001b]junk\u0007${whitespace}secret`;

    expect(containsSensitiveMaterial(disguised, [secret])).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised }, [secret])).toThrow(/sensitive/i);
  });

  it("detects configured material that uses an OSC termination backslash as data", () => {
    const secret = "configured\\secret";
    const disguised = "configured\u001b]0;window-title\u001b\\secret";

    expect(containsSensitiveMaterial(disguised, [secret])).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised }, [secret])).toThrow(/sensitive/i);
  });

  it("detects configured material requiring independent CSI-final choices", () => {
    const disguised = "configured\u001b[31Asec\u001b[31mret";

    expect(containsSensitiveMaterial(disguised, ["configuredAsecret"])).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised }, ["configuredAsecret"])).toThrow(
      /sensitive/i
    );
  });

  it("detects a known credential requiring independent CSI-final choices", () => {
    const disguised = `ghp_\u001b[31A${"A".repeat(10)}\u001b[31@${"A".repeat(9)}`;

    expect(containsSensitiveMaterial(disguised)).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised })).toThrow(/sensitive/i);
  });

  it("detects a known credential requiring a retained CSI parameter", () => {
    const disguised = `ghp_\u001b[1@${"A".repeat(19)}`;

    expect(containsSensitiveMaterial(disguised)).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised })).toThrow(/sensitive/i);
  });

  it("detects configured material reconstructed from CSI parameters", () => {
    const disguised = "configured\u001b[31Asecret";

    expect(containsSensitiveMaterial(disguised, ["configured31secret"])).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised }, ["configured31secret"])).toThrow(
      /sensitive/i
    );
  });

  it("detects configured material using a CSI introducer as data", () => {
    const disguised = "configured\u001b[msecret";

    expect(containsSensitiveMaterial(disguised, ["configured[secret"])).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised }, ["configured[secret"])).toThrow(
      /sensitive/i
    );
  });

  it("detects configured material using an OSC introducer as data", () => {
    const disguised = "configured\u001b]title\u0007secret";

    expect(containsSensitiveMaterial(disguised, ["configured]secret"])).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised }, ["configured]secret"])).toThrow(
      /sensitive/i
    );
  });

  it.each([
    ["NUL", "\u0000", "configured31secret"],
    ["TAB", "\t", "configured31secret"],
    ["DEL", "\u007f", "configured31secret"],
    ["printable non-ASCII", "é", "configured3é1secret"]
  ])("keeps detector and renderer CSI state aligned across %s", (_, embedded, secret) => {
    const disguised = `configured\u001b[3${embedded}1Asecret`;

    expect(containsSensitiveMaterial(disguised, [secret])).toBe(true);
    expect(() => normalizeSafeJson({ value: disguised }, [secret])).toThrow(/sensitive/i);
  });

  it("scans repetitive long configured values without quadratic prefix-state growth", () => {
    const secret = `${"1".repeat(8_000)}X`;
    const detector = new StreamingSensitiveMaterialDetector([secret]);

    detector.write("1".repeat(40_000));

    expect(detector.finalize()).toBe(false);
  });

  it("bounds ambiguous CSI matching for a repetitive long configured value", () => {
    const secret = `prefix${"1".repeat(8_000)}X`;
    const detector = new StreamingSensitiveMaterialDetector([secret]);

    detector.write("prefix\u001b[");
    detector.write("1".repeat(8_000));
    detector.write("X");

    expect(detector.finalize()).toBe(true);
  });

  // Scan-work bound: this case drives the redaction scanner over a long ambiguous CSI sequence to
  // prove the memo table bounds the work, and measures ~0.3s on an unconstrained dev machine. CI
  // runs `pnpm test:coverage` on a 2-vCPU runner with V8 coverage instrumentation while every
  // workspace package tests in parallel, which stretches it past the 5s default.
  it(
    "memoizes repeated high-prefix mismatches in an ambiguous CSI sequence",
    { timeout: 15_000 },
    () => {
      const detector = new StreamingSensitiveMaterialDetector([`${"1".repeat(8_000)}X`]);

      detector.write("1".repeat(8_000));
      detector.write("\u001b[");
      detector.write("2".repeat(400_000));

      expect(detector.finalize()).toBe(false);
    }
  );

  it.each([
    ["parameterized ESC CSI known credential", `ghp_\u001b[31A${"G".repeat(19)}`, []],
    ["parameterized C1 CSI known credential", `ghp_\u009b31A${"H".repeat(19)}`, []],
    [
      "parameterized ESC CSI configured credential",
      "configured\u001b[31Asecret",
      ["configuredAsecret"]
    ],
    [
      "parameterized C1 CSI configured credential",
      "configured\u009b31Asecret",
      ["configuredAsecret"]
    ],
    [
      "terminal-consumed parameterless configured credential",
      "configured\u009bmsecret",
      ["configuredsecret"]
    ],
    [
      "terminal-consumed parameterless known credential",
      `ghp_${"I".repeat(10)}\u009b~${"I".repeat(10)}`,
      []
    ],
    [
      "terminal-consumed CSI inside an OSC configured credential",
      "\u001b]0;os\u001b[31mc-secret\u0007",
      ["osc-secret"]
    ],
    ["ESC restarted by C1 CSI", "configured\u001b\u009bmsecret", ["configuredsecret"]],
    [
      "parameterized CSI restarted by C1 CSI",
      "configured\u001b[31\u009bmsecret",
      ["configuredsecret"]
    ],
    [
      "parameterized CSI restarted by ESC CSI",
      "configured\u001b[31\u001b[msecret",
      ["configuredsecret"]
    ]
  ] as const)(
    "checks parallel terminal and conservative projections for %s",
    (_, value, secrets) => {
      expect(containsSensitiveMaterial(value, secrets)).toBe(true);
      expect(() => normalizeSafeJson({ value }, secrets)).toThrow(/sensitive/i);
    }
  );

  it.each([
    ["space", " "],
    ["tab", "\t"],
    ["line feed", "\n"],
    ["vertical tab", "\v"],
    ["form feed", "\f"],
    ["carriage return", "\r"],
    ["non-breaking space", "\u00a0"],
    ["Ogham space mark", "\u1680"],
    ["en quad", "\u2000"],
    ["hair space", "\u200a"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["narrow no-break space", "\u202f"],
    ["medium mathematical space", "\u205f"],
    ["ideographic space", "\u3000"],
    ["byte-order mark", "\ufeff"]
  ])("recognizes a Bearer token separated by ECMAScript %s", (_, whitespace) => {
    expect(containsSensitiveMaterial(`Bearer${whitespace}${"Z".repeat(20)}`)).toBe(true);
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

  it.each([
    ["direct", { safe: "s3cr3t" }],
    ["nested", { safe: { nested: "s3cr3t" } }]
  ])("reuses a one-shot configured-values snapshot for a %s secret value", (_, value) => {
    function* configuredValues(): Generator<string> {
      yield "s3cr3t";
    }

    expect(() =>
      normalizeSafeJson(value, configuredValues() as unknown as readonly string[])
    ).toThrow("Sensitive material is not allowed.");
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

  it("rejects a sensitive accessor key before exposing its key or invoking its getter", () => {
    let reads = 0;
    const value = {};
    Object.defineProperty(value, CONFIGURED_SECRET, {
      enumerable: true,
      get: () => {
        reads += 1;
        return "safe";
      }
    });

    let message = "";
    try {
      normalizeSafeJson({ nested: value }, [CONFIGURED_SECRET]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Sensitive material is not allowed.");
    expect(message).not.toContain(CONFIGURED_SECRET);
    expect(message).not.toContain("nested");
    expect(reads).toBe(0);
  });

  it("does not expose a sensitive non-JSON array property key", () => {
    const value = ["safe"];
    Object.defineProperty(value, GITHUB_TOKEN, { enumerable: true, value: "safe" });

    let message = "";
    try {
      normalizeSafeJson(value);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Sensitive material is not allowed.");
    expect(message).not.toContain(GITHUB_TOKEN);
  });

  it("rejects a canonical numeric array property outside the captured length", () => {
    const key = "4294967295";
    const value: unknown[] = [];
    Object.defineProperty(value, key, {
      enumerable: true,
      value: CONFIGURED_SECRET
    });

    let message = "";
    try {
      normalizeSafeJson(value, [CONFIGURED_SECRET]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Non-JSON array properties are not allowed.");
    expect(message).not.toContain(key);
    expect(message).not.toContain(CONFIGURED_SECRET);
  });

  it("uses a static path-free error for an ordinary hostile accessor", () => {
    let reads = 0;
    const value = { nested: {} };
    Object.defineProperty(value.nested, "hostileGetter", {
      enumerable: true,
      get: () => {
        reads += 1;
        return CONFIGURED_SECRET;
      }
    });

    let message = "";
    try {
      normalizeSafeJson(value, [CONFIGURED_SECRET]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("JSON accessors are not allowed.");
    expect(message).not.toContain("hostileGetter");
    expect(message).not.toContain("nested");
    expect(reads).toBe(0);
  });

  it("sanitizes exceptions thrown by hostile reflection traps", () => {
    const value = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(CONFIGURED_SECRET);
        }
      }
    );

    let message = "";
    try {
      normalizeSafeJson(value, [CONFIGURED_SECRET]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Unable to inspect JSON safely.");
    expect(message).not.toContain(CONFIGURED_SECRET);
  });

  it("classifies hostile thrown proxies without invoking their traps", () => {
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(CONFIGURED_SECRET);
        }
      }
    );
    const value = new Proxy(
      {},
      {
        ownKeys: () => {
          throw hostileError;
        }
      }
    );

    let message = "";
    try {
      normalizeSafeJson(value, [CONFIGURED_SECRET]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Unable to inspect JSON safely.");
    expect(message).not.toContain(CONFIGURED_SECRET);
  });

  it("rematerializes a static error when a mutated prior validation error is replayed", () => {
    let prior: unknown;
    try {
      normalizeSafeJson({ value: undefined });
    } catch (error) {
      prior = error;
    }
    expect(prior).toBeInstanceOf(TypeError);
    if (!(prior instanceof Error)) throw new Error("Expected a validation error.");
    prior.name = CONFIGURED_SECRET;
    prior.message = CONFIGURED_SECRET;
    Object.defineProperty(prior, "cause", { value: CONFIGURED_SECRET });
    Object.defineProperty(prior, "leakedPath", { value: CONFIGURED_SECRET });
    const value = new Proxy(
      {},
      {
        ownKeys: () => {
          throw prior;
        }
      }
    );

    const replayed = (() => {
      try {
        normalizeSafeJson(value, [CONFIGURED_SECRET]);
      } catch (error) {
        return error;
      }
      throw new Error("Expected replayed validation to fail.");
    })();

    expect(replayed).not.toBe(prior);
    expect(replayed).toBeInstanceOf(TypeError);
    if (!(replayed instanceof Error)) throw new Error("Expected a rematerialized error.");
    expect(replayed.name).toBe("TypeError");
    expect(replayed.message).toBe("Unable to inspect JSON safely.");
    expect(Object.hasOwn(replayed, "cause")).toBe(false);
    expect(Reflect.ownKeys(replayed).map((key) => String(key))).not.toContain(CONFIGURED_SECRET);
    expect([replayed.name, replayed.message, replayed.stack].join(" ")).not.toContain(
      CONFIGURED_SECRET
    );
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
