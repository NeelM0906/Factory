import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { IPty } from "node-pty";

import type { SafeJsonValue } from "@autostack/contracts";

import { snapshotBytes, snapshotDataRecord, snapshotSafeJson } from "./command-guardian-bounds.js";

export interface Disposable {
  dispose(): void;
}

export interface PtyEnvironmentValue {
  readonly name: string;
  readonly value: string;
}

export interface PtySpawnRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: readonly PtyEnvironmentValue[];
  readonly terminal: Readonly<{ readonly columns: number; readonly rows: number }>;
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export type ProcessTreeExitProof =
  | Readonly<{
      readonly identityDigest: string;
      readonly processTreeTerminated: true;
      readonly exit: PtyExit;
    }>
  | Readonly<{
      readonly identityDigest: string;
      readonly processTreeTerminated: false;
      readonly exit: null;
    }>;

export interface PtySession {
  write(value: string): void;
  resize(columns: number, rows: number): void;
}

export interface PtyCapture {
  readonly onData: (chunk: Uint8Array) => void;
  readonly onEof: () => void;
  readonly onExit: (exit: PtyExit) => void;
}

/**
 * Immutable authority for exactly the process tree created by one atomic spawn. The native Task 9
 * adapter must reject PID/PGID reuse internally and honor abort before any late signal side effect.
 */
export interface BoundProcessTreeAuthority {
  readonly identityDigest: string;
  signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL", abortSignal: AbortSignal): Promise<void>;
  waitForExit(abortSignal: AbortSignal): Promise<ProcessTreeExitProof>;
}

export type BoundPtySpawnResult =
  | Readonly<{
      readonly status: "spawned";
      readonly session: PtySession;
      readonly processTree: BoundProcessTreeAuthority;
      readonly capture: Disposable;
    }>
  | Readonly<{ readonly status: "rejected" }>
  | Readonly<{
      readonly status: "uncertain";
      readonly processTree: BoundProcessTreeAuthority;
    }>;

/**
 * Synchronous, identity-bound spawn capability. Capture must be installed before the native child can
 * execute. In the same indivisible native operation, the adapter must validate the executable, cwd,
 * and private HOME/TMPDIR as canonical current-uid, private-mode, no-link identities. It must return
 * uncertain authority rather than throw after a possible spawn.
 */
export interface AtomicPtySpawnAuthority {
  spawnBound(
    input: Readonly<{
      readonly request: PtySpawnRequest;
      readonly expectedExecutableIdentityDigest: string;
      readonly expectedCwdIdentityDigest: string;
      readonly privateEnvironment: Readonly<{
        readonly home: string;
        readonly temporary: string;
      }>;
      readonly capture: PtyCapture;
    }>
  ): BoundPtySpawnResult;
}

/** Type-only native boundary. Task 9 supplies the Electron-ABI adapter. */
export type NodePtyNativeSession = IPty;

export type GuardianDirection = "host_to_guardian" | "guardian_to_host";

export interface GuardianAuthenticatedEnvelope<Payload = unknown> {
  readonly version: 1;
  readonly sessionId: string;
  readonly direction: GuardianDirection;
  readonly sequence: number;
  readonly payload: Payload;
  readonly payloadDigest: string;
  readonly hmac: string;
}

const canonicalJson = (value: SafeJsonValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
};

const guardianMacInput = (value: SafeJsonValue): string => canonicalJson(value);
export const MAXIMUM_GUARDIAN_ENVELOPE_BYTES = 64 * 1_024;
const MAXIMUM_GUARDIAN_PAYLOAD_BYTES = MAXIMUM_GUARDIAN_ENVELOPE_BYTES - 1_024;
export const MAXIMUM_GUARDIAN_INPUT_BYTES = MAXIMUM_GUARDIAN_PAYLOAD_BYTES - 256;

