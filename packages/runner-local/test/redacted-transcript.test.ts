import { describe, expect, it } from "vitest";

import { CONFIGURED_SECRET_LIMITS, StreamingSensitiveMaterialDetector } from "@autostack/contracts";

import {
  RedactedTranscript,
  StreamingSecretRedactor,
  StreamingSensitiveScanner,
  type RedactedTranscriptOptions,
  type StreamingSecretRedactorOptions,
  TranscriptLimitError
} from "../src/redacted-transcript.js";
import {
  StatefulSecretSanitizer,
  StreamingTerminalNormalizer,
  renderRedactions
} from "../src/secret-stream.js";

const thrownBy = (operation: () => unknown): unknown => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to throw.");
};

const HOSTILE_ADMISSION_VALUE = "ghp_RAW_CONSTRUCTOR_SECRET /private/secret/path";

type AdmissionAttack =
  | "option getter"
  | "sensitiveValues getter"
  | "Symbol.iterator getter"
  | "iterator.next"
  | "iterator value";

const hostileFailure = (): Error => {
  const failure = new Error(HOSTILE_ADMISSION_VALUE);
  failure.name = HOSTILE_ADMISSION_VALUE;
  Object.defineProperty(failure, "cause", { value: HOSTILE_ADMISSION_VALUE });
  Object.defineProperty(failure, "leakedPath", { value: HOSTILE_ADMISSION_VALUE });
  return failure;
};

const hostileSensitiveValues = (
  attack: Exclude<AdmissionAttack, "option getter" | "sensitiveValues getter">,
  failure: Error
): readonly string[] => {
  if (attack === "Symbol.iterator getter") {
    const values = {};
    Object.defineProperty(values, Symbol.iterator, {
      get() {
        throw failure;
      }
    });
    return values as readonly string[];
  }
  if (attack === "iterator.next") {
    return {
      [Symbol.iterator]() {
        return {
          next(): IteratorResult<string> {
            throw failure;
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
              throw failure;
            }
          });
          return result as IteratorResult<string>;
        }
      };
    }
  } as unknown as readonly string[];
};

const streamingAdmissionOptions = (
  attack: AdmissionAttack,
  failure: Error
): StreamingSecretRedactorOptions => {
  if (attack === "option getter") {
    const options = {};
    Object.defineProperty(options, "withheldCharacters", {
      get() {
        throw failure;
      }
    });
    return options;
  }
  if (attack === "sensitiveValues getter") {
    const options = {};
    Object.defineProperty(options, "sensitiveValues", {
      get() {
        throw failure;
      }
    });
    return options;
  }
  return { sensitiveValues: hostileSensitiveValues(attack, failure) };
};

const transcriptAdmissionOptions = (
  attack: AdmissionAttack,
  failure: Error
): RedactedTranscriptOptions => {
  const options = {
    durableByteLimit: 128,
    liveByteLimit: 128,
    replayByteLimit: 128
  };
  if (attack === "option getter") {
    Object.defineProperty(options, "durableByteLimit", {
      get() {
        throw failure;
      }
    });
    return options;
  }
  if (attack === "sensitiveValues getter") {
    Object.defineProperty(options, "sensitiveValues", {
      get() {
        throw failure;
      }
    });
    return options;
  }
  return { ...options, sensitiveValues: hostileSensitiveValues(attack, failure) };
};

const expectSanitizedAdmissionFailure = (failure: Error, operation: () => unknown): void => {
  const received = thrownBy(operation);
  expect(received).not.toBe(failure);
  expect(received).toBeInstanceOf(RangeError);
  if (!(received instanceof Error)) throw new Error("Expected an Error instance.");
  expect(received.name).toBe("RedactionConfigurationError");
  expect(received.message).toBe("The redaction configuration is invalid.");
  expect(Object.hasOwn(received, "cause")).toBe(false);
  const ownValues = Reflect.ownKeys(received)
    .map((key) => Object.getOwnPropertyDescriptor(received, key))
    .flatMap((descriptor) =>
      descriptor !== undefined && "value" in descriptor ? [String(descriptor.value)] : []
    );
  expect([received.name, received.message, ...ownValues].join(" ")).not.toContain(
    HOSTILE_ADMISSION_VALUE
  );
};

