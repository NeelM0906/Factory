import {
  KNOWN_CREDENTIAL_SPECS,
  isKnownCredentialBodyCharacter,
  isKnownCredentialSeparatorCharacter,
  type KnownCredentialSpec
} from "@autostack/contracts";

const INTERNAL_REDACTION = "\u0000";
const IGNORED_MATCH_CONTROLS = new Set(["\r", "\n", "\t"]);
const MAX_PENDING_RENDERED_CHARACTERS = 32_768;

type TerminalState = "text" | "escape" | "csi" | "osc" | "osc_escape";

/** Removes terminal protocol bytes while retaining ordinary rendered whitespace. */
export class StreamingTerminalNormalizer {
  #state: TerminalState = "text";

  write(value: string): string {
    let result = "";
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      switch (this.#state) {
        case "text":
          if (character === "\u001b") this.#state = "escape";
          else if (character === "\u009b") this.#state = "csi";
          else if (character === "\u009d") this.#state = "osc";
          else if (
            (code < 0x20 && !IGNORED_MATCH_CONTROLS.has(character)) ||
            (code >= 0x80 && code <= 0x9f) ||
            code === 0x7f
          ) {
            // Non-rendering C0/C1 controls are intentionally discarded.
          } else result += character;
          break;
        case "escape":
          if (character === "\u001b") this.#state = "escape";
          else if (character === "\u009b") this.#state = "csi";
          else if (character === "\u009d") this.#state = "osc";
          else if (character === "[") this.#state = "csi";
          else if (character === "]") this.#state = "osc";
          else this.#state = "text";
          break;
        case "csi":
          if (character === "\u001b") this.#state = "escape";
          else if (character === "\u009b") this.#state = "csi";
          else if (character === "\u009d") this.#state = "osc";
          else if (code >= 0x40 && code <= 0x7e) this.#state = "text";
          break;
        case "osc":
          if (character === "\u0007" || character === "\u009c") this.#state = "text";
          else if (character === "\u001b") this.#state = "osc_escape";
          break;
        case "osc_escape":
          if (character === "\u001b") this.#state = "osc_escape";
          else this.#state = character === "\\" || character === "\u009c" ? "text" : "osc";
          break;
      }
    }
    return result;
  }

  finalize(): string {
    this.#state = "text";
    return "";
  }
}

interface CompactView {
  readonly value: string;
  readonly sourceStarts: readonly number[];
  readonly sourceEnds: readonly number[];
}

const compact = (value: string): CompactView => {
  let compactValue = "";
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let sourceOffset = 0;
  for (const character of value) {
    const sourceEnd = sourceOffset + character.length;
    if (character !== INTERNAL_REDACTION && !IGNORED_MATCH_CONTROLS.has(character)) {
      compactValue += character;
      for (let index = 0; index < character.length; index += 1) {
        sourceStarts.push(sourceOffset);
        sourceEnds.push(sourceEnd);
      }
    }
    sourceOffset = sourceEnd;
  }
  return { value: compactValue, sourceStarts, sourceEnds };
};

const compactConfiguredValue = (value: string): string =>
  [...value].filter((character) => !IGNORED_MATCH_CONTROLS.has(character)).join("");

interface Match {
  readonly start: number;
  readonly end: number;
  readonly continuation?: KnownCredentialSpec;
}

interface RequiredSeparatorCandidate {
  readonly spec: KnownCredentialSpec;
  holdingStart: number;
  matchStart: number;
  phase: "separator" | "body";
  bodyLength: number;
}

const configuredMatches = (value: string, sensitiveValues: readonly string[]): Match[] => {
  const matches: Match[] = [];
  for (const sensitiveValue of sensitiveValues) {
    let offset = 0;
    while (offset <= value.length - sensitiveValue.length) {
      const start = value.indexOf(sensitiveValue, offset);
      if (start < 0) break;
      matches.push({ start, end: start + sensitiveValue.length });
      offset = start + Math.max(1, sensitiveValue.length);
    }
  }
  return matches;
};

const credentialBodyStart = (
  value: string,
  prefixEnd: number,
  spec: KnownCredentialSpec
): number => {
  if (spec.separator !== "required_whitespace") return prefixEnd;
  let bodyStart = prefixEnd;
  while (isKnownCredentialSeparatorCharacter(spec, value[bodyStart] ?? "")) bodyStart += 1;
  // CR/LF/TAB interleavers are absent from this compact detection view.
  // Accepting zero visible spaces is deliberately conservative: the erased
  // control may have been the required Bearer separator.
  return bodyStart;
};

