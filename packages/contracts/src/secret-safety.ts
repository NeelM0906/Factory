import { z } from "zod";

export type KnownCredentialBodyClass =
  | "ascii_alphanumeric"
  | "alphanumeric_dash"
  | "alphanumeric_underscore"
  | "bearer"
  | "upper_alphanumeric"
  | "jwt";

export type KnownCredentialSeparator = "required_whitespace";

export interface KnownCredentialSpec {
  readonly prefix: string;
  readonly minimumBodyLength: number;
  readonly bodyClass: KnownCredentialBodyClass;
  readonly bodyCharacterPattern: string;
  readonly separator?: KnownCredentialSeparator;
}

const BODY_CHARACTER_PATTERNS = Object.freeze({
  ascii_alphanumeric: "[A-Za-z0-9]",
  alphanumeric_dash: "[A-Za-z0-9-]",
  alphanumeric_underscore: "[A-Za-z0-9_-]",
  bearer: "[A-Za-z0-9._~+/=-]",
  upper_alphanumeric: "[0-9A-Z]",
  jwt: "[A-Za-z0-9_.-]"
} as const satisfies Readonly<Record<KnownCredentialBodyClass, string>>);

const credentialSpec = (
  prefix: string,
  minimumBodyLength: number,
  bodyClass: KnownCredentialBodyClass,
  separator?: KnownCredentialSeparator
): KnownCredentialSpec =>
  Object.freeze({
    prefix,
    minimumBodyLength,
    bodyClass,
    bodyCharacterPattern: BODY_CHARACTER_PATTERNS[bodyClass],
    ...(separator === undefined ? {} : { separator })
  });

export const KNOWN_CREDENTIAL_SPECS: readonly KnownCredentialSpec[] = Object.freeze([
  ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((prefix) =>
    credentialSpec(prefix, 20, "ascii_alphanumeric")
  ),
  ...["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"].map((prefix) =>
    credentialSpec(prefix, 10, "alphanumeric_dash")
  ),
  credentialSpec("sk-", 16, "alphanumeric_underscore"),
  credentialSpec("xai-", 16, "alphanumeric_underscore"),
  credentialSpec("npm_", 20, "ascii_alphanumeric"),
  credentialSpec("AKIA", 16, "upper_alphanumeric"),
  credentialSpec("Bearer", 16, "bearer", "required_whitespace"),
  credentialSpec("github_pat_", 20, "alphanumeric_underscore"),
  credentialSpec("glpat-", 20, "alphanumeric_underscore"),
  credentialSpec("sk_live_", 16, "alphanumeric_underscore"),
  credentialSpec("eyJ", 16, "jwt")
]);

const isAsciiAlphaNumeric = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a);

export const isKnownCredentialBodyCharacter = (
  spec: KnownCredentialSpec,
  character: string
): boolean => {
  if (typeof character !== "string") return false;
  try {
    if ([...character].length !== 1) return false;
    const code = character.codePointAt(0) ?? -1;
    switch (spec.bodyClass) {
      case "ascii_alphanumeric":
        return isAsciiAlphaNumeric(code);
      case "alphanumeric_dash":
        return isAsciiAlphaNumeric(code) || character === "-";
      case "alphanumeric_underscore":
        return isAsciiAlphaNumeric(code) || character === "-" || character === "_";
      case "bearer":
        return isAsciiAlphaNumeric(code) || "._~+/=-".includes(character);
      case "upper_alphanumeric":
        return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a);
      case "jwt":
        return isAsciiAlphaNumeric(code) || "_.-".includes(character);
      default:
        return false;
    }
  } catch {
    return false;
  }
};

export const isEcmaScriptWhitespace = (character: string): boolean => {
  if (typeof character !== "string") return false;
  if ([...character].length !== 1) return false;
  const code = character.codePointAt(0) ?? -1;
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
};

