const invalidEvidence = (): TypeError =>
  new TypeError("Approval evidence must contain only finite JSON values.");

const encode = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidEvidence();
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw invalidEvidence();
  if (ancestors.has(value)) throw new TypeError("Approval evidence must not contain cycles.");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    }

    if (
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw invalidEvidence();
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJson = (value: unknown): string => encode(value, new Set());
