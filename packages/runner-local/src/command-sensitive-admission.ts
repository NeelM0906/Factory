import type { StartCommandRequest } from "@autostack/contracts";

import { StreamingSensitiveScanner } from "./redacted-transcript.js";
import { canonicalJson, MAXIMUM_INTENT_BYTES } from "./replay-spool-codec.js";

const MAXIMUM_COMMAND_METADATA_BYTES = MAXIMUM_INTENT_BYTES + 64 * 1_024;

interface SpawnEnvironmentValue {
  readonly name: string;
  readonly value: string;
}

interface SpawnMetadata {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: readonly SpawnEnvironmentValue[];
  readonly terminal: Readonly<{ readonly columns: number; readonly rows: number }>;
}

/** Fail-closed scan of every non-secret field that can influence durable command state. */
export const commandMetadataContainsResolvedSecret = (input: {
  readonly request: StartCommandRequest;
  readonly intent: unknown;
  readonly envelope: SpawnMetadata;
  readonly sensitiveValues: readonly string[];
}): boolean => {
  try {
    const requestedEnvironment = input.request.command.environment;
    const baselineCount = input.envelope.environment.length - requestedEnvironment.length;
    if (baselineCount < 0) return true;
    const environment = input.envelope.environment.map((actual, index) => {
      const requested = requestedEnvironment[index - baselineCount];
      if (requested?.kind === "credential_ref") {
        return {
          kind: "credential_ref",
          name: actual.name,
          credentialRefId: requested.credentialRefId
        };
      }
      return {
        kind: requested?.kind ?? "baseline",
        name: actual.name,
        value: actual.value
      };
    });
    const bytes = Buffer.from(
      canonicalJson({
        intent: input.intent,
        envelope: {
          executable: input.envelope.executable,
          args: input.envelope.args,
          cwd: input.envelope.cwd,
          environment,
          terminal: input.envelope.terminal
        }
      }),
      "utf8"
    );
    if (bytes.byteLength > MAXIMUM_COMMAND_METADATA_BYTES) return true;
    const scanner = new StreamingSensitiveScanner(input.sensitiveValues);
    scanner.write(bytes);
    return scanner.finalize();
  } catch {
    return true;
  }
};