export const isKnownCredentialSeparatorCharacter = (
  spec: KnownCredentialSpec,
  character: string
): boolean => {
  if (typeof character !== "string") return false;
  try {
    return spec.separator === "required_whitespace" && isEcmaScriptWhitespace(character);
  } catch {
    return false;
  }
};

type DetectionProjectionState = "text" | "escape" | "csi" | "osc" | "osc_escape";

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const knownCredentialPattern = (spec: KnownCredentialSpec): RegExp =>
  new RegExp(
    `${escapeRegularExpression(spec.prefix)}${spec.separator === "required_whitespace" ? "\\s+" : ""}(?:${spec.bodyCharacterPattern}){${spec.minimumBodyLength},}`,
    "gu"
  );

interface StartMatcherAction {
  readonly nextState?: number;
  readonly detects: boolean;
}

interface LiteralMatcher {
  readonly characters: readonly string[];
  readonly failure: readonly number[];
  readonly alphabet: ReadonlySet<string>;
  readonly transitions: Map<string, Map<number, number>>;
}

type SensitiveMatcherNode =
  | {
      readonly kind: "literal";
      readonly expected: string;
      readonly nextState?: number;
      readonly detects: boolean;
    }
  | {
      readonly kind: "separator";
      readonly spec: KnownCredentialSpec;
      readonly bodyState: number;
    }
  | {
      readonly kind: "body";
      readonly spec: KnownCredentialSpec;
      readonly nextState?: number;
      readonly detects: boolean;
    };

const unionMatcherStates = (left: ReadonlySet<number>, right: ReadonlySet<number>): Set<number> =>
  new Set([...left, ...right]);

interface MatcherSnapshot {
  knownStates: Set<number>;
  literalStates: Set<number>[];
}

interface ProjectionConfiguration {
  terminalState: DetectionProjectionState;
  csiReturnState: "text" | "osc";
  matcher: MatcherSnapshot;
  oscDropped?: MatcherSnapshot;
}

// Optional terminal bytes can otherwise create one KMP state per secret prefix.
// Fail closed before an adversarial control lattice can consume unbounded CPU.
const MAX_AMBIGUOUS_LITERAL_STATES = 256;
const MAX_LITERAL_TRANSITION_WORK = 32_768;

const literalFailureTable = (characters: readonly string[]): readonly number[] => {
  const failure = Array.from({ length: characters.length }, () => 0);
  let matched = 0;
  for (let index = 1; index < characters.length; index += 1) {
    while (matched > 0 && characters[index] !== characters[matched]) {
      matched = failure[matched - 1] ?? 0;
    }
    if (characters[index] === characters[matched]) matched += 1;
    failure[index] = matched;
  }
  return failure;
};

class SensitiveMaterialConfigurationError extends RangeError {
  constructor() {
    super("The sensitive-material detector configuration is invalid.");
    this.name = "SensitiveMaterialConfigurationError";
  }
}

/**
 * Stateful bounded matcher for raw text and every independently ambiguous
 * terminal-control interpretation. Matcher states collapse equivalent paths,
 * so sequential escape choices do not materialize exponentially many strings.
 */
export class StreamingSensitiveMaterialDetector {
  readonly #nodes: SensitiveMatcherNode[] = [];
  readonly #startActions = new Map<string, StartMatcherAction[]>();
  readonly #literalMatchers: LiteralMatcher[] = [];
  readonly #rawLiteralStates: number[] = [];
  #rawKnownStates = new Set<number>();
  #projectionConfigurations: ProjectionConfiguration[];
  #remainingLiteralTransitionWork = MAX_LITERAL_TRANSITION_WORK;
  #sensitiveDetected = false;

