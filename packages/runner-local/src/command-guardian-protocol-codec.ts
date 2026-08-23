import type { SafeJsonValue } from "@autostack/contracts";

import type { GuardianHostControl } from "./command-guardian.js";
import { snapshotSafeJson } from "./command-guardian-bounds.js";
import { MAXIMUM_GUARDIAN_ENVELOPE_BYTES, MAXIMUM_GUARDIAN_INPUT_BYTES } from "./pty.js";

export type HostToGuardianPayload =
  | GuardianHostControl
  | Readonly<{
      readonly type: "host.lease_transfer";
      readonly bindingDigest: string;
      readonly receiptDigest: string;
    }>
  | Readonly<{ readonly type: "host.event_ack"; readonly sequence: number }>
  | Readonly<{ readonly type: "host.protocol_failure"; readonly reason: "protocol_failure" }>;

export const exactProtocolKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};

const isRecord = (value: SafeJsonValue): value is Readonly<Record<string, SafeJsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseHostPayload = (input: unknown): HostToGuardianPayload => {
  const value = snapshotSafeJson(input, MAXIMUM_GUARDIAN_ENVELOPE_BYTES);
  if (!isRecord(value) || typeof value.type !== "string") throw new TypeError();
  if (value.type === "host.lease_transfer") {
    if (
      !exactProtocolKeys(value, ["type", "bindingDigest", "receiptDigest"]) ||
      typeof value.bindingDigest !== "string" ||
      typeof value.receiptDigest !== "string"
    ) {
      throw new TypeError();
    }
  } else if (value.type === "host.input") {
    if (
      !exactProtocolKeys(value, ["type", "value"]) ||
      typeof value.value !== "string" ||
      Buffer.byteLength(value.value) > MAXIMUM_GUARDIAN_INPUT_BYTES
    ) {
      throw new TypeError();
    }
  } else if (value.type === "host.resize") {
    if (
      !exactProtocolKeys(value, ["type", "columns", "rows"]) ||
      typeof value.columns !== "number" ||
      typeof value.rows !== "number"
    ) {
      throw new TypeError();
    }
  } else if (value.type === "host.cancel") {
    if (
      !exactProtocolKeys(value, ["type", "reason", "requestDigest", "decidedAt"]) ||
      value.reason !== "user" ||
      typeof value.requestDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
      typeof value.decidedAt !== "string" ||
      new Date(value.decidedAt).toISOString() !== value.decidedAt
    ) {
      throw new TypeError();
    }
  } else if (value.type === "host.protocol_failure") {
    if (
      !exactProtocolKeys(value, ["type", "reason"]) ||
      (value.reason !== "output_quarantined" && value.reason !== "protocol_failure")
    ) {
      throw new TypeError();
    }
  } else if (value.type === "host.interrupt") {
    if (!exactProtocolKeys(value, ["type"])) throw new TypeError();
  } else if (value.type === "host.event_ack") {
    if (
      !exactProtocolKeys(value, ["type", "sequence"]) ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 1
    ) {
      throw new TypeError();
    }
  } else {
    throw new TypeError();
  }
  return value as HostToGuardianPayload;
};
