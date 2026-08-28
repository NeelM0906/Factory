import { createHash } from "node:crypto";
import { join } from "node:path";

import type { CredentialRef } from "@autostack/contracts";

/**
 * A `macos_keychain` `CredentialRef`'s `locator` is a *reference* — a service/account pair naming
 * where the Keychain holds the secret — and this file-backed, `SecretProtector`-protected store is
 * Milestone A's local realization of that reference, not a second source of truth. The on-disk
 * filename is a digest of `store` + `locator`, so the locator is never interpreted as a path: a
 * hostile `service`/`account` value (a `../` segment, a NUL byte, a path separator) contributes only
 * to the hash input, never to a path component, so it cannot escape `root` or collide with another
 * locator's file by construction of the filesystem path.
 */
export type MacosKeychainCredentialRef = Extract<CredentialRef, { store: "macos_keychain" }>;

const CREDENTIAL_FILE_SUFFIX = ".cred";

export const credentialFileName = (ref: MacosKeychainCredentialRef): string => {
  const canonical = JSON.stringify({
    store: ref.store,
    service: ref.locator.service,
    account: ref.locator.account
  });
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${digest}${CREDENTIAL_FILE_SUFFIX}`;
};

export const credentialFilePath = (root: string, ref: MacosKeychainCredentialRef): string =>
  join(root, credentialFileName(ref));