  constructor(sensitiveValues: readonly string[] = []) {
    try {
      const normalized = normalizedSecrets(sensitiveValues);
      if (normalized.exceeded) throw new SensitiveMaterialConfigurationError();
      for (const value of normalized.values) {
        const characters = [...value];
        if (characters.length > 0) this.#registerLiteral(characters);
      }
      for (const spec of KNOWN_CREDENTIAL_SPECS) this.#registerCredential(spec);
      this.#projectionConfigurations = [
        {
          terminalState: "text",
          csiReturnState: "text",
          matcher: this.#initialMatcherSnapshot()
        }
      ];
    } catch {
      throw new SensitiveMaterialConfigurationError();
    }
  }

  get sensitiveDetected(): boolean {
    return this.#sensitiveDetected;
  }

  write(value: string): void {
    if (this.#sensitiveDetected) return;
    if (typeof value !== "string") {
      this.#sensitiveDetected = true;
      return;
    }
    for (const character of value) {
      this.#advanceRawLiterals(character);
      if (this.#sensitiveDetected) return;
      this.#rawKnownStates = this.#advanceKnown(this.#rawKnownStates, character);
      if (this.#sensitiveDetected) return;
      this.#consumeProjected(character);
      if (this.#sensitiveDetected) return;
    }
  }

  finalize(): boolean {
    for (const configuration of this.#projectionConfigurations) {
      if (configuration.oscDropped !== undefined) {
        configuration.matcher = this.#unionSnapshots(
          configuration.matcher,
          configuration.oscDropped
        );
        delete configuration.oscDropped;
      }
      configuration.terminalState = "text";
    }
    return this.#sensitiveDetected;
  }

  #registerLiteral(characters: readonly string[]): void {
    this.#literalMatchers.push({
      characters,
      failure: literalFailureTable(characters),
      alphabet: new Set(characters),
      transitions: new Map()
    });
    this.#rawLiteralStates.push(0);
  }

  #registerCredential(spec: KnownCredentialSpec): void {
    const bodyStates: number[] = [];
    for (let count = spec.minimumBodyLength - 1; count >= 0; count -= 1) {
      const detects = count + 1 >= spec.minimumBodyLength;
      const nextState = bodyStates[count + 1];
      bodyStates[count] =
        this.#nodes.push({
          kind: "body",
          spec,
          detects,
          ...(detects || nextState === undefined ? {} : { nextState })
        }) - 1;
    }
    let nextState = bodyStates[0];
    if (nextState === undefined) return;
    if (spec.separator === "required_whitespace") {
      nextState = this.#nodes.push({ kind: "separator", spec, bodyState: nextState }) - 1;
    }
    const prefix = [...spec.prefix];
    for (let position = prefix.length - 1; position >= 1; position -= 1) {
      nextState =
        this.#nodes.push({
          kind: "literal",
          expected: prefix[position] ?? "",
          nextState,
          detects: false
        }) - 1;
    }
    this.#registerStart(prefix[0] ?? "", { nextState, detects: false });
  }

  #registerStart(character: string, action: StartMatcherAction): void {
    const actions = this.#startActions.get(character) ?? [];
    actions.push(action);
    this.#startActions.set(character, actions);
  }

  #advanceKnown(states: ReadonlySet<number>, character: string): Set<number> {
    const next = new Set<number>();
    for (const action of this.#startActions.get(character) ?? []) {
      if (action.detects) this.#sensitiveDetected = true;
      else if (action.nextState !== undefined) next.add(action.nextState);
    }
    for (const state of states) {
      const node = this.#nodes[state];
      if (node === undefined) continue;
      if (node.kind === "literal") {
        if (character !== node.expected) continue;
        if (node.detects) this.#sensitiveDetected = true;
        else if (node.nextState !== undefined) next.add(node.nextState);
        continue;
      }
      if (node.kind === "separator") {
        if (isKnownCredentialSeparatorCharacter(node.spec, character)) next.add(state);
        else if (isKnownCredentialBodyCharacter(node.spec, character)) {
          this.#advanceBody(node.bodyState, next);
        }
        continue;
      }
      if (isKnownCredentialBodyCharacter(node.spec, character)) {
        if (node.detects) this.#sensitiveDetected = true;
        else if (node.nextState !== undefined) next.add(node.nextState);
      }
    }
    return next;
  }

  #advanceBody(bodyState: number, next: Set<number>): void {
    const node = this.#nodes[bodyState];
    if (node?.kind !== "body") return;
    if (node.detects) this.#sensitiveDetected = true;
    else if (node.nextState !== undefined) next.add(node.nextState);
  }

  #initialMatcherSnapshot(): MatcherSnapshot {
    return {
      knownStates: new Set<number>(),
      literalStates: this.#literalMatchers.map(() => new Set([0]))
    };
  }

  #cloneSnapshot(snapshot: MatcherSnapshot): MatcherSnapshot {
    return {
      knownStates: new Set(snapshot.knownStates),
      literalStates: snapshot.literalStates.map((states) => new Set(states))
    };
  }

  #cloneConfiguration(configuration: ProjectionConfiguration): ProjectionConfiguration {
    return {
      terminalState: configuration.terminalState,
      csiReturnState: configuration.csiReturnState,
      matcher: this.#cloneSnapshot(configuration.matcher),
      ...(configuration.oscDropped === undefined
        ? {}
        : { oscDropped: this.#cloneSnapshot(configuration.oscDropped) })
    };
  }

  #advanceLiteral(matcher: LiteralMatcher, state: number, character: string): number {
    if (character === matcher.characters[state]) return state + 1;
    if (state === 0 || !matcher.alphabet.has(character)) return 0;
    const cached = matcher.transitions.get(character)?.get(state);
    if (cached !== undefined) return cached;
    let matched = state;
    while (matched > 0 && character !== matcher.characters[matched]) {
      matched = matcher.failure[matched - 1] ?? 0;
      this.#remainingLiteralTransitionWork -= 1;
      if (this.#remainingLiteralTransitionWork < 0) {
        this.#sensitiveDetected = true;
        return 0;
      }
    }
    if (character === matcher.characters[matched]) matched += 1;
    const transitions = matcher.transitions.get(character) ?? new Map<number, number>();
    if (!transitions.has(state)) {
      this.#remainingLiteralTransitionWork -= 1;
      if (this.#remainingLiteralTransitionWork < 0) {
        this.#sensitiveDetected = true;
        return 0;
      }
      transitions.set(state, matched);
      matcher.transitions.set(character, transitions);
    }
    return matched;
  }

  #advanceRawLiterals(character: string): void {
    for (let index = 0; index < this.#literalMatchers.length; index += 1) {
      const matcher = this.#literalMatchers[index];
      if (matcher === undefined) continue;
      const next = this.#advanceLiteral(matcher, this.#rawLiteralStates[index] ?? 0, character);
      if (next === matcher.characters.length) {
        this.#sensitiveDetected = true;
        return;
      }
      this.#rawLiteralStates[index] = next;
    }
  }

  #advanceLiteralSets(
    literalStates: readonly ReadonlySet<number>[],
    character: string,
    ambiguous: boolean
  ): Set<number>[] {
    return literalStates.map((states, index) => {
      const matcher = this.#literalMatchers[index];
      if (matcher === undefined) return new Set<number>();
      const next = ambiguous ? new Set(states) : new Set<number>();
      for (const state of states) {
        const advanced = this.#advanceLiteral(matcher, state, character);
        if (advanced === matcher.characters.length) {
          this.#sensitiveDetected = true;
          return next;
        }
        next.add(advanced);
        if (next.size > MAX_AMBIGUOUS_LITERAL_STATES) {
          this.#sensitiveDetected = true;
          return next;
        }
      }
      return next;
    });
  }

  #advanceSnapshot(snapshot: MatcherSnapshot, character: string, ambiguous: boolean): void {
    const advancedKnown = this.#advanceKnown(snapshot.knownStates, character);
    snapshot.knownStates = ambiguous
      ? unionMatcherStates(snapshot.knownStates, advancedKnown)
      : advancedKnown;
    snapshot.literalStates = this.#advanceLiteralSets(snapshot.literalStates, character, ambiguous);
  }

  #unionSnapshots(left: MatcherSnapshot, right: MatcherSnapshot): MatcherSnapshot {
    const literalStates = left.literalStates.map((states, index) => {
      const merged = unionMatcherStates(states, right.literalStates[index] ?? new Set<number>());
      if (merged.size > MAX_AMBIGUOUS_LITERAL_STATES) this.#sensitiveDetected = true;
      return merged;
    });
    return {
      knownStates: unionMatcherStates(left.knownStates, right.knownStates),
      literalStates
    };
  }

  #emitCandidate(configuration: ProjectionConfiguration, character: string): void {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\r" || character === "\n" || character === "\t") {
      this.#advanceSnapshot(configuration.matcher, character, true);
      return;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return;
    this.#advanceSnapshot(configuration.matcher, character, false);
  }

  #emitAmbiguousCandidate(configuration: ProjectionConfiguration, character: string): void {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return;
    this.#advanceSnapshot(configuration.matcher, character, true);
  }

  #beginOsc(configuration: ProjectionConfiguration): void {
    if (configuration.oscDropped !== undefined) {
      configuration.matcher = this.#unionSnapshots(configuration.matcher, configuration.oscDropped);
    }
    configuration.oscDropped = this.#cloneSnapshot(configuration.matcher);
    configuration.terminalState = "osc";
  }

  #finishOsc(configuration: ProjectionConfiguration, retainBackslash: boolean): void {
    configuration.matcher = this.#unionSnapshots(
      configuration.matcher,
      configuration.oscDropped ?? configuration.matcher
    );
    if (retainBackslash) this.#emitAmbiguousCandidate(configuration, "\\");
    delete configuration.oscDropped;
    configuration.terminalState = "text";
  }

  #enterCsi(configuration: ProjectionConfiguration, returnState: "text" | "osc"): void {
    configuration.terminalState = "csi";
    configuration.csiReturnState = returnState;
  }

  #mergeProjectionConfigurations(
    configurations: readonly ProjectionConfiguration[]
  ): ProjectionConfiguration[] {
    const merged = new Map<string, ProjectionConfiguration>();
    for (const configuration of configurations) {
      const key = `${configuration.terminalState}:${configuration.csiReturnState}:${configuration.oscDropped === undefined ? "open" : "osc"}`;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, configuration);
        continue;
      }
      existing.matcher = this.#unionSnapshots(existing.matcher, configuration.matcher);
      if (existing.oscDropped !== undefined && configuration.oscDropped !== undefined) {
        existing.oscDropped = this.#unionSnapshots(existing.oscDropped, configuration.oscDropped);
      }
    }
    return [...merged.values()];
  }

  #consumeConfiguration(
    configuration: ProjectionConfiguration,
    character: string
  ): ProjectionConfiguration[] {
    const code = character.codePointAt(0) ?? 0;
    switch (configuration.terminalState) {
      case "text":
        if (character === "\u001b") configuration.terminalState = "escape";
        else if (character === "\u009b") this.#enterCsi(configuration, "text");
        else if (character === "\u009d") this.#beginOsc(configuration);
        else this.#emitCandidate(configuration, character);
        break;
      case "escape":
        if (character === "\u001b") configuration.terminalState = "escape";
        else if (character === "\u009b") this.#enterCsi(configuration, "text");
        else if (character === "\u009d") this.#beginOsc(configuration);
        else if (character === "[") {
          this.#emitAmbiguousCandidate(configuration, character);
          this.#enterCsi(configuration, "text");
        } else if (character === "]") {
          this.#emitAmbiguousCandidate(configuration, character);
          this.#beginOsc(configuration);
        } else {
          configuration.terminalState = "text";
          this.#emitAmbiguousCandidate(configuration, character);
        }
        break;
      case "csi":
        if (character === "\u001b") {
          configuration.terminalState =
            configuration.csiReturnState === "osc" ? "osc_escape" : "escape";
        } else if (character === "\u009b") {
          this.#enterCsi(configuration, configuration.csiReturnState);
        } else if (character === "\u009d") this.#beginOsc(configuration);
        else if (code >= 0x40 && code <= 0x7e) {
          configuration.terminalState = configuration.csiReturnState;
          this.#emitAmbiguousCandidate(configuration, character);
        } else if (code >= 0x20 && code <= 0x3f) {
          this.#emitAmbiguousCandidate(configuration, character);
        } else if (code > 0x9f) this.#emitAmbiguousCandidate(configuration, character);
        break;
      case "osc":
        if (character === "\u0007" || character === "\u009c") {
          this.#finishOsc(configuration, false);
        } else if (character === "\u001b") configuration.terminalState = "osc_escape";
        else if (character === "\u009b") {
          const nestedCsi = this.#cloneConfiguration(configuration);
          this.#enterCsi(nestedCsi, "osc");
          return [configuration, nestedCsi];
        } else if (character === "\u009d") {
          const nestedOsc = this.#cloneConfiguration(configuration);
          this.#beginOsc(nestedOsc);
          return [configuration, nestedOsc];
        } else this.#emitCandidate(configuration, character);
        break;
      case "osc_escape":
        if (character === "\u001b") configuration.terminalState = "osc_escape";
        else if (character === "\u009b") {
          const nestedCsi = this.#cloneConfiguration(configuration);
          configuration.terminalState = "osc";
          this.#enterCsi(nestedCsi, "osc");
          return [configuration, nestedCsi];
        } else if (character === "\u009d") {
          const nestedOsc = this.#cloneConfiguration(configuration);
          configuration.terminalState = "osc";
          this.#beginOsc(nestedOsc);
          return [configuration, nestedOsc];
        } else if (character === "\u009c") this.#finishOsc(configuration, false);
        else if (character === "\\") this.#finishOsc(configuration, true);
        else if (character === "[") {
          const nestedCsi = this.#cloneConfiguration(configuration);
          configuration.terminalState = "osc";
          this.#emitAmbiguousCandidate(nestedCsi, character);
          this.#enterCsi(nestedCsi, "osc");
          return [configuration, nestedCsi];
        } else {
          configuration.terminalState = "osc";
          this.#emitAmbiguousCandidate(configuration, character);
        }
        break;
    }
    return [configuration];
  }

  #consumeProjected(character: string): void {
    const next = this.#projectionConfigurations.flatMap((configuration) =>
      this.#consumeConfiguration(configuration, character)
    );
    this.#projectionConfigurations = this.#mergeProjectionConfigurations(next);
  }
}

