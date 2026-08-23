import { captureGuardianMethod } from "./command-guardian-bounds.js";
import { GuardianRuntime } from "./command-guardian.js";
import { admitGuardianLaunchOptions } from "./command-guardian-admission.js";
import {
  GuardianSupervisionError,
  type CommandGuardianLaunchOptions,
  type GuardianHostSession
} from "./command-guardian-types.js";

const closeCapturedLease = (options: CommandGuardianLaunchOptions): void => {
  try {
    if (utilTypes.isProxy(options)) return;
    const descriptor = Reflect.getOwnPropertyDescriptor(options, "acquiredLease");
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined)
      return;
    const close = captureGuardianMethod(descriptor.value, "close")!;
    Reflect.apply(close, undefined, []);
  } catch {
    // Invalid bootstrap state never authorizes another cleanup target.
  }
};

export class CommandGuardian {
  static async launch(options: CommandGuardianLaunchOptions): Promise<GuardianHostSession> {
    let admitted: CommandGuardianLaunchOptions;
    try {
      admitted = admitGuardianLaunchOptions(options);
    } catch {
      closeCapturedLease(options);
      throw new TypeError("Guardian bootstrap is invalid.");
    }
    const runtime = new GuardianRuntime(admitted);
    void runtime.closed.catch(() => undefined);
    await runtime.start();
    return runtime;
  }
}

export { GuardianSupervisionError };
import { types as utilTypes } from "node:util";
