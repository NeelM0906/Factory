import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DataPathPolicy,
  PathPolicyError,
  RepositoryInspectionPathPolicy
} from "../src/path-policy.js";

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-path-policy-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DataPathPolicy", () => {
  it("creates private nested state paths and opens private no-follow files", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "private", "state");
    const policy = await DataPathPolicy.create(root);

    const directory = await policy.ensureDirectory("commands/active");
    const file = await policy.openFile("commands/active/receipt.json", "wx");
    await file.writeFile("safe");
    await file.sync();
    await file.close();

    expect(await realpath(directory)).toBe(join(await realpath(root), "commands", "active"));
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, "receipt.json"))).mode & 0o777).toBe(0o600);
    expect(policy.enforcementScope).toBe("autostack_operations");
    expect(policy.namespaceMutationProtection).toBe("advisory_same_uid");
  });

  it.each([
    "/absolute",
    "../escape",
    "nested/../escape",
    "nested\\escape",
    "nested%2fescape",
    "nested%5Cescape",
    "%2e%2e/escape",
    "C:/escape",
    "nul\0byte"
  ])("rejects untrusted relative path variant %j", async (candidate) => {
    const policy = await DataPathPolicy.create(join(await temporaryRoot(), "state"));

    await expect(policy.ensureDirectory(candidate)).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "invalid_relative_path"
    });
  });

  it("rejects a symlink inside the state root that escapes outside", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const outside = join(parent, "outside");
    await mkdir(outside);
    const policy = await DataPathPolicy.create(root);
    await symlink(outside, join(root, "escape"));

    await expect(policy.ensureDirectory("escape/nested")).rejects.toMatchObject({
      code: "symlink_forbidden"
    });
  });

  it("rejects a state root that is itself a symlink", async () => {
    const parent = await temporaryRoot();
    const actual = join(parent, "actual");
    const alias = join(parent, "state");
    await mkdir(actual);
    await symlink(actual, alias);

    await expect(DataPathPolicy.create(alias)).rejects.toMatchObject({
      code: "state_root_invalid"
    });
  });

  it("rejects an existing state root reached through a symlinked parent", async () => {
    const parent = await temporaryRoot();
    const actualParent = join(parent, "actual");
    const aliasParent = join(parent, "alias");
    await mkdir(join(actualParent, "state"), { recursive: true });
    await symlink(actualParent, aliasParent);

    await expect(DataPathPolicy.create(join(aliasParent, "state"))).rejects.toMatchObject({
      code: "state_root_invalid"
    });
  });

  it("rejects a state root that is an existing regular file", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    await writeFile(root, "not a directory");

    await expect(DataPathPolicy.create(root)).rejects.toMatchObject({
      code: "state_root_invalid"
    });
  });

  it("opens existing private files for reading and rejects truncate-on-open", async () => {
    const root = join(await temporaryRoot(), "state");
    const policy = await DataPathPolicy.create(root);
    const created = await policy.openFile("value.txt", "wx");
    await created.writeFile("old");
    await created.close();
    const reader = await policy.openFile("value.txt", "r");

    await expect(reader.readFile("utf8")).resolves.toBe("old");
    await reader.close();
    await expect(policy.openFile("value.txt", "w" as never)).rejects.toMatchObject({
      code: "invalid_open_mode"
    });
    await expect(readFile(join(root, "value.txt"), "utf8")).resolves.toBe("old");
    await expect(policy.ensureDirectory(".")).resolves.toBe(await realpath(root));
  });

  it("uses O_NOFOLLOW when a final file is swapped to a symlink before open", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "outside");
    let swapped = false;
    const policy = await DataPathPolicy.create(root, {
      beforeFileOpen: async (absolutePath) => {
        if (!swapped) {
          swapped = true;
          await symlink(outside, absolutePath);
        }
      }
    });

    await expect(policy.openFile("receipts/final.json", "wx")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "symlink_forbidden"
    });
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(fsConstants.O_NOFOLLOW).toBeGreaterThan(0);
  });

  it("detects a root swap before nested directory creation without creating outside", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const moved = join(parent, "moved-state");
    const outside = join(parent, "outside");
    await mkdir(outside);
    let swapped = false;
    const policy = await DataPathPolicy.create(root, {
      beforeDirectoryCreate: async () => {
        if (swapped) return;
        swapped = true;
        await rename(root, moved);
        await symlink(outside, root);
      }
    });

    await expect(policy.ensureDirectory("nested")).rejects.toMatchObject({
      code: "path_identity_changed"
    });
    await expect(lstat(join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects an intermediate-parent swap without leaving an outside directory", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const moved = join(parent, "moved-parent");
    const outside = join(parent, "outside");
    await mkdir(outside);
    let swapped = false;
    const policy = await DataPathPolicy.create(root, {
      beforeDirectoryCreate: async ({ directoryPath }) => {
        if (swapped || !directoryPath.endsWith("/parent/child")) return;
        swapped = true;
        await rename(join(root, "parent"), moved);
        await symlink(outside, join(root, "parent"));
      }
    });

    await expect(policy.ensureDirectory("parent/child")).rejects.toMatchObject({
      code: "path_identity_changed"
    });
    await expect(lstat(join(outside, "child"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a final-open parent swap without creating or truncating outside", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const moved = join(parent, "moved-parent");
    const outside = join(parent, "outside");
    await mkdir(outside);
    let swapped = false;
    const policy = await DataPathPolicy.create(root, {
      beforeFileOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(join(root, "receipts"), moved);
        await symlink(outside, join(root, "receipts"));
      }
    });

    await expect(policy.openFile("receipts/new.json", "wx")).rejects.toMatchObject({
      code: "path_identity_changed"
    });
    await expect(lstat(join(outside, "new.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins root dev/ino/mode/nlink and rejects replacement or permission drift", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const policy = await DataPathPolicy.create(root);
    const displaced = join(parent, "displaced");
    await rename(root, displaced);
    await mkdir(root, { mode: 0o700 });

    await expect(policy.ensureDirectory("after-swap")).rejects.toMatchObject({
      code: "path_identity_changed"
    });

    const secondRoot = join(parent, "second-state");
    const secondPolicy = await DataPathPolicy.create(secondRoot);
    await chmod(secondRoot, 0o755);
    await expect(secondPolicy.ensureDirectory(".")).rejects.toMatchObject({
      code: "unsafe_permissions"
    });
  });

  it("rejects hard-linked state files", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const outside = join(parent, "outside-link");
    const policy = await DataPathPolicy.create(root);
    const file = await policy.openFile("value.txt", "wx");
    await file.writeFile("private");
    await file.close();
    await link(join(root, "value.txt"), outside);

    await expect(policy.openFile("value.txt", "r")).rejects.toMatchObject({
      code: "hardlink_forbidden"
    });
  });

  it("revalidates exact root identity and permissions during file inspection", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    const moved = join(parent, "moved-state");
    const policy = await DataPathPolicy.create(root);
    const handle = await policy.openFile("value.txt", "wx");
    await handle.close();
    await rename(root, moved);
    await mkdir(root, { mode: 0o700 });

    await expect(policy.fileExists("value.txt")).rejects.toMatchObject({
      code: "path_identity_changed"
    });

    const permissionRoot = join(parent, "permission-state");
    const permissionPolicy = await DataPathPolicy.create(permissionRoot);
    const permissionFile = await permissionPolicy.openFile("value.txt", "wx");
    await permissionFile.close();
    await chmod(permissionRoot, 0o755);
    await expect(permissionPolicy.fileExists("value.txt")).rejects.toMatchObject({
      code: "unsafe_permissions"
    });
  });

  it("returns the exact canonical path for a newly created missing root", async () => {
    const parent = await temporaryRoot();
    const requested = join(parent, "missing", "state");
    const expected = join(await realpath(parent), "missing", "state");

    const policy = await DataPathPolicy.create(requested);

    expect(policy.root).toBe(expected);
    expect(await realpath(requested)).toBe(expected);
  });

  it("admits a sibling directory created concurrently in the missing-root parent", async () => {
    const parent = await temporaryRoot();
    const requested = join(parent, "missing", "state");
    const expected = join(await realpath(parent), "missing", "state");
    let siblings = 0;

    const policy = await DataPathPolicy.create(requested, {
      beforeRootCreate: async ({ parentPath }) => {
        siblings += 1;
        await mkdir(join(parentPath, `concurrent-sibling-${siblings}`), { mode: 0o700 });
      }
    });

    expect(siblings).toBe(1);
    expect(policy.root).toBe(expected);
    expect(await realpath(requested)).toBe(expected);
  });

  it("rolls back the exact directory created through a swapped missing-root parent", async () => {
    const base = await temporaryRoot();
    const requested = join(base, "parent", "child");
    const moved = join(base, "moved-parent");
    const outside = join(base, "outside");
    await mkdir(outside, { mode: 0o700 });
    let swapped = false;

    await expect(
      DataPathPolicy.create(requested, {
        beforeRootDirectoryCreate: async ({ directoryPath }: { directoryPath: string }) => {
          if (swapped || !directoryPath.endsWith("/parent/child")) return;
          swapped = true;
          await rename(join(base, "parent"), moved);
          await symlink(outside, join(base, "parent"));
        }
      } as never)
    ).rejects.toMatchObject({ code: "path_identity_changed" });

    expect(swapped).toBe(true);
    await expect(lstat(join(outside, "child"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sanitizes hostile relative-path accessors at the public boundary", async () => {
    const parent = await temporaryRoot();
    const secret = join(parent, "must-not-leak");
    const policy = await DataPathPolicy.create(join(parent, "state"));
    const hostile = Object.defineProperty({}, "length", {
      get() {
        throw new Error(secret);
      }
    });

    const error = await policy.ensureDirectory(hostile as never).catch((reason) => reason);

    expect(error).toMatchObject({ name: "PathPolicyError", code: "invalid_relative_path" });
    expect(String(error)).not.toContain(secret);
  });

  it("sanitizes unknown string inputs across every exported data-path operation", async () => {
    const parent = await temporaryRoot();
    const secret = join(parent, "must-not-leak-from-path-input");
    const policy = await DataPathPolicy.create(join(parent, "state"));
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(secret);
        }
      }
    );
    const operations = [
      () => policy.fileExists(hostile as never),
      () => policy.unlinkFile(hostile as never),
      () => policy.openFile(hostile as never, "r"),
      () => policy.linkFileNoReplace(hostile as never, "target"),
      () => policy.healLinkedAlias(hostile as never, "target"),
      () => policy.syncDirectory(hostile as never),
      () => policy.listDirectory(hostile as never),
      () => policy.refreshDirectoryChainAfterConcurrentEntryChange(hostile as never)
    ];

    for (const operation of operations) {
      const error = await operation().catch((reason) => reason);
      expect(error).toBeInstanceOf(PathPolicyError);
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("sanitizes unknown roots and repository source inputs", async () => {
    const parent = await temporaryRoot();
    const managedRoot = join(parent, "managed");
    await mkdir(managedRoot);
    const repository = await RepositoryInspectionPathPolicy.create(managedRoot);
    const secret = join(parent, "must-not-leak-from-root-input");
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(secret);
        }
      }
    );
    const operations = [
      () => DataPathPolicy.create(hostile as never),
      () => RepositoryInspectionPathPolicy.create(hostile as never),
      () => repository.resolveSource(hostile as never)
    ];

    for (const operation of operations) {
      const error = await operation().catch((reason) => reason);
      expect(error).toBeInstanceOf(PathPolicyError);
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("semantically verifies Darwin whole-path no-follow and unique-link opens", async () => {
    const verified: string[] = [];
    await DataPathPolicy.create(join(await temporaryRoot(), "state"), {
      onDarwinCapabilityVerified: (capability: string) => {
        verified.push(capability);
      }
    } as never);

    expect(verified).toEqual(process.platform === "darwin" ? ["nofollow_any", "unique_link"] : []);
  });

  it("opens a replacement root read-only without a Darwin capability-probe boundary", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "state");
    await DataPathPolicy.create(root);
    await rename(root, join(parent, "displaced-state"));
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, "marker"), "replacement", { mode: 0o600 });
    const before = await readdir(root);
    let boundaryCalls = 0;
    let transientEntries: readonly string[] = [];

    await expect(
      DataPathPolicy.openExisting(root, {
        onDarwinCapabilityVerified: async () => {
          boundaryCalls += 1;
          transientEntries = await readdir(root);
          throw new Error("simulated crash boundary");
        }
      })
    ).resolves.toBeInstanceOf(DataPathPolicy);

    expect(boundaryCalls).toBe(0);
    expect(transientEntries).toEqual([]);
    expect(await readdir(root)).toEqual(before);
  });

  it("sanitizes root and directory hook failures", async () => {
    const parent = await temporaryRoot();
    const secretPath = join(parent, "do-not-leak");
    const rootError = await DataPathPolicy.create(join(parent, "new-root"), {
      beforeRootCreate: () => {
        throw new Error(secretPath);
      }
    }).catch((error) => error);
    expect(rootError).toMatchObject({ code: "filesystem_error" });
    expect(String(rootError)).not.toContain(secretPath);

    const policy = await DataPathPolicy.create(join(parent, "state"), {
      beforeDirectoryCreate: () => {
        throw new Error(secretPath);
      }
    });
    const directoryError = await policy.ensureDirectory("nested").catch((error) => error);
    expect(directoryError).toMatchObject({ code: "filesystem_error" });
    expect(String(directoryError)).not.toContain(secretPath);
  });

  it.each(["existing", "missing"] as const)(
    "trap-safely snapshots hostile hooks for an %s root",
    async (rootState) => {
      const parent = await temporaryRoot();
      const root = join(parent, `${rootState}-state`);
      if (rootState === "existing") await mkdir(root, { mode: 0o700 });
      const secret = join(parent, "hook-proxy-secret");
      const hostileThrownValue = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error(secret);
          }
        }
      );
      const hostileHooks = new Proxy(
        {},
        {
          get() {
            throw hostileThrownValue;
          }
        }
      );

      const error = await DataPathPolicy.create(root, hostileHooks as never).catch(
        (reason) => reason
      );

      expect(error).toBeInstanceOf(PathPolicyError);
      expect(error).toMatchObject({ code: "filesystem_error" });
      expect(String(error)).not.toContain(secret);
    }
  );

  it.each(["existing", "missing"] as const)(
    "does not trust a caller-constructed PathPolicyError from %s-root hook admission",
    async (rootState) => {
      const parent = await temporaryRoot();
      const root = join(parent, `${rootState}-external-error-state`);
      if (rootState === "existing") await mkdir(root, { mode: 0o700 });
      const secret = join(parent, "external-path-policy-error-secret");
      const external = new PathPolicyError("filesystem_error", secret) as PathPolicyError & {
        cause?: unknown;
        leaked?: string;
      };
      external.cause = new Error(secret);
      external.leaked = secret;
      const hostileHooks = new Proxy(
        {},
        {
          get() {
            throw external;
          }
        }
      );

      const error = await DataPathPolicy.create(root, hostileHooks as never).catch(
        (reason) => reason
      );

      expect(error).toBeInstanceOf(PathPolicyError);
      expect(error).not.toBe(external);
      expect(error).toMatchObject({ code: "filesystem_error" });
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("leaked");
      expect(String(error)).not.toContain(secret);
    }
  );

  it("sanitizes caller errors and hostile proxies thrown by admitted runtime hooks", async () => {
    const parent = await temporaryRoot();
    const secret = join(parent, "runtime-hook-secret");
    const external = new PathPolicyError("path_escape", secret) as PathPolicyError & {
      cause?: unknown;
    };
    external.cause = new Error(secret);
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(secret);
        }
      }
    );
    const missingRootError = await DataPathPolicy.create(join(parent, "missing-runtime"), {
      beforeRootCreate: () => {
        throw external;
      }
    }).catch((reason) => reason);
    expect(missingRootError).not.toBe(external);
    expect(missingRootError).toMatchObject({ code: "filesystem_error" });
    expect(missingRootError).not.toHaveProperty("cause");
    expect(String(missingRootError)).not.toContain(secret);

    const policy = await DataPathPolicy.create(join(parent, "existing-runtime"), {
      beforeDirectoryCreate: () => {
        throw hostileProxy;
      }
    });
    const directoryError = await policy.ensureDirectory("nested").catch((reason) => reason);
    expect(directoryError).toMatchObject({ code: "filesystem_error" });
    expect(directoryError).not.toHaveProperty("cause");
    expect(String(directoryError)).not.toContain(secret);
  });
});