const credentialMatches = (value: string): Match[] => {
  const matches: Match[] = [];
  for (const spec of KNOWN_CREDENTIAL_SPECS) {
    let searchOffset = 0;
    while (searchOffset <= value.length - spec.prefix.length) {
      const start = value.indexOf(spec.prefix, searchOffset);
      if (start < 0) break;
      const bodyStart = credentialBodyStart(value, start + spec.prefix.length, spec);
      let end = bodyStart;
      while (end < value.length && isKnownCredentialBodyCharacter(spec, value[end] ?? "")) {
        end += 1;
      }
      if (end - bodyStart >= spec.minimumBodyLength) {
        matches.push(end === value.length ? { start, end, continuation: spec } : { start, end });
      }
      searchOffset = start + 1;
    }
  }
  return matches;
};

const mergeMatches = (matches: readonly Match[]): Match[] => {
  const sorted = [...matches].sort(
    (left, right) => left.start - right.start || right.end - left.end
  );
  const merged: Match[] = [];
  for (const match of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || match.start >= previous.end) {
      merged.push(match);
      continue;
    }
    const replacesPrevious = match.end > previous.end;
    const continuation = replacesPrevious ? match.continuation : previous.continuation;
    merged[merged.length - 1] =
      continuation === undefined
        ? {
            start: previous.start,
            end: Math.max(previous.end, match.end)
          }
        : {
            start: previous.start,
            end: Math.max(previous.end, match.end),
            continuation
          };
  }
  return merged;
};

const possibleCredentialSuffixStart = (value: string): number | undefined => {
  let earliest: number | undefined;
  for (const spec of KNOWN_CREDENTIAL_SPECS) {
    const maximumPrefix = Math.min(value.length, spec.prefix.length - 1);
    for (let length = 1; length <= maximumPrefix; length += 1) {
      const start = value.length - length;
      const suffix = value.slice(start);
      if (spec.prefix.startsWith(suffix)) {
        earliest = earliest === undefined ? start : Math.min(earliest, start);
      }
    }
    const start = value.lastIndexOf(spec.prefix);
    if (start >= 0) {
      const bodyStart = credentialBodyStart(value, start + spec.prefix.length, spec);
      const body = value.slice(bodyStart);
      const possible =
        body.length < spec.minimumBodyLength &&
        [...body].every((character) => isKnownCredentialBodyCharacter(spec, character));
      if (possible) earliest = earliest === undefined ? start : Math.min(earliest, start);
    }
  }
  return earliest;
};

const possibleConfiguredSuffixStart = (
  value: string,
  sensitiveValues: readonly string[]
): number | undefined => {
  let earliest: number | undefined;
  for (const sensitiveValue of sensitiveValues) {
    const maximum = Math.min(value.length, sensitiveValue.length - 1);
    for (let length = 1; length <= maximum; length += 1) {
      const start = value.length - length;
      if (sensitiveValue.startsWith(value.slice(start))) {
        earliest = earliest === undefined ? start : Math.min(earliest, start);
      }
    }
  }
  return earliest;
};

const codePointPrefixOffset = (value: string, count: number): number =>
  [...value].slice(0, count).join("").length;

const codePointAtOffset = (value: string, offset: number): string | undefined => {
  const code = value.codePointAt(offset);
  return code === undefined ? undefined : String.fromCodePoint(code);
};

/**
 * Redacts a stream after terminal normalization. It tracks credential prefixes
 * explicitly, so an unbounded credential body is discarded in constant space
 * after the minimum identifying prefix has been observed.
 */
export class StatefulSecretSanitizer {
  readonly #sensitiveValues: readonly string[];
  readonly #withheldCharacters: number;
  #pending = "";
  #continuation: KnownCredentialSpec | undefined;
  #continuationAwaitingBody = false;
  #requiredSeparatorCandidate: RequiredSeparatorCandidate | undefined;
  #sensitiveDetected = false;

  constructor(sensitiveValues: readonly string[], withheldCharacters: number) {
    this.#sensitiveValues = sensitiveValues
      .map(compactConfiguredValue)
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
    this.#withheldCharacters = withheldCharacters;
  }

  get sensitiveDetected(): boolean {
    return this.#sensitiveDetected;
  }

