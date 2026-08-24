import { join } from "node:path";
import { createRequire } from "node:module";

import {
  ArtifactStore,
  type GuardianAuthenticatedEnvelope,
  type GuardianBootstrap
} from "@autostack/runner-local";
import {
  CommandGuardianProtocolRuntime,
  type GuardianChildRuntimeOptions
} from "@autostack/runner-local/guardian-child";

import { createNodePtySpawnAuthority, type NodePtyModule } from "./native-pty.js";
import { GuardianBootstrapRouter } from "./bootstrap-router.js";

interface GuardianBootstrapMessage {
  readonly schemaVersion: 1;
  readonly type: "guardian.bootstrap";
  readonly bootstrap: GuardianBootstrap;
}

const stagedNativeRequire = createRequire(
  join(import.meta.dirname, "../runtime/native/package.json")
);
const nodePty = stagedNativeRequire("node-pty") as NodePtyModule;
let runtime: CommandGuardianProtocolRuntime | undefined;

const send: GuardianChildRuntimeOptions["send"] = async (message, signal) => {
  if (signal.aborted || process.send === undefined || !process.connected) {
    throw new TypeError("guardian transport is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => (error === null ? resolve() : reject(error)));
  });
};

const bootstrap = async (candidate: unknown): Promise<void> => {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    (candidate as GuardianBootstrapMessage).schemaVersion !== 1 ||
    (candidate as GuardianBootstrapMessage).type !== "guardian.bootstrap"
  ) {
    throw new TypeError("invalid guardian bootstrap");
  }
  const message = candidate as GuardianBootstrapMessage;
  const artifactStore = await ArtifactStore.create({ dataRoot: message.bootstrap.dataRoot });
  runtime = await CommandGuardianProtocolRuntime.bootstrap({
    bootstrap: message.bootstrap,
    artifactStore,
    spawnAuthority: createNodePtySpawnAuthority(nodePty),
    now: () => new Date().toISOString(),
    monotonicNowMs: () => performance.now(),
    send
  });
  runtime.closed.finally(() => process.disconnect?.()).catch(() => undefined);
};

const router = GuardianBootstrapRouter.create<
  GuardianBootstrapMessage,
  GuardianAuthenticatedEnvelope<unknown>
>({
  bootstrap: async (candidate) => {
    await bootstrap(candidate);
    return runtime!;
  },
  onFailure: () => process.disconnect?.()
});

process.on("message", (candidate: unknown) => {
  void router.route(candidate as GuardianBootstrapMessage).catch(() => process.disconnect?.());
});
process.once("disconnect", () => void router.disconnect());