export const sealGuardianEnvelope = <Payload>(input: {
  readonly sessionId: string;
  readonly secret: Uint8Array;
  readonly direction: GuardianDirection;
  readonly sequence: number;
  readonly payload: Payload;
}): GuardianAuthenticatedEnvelope<Payload> => {
  try {
    const candidate = snapshotDataRecord(input, 5);
    const sessionId = candidate.sessionId;
    const direction = candidate.direction;
    const sequence = candidate.sequence;
    const secret = snapshotBytes(candidate.secret, {
      maximumBytes: 32,
      exactBytes: 32
    });
    const payload = snapshotSafeJson(candidate.payload, MAXIMUM_GUARDIAN_PAYLOAD_BYTES);
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId) ||
      (direction !== "host_to_guardian" && direction !== "guardian_to_host") ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 1
    ) {
      throw new TypeError();
    }
    const payloadBytes = canonicalJson(payload);
    if (Buffer.byteLength(payloadBytes) > MAXIMUM_GUARDIAN_PAYLOAD_BYTES) throw new TypeError();
    const payloadDigest = createHash("sha256").update(payloadBytes).digest("hex");
    const base = {
      version: 1 as const,
      sessionId,
      direction: direction as GuardianDirection,
      sequence: sequence as number,
      payload,
      payloadDigest
    };
    const sealed = {
      ...base,
      payload: payload as Payload,
      hmac: createHmac("sha256", secret).update(guardianMacInput(base)).digest("hex")
    };
    if (Buffer.byteLength(canonicalJson(sealed as never)) > MAXIMUM_GUARDIAN_ENVELOPE_BYTES) {
      throw new TypeError();
    }
    return Object.freeze(sealed);
  } catch {
    throw new TypeError("Invalid guardian envelope input.");
  }
};

export const verifyGuardianEnvelope = <Payload>(input: {
  readonly envelope: GuardianAuthenticatedEnvelope<Payload>;
  readonly secret: Uint8Array;
  readonly sessionId: string;
  readonly direction: GuardianDirection;
  readonly expectedSequence: number;
}): Payload => {
  try {
    const candidate = snapshotDataRecord(input, 5);
    const envelope = snapshotSafeJson(
      candidate.envelope,
      MAXIMUM_GUARDIAN_ENVELOPE_BYTES
    ) as unknown as GuardianAuthenticatedEnvelope<Payload>;
    const sessionId = candidate.sessionId;
    const direction = candidate.direction;
    const expectedSequence = candidate.expectedSequence;
    const secret = snapshotBytes(candidate.secret, {
      maximumBytes: 32,
      exactBytes: 32
    });
    const keys = Object.keys(envelope).sort();
    const expectedKeys = [
      "direction",
      "hmac",
      "payload",
      "payloadDigest",
      "sequence",
      "sessionId",
      "version"
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      envelope.version !== 1 ||
      envelope.sessionId !== sessionId ||
      envelope.direction !== direction ||
      envelope.sequence !== expectedSequence ||
      !/^[0-9a-f]{64}$/.test(envelope.payloadDigest) ||
      !/^[0-9a-f]{64}$/.test(envelope.hmac)
    ) {
      throw new TypeError();
    }
    const payload = envelope.payload as unknown as SafeJsonValue;
    const payloadBytes = canonicalJson(payload);
    if (
      Buffer.byteLength(payloadBytes) > MAXIMUM_GUARDIAN_PAYLOAD_BYTES ||
      Buffer.byteLength(canonicalJson(envelope as never)) > MAXIMUM_GUARDIAN_ENVELOPE_BYTES
    ) {
      throw new TypeError();
    }
    const payloadDigest = createHash("sha256").update(payloadBytes).digest("hex");
    const base = {
      version: 1 as const,
      sessionId: envelope.sessionId,
      direction: envelope.direction,
      sequence: envelope.sequence,
      payload,
      payloadDigest: envelope.payloadDigest
    };
    const expected = createHmac("sha256", secret).update(guardianMacInput(base)).digest();
    const received = Buffer.from(envelope.hmac, "hex");
    if (
      payloadDigest !== envelope.payloadDigest ||
      received.byteLength !== expected.byteLength ||
      !timingSafeEqual(received, expected)
    ) {
      throw new TypeError();
    }
    return payload as Payload;
  } catch {
    throw new TypeError("Guardian authentication failed.");
  }
};
