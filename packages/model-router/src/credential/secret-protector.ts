/**
 * Structurally identical to `apps/desktop/src/main/credential-store.ts`'s `SecretProtector`, and
 * deliberately re-declared: `packages/model-router` must not import from `apps/desktop`, and hoisting
 * the interface into `@autostack/contracts` is not S3's to do. Wave 2 wires the desktop main process
 * to this store and reconciles the two declarations into one; until then the duplication is the
 * boundary, not an oversight. Electron `safeStorage` satisfies this shape as-is.
 */
export interface SecretProtector {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
