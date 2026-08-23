import type { CommandId, EnvironmentId } from "@autostack/contracts";

import type { EnvironmentQuiescenceLease } from "./worktree-manager.js";

export type CommandActivityErrorCode =
  "closed" | "environment_active" | "environment_quiescing" | "unsafe_state";

const ACTIVITY_ERROR_MESSAGES: Readonly<Record<CommandActivityErrorCode, string>> = Object.freeze({
  closed: "Command admission is closed.",
  environment_active: "The environment already has an active command.",
  environment_quiescing: "The environment is quiescing.",
  unsafe_state: "The command activity state is unsafe."
});

export class CommandActivityError extends Error {
  readonly code: CommandActivityErrorCode;

  constructor(code: CommandActivityErrorCode) {
    super(ACTIVITY_ERROR_MESSAGES[code]);
    this.name = "CommandActivityError";
    this.code = code;
    Object.freeze(this);
  }
}

const trustedActivityErrors = new WeakSet<CommandActivityError>();

const createCommandActivityError = (code: CommandActivityErrorCode): CommandActivityError => {
  const error = new CommandActivityError(code);
  trustedActivityErrors.add(error);
  return error;
};

export const isTrustedCommandActivityError = (error: unknown): error is CommandActivityError =>
  typeof error === "object" &&
  error !== null &&
  trustedActivityErrors.has(error as CommandActivityError);

export interface ActiveCommandLease {
  readonly environmentId: EnvironmentId;
  readonly commandId: CommandId;
  close(): Promise<void>;
}

interface EnvironmentActivity {
  activeCommandId?: CommandId;
  quiescenceHeld: boolean;
}

class ActivityLease implements ActiveCommandLease {
  readonly environmentId: EnvironmentId;
  readonly commandId: CommandId;
  readonly #release: () => void;
  #released = false;

  constructor(environmentId: EnvironmentId, commandId: CommandId, release: () => void) {
    this.environmentId = environmentId;
    this.commandId = commandId;
    this.#release = release;
    Object.freeze(this);
  }

  async close(): Promise<void> {
    if (this.#released) return;
    this.#release();
    this.#released = true;
  }
}

class QuiescenceLease implements EnvironmentQuiescenceLease {
  readonly #release: () => void;
  #released = false;

  constructor(release: () => void) {
    this.#release = release;
    Object.freeze(this);
  }

  async close(): Promise<void> {
    if (this.#released) return;
    this.#release();
    this.#released = true;
  }
}

/** Serializes command admission against destructive worktree disposal. */
export class CommandActivityCoordinator {
  readonly #activities = new Map<EnvironmentId, EnvironmentActivity>();
  #closed = false;

  async reserveCommand(
    environmentId: EnvironmentId,
    commandId: CommandId
  ): Promise<ActiveCommandLease> {
    if (this.#closed) throw createCommandActivityError("closed");
    const activity = this.#activities.get(environmentId) ?? { quiescenceHeld: false };
    if (activity.quiescenceHeld) throw createCommandActivityError("environment_quiescing");
    if (activity.activeCommandId !== undefined)
      throw createCommandActivityError("environment_active");
    activity.activeCommandId = commandId;
    this.#activities.set(environmentId, activity);
    return new ActivityLease(environmentId, commandId, () => {
      if (activity.activeCommandId !== commandId || activity.quiescenceHeld) {
        this.#closed = true;
        throw createCommandActivityError("unsafe_state");
      }
      delete activity.activeCommandId;
      if (!activity.quiescenceHeld) this.#activities.delete(environmentId);
    });
  }

  async acquireEnvironmentQuiescence(
    environmentId: EnvironmentId
  ): Promise<EnvironmentQuiescenceLease | undefined> {
    const activity = this.#activities.get(environmentId) ?? { quiescenceHeld: false };
    if (activity.activeCommandId !== undefined || activity.quiescenceHeld) return undefined;
    activity.quiescenceHeld = true;
    this.#activities.set(environmentId, activity);
    return new QuiescenceLease(() => {
      if (!activity.quiescenceHeld || activity.activeCommandId !== undefined) {
        this.#closed = true;
        throw createCommandActivityError("unsafe_state");
      }
      activity.quiescenceHeld = false;
      this.#activities.delete(environmentId);
    });
  }

  closeAdmission(): void {
    this.#closed = true;
  }
}