export const CONFIGURED_SECRET_LIMITS = Object.freeze({
  maximumCount: 256,
  maximumAggregateCharacters: 65_536
});

const DEFAULT_REDACTION_MARKER = "[REDACTED]";

interface NormalizedSecrets {
  readonly values: readonly string[];
  readonly exceeded: boolean;
}

const normalizedSecrets = (values: readonly string[]): NormalizedSecrets => {
  try {
    const normalized: string[] = [];
    let aggregateCharacters = 0;
    let inspectedValues = 0;
    const append = (value: unknown): boolean => {
      inspectedValues += 1;
      if (inspectedValues > CONFIGURED_SECRET_LIMITS.maximumCount) return false;
      if (typeof value !== "string") return false;
      if (value.length === 0) return true;
      normalized.push(value);
      aggregateCharacters += value.length;
      return (
        normalized.length <= CONFIGURED_SECRET_LIMITS.maximumCount &&
        aggregateCharacters <= CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters
      );
    };
    if (Array.isArray(values)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(values, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > CONFIGURED_SECRET_LIMITS.maximumCount
      ) {
        return { values: [], exceeded: true };
      }
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !append(descriptor.value)) {
          return { values: [], exceeded: true };
        }
      }
    } else {
      const iteratorMethod = Reflect.get(values, Symbol.iterator) as unknown;
      if (typeof iteratorMethod !== "function") return { values: [], exceeded: true };
      const iterator = Reflect.apply(iteratorMethod, values, []) as Iterator<string>;
      if (typeof iterator !== "object" || iterator === null) {
        return { values: [], exceeded: true };
      }
      let completed = false;
      try {
        while (true) {
          const nextMethod = Reflect.get(iterator, "next") as unknown;
          if (typeof nextMethod !== "function") return { values: [], exceeded: true };
          const result = Reflect.apply(nextMethod, iterator, []) as IteratorResult<unknown>;
          if (typeof result !== "object" || result === null) {
            return { values: [], exceeded: true };
          }
          if (Reflect.get(result, "done") === true) {
            completed = true;
            break;
          }
          if (!append(Reflect.get(result, "value"))) {
            return { values: [], exceeded: true };
          }
        }
      } finally {
        if (!completed) {
          try {
            const returnMethod = Reflect.get(iterator, "return") as unknown;
            if (typeof returnMethod === "function") {
              const cleanup = Reflect.apply(returnMethod, iterator, []) as unknown;
              void Promise.resolve(cleanup).catch(() => undefined);
            }
          } catch {
            // Cleanup is best effort and must not escape the fail-closed boundary.
          }
        }
      }
    }
    normalized.sort((left, right) => right.length - left.length);
    return { values: normalized, exceeded: false };
  } catch {
    return { values: [], exceeded: true };
  }
};

