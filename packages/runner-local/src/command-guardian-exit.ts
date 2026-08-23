import { admitPtyExit } from "./command-guardian-capability.js";
import type { Disposable, ProcessTreeExitProof, PtyExit } from "./pty.js";

const sameExit = (left: PtyExit, right: PtyExit): boolean =>
  left.exitCode === right.exitCode && left.signal === right.signal;

export const disposeGuardianExitIngress = (
  ingress: Disposable,
  disposables: Disposable[]
): boolean => {
  const index = disposables.indexOf(ingress);
  if (index >= 0) disposables.splice(index, 1);
  try {
    ingress.dispose();
    return true;
  } catch {
    return false;
  }
};

/** Latches callback evidence and the one immutable authoritative process-tree proof. */
export class GuardianExitAuthority {
  #observed: PtyExit | undefined;
  #proof: Extract<ProcessTreeExitProof, { readonly processTreeTerminated: true }> | undefined;
  #conflict = false;
  #sealed = false;

  constructor() {
    Object.freeze(this);
  }

  initialize(observed: PtyExit | undefined, conflict: boolean): void {
    if (observed !== undefined) this.#observed = observed;
    if (conflict) this.#conflict = true;
  }

  observe(
    input: unknown,
    sensitiveValues: readonly string[]
  ): Readonly<{
    readonly exit?: PtyExit;
    readonly first: boolean;
    readonly conflict: boolean;
    readonly ignored: boolean;
  }> {
    if (this.#sealed) {
      return Object.freeze({ first: false, conflict: false, ignored: true });
    }
    let exit: PtyExit;
    try {
      exit = admitPtyExit(input, sensitiveValues);
    } catch (error) {
      this.#conflict = true;
      throw error;
    }
    const mismatch =
      (this.#observed !== undefined && !sameExit(this.#observed, exit)) ||
      (this.#proof !== undefined && !sameExit(this.#proof.exit, exit));
    if (mismatch) this.#conflict = true;
    const first = this.#observed === undefined;
    if (first) this.#observed = exit;
    return Object.freeze({ exit, first, conflict: this.#conflict, ignored: false });
  }

  sealProof(proof: ProcessTreeExitProof | undefined): PtyExit | undefined {
    if (this.#sealed) {
      return proof?.processTreeTerminated === true &&
        this.#proof?.identityDigest === proof.identityDigest &&
        sameExit(this.#proof.exit, proof.exit)
        ? this.#proof.exit
        : undefined;
    }
    if (proof?.processTreeTerminated !== true || this.#conflict) return undefined;
    if (
      this.#proof !== undefined &&
      (this.#proof.identityDigest !== proof.identityDigest ||
        !sameExit(this.#proof.exit, proof.exit))
    ) {
      this.#conflict = true;
      return undefined;
    }
    if (this.#observed !== undefined && !sameExit(this.#observed, proof.exit)) {
      this.#conflict = true;
      return undefined;
    }
    this.#proof = Object.freeze({
      identityDigest: proof.identityDigest,
      processTreeTerminated: true,
      exit: Object.freeze({ exitCode: proof.exit.exitCode, signal: proof.exit.signal })
    });
    this.#sealed = true;
    return this.#proof.exit;
  }

  get observed(): PtyExit | undefined {
    return this.#observed;
  }

  get conflict(): boolean {
    return this.#conflict;
  }

  get proofIsCurrent(): boolean {
    return (
      this.#sealed &&
      this.#proof !== undefined &&
      !this.#conflict &&
      (this.#observed === undefined || sameExit(this.#observed, this.#proof.exit))
    );
  }

  get sealed(): boolean {
    return this.#sealed;
  }
}