describe("RepositoryInspectionPathPolicy", () => {
  it("returns a canonical source checkout outside the managed-worktree root", async () => {
    const parent = await temporaryRoot();
    const managedRoot = join(parent, "managed");
    const source = join(parent, "source");
    await mkdir(managedRoot);
    await mkdir(source);
    const policy = await RepositoryInspectionPathPolicy.create(managedRoot);

    await expect(policy.resolveSource(source)).resolves.toBe(await realpath(source));
    expect(policy.enforcementScope).toBe("autostack_operations");
  });

  it("rejects a source checkout whose real path is inside the managed-worktree root", async () => {
    const parent = await temporaryRoot();
    const managedRoot = join(parent, "managed");
    const worktree = join(managedRoot, "run");
    const alias = join(parent, "source-alias");
    await mkdir(worktree, { recursive: true });
    await symlink(worktree, alias);
    const policy = await RepositoryInspectionPathPolicy.create(managedRoot);

    await expect(policy.resolveSource(alias)).rejects.toMatchObject({
      code: "managed_worktree_source"
    });
  });

  it("revalidates the pinned managed-root identity at source inspection", async () => {
    const parent = await temporaryRoot();
    const managedRoot = join(parent, "managed");
    const movedRoot = join(parent, "moved-managed");
    const worktree = join(managedRoot, "run");
    await mkdir(worktree, { recursive: true });
    const policy = await RepositoryInspectionPathPolicy.create(managedRoot);
    await rename(managedRoot, movedRoot);
    await mkdir(managedRoot);

    await expect(policy.resolveSource(join(movedRoot, "run"))).rejects.toMatchObject({
      code: "path_identity_changed"
    });
  });

  it("does not expose an unrelated absolute path through a typed policy error cause", async () => {
    const parent = await temporaryRoot();
    const managedRoot = join(parent, "managed");
    await mkdir(managedRoot);
    const policy = await RepositoryInspectionPathPolicy.create(managedRoot);

    const error = await policy
      .resolveSource(join(parent, "missing-secret-name"))
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(PathPolicyError);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain(parent);
  });

  it("rejects relative sources and source files", async () => {
    const parent = await temporaryRoot();
    const managedRoot = join(parent, "managed");
    const sourceFile = join(parent, "source.txt");
    await mkdir(managedRoot);
    await writeFile(sourceFile, "not a checkout");
    const policy = await RepositoryInspectionPathPolicy.create(managedRoot);

    await expect(policy.resolveSource("relative/source")).rejects.toMatchObject({
      code: "invalid_source"
    });
    await expect(policy.resolveSource(sourceFile)).rejects.toMatchObject({
      code: "invalid_source"
    });
  });
});
