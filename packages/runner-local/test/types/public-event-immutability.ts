import type { CommandRegistry } from "../../src/command-registry.js";
import type { DurableRunnerFrame } from "../../src/replay-spool.js";

type RegistrySubscriptionItem =
  ReturnType<CommandRegistry["subscribe"]> extends AsyncIterable<infer Item> ? Item : never;

const assertFrameEvidenceIsDeeplyReadonly = (frame: DurableRunnerFrame): void => {
  if (frame.event.type === "artifact.created") {
    // @ts-expect-error Durable artifact evidence is frozen recursively at runtime.
    frame.event.artifact.digest = "changed";
  }
  if (frame.event.type === "command.completed") {
    // @ts-expect-error Durable transcript evidence is frozen recursively at runtime.
    frame.event.transcript.digest = "changed";
  }
};

const assertSubscriptionEvidenceIsDeeplyReadonly = (item: RegistrySubscriptionItem): void => {
  if (item.type !== "runner.event") return;
  if (item.event.type === "artifact.created") {
    // @ts-expect-error Subscriber artifact evidence is frozen recursively at runtime.
    item.event.artifact.digest = "changed";
  }
  if (item.event.type === "command.completed") {
    // @ts-expect-error Subscriber transcript evidence is frozen recursively at runtime.
    item.event.transcript.digest = "changed";
  }
};

void assertFrameEvidenceIsDeeplyReadonly;
void assertSubscriptionEvidenceIsDeeplyReadonly;