  write(value: string): string {
    this.#append(value);
    if (this.#requiredSeparatorCandidate === undefined) this.#redactCompleteMatches();
    return this.#releaseSafePrefix(false);
  }

  finalize(): string {
    this.#continuation = undefined;
    this.#continuationAwaitingBody = false;
    this.#requiredSeparatorCandidate = undefined;
    this.#redactCompleteMatches();
    return this.#releaseSafePrefix(true);
  }

  #append(value: string): void {
    if (this.#requiredSeparatorCandidate !== undefined) {
      this.#appendRequiredSeparatorCandidate(value);
      return;
    }
    if (this.#continuation === undefined) {
      this.#pending += value;
      return;
    }
    let offset = 0;
    for (const character of value) {
      offset += character.length;
      if (
        this.#continuationAwaitingBody &&
        isKnownCredentialSeparatorCharacter(this.#continuation, character)
      ) {
        continue;
      }
      if (
        this.#continuationAwaitingBody &&
        isKnownCredentialBodyCharacter(this.#continuation, character)
      ) {
        this.#continuationAwaitingBody = false;
        continue;
      }
      if (
        !this.#continuationAwaitingBody &&
        (IGNORED_MATCH_CONTROLS.has(character) ||
          isKnownCredentialBodyCharacter(this.#continuation, character))
      ) {
        continue;
      }
      this.#continuation = undefined;
      this.#continuationAwaitingBody = false;
      this.#pending += value.slice(offset - character.length);
      break;
    }
  }

  #appendRequiredSeparatorCandidate(value: string): void {
    const candidate = this.#requiredSeparatorCandidate;
    if (candidate === undefined) return;
    const previousLength = this.#pending.length;
    this.#pending += value;
    let offset = 0;
    for (const character of value) {
      offset += character.length;
      if (candidate.phase === "separator") {
        if (isKnownCredentialSeparatorCharacter(candidate.spec, character)) {
          // The separator remains a possible credential prefix.
        } else if (isKnownCredentialBodyCharacter(candidate.spec, character)) {
          candidate.phase = "body";
          candidate.bodyLength = 1;
        } else {
          this.#requiredSeparatorCandidate = undefined;
          return;
        }
      } else if (IGNORED_MATCH_CONTROLS.has(character)) {
        // Compact control interleavers do not end the candidate body.
      } else if (isKnownCredentialBodyCharacter(candidate.spec, character)) {
        candidate.bodyLength += 1;
      } else {
        this.#requiredSeparatorCandidate = undefined;
        return;
      }

      const sourceEnd = previousLength + offset;
      const complete = candidate.bodyLength >= candidate.spec.minimumBodyLength;
      const overLimit = sourceEnd - candidate.matchStart > MAX_PENDING_RENDERED_CHARACTERS;
      if (complete) {
        this.#requiredSeparatorCandidate = undefined;
        return;
      }
      if (overLimit) {
        const suffix = this.#pending.slice(sourceEnd);
        this.#pending = this.#pending.slice(0, candidate.holdingStart) + INTERNAL_REDACTION;
        this.#requiredSeparatorCandidate = undefined;
        this.#sensitiveDetected = true;
        this.#continuation = candidate.spec;
        this.#continuationAwaitingBody = candidate.phase === "separator";
        if (suffix.length > 0) this.#append(suffix);
        return;
      }
    }
  }

  #redactCompleteMatches(): void {
    const view = compact(this.#pending);
    const matches = mergeMatches([
      ...configuredMatches(view.value, this.#sensitiveValues),
      ...credentialMatches(view.value)
    ]);
    if (matches.length === 0) {
      this.#trackRequiredSeparatorCandidate(view);
      return;
    }
    this.#sensitiveDetected = true;
    const trailingContinuation = matches.find(
      (match) => match.end === view.value.length && match.continuation !== undefined
    )?.continuation;
    for (const match of [...matches].reverse()) {
      const sourceStart = view.sourceStarts[match.start];
      const sourceEnd = view.sourceEnds[match.end - 1];
      if (sourceStart === undefined || sourceEnd === undefined) continue;
      this.#pending =
        this.#pending.slice(0, sourceStart) + INTERNAL_REDACTION + this.#pending.slice(sourceEnd);
    }
    this.#continuation = trailingContinuation;
    this.#continuationAwaitingBody = false;
  }

  #trackRequiredSeparatorCandidate(view: CompactView): void {
    for (const spec of KNOWN_CREDENTIAL_SPECS) {
      if (spec.separator !== "required_whitespace") continue;
      let searchOffset = 0;
      while (searchOffset <= view.value.length - spec.prefix.length) {
        const start = view.value.indexOf(spec.prefix, searchOffset);
        if (start < 0) break;
        const matchStart = view.sourceStarts[start];
        const sourcePrefixEnd = view.sourceEnds[start + spec.prefix.length - 1];
        if (matchStart === undefined || sourcePrefixEnd === undefined) return;
        let sourceEnd = sourcePrefixEnd;
        const firstSeparator = codePointAtOffset(this.#pending, sourceEnd);
        if (
          firstSeparator === undefined ||
          !isKnownCredentialSeparatorCharacter(spec, firstSeparator)
        ) {
          searchOffset = start + 1;
          continue;
        }
        for (
          let character = codePointAtOffset(this.#pending, sourceEnd);
          character !== undefined;
        ) {
          if (!isKnownCredentialSeparatorCharacter(spec, character)) break;
          sourceEnd += character.length;
          character = codePointAtOffset(this.#pending, sourceEnd);
        }
        let bodyLength = 0;
        for (
          let character = codePointAtOffset(this.#pending, sourceEnd);
          character !== undefined;
        ) {
          if (IGNORED_MATCH_CONTROLS.has(character)) {
            sourceEnd += character.length;
            character = codePointAtOffset(this.#pending, sourceEnd);
            continue;
          }
          if (!isKnownCredentialBodyCharacter(spec, character)) break;
          bodyLength += 1;
          sourceEnd += character.length;
          character = codePointAtOffset(this.#pending, sourceEnd);
        }
        if (sourceEnd !== this.#pending.length || bodyLength >= spec.minimumBodyLength) {
          searchOffset = start + 1;
          continue;
        }
        const configuredStart = possibleConfiguredSuffixStart(view.value, this.#sensitiveValues);
        const credentialStart = possibleCredentialSuffixStart(view.value);
        const holdingCompactStart =
          configuredStart === undefined
            ? (credentialStart ?? start)
            : credentialStart === undefined
              ? Math.min(configuredStart, start)
              : Math.min(configuredStart, credentialStart, start);
        this.#requiredSeparatorCandidate = {
          spec,
          holdingStart: view.sourceStarts[holdingCompactStart] ?? matchStart,
          matchStart,
          phase: bodyLength === 0 ? "separator" : "body",
          bodyLength
        };
        return;
      }
    }
  }

  #releaseSafePrefix(final: boolean): string {
    if (final) {
      const released = this.#pending;
      this.#pending = "";
      return released;
    }
    if (this.#requiredSeparatorCandidate !== undefined) {
      const releaseOffset = this.#requiredSeparatorCandidate.holdingStart;
      if (releaseOffset === 0) return "";
      const released = this.#pending.slice(0, releaseOffset);
      this.#pending = this.#pending.slice(releaseOffset);
      this.#requiredSeparatorCandidate.holdingStart = 0;
      this.#requiredSeparatorCandidate.matchStart -= releaseOffset;
      return released;
    }
    const view = compact(this.#pending);
    const configuredStart = possibleConfiguredSuffixStart(view.value, this.#sensitiveValues);
    const credentialStart = possibleCredentialSuffixStart(view.value);
    const compactUnsafeStart =
      configuredStart === undefined
        ? credentialStart
        : credentialStart === undefined
          ? configuredStart
          : Math.min(configuredStart, credentialStart);
    const unsafeSourceStart =
      compactUnsafeStart === undefined ? undefined : view.sourceStarts[compactUnsafeStart];
    const characters = [...this.#pending];
    const tailReleaseOffset = codePointPrefixOffset(
      this.#pending,
      Math.max(0, characters.length - this.#withheldCharacters)
    );
    const releaseOffset =
      unsafeSourceStart === undefined
        ? tailReleaseOffset
        : Math.min(tailReleaseOffset, unsafeSourceStart);
    const released = this.#pending.slice(0, releaseOffset);
    this.#pending = this.#pending.slice(releaseOffset);
    if ([...this.#pending].length > MAX_PENDING_RENDERED_CHARACTERS) {
      this.#pending = [...this.#pending]
        .filter((character) => !IGNORED_MATCH_CONTROLS.has(character))
        .join("");
    }
    return released;
  }
}

export const renderRedactions = (value: string, marker: string): string =>
  value.replaceAll(INTERNAL_REDACTION, marker);