const markerForNormalizedSecrets = (sensitiveValues: readonly string[]): string => {
  if (sensitiveValues.every((secret) => !DEFAULT_REDACTION_MARKER.includes(secret))) {
    return DEFAULT_REDACTION_MARKER;
  }
  for (let codePoint = 0xf0000; codePoint <= 0xffffd; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (sensitiveValues.every((secret) => !candidate.includes(secret))) return candidate;
  }
  return "";
};

export const selectSensitiveRedactionMarker = (sensitiveValues: readonly string[] = []): string => {
  const normalized = normalizedSecrets(sensitiveValues);
  return normalized.exceeded ? "" : markerForNormalizedSecrets(normalized.values);
};

const redactOrdinarySensitiveText = (
  value: string,
  sensitiveValues: readonly string[],
  replacement: string
): string => {
  let redacted = value;
  for (const secret of sensitiveValues) redacted = redacted.replaceAll(secret, replacement);
  for (const spec of KNOWN_CREDENTIAL_SPECS) {
    redacted = redacted.replace(knownCredentialPattern(spec), replacement);
  }
  return redacted;
};

export const redactSensitiveText = (
  value: string,
  sensitiveValues: readonly string[] = []
): string => {
  if (typeof value !== "string") return "";
  try {
    const normalized = normalizedSecrets(sensitiveValues);
    if (normalized.exceeded) return "";
    const replacement = markerForNormalizedSecrets(normalized.values);
    const redacted = redactOrdinarySensitiveText(value, normalized.values, replacement);
    const detector = new StreamingSensitiveMaterialDetector(normalized.values);
    detector.write(redacted);
    return detector.finalize() ? replacement : redacted;
  } catch {
    return "";
  }
};