describe("redaction constructor admission", () => {
  it.each([
    "option getter",
    "sensitiveValues getter",
    "Symbol.iterator getter",
    "iterator.next",
    "iterator value"
  ] as const)("sanitizes StreamingSecretRedactor %s failures", (attack) => {
    const failure = hostileFailure();

    expectSanitizedAdmissionFailure(failure, () => {
      new StreamingSecretRedactor(streamingAdmissionOptions(attack, failure));
    });
  });

  it.each([
    "option getter",
    "sensitiveValues getter",
    "Symbol.iterator getter",
    "iterator.next",
    "iterator value"
  ] as const)("sanitizes RedactedTranscript %s failures", (attack) => {
    const failure = hostileFailure();

    expectSanitizedAdmissionFailure(failure, () => {
      new RedactedTranscript(transcriptAdmissionOptions(attack, failure));
    });
  });

  it.each(["StreamingSecretRedactor", "RedactedTranscript"] as const)(
    "bounds and closes an infinite configured-values iterable for %s",
    (constructorName) => {
      let nextCalls = 0;
      let returnCalls = 0;
      const sensitiveValues = {
        [Symbol.iterator]() {
          return {
            next(): IteratorResult<string> {
              nextCalls += 1;
              return { done: false, value: `configured-${nextCalls}` };
            },
            return(): IteratorResult<string> {
              returnCalls += 1;
              return { done: true, value: undefined };
            }
          };
        }
      } as unknown as readonly string[];
      const failure = hostileFailure();

      expectSanitizedAdmissionFailure(failure, () => {
        if (constructorName === "StreamingSecretRedactor") {
          new StreamingSecretRedactor({ sensitiveValues });
        } else {
          new RedactedTranscript({
            durableByteLimit: 128,
            liveByteLimit: 128,
            replayByteLimit: 128,
            sensitiveValues
          });
        }
      });
      expect(nextCalls).toBeLessThanOrEqual(257);
      expect(returnCalls).toBe(1);
    }
  );

  it("observes a rejected asynchronous iterator cleanup during admission", async () => {
    let cleanupObserved = false;
    const sensitiveValues = {
      [Symbol.iterator]() {
        return {
          next() {
            return { done: false, value: "configured" };
          },
          return() {
            return {
              then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
                cleanupObserved = true;
                reject(hostileFailure());
              }
            };
          }
        };
      }
    } as unknown as readonly string[];

    expectSanitizedAdmissionFailure(hostileFailure(), () => {
      new StreamingSecretRedactor({ sensitiveValues });
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(cleanupObserved).toBe(true);
  });

  it.each([
    [
      "count",
      Array.from(
        { length: CONFIGURED_SECRET_LIMITS.maximumCount + 1 },
        (_, index) => `configured-${index}`
      )
    ],
    ["aggregate characters", ["q".repeat(CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters + 1)]]
  ] as const)("rejects configured-values arrays exceeding the %s bound", (_, sensitiveValues) => {
    for (const construct of [
      () => new StreamingSecretRedactor({ sensitiveValues }),
      () =>
        new RedactedTranscript({
          durableByteLimit: 128,
          liveByteLimit: 128,
          replayByteLimit: 128,
          sensitiveValues
        })
    ]) {
      expectSanitizedAdmissionFailure(hostileFailure(), construct);
    }
  });
});

describe("StreamingSecretRedactor", () => {
  it.each([
    ["a restarted escape", "\u001b\u001bA", ""],
    ["C1 OSC from escape", "\u001b\u009dtitle\u0007x", "x"],
    ["C1 OSC from CSI", "\u001b[31\u009dtitle\u0007x", "x"],
    ["a restarted OSC escape", "\u001b]title\u001b\u001b\\x", "x"]
  ])("normalizes %s without exposing protocol bytes", (_, input, expected) => {
    const normalizer = new StreamingTerminalNormalizer();

    expect(normalizer.write(input) + normalizer.finalize()).toBe(expected);
  });

  it("merges overlapping configured redactions into one marker", () => {
    const sanitizer = new StatefulSecretSanitizer(["abcdefgh", "bcdefgh"], 64);

    const output = sanitizer.write("abcdefgh!") + sanitizer.finalize();

    expect(renderRedactions(output, "[REDACTED]")).toBe("[REDACTED]!");
  });

  it("redacts a configured secret split across chunks before releasing output", () => {
    const redactor = new StreamingSecretRedactor({ sensitiveValues: ["top-secret-value"] });

    const output = [
      redactor.write("prefix top-se"),
      redactor.write("cret-value suffix"),
      redactor.finalize()
    ].join("");

    expect(output).toBe("prefix [REDACTED] suffix");
    expect(output).not.toContain("top-secret-value");
  });

  it("normalizes split ANSI and control sequences before scanning known credentials", () => {
    const redactor = new StreamingSecretRedactor();

    const output = [
      redactor.write("token=ghp_1234567890"),
      redactor.write("\u001b[31mABCDEFGHIJ\u001b[0"),
      redactor.write("m\u0000 done"),
      redactor.finalize()
    ].join("");

    expect(output).toBe("token=[REDACTED] done");
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0000");
  });

  it.each([
    ["known credential", `ghp_\u001bA${"A".repeat(19)}`, [], `ghp_${"A".repeat(19)}`],
    ["configured credential", "configured\u001bAsecret", ["configuredAsecret"], "configuredsecret"]
  ] as const)(
    "detects a %s whose candidate character is consumed by a valid two-byte escape",
    (_, input, sensitiveValues, expectedRendered) => {
      const redactor = new StreamingSecretRedactor({ sensitiveValues });

      const output = redactor.write(input) + redactor.finalize();

      expect(output).toBe(expectedRendered);
      expect(redactor.sensitiveDetected).toBe(true);
    }
  );

  it.each([
    ["ESC CSI known credential", `ghp_\u001b[31A${"M".repeat(19)}`, [], `ghp_${"M".repeat(19)}`],
    ["C1 CSI known credential", `ghp_\u009b31A${"N".repeat(19)}`, [], `ghp_${"N".repeat(19)}`],
    [
      "ESC CSI configured credential",
      "configured\u001b[31Asecret",
      ["configuredAsecret"],
      "configuredsecret"
    ],
    [
      "C1 CSI configured credential",
      "configured\u009b31Asecret",
      ["configuredAsecret"],
      "configuredsecret"
    ]
  ] as const)(
    "detects the final byte of a parameterized %s in the conservative projection",
    (_, input, sensitiveValues, expectedRendered) => {
      const redactor = new StreamingSecretRedactor({ sensitiveValues });

      const output = redactor.write(input) + redactor.finalize();

      expect(output).toBe(expectedRendered);
      expect(redactor.sensitiveDetected).toBe(true);
    }
  );

  it.each([
    ["ESC restarted by C1 CSI", ["configured\u001b", "\u009bmsecret"]],
    ["parameterized CSI restarted by C1 CSI", ["configured\u001b[31", "\u009bmsecret"]],
    ["parameterized CSI restarted by ESC CSI", ["configured\u001b[31", "\u001b[msecret"]]
  ] as const)("detects configured material across split %s controls", (_, chunks) => {
    const redactor = new StreamingSecretRedactor({ sensitiveValues: ["configuredsecret"] });

    const output = chunks.map((chunk) => redactor.write(chunk)).join("") + redactor.finalize();

    expect(output).toBe("[REDACTED]");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("redacts every non-empty configured secret, including short scoped values", () => {
    const redactor = new StreamingSecretRedactor({ sensitiveValues: ["s3cr3t"] });

    const output = redactor.write("pin=s3c") + redactor.write("r3t") + redactor.finalize();

    expect(output).toBe("pin=[REDACTED]");
  });

  it.each(["[REDACTED]", "R"])(
    "uses a collision-free streaming marker for configured value %j",
    (secret) => {
      const redactor = new StreamingSecretRedactor({ sensitiveValues: [secret] });

      const output =
        redactor.write(`left${secret}`) + redactor.write("right") + redactor.finalize();

      expect(output).not.toContain(secret);
      expect([...output]).toHaveLength("leftright".length + 1);
      expect(redactor.sensitiveDetected).toBe(true);
    }
  );

  it("detects configured material that uses a C1 CSI final as a candidate character", () => {
    const redactor = new StreamingSecretRedactor({ sensitiveValues: ["controlsecret"] });

    const output = redactor.write("control\u009bsecret") + redactor.finalize();

    expect(output).toBe("controlecret");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("normalizes OSC, two-character escapes, DEL, and split UTF-8 statefully", () => {
    const redactor = new StreamingSecretRedactor();
    const euro = Buffer.from("€");

    const output =
      redactor.write("a\u001b]0;window") +
      redactor.write("\u0007b\u001b7c\u007f") +
      redactor.write(euro.subarray(0, 1)) +
      redactor.write(euro.subarray(1)) +
      redactor.finalize();

    expect(output).toBe("abc€");
    expect(redactor.finalize()).toBe("");
    expect(() => redactor.write("late")).toThrow("already finalized");
  });

  it("flushes an incomplete byte sequence before a following string write", () => {
    const redactor = new StreamingSecretRedactor();

    const output = redactor.write(Uint8Array.of(0xe2)) + redactor.write("x") + redactor.finalize();

    expect(output).toBe("�x");
  });

  it("rejects unbounded redaction tails and oversized configured values", () => {
    expect(() => new StreamingSecretRedactor({ withheldCharacters: 8_193 })).toThrow(RangeError);
    expect(() => new StreamingSecretRedactor({ sensitiveValues: ["x".repeat(8_129)] })).toThrow(
      RangeError
    );
  });

  it.each([
    ["BEL", "\u001b]0;osc-secret\u0007"],
    ["ST", "\u001b]0;osc-secret\u001b\\"]
  ])("detects a configured secret inside a split OSC sequence terminated by %s", (_, osc) => {
    const redactor = new StreamingSecretRedactor({ sensitiveValues: ["osc-secret"] });

    const output =
      redactor.write(`before${osc.slice(0, 8)}`) +
      redactor.write(osc.slice(8)) +
      redactor.write("after") +
      redactor.finalize();

    expect(output).toBe("beforeafter");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("detects a known credential inside a raw OSC payload before discarding it", () => {
    const token = `ghp_${"A".repeat(20)}`;
    const redactor = new StreamingSecretRedactor();

    const output =
      redactor.write(`left\u001b]8;;https://example.test/${token.slice(0, 9)}`) +
      redactor.write(`${token.slice(9)}\u0007right`) +
      redactor.finalize();

    expect(output).toBe("leftright");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("redacts a known credential reconstructed around a complete OSC sequence", () => {
    const token = `ghp_${"Q".repeat(20)}`;
    const redactor = new StreamingSecretRedactor();

    const output =
      redactor.write(`${token.slice(0, 12)}\u001b]0;not/a-token?`) +
      redactor.write(`\u0007${token.slice(12)}`) +
      redactor.finalize();

    expect(output).toBe("[REDACTED]");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it.each([
    ["C1 CSI", "\u009b"],
    ["ESC CSI", "\u001b["]
  ])("keeps detector and terminal rendering aligned for %s inside OSC", (_, introducer) => {
    const token = `ghp_${"A".repeat(20)}`;
    const disguised = `${token.slice(0, 14)}\u001b]!${introducer}\u0007${token.slice(14)}`;
    const normalizer = new StreamingTerminalNormalizer();
    const detector = new StreamingSensitiveMaterialDetector();

    expect(normalizer.write(disguised.slice(0, 18))).toBe(token.slice(0, 14));
    expect(normalizer.write(disguised.slice(18)) + normalizer.finalize()).toBe(token.slice(14));
    detector.write(disguised.slice(0, 18));
    detector.write(disguised.slice(18));

    expect(detector.finalize()).toBe(true);
  });

  it.each([
    ["tab", "\t"],
    ["line feed", "\n"],
    ["carriage return", "\r"]
  ])("keeps split detector and terminal rendering aligned for %s", (_, whitespace) => {
    const secret = `configured${whitespace}secret`;
    const normalizer = new StreamingTerminalNormalizer();
    const detector = new StreamingSensitiveMaterialDetector([secret]);

    expect(normalizer.write("configured\u001b]junk")).toBe("configured");
    expect(normalizer.write(`\u0007${whitespace}secret`) + normalizer.finalize()).toBe(
      `${whitespace}secret`
    );
    detector.write("configured\u001b]junk");
    detector.write(`\u0007${whitespace}secret`);

    expect(detector.finalize()).toBe(true);
  });

  it("detects configured material using an OSC termination backslash as data", () => {
    const scanner = new StreamingSensitiveScanner(["configured\\secret"]);

    scanner.write("configured\u001b]0;window-title\u001b");
    scanner.write("\\secret");

    expect(scanner.finalize()).toBe(true);
  });

  it("detects configured material requiring independent CSI-final choices across chunks", () => {
    const redactor = new StreamingSecretRedactor({
      sensitiveValues: ["configuredAsecret"]
    });

    const output =
      redactor.write("configured\u001b[31") +
      redactor.write("Asec\u001b[31") +
      redactor.write("mret") +
      redactor.finalize();

    expect(output).toBe("configuredsecret");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("detects a known credential requiring independent CSI-final choices across chunks", () => {
    const scanner = new StreamingSensitiveScanner();

    scanner.write("ghp_\u001b[31");
    scanner.write(`A${"A".repeat(10)}\u001b[31`);
    scanner.write(`@${"A".repeat(9)}`);

    expect(scanner.finalize()).toBe(true);
  });

  it("detects a known credential requiring a retained CSI parameter across chunks", () => {
    const scanner = new StreamingSensitiveScanner();

    scanner.write("ghp_\u001b[");
    scanner.write(`1@${"A".repeat(19)}`);

    expect(scanner.finalize()).toBe(true);
  });

  it("detects configured material reconstructed from split CSI parameters", () => {
    const scanner = new StreamingSensitiveScanner(["configured31secret"]);

    scanner.write("configured\u001b[3");
    scanner.write("1Asecret");

    expect(scanner.finalize()).toBe(true);
  });

  it("detects configured material using a split CSI introducer as data", () => {
    const scanner = new StreamingSensitiveScanner(["configured[secret"]);

    scanner.write("configured\u001b");
    scanner.write("[msecret");

    expect(scanner.finalize()).toBe(true);
  });

  it("detects configured material using a split OSC introducer as data", () => {
    const scanner = new StreamingSensitiveScanner(["configured]secret"]);

    scanner.write("configured\u001b");
    scanner.write("]title\u0007secret");

    expect(scanner.finalize()).toBe(true);
  });

  it.each([
    ["NUL", "\u0000", "configured31secret"],
    ["TAB", "\t", "configured31secret"],
    ["DEL", "\u007f", "configured31secret"],
    ["printable non-ASCII", "é", "configured3é1secret"]
  ])("keeps split detector CSI state aligned across %s", (_, embedded, secret) => {
    const scanner = new StreamingSensitiveScanner([secret]);

    scanner.write("configured\u001b[3");
    scanner.write(`${embedded}1`);
    scanner.write("Asecret");

    expect(scanner.finalize()).toBe(true);
  });

  it("scans repetitive long configured values without quadratic prefix-state growth", () => {
    const scanner = new StreamingSensitiveScanner([`${"1".repeat(8_000)}X`]);

    scanner.write("1".repeat(40_000));

    expect(scanner.finalize()).toBe(false);
  });

  it("bounds split ambiguous CSI matching for a repetitive long configured value", () => {
    const scanner = new StreamingSensitiveScanner([`prefix${"1".repeat(8_000)}X`]);

    scanner.write("prefix\u001b[");
    scanner.write("1".repeat(8_000));
    scanner.write("X");

    expect(scanner.finalize()).toBe(true);
  });

  it("memoizes repeated high-prefix mismatches in a split ambiguous CSI sequence", () => {
    const detector = new StreamingSensitiveMaterialDetector([`${"1".repeat(8_000)}X`]);

    detector.write("1".repeat(8_000));
    detector.write("\u001b[");
    detector.write("2".repeat(400_000));

    expect(detector.finalize()).toBe(false);
  });

  it("treats C1 CSI as a complete control sequence instead of exposing its parameters", () => {
    const redactor = new StreamingSecretRedactor({ sensitiveValues: ["controlsecret"] });

    const output = redactor.write("control\u009b31msecret") + redactor.finalize();

    expect(output).toBe("[REDACTED]");
  });

  it("consumes the immediate final byte of a parameterless C1 CSI", () => {
    const redactor = new StreamingSecretRedactor();

    const output = redactor.write("a\u009bmb") + redactor.finalize();

    expect(output).toBe("ab");
  });

  it("conservatively detects a credential character consumed as a C1 CSI final", () => {
    const redactor = new StreamingSecretRedactor();

    const output = redactor.write(`ghp_\u009bm${"A".repeat(19)}`) + redactor.finalize();

    expect(output).toBe(`ghp_${"A".repeat(19)}`);
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("detects credentials in C1 OSC payloads terminated by C1 ST", () => {
    const token = `glpat-${"B".repeat(20)}`;
    const redactor = new StreamingSecretRedactor();

    const output = redactor.write(`a\u009dtitle=${token}\u009cb`) + redactor.finalize();

    expect(output).toBe("ab");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("redacts configured material interleaved by whitespace and terminal controls", () => {
    const redactor = new StreamingSecretRedactor({ sensitiveValues: ["alphaSecret"] });

    const output =
      redactor.write("al\rph\ta\nSe\u001b[31mcr") +
      redactor.write("\u001b[0met") +
      redactor.finalize();

    expect(output).toBe("[REDACTED]");
  });

  it("redacts known credentials interleaved by whitespace and terminal controls", () => {
    const token = `ghp_${"C".repeat(20)}`;
    const disguised = `${token.slice(0, 6)}\r${token.slice(6, 12)}\t\u001b[32m${token.slice(12, 19)}\n${token.slice(19)}\u001b[0m`;
    const redactor = new StreamingSecretRedactor();

    const output =
      redactor.write(disguised.slice(0, 18)) +
      redactor.write(disguised.slice(18)) +
      redactor.finalize();

    expect(output).toBe("[REDACTED]");
  });

  it("redacts a Bearer credential whose required separator is a normalized control", () => {
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const output =
      redactor.write(`Bearer\n${"K".repeat(9)}`) +
      redactor.write(`${"K".repeat(11)} boundary`) +
      redactor.finalize();

    expect(output).toBe("[REDACTED] boundary");
  });

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
  ])("redacts a Bearer credential separated by ECMAScript %s", (_, whitespace) => {
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const output =
      redactor.write(`Bearer${whitespace}${"L".repeat(7)}`) +
      redactor.write(`${"L".repeat(13)} boundary`) +
      redactor.finalize();

    expect(output).toBe("[REDACTED] boundary");
  });

  it("never releases a prefix of an unfinished credential run longer than the redaction tail", () => {
    const credential = `Bearer ${"D".repeat(9_000)}`;
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });
    const outputs: string[] = [];

    for (let offset = 0; offset < credential.length; offset += 137) {
      outputs.push(redactor.write(credential.slice(offset, offset + 137)));
    }
    outputs.push(redactor.write(" boundary"), redactor.finalize());
    const output = outputs.join("");

    expect(output).toBe("[REDACTED] boundary");
    expect(output).not.toContain("D".repeat(16));
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("bounds an unfinished Bearer candidate followed by an arbitrarily long separator", () => {
    const separator = " \u00a0\u2028\u2029".repeat(100_000);
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });
    const outputs: string[] = [];

    outputs.push(redactor.write("Bearer"));
    for (let offset = 0; offset < separator.length; offset += 137) {
      outputs.push(redactor.write(separator.slice(offset, offset + 137)));
    }

    expect(redactor.sensitiveDetected).toBe(true);
    outputs.push(redactor.finalize());
    expect(outputs.join("")).toBe("[REDACTED]");
  });

  it("preserves a benign Bearer phrase below the credential body threshold", () => {
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const output = redactor.write("Use Bearer token auth.") + redactor.finalize();

    expect(output).toBe("Use Bearer token auth.");
    expect(redactor.sensitiveDetected).toBe(false);
  });

  it("releases safe text before an unfinished Bearer separator candidate", () => {
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const first = redactor.write("safe-prefix Bearer ");
    const output = first + redactor.write(": boundary") + redactor.finalize();

    expect(first).toBe("safe-prefix ");
    expect(output).toBe("safe-prefix Bearer : boundary");
    expect(redactor.sensitiveDetected).toBe(false);
  });

  it("preserves a short Bearer body with compact controls before its boundary", () => {
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const output =
      redactor.write("Bearer short") + redactor.write("\r\n\t: boundary") + redactor.finalize();

    expect(output).toBe("Bearer short\r\n\t: boundary");
    expect(redactor.sensitiveDetected).toBe(false);
  });

  it("processes the suffix of an over-limit Bearer separator without rescanning it", () => {
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const output =
      redactor.write("Bearer ") +
      redactor.write(`${" ".repeat(32_769)}: boundary`) +
      redactor.finalize();

    expect(output).toBe("[REDACTED]: boundary");
    expect(redactor.sensitiveDetected).toBe(true);
  });

  it("preserves a boundary-terminated benign Bearer phrase in a large chunk", () => {
    const input = `${"x".repeat(33_000)} Use Bearer token auth.`;
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const output = redactor.write(input) + redactor.finalize();

    expect(output).toBe(input);
    expect(redactor.sensitiveDetected).toBe(false);
  });

  it.each([
    ["fine-grained GitHub token", `github_pat_${"E".repeat(24)}`],
    ["GitLab token", `glpat-${"F".repeat(20)}`],
    ["Stripe live secret", `sk_live_${"G".repeat(24)}`]
  ])("redacts the %s format", (_, token) => {
    const redactor = new StreamingSecretRedactor({ withheldCharacters: 64 });

    const output = redactor.write(`token=${token}`) + redactor.finalize();

    expect(output).toBe("token=[REDACTED]");
    expect(redactor.sensitiveDetected).toBe(true);
  });
});

describe("StreamingSensitiveScanner", () => {
  it("detects both raw OSC credentials and control-normalized configured values", () => {
    const rawToken = `sk_live_${"H".repeat(24)}`;
    const scanner = new StreamingSensitiveScanner(["split-secret"]);

    scanner.write(`\u001b]0;${rawToken.slice(0, 12)}`);
    scanner.write(`${rawToken.slice(12)}\u0007split\r-se\u009b31mcret`);

    expect(scanner.finalize()).toBe(true);
  });

  it("detects configured material hidden by a CSI sequence inside OSC", () => {
    const scanner = new StreamingSensitiveScanner(["osc-secret"]);

    scanner.write("\u001b]0;os\u001b[31m");
    scanner.write("c-\rse\tcret\u0007");

    expect(scanner.finalize()).toBe(true);
  });

  it("detects a known credential hidden by controls inside OSC", () => {
    const token = `github_pat_${"J".repeat(24)}`;
    const scanner = new StreamingSensitiveScanner();

    scanner.write(`\u009dtitle=${token.slice(0, 14)}\u009b32m`);
    scanner.write(`${token.slice(14, 25)}\n${token.slice(25)}\u009c`);

    expect(scanner.finalize()).toBe(true);
  });

  it("does not flag ordinary terminal output", () => {
    const scanner = new StreamingSensitiveScanner(["not-present"]);

    scanner.write("build \u001b[32mcompleted\u001b[0m\n");

    expect(scanner.finalize()).toBe(false);
  });
});

describe("RedactedTranscript", () => {
  it("snapshots every constructor option exactly once", () => {
    const reads = {
      durableByteLimit: 0,
      liveByteLimit: 0,
      replayByteLimit: 0,
      sensitiveValues: 0,
      withheldCharacters: 0
    };
    const transcript = new RedactedTranscript({
      get durableByteLimit() {
        reads.durableByteLimit += 1;
        return 128;
      },
      get liveByteLimit() {
        reads.liveByteLimit += 1;
        return 128;
      },
      get replayByteLimit() {
        reads.replayByteLimit += 1;
        return 128;
      },
      get sensitiveValues() {
        reads.sensitiveValues += 1;
        return ["configured-secret"];
      },
      get withheldCharacters() {
        reads.withheldCharacters += 1;
        return 64;
      }
    });

    const result = transcript.write("configured-secret");
    const final = transcript.finalize();

    expect(Buffer.concat([result.durable, final.durable]).toString()).toBe("[REDACTED]");
    expect(reads).toEqual({
      durableByteLimit: 1,
      liveByteLimit: 1,
      replayByteLimit: 1,
      sensitiveValues: 1,
      withheldCharacters: 1
    });
  });

  it("cannot bypass the durable limit with a changing getter", () => {
    let reads = 0;
    const transcript = new RedactedTranscript({
      get durableByteLimit() {
        reads += 1;
        return reads === 1 ? 0 : Number.MAX_SAFE_INTEGER;
      },
      liveByteLimit: 16,
      replayByteLimit: 16
    });

    transcript.write("x");

    expect(thrownBy(() => transcript.finalize())).toBeInstanceOf(TranscriptLimitError);
    expect(reads).toBe(1);
  });

  it.each(["[REDACTED]", "R"])(
    "keeps transcript outputs collision-free for configured value %j",
    (secret) => {
      const transcript = new RedactedTranscript({
        durableByteLimit: 128,
        liveByteLimit: 128,
        replayByteLimit: 128,
        sensitiveValues: [secret]
      });

      const results = [transcript.write(`left${secret}right`), transcript.finalize()];
      const durable = Buffer.concat(results.map((result) => result.durable)).toString();
      const live = results.flatMap((result) => result.liveOutput).join("");
      const replay = results.flatMap((result) => result.replayOutput).join("");

      for (const output of [durable, live, replay]) {
        expect(output).not.toContain(secret);
        expect([...output]).toHaveLength("leftright".length + 1);
      }
    }
  );

  it("emits one explicit live and replay truncation while durable output continues", () => {
    const transcript = new RedactedTranscript({
      durableByteLimit: 64,
      liveByteLimit: 5,
      replayByteLimit: 7
    });

    const first = transcript.write("hello");
    const second = transcript.write(" world");
    const third = transcript.write("!");
    const final = transcript.finalize();
    const results = [first, second, third, final];

    expect(Buffer.concat(results.map((result) => result.durable))).toEqual(
      Buffer.from("hello world!")
    );
    expect(results.flatMap((result) => result.liveOutput).join("")).toBe("hello");
    expect(results.flatMap((result) => result.replayOutput).join("")).toBe("hello w");
    expect(results.flatMap((result) => result.truncations)).toEqual([
      { target: "live", byteLimit: 5 },
      { target: "replay", byteLimit: 7 }
    ]);
  });

  it("enforces the durable transcript limit after redaction", () => {
    const transcript = new RedactedTranscript({
      durableByteLimit: 3,
      liveByteLimit: 3,
      replayByteLimit: 3
    });
    transcript.write("four");

    expect(() => transcript.finalize()).toThrow(TranscriptLimitError);
  });

  it("poisons the transcript after an over-limit write without releasing rejected bytes", () => {
    const transcript = new RedactedTranscript({
      durableByteLimit: 1,
      liveByteLimit: 128,
      replayByteLimit: 128,
      withheldCharacters: 64
    });

    const failure = thrownBy(() => transcript.write("x".repeat(70)));

    expect(failure).toBeInstanceOf(TranscriptLimitError);
    if (!(failure instanceof Error)) throw new Error("Expected a transcript limit error.");
    failure.name = HOSTILE_ADMISSION_VALUE;
    failure.message = HOSTILE_ADMISSION_VALUE;
    Object.defineProperty(failure, "cause", { value: HOSTILE_ADMISSION_VALUE });
    const laterWrite = thrownBy(() => transcript.write("later"));
    const laterFinalize = thrownBy(() => transcript.finalize());

    expect(laterWrite).not.toBe(failure);
    expect(laterFinalize).not.toBe(failure);
    expect(laterFinalize).not.toBe(laterWrite);
    for (const error of [laterWrite, laterFinalize]) {
      expect(error).toBeInstanceOf(TranscriptLimitError);
      if (!(error instanceof Error)) throw new Error("Expected a rematerialized limit error.");
      expect(error.name).toBe("TranscriptLimitError");
      expect(error.message).toBe(
        "The durable redacted transcript exceeded its configured byte limit."
      );
      expect(Object.hasOwn(error, "cause")).toBe(false);
      expect([error.name, error.message, error.stack].join(" ")).not.toContain(
        HOSTILE_ADMISSION_VALUE
      );
    }
  });

  it("poisons the transcript after an over-limit finalize", () => {
    const transcript = new RedactedTranscript({
      durableByteLimit: 3,
      liveByteLimit: 128,
      replayByteLimit: 128
    });
    transcript.write("four");

    const failure = thrownBy(() => transcript.finalize());

    expect(failure).toBeInstanceOf(TranscriptLimitError);
    if (!(failure instanceof Error)) throw new Error("Expected a transcript limit error.");
    failure.message = HOSTILE_ADMISSION_VALUE;
    const laterFinalize = thrownBy(() => transcript.finalize());
    const laterWrite = thrownBy(() => transcript.write("later"));

    expect(laterFinalize).not.toBe(failure);
    expect(laterWrite).not.toBe(failure);
    expect(laterWrite).not.toBe(laterFinalize);
    expect(laterFinalize).toBeInstanceOf(TranscriptLimitError);
    expect(laterWrite).toBeInstanceOf(TranscriptLimitError);
    for (const error of [laterFinalize, laterWrite]) {
      if (!(error instanceof Error)) throw new Error("Expected a rematerialized limit error.");
      expect(error.message).toBe(
        "The durable redacted transcript exceeded its configured byte limit."
      );
      expect(error.message).not.toContain(HOSTILE_ADMISSION_VALUE);
    }
  });

  it("does not split a UTF-8 code point at a live or replay byte boundary", () => {
    const transcript = new RedactedTranscript({
      durableByteLimit: 16,
      liveByteLimit: 2,
      replayByteLimit: 3
    });
    transcript.write("€x");

    const final = transcript.finalize();

    expect(final.liveOutput).toEqual([]);
    expect(final.replayOutput).toEqual(["€"]);
    expect(final.truncations).toEqual([
      { target: "live", byteLimit: 2 },
      { target: "replay", byteLimit: 3 }
    ]);
    expect(transcript.finalize()).toEqual({
      durable: Buffer.alloc(0),
      liveOutput: [],
      replayOutput: [],
      truncations: []
    });
  });

  it.each([
    ["durableByteLimit", -1],
    ["liveByteLimit", Number.NaN],
    ["replayByteLimit", 1.5]
  ] as const)("rejects invalid %s", (key, value) => {
    expect(
      () =>
        new RedactedTranscript({
          durableByteLimit: 1,
          liveByteLimit: 1,
          replayByteLimit: 1,
          [key]: value
        })
    ).toThrow(RangeError);
  });

  it("keeps durable, live, replay, and final output coherent for a long credential", () => {
    const credential = `Bearer ${"I".repeat(9_000)}`;
    const transcript = new RedactedTranscript({
      durableByteLimit: 128,
      liveByteLimit: 128,
      replayByteLimit: 128,
      withheldCharacters: 64
    });
    const results = [
      transcript.write(credential.slice(0, 4_500)),
      transcript.write(credential.slice(4_500)),
      transcript.write(" done"),
      transcript.finalize()
    ];

    expect(Buffer.concat(results.map((result) => result.durable)).toString()).toBe(
      "[REDACTED] done"
    );
    expect(results.flatMap((result) => result.liveOutput).join("")).toBe("[REDACTED] done");
    expect(results.flatMap((result) => result.replayOutput).join("")).toBe("[REDACTED] done");
    expect(results.flatMap((result) => result.truncations)).toEqual([]);
  });
});