export const containsSensitiveMaterial = (
  value: string,
  sensitiveValues: readonly string[] = []
): boolean => {
  if (typeof value !== "string") return true;
  try {
    const normalized = normalizedSecrets(sensitiveValues);
    if (normalized.exceeded) return true;
    if (redactOrdinarySensitiveText(value, normalized.values, DEFAULT_REDACTION_MARKER) !== value) {
      return true;
    }
    const detector = new StreamingSensitiveMaterialDetector(normalized.values);
    detector.write(value);
    return detector.finalize();
  } catch {
    return true;
  }
};

export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SafeJsonValue[]
  | Readonly<{ [key: string]: SafeJsonValue }>;

const safeJsonValidationErrors = new WeakMap<object, string>();

const safeJsonValidationError = (message: string): TypeError => {
  const error = new TypeError(message);
  safeJsonValidationErrors.set(error, message);
  return error;
};

export function normalizeSafeJson(
  value: unknown,
  sensitiveValues: readonly string[] = []
): SafeJsonValue {
  const normalized = normalizedSecrets(sensitiveValues);
  if (normalized.exceeded) throw new TypeError("Sensitive material is not allowed.");
  const stableSensitiveValues = normalized.values;
  const active = new WeakSet<object>();
  const inspect = (candidate: unknown): SafeJsonValue => {
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if (containsSensitiveMaterial(candidate, stableSensitiveValues)) {
        throw safeJsonValidationError("Sensitive material is not allowed.");
      }
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw safeJsonValidationError("A finite number is required.");
      }
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw safeJsonValidationError("A JSON-safe value is required.");
    }
    if (active.has(candidate)) throw safeJsonValidationError("Cyclic JSON is not allowed.");
    const prototype = Object.getPrototypeOf(candidate) as object | null;
    const isArray = Array.isArray(candidate);
    if (isArray && prototype !== Array.prototype) {
      throw safeJsonValidationError("A plain JSON array prototype is required.");
    }
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw safeJsonValidationError("A plain JSON object is required.");
    }
    active.add(candidate);
    let snapshot: SafeJsonValue;
    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw safeJsonValidationError("A safe array length is required.");
      }
      const length = lengthDescriptor.value;
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key === "symbol") {
          throw safeJsonValidationError("Symbol-keyed values are not allowed.");
        }
        if (containsSensitiveMaterial(key, stableSensitiveValues)) {
          throw safeJsonValidationError("Sensitive material is not allowed.");
        }
        if (key !== "length") {
          const index = Number(key);
          if (
            !/^(0|[1-9]\d*)$/.test(key) ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= length
          ) {
            throw safeJsonValidationError("Non-JSON array properties are not allowed.");
          }
        }
      }
      const result: SafeJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (descriptor === undefined) {
          throw safeJsonValidationError("Sparse arrays are not allowed.");
        }
        if (!("value" in descriptor)) {
          throw safeJsonValidationError("JSON accessors are not allowed.");
        }
        if (descriptor.enumerable !== true) {
          throw safeJsonValidationError("Every JSON array item must be enumerable.");
        }
        result.push(visit(descriptor.value));
      }
      snapshot = Object.freeze(result);
    } else {
      const result: Record<string, SafeJsonValue> = Object.create(null) as Record<
        string,
        SafeJsonValue
      >;
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key === "symbol") {
          throw safeJsonValidationError("Symbol-keyed values are not allowed.");
        }
        if (containsSensitiveMaterial(key, stableSensitiveValues)) {
          throw safeJsonValidationError("Sensitive material is not allowed.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor?.enumerable !== true) {
          throw safeJsonValidationError("Every JSON property must be enumerable.");
        }
        if (!("value" in descriptor)) {
          throw safeJsonValidationError("JSON accessors are not allowed.");
        }
        result[key] = visit(descriptor.value);
      }
      snapshot = Object.freeze(result);
    }
    active.delete(candidate);
    return snapshot;
  };
  const visit = (candidate: unknown): SafeJsonValue => {
    try {
      return inspect(candidate);
    } catch (error) {
      if (typeof error === "object" && error !== null && safeJsonValidationErrors.has(error)) {
        throw error;
      }
      throw safeJsonValidationError("Unable to inspect JSON safely.");
    }
  };
  try {
    return visit(value);
  } catch (error) {
    const message =
      typeof error === "object" && error !== null ? safeJsonValidationErrors.get(error) : undefined;
    throw new TypeError(message ?? "Unable to inspect JSON safely.");
  }
}

export function assertSafeJson(value: unknown, sensitiveValues: readonly string[] = []): void {
  normalizeSafeJson(value, sensitiveValues);
}

export const SafeMetadataStringSchema = z
  .string()
  .min(1)
  .refine((value) => !containsSensitiveMaterial(value), "Raw credential material is forbidden.");
