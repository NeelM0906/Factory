import { describe, expect, it } from "vitest";

import {
  CommandAuthorizationSchema,
  type DesktopApiOperationMap,
  DesktopApiOperationMapSchema,
  admitPrepareEnvironment,
  admitStartCommand,
  canonicalizeCommandScope,
  canonicalizeEnvironmentAuthorizationForDigest,
  canonicalizeExecutionScope,
  CommandEnvironmentEntrySchema,
  CommandSpecSchema,
  CommandScopeSchema,
  GuardianLaunchDescriptorSchema,
  InspectRepositoryRequestSchema,
  ReadArtifactChunkResponseSchema,
  RunnerCapabilitiesSchema,
  RunnerStreamEventSchema,
  StartCommandRequestSchema,
  PrepareEnvironmentRequestSchema,
  EnvironmentAuthorizationSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  ExecutionScopeSchema,
  NetworkPolicySchema,
  RelativeWorkspacePathSchema,
  RunnerSubscriptionItemSchema,
  validateCommandAuthorizationAgainstEnvironment,
  validateArtifactChunkResponse,
  validateRunnerStream,
  assertResolvedCommandDoesNotUseShellCommandString,
  createId,
  createIdFactory,
  type Approval,
  type TrustedRunnerAdmissionDependencies
} from "../src/index.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = "2026-08-21T12:00:00.000Z";
const DIGEST = "a".repeat(64);

const ids = {
  workspaceId: createId("workspace", UUID),
  runId: createId("run", UUID),
  environmentId: createId("environment", UUID),
  commandId: createId("command", UUID),
  approvalId: createId("approval", UUID),
  permissionApprovalId: createId("approval", "123e4567-e89b-42d3-a456-426614174001"),
  environmentAuthorizationId: createId("environmentAuthorization", UUID),
  commandAuthorizationId: createId("commandAuthorization", UUID),
  credentialRefId: createId("credentialRef", UUID)
};

const scope = {
  workspaceId: ids.workspaceId,
  runId: ids.runId,
  environmentId: ids.environmentId,
  repositoryIdentity: "github:autostack/contracts",
  sourceCommit: "b".repeat(40),
  branch: "autostack/local-runner",
  cwdRoot: ".",
  resourceLimits: { cpu: 2, memoryMb: 2048, durationSeconds: 600 },
  networkPolicy: "host",
  filesystemDisclosure: "host_user",
  allowedCredentialRefIds: [ids.credentialRefId]
};

describe("local runner contracts", () => {
  it("creates deterministic command and authorization identifiers and rejects wrong prefixes", () => {
    const factory = createIdFactory(() => UUID);
    expect(factory.command()).toBe(`cmd_${UUID}`);
    expect(factory.environmentAuthorization()).toBe(`envauth_${UUID}`);
    expect(factory.commandAuthorization()).toBe(`cmdauth_${UUID}`);
    expect(factory.repositoryCapability()).toBe(`repocap_${UUID}`);
    expect(factory.inspectedSourceCapability()).toBe(`inspsrc_${UUID}`);
    expect(() => createId("command", "not-a-uuid")).toThrow();
    const request = <K extends keyof DesktopApiOperationMap>(
      input: DesktopApiOperationMap[K]["request"]
    ): Promise<DesktopApiOperationMap[K]["response"]> => {
      void input;
      return new Promise(() => undefined);
    };
    const statusRequest: DesktopApiOperationMap["runtime.status"]["request"] = {
      operation: "runtime.status"
    };
    const listRequest: DesktopApiOperationMap["local.list"]["request"] = {
      operation: "local.list"
    };
    const pickerRequest: DesktopApiOperationMap["repository.pick"]["request"] = {
      operation: "repository.pick"
    };
    void request(statusRequest);
    void request(listRequest);
    void request(pickerRequest);
    expect(DesktopApiOperationMapSchema.parse(statusRequest)).toMatchObject({
      operation: "runtime.status"
    });
    expect(DesktopApiOperationMapSchema.parse(listRequest)).toMatchObject({
      operation: "local.list"
    });
    expect(() =>
      DesktopApiOperationMapSchema.parse({
        operation: "runtime.status",
        response: { status: "ready" }
      })
    ).toThrow();
    expect(
      DesktopApiOperationMapSchema.parse({
        operation: "local.prepare",
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        approvalId: ids.approvalId,
        environmentAuthorizationId: ids.environmentAuthorizationId,
        environmentAuthorizationDigest: DIGEST,
        inspectedSourceCapabilityId: "inspsrc_123e4567-e89b-42d3-a456-426614174000",
        idempotencyKey: "prepare"
      })
    ).toMatchObject({ operation: "local.prepare" });
    expect(() =>
      DesktopApiOperationMapSchema.parse({
        operation: "repository.pick",
        response: {
          repository: {
            id: `repocap_${UUID}`,
            label: "/private/source",
            expiresAt: "2026-08-21T13:00:00.000Z"
          }
        }
      })
    ).toThrow();
  });

  it("accepts argument-array commands and rejects unsafe workspace paths or literal credentials", () => {
    expect(
      CommandSpecSchema.parse({
        executable: "pnpm",
        args: ["test", "--", "runner.test.ts"],
        cwd: "packages/contracts",
        environment: [
          { kind: "credential_ref", name: "NPM_TOKEN", credentialRefId: ids.credentialRefId }
        ],
        timeoutSeconds: 600,
        terminal: { columns: 120, rows: 40 }
      })
    ).toMatchObject({ executable: "pnpm" });
    for (const path of ["/tmp", "../escape", "a//b", "a/./b", "a\\b", "a\u0000b"]) {
      expect(() => RelativeWorkspacePathSchema.parse(path)).toThrow();
    }
    expect(() =>
      CommandEnvironmentEntrySchema.parse({
        kind: "literal",
        name: "TOKEN",
        value: "ghp_0123456789abcdefghijklmnop"
      })
    ).toThrow();
    expect(() =>
      CommandSpecSchema.parse({
        executable: "ghp_0123456789abcdefghijklmnop",
        args: [""],
        cwd: ".",
        environment: [{ kind: "literal", name: "EMPTY", value: "" }],
        timeoutSeconds: 1,
        terminal: { columns: 80, rows: 24 }
      })
    ).toThrow();
    for (const command of [
      { executable: "sh", args: ["-c", "echo safe"] },
      { executable: "bash", args: ["-lc", "echo safe"] },
      { executable: "dash", args: ["-c=echo safe"] },
      { executable: "/bin/zsh", args: ["--command=echo safe"] },
      { executable: "/usr/bin/env", args: ["fish", "-c", "echo safe"] },
      { executable: "bash", args: ["-O", "extglob", "-c", "echo safe"] },
      { executable: "bash", args: ["--rcfile", "/dev/null", "-c", "echo safe"] },
      { executable: "bash", args: ["-o", "pipefail", "-c", "echo safe"] },
      { executable: "bash", args: ["+O", "extglob", "-c", "echo safe"] },
      { executable: "bash", args: ["+o", "posix", "-c", "echo safe"] },
      { executable: "nice", args: ["bash", "+O", "extglob", "-c", "echo safe"] },
      { executable: "/usr/bin/time", args: ["/bin/sh", "-c", "echo safe"] },
      { executable: "/usr/bin/caffeinate", args: ["/bin/sh", "-c", "echo safe"] },
      { executable: "wrapper-probe", args: ["bash", "-c", "echo safe"] },
      { executable: "/usr/bin/env", args: ["MODE=safe", "-i", "sh", "-c", "echo safe"] },
      { executable: "/usr/bin/env", args: ["-S", "bash -c 'echo safe'"] },
      { executable: "/usr/bin/env", args: ["-Sbash -c 'echo safe'"] },
      { executable: "/usr/bin/env", args: ["-ivSbash -c 'echo safe'"] },
      { executable: "nice", args: ["/usr/bin/env", "-S", "bash -c 'echo safe'"] },
      { executable: "sudo", args: ["-n", "/usr/bin/env", "-Sbash -c 'echo safe'"] },
      { executable: "sudo", args: ["-n", "zsh", "-c", "echo safe"] },
      { executable: "sudo", args: ["-s", "-c", "echo safe"] },
      { executable: "sudo", args: ["--shell"] },
      { executable: "sudo", args: ["-ns"] },
      { executable: "doas", args: ["-ni"] },
      { executable: "busybox", args: ["sh", "-c", "echo safe"] },
      { executable: "busybox", args: ["ash", "-c", "echo safe"] },
      { executable: "busybox", args: ["hush", "-c", "echo safe"] },
      { executable: "/usr/local/bin/mksh", args: ["-c", "echo safe"] },
      { executable: "/usr/bin/YASH", args: ["-c", "echo safe"] },
      { executable: "ksh93", args: ["-c", "echo safe"] },
      { executable: "rksh93", args: ["-c", "echo safe"] },
      { executable: "oksh", args: ["-c", "echo safe"] },
      { executable: "loksh", args: ["-c", "echo safe"] },
      { executable: "pdksh", args: ["-c", "echo safe"] },
      { executable: "wrapper-probe", args: ["oksh", "-c", "echo safe"] },
      { executable: "C:\\Program Files\\PowerShell\\pwsh.exe", args: ["-Command", "echo safe"] },
      { executable: "nu", args: ["--commands", "echo safe"] },
      { executable: "nu", args: ["--commands=echo safe"] },
      { executable: "nu", args: ["-e", "print 1"] },
      { executable: "nu", args: ["-e=print 1"] },
      { executable: "nu", args: ["-eprint 1"] },
      { executable: "nu", args: ["--execute", "print 1"] },
      { executable: "nu", args: ["--execute=print 1"] },
      { executable: "fish", args: ["-C", "echo safe"] },
      { executable: "fish", args: ["--init-command", "echo safe"] },
      { executable: "fish", args: ["--init-command=echo safe"] },
      { executable: "fish", args: ["-Cecho safe"] },
      { executable: "fish", args: ["-cecho safe"] },
      { executable: "fish", args: ["--comm=echo safe"] },
      { executable: "fish", args: ["--ini=echo safe"] },
      { executable: "nice", args: ["fish", "-Cecho safe"] },
      { executable: "powershell.exe", args: ["-EncodedCommand", "ZQBjAGgAbwA="] },
      { executable: "pwsh", args: ["-e", "ZQBjAGgAbwA="] },
      { executable: "nice", args: ["pwsh", "-e", "ZQBjAGgAbwA="] },
      { executable: "pwsh-preview", args: ["-e", "ZQBjAGgAbwA="] },
      { executable: "nice", args: ["pwsh-preview", "-e", "ZQBjAGgAbwA="] },
      { executable: "pwsh", args: ["/Command", "echo safe"] },
      { executable: "pwsh-preview", args: ["/EncodedCommand", "ZQBjAGgAbwA="] },
      { executable: "nice", args: ["pwsh", "/C", "echo safe"] },
      { executable: "pwsh", args: ["–Command", "echo safe"] },
      { executable: "cmd.exe", args: ["/c", "echo safe"] },
      { executable: "nice", args: ["sh", "-c", "echo safe"] },
      { executable: "xargs", args: ["sh", "-c", "echo safe"] },
      { executable: "csh", args: ["-c", "echo safe"] },
      { executable: "tcsh", args: ["-c", "echo safe"] },
      { executable: "/bin/BASH", args: ["-c", "echo safe"] }
    ]) {
      expect(() =>
        CommandSpecSchema.parse({
          ...command,
          cwd: ".",
          environment: [],
          timeoutSeconds: 1,
          terminal: { columns: 80, rows: 24 }
        })
      ).toThrow(/shell command-string/i);
    }
    expect(
      CommandSpecSchema.parse({
        executable: "git",
        args: ["-c", "core.hooksPath=/dev/null", "status"],
        cwd: ".",
        environment: [],
        timeoutSeconds: 60,
        terminal: { columns: 80, rows: 24 }
      })
    ).toMatchObject({ executable: "git" });
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/private/tool-alias/bash", [
        "-c",
        "echo safe"
      ])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/private/tool-alias/bash", ["script.sh"])
    ).not.toThrow();
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/usr/bin/nice", [
        "/usr/bin/env",
        "-Sbash -c 'echo safe'"
      ])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/private/tool-alias/pwsh", [
        "-e",
        "ZQBjAGgAbwA="
      ])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/private/tool-alias/pwsh-preview", [
        "-e",
        "ZQBjAGgAbwA="
      ])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/private/tool-alias/fish", ["-Cecho safe"])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/private/tool-alias/bash", [
        "+O",
        "extglob",
        "-c",
        "echo safe"
      ])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/opt/bin/pwsh", ["/Command", "echo safe"])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/usr/bin/time", [
        "/bin/sh",
        "-c",
        "echo safe"
      ])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/opt/bin/ksh93", ["-c", "echo safe"])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/opt/homebrew/bin/oksh", [
        "-c",
        "echo safe"
      ])
    ).toThrow(/resolved shell command-string/i);
    expect(() =>
      assertResolvedCommandDoesNotUseShellCommandString("/opt/bin/pwsh", ["–Command", "echo safe"])
    ).toThrow(/resolved shell command-string/i);
    expect(
      CommandSpecSchema.parse({
        executable: "bash",
        args: ["scripts/verify.sh"],
        cwd: ".",
        environment: [],
        timeoutSeconds: 1,
        terminal: { columns: 80, rows: 24 }
      })
    ).toMatchObject({ executable: "bash" });
    for (const command of [
      { executable: "nu", args: ["script.nu"] },
      { executable: "fish", args: ["script.fish"] },
      { executable: "powershell.exe", args: ["-File", "script.ps1"] },
      { executable: "bash", args: ["script.sh", "--mode", "verify"] },
      { executable: "fish", args: ["script.fish", "--mode", "verify"] },
      { executable: "./scripts/verify.sh", args: ["--mode", "verify"] },
      { executable: "ssh", args: ["-p", "2222", "host"] },
      { executable: "mosh", args: ["--ssh=ssh -p 2222", "host"] },
      { executable: "echo", args: ["bash", "-c", "display only"] }
    ]) {
      expect(
        CommandSpecSchema.parse({
          ...command,
          cwd: ".",
          environment: [],
          timeoutSeconds: 1,
          terminal: { columns: 80, rows: 24 }
        })
      ).toMatchObject({ executable: command.executable });
    }
    expect(() =>
      CommandSpecSchema.parse({
        executable: "echo",
        args: ["Bearer abcdefghijklmnopqrst"],
        cwd: ".",
        environment: [],
        timeoutSeconds: 1,
        terminal: { columns: 80, rows: 24 }
      })
    ).toThrow();
    expect(() =>
      CommandSpecSchema.parse({
        executable: "echo",
        args: [],
        cwd: ".",
        environment: [
          { kind: "literal", name: "DUPLICATE", value: "" },
          { kind: "credential_ref", name: "DUPLICATE", credentialRefId: ids.credentialRefId }
        ],
        timeoutSeconds: 1,
        terminal: { columns: 80, rows: 24 }
      })
    ).toThrow();
  });

  it("keeps execution and command approval digests non-circular and scope-bound", () => {
    expect(ExecutionScopeSchema.parse(scope)).toEqual(scope);
    expect(canonicalizeExecutionScope(scope)).not.toContain("approvalId");
    expect(() => ExecutionScopeSchema.parse({ ...scope, approvalId: ids.approvalId })).toThrow();
    const environmentAuthorization = {
      id: ids.environmentAuthorizationId,
      digest: DIGEST,
      approvalId: ids.approvalId,
      approvalEvidenceDigest: DIGEST,
      scope,
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    expect(EnvironmentAuthorizationSchema.parse(environmentAuthorization)).toMatchObject({
      id: ids.environmentAuthorizationId
    });
    expect(canonicalizeEnvironmentAuthorizationForDigest(environmentAuthorization)).not.toContain(
      '"digest"'
    );
    const commandScope = {
      environmentAuthorizationId: ids.environmentAuthorizationId,
      environmentAuthorizationDigest: DIGEST,
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      commandId: ids.commandId,
      action: "implement",
      commandDigest: DIGEST,
      repositoryIdentity: scope.repositoryIdentity,
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      cwdRoot: scope.cwdRoot,
      networkPolicy: "host",
      filesystemDisclosure: "host_user",
      resourceLimits: scope.resourceLimits,
      allowedCredentialRefIds: scope.allowedCredentialRefIds
    };
    expect(CommandScopeSchema.parse(commandScope)).toMatchObject({ commandId: ids.commandId });
    expect(canonicalizeCommandScope(commandScope)).not.toContain("approvalEvidenceDigest");
    expect(
      CommandAuthorizationSchema.parse({
        id: ids.commandAuthorizationId,
        digest: DIGEST,
        approvalId: ids.approvalId,
        approvalEvidenceDigest: DIGEST,
        scope: commandScope,
        createdAt: NOW,
        expiresAt: "2026-08-21T13:00:00.000Z"
      })
    ).toMatchObject({ id: ids.commandAuthorizationId });
  });

  it("distinguishes durable stream events from subscriber-local lag and keeps policy versions explicit", () => {
    expect(NetworkPolicySchema.options).toEqual(["host", "none", "restricted"]);
    expect(
      RunnerSubscriptionItemSchema.parse({
        type: "subscription.lagged",
        lastDurableSequence: 5,
        resumeCursor: 5
      })
    ).toMatchObject({ type: "subscription.lagged" });
    expect(() =>
      RunnerSubscriptionItemSchema.parse({
        type: "runner.event",
        event: { type: "subscription.lagged" }
      })
    ).toThrow();
  });

  it("rejects command authorization scope broadening against its recorded environment authorization", () => {
    const environmentAuthorization = EnvironmentAuthorizationSchema.parse({
      id: ids.environmentAuthorizationId,
      digest: DIGEST,
      approvalId: ids.approvalId,
      approvalEvidenceDigest: DIGEST,
      scope,
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    });
    const authorization = CommandAuthorizationSchema.parse({
      id: ids.commandAuthorizationId,
      digest: DIGEST,
      approvalId: ids.approvalId,
      approvalEvidenceDigest: DIGEST,
      scope: {
        environmentAuthorizationId: ids.environmentAuthorizationId,
        environmentAuthorizationDigest: DIGEST,
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        commandId: ids.commandId,
        action: "verify",
        commandDigest: DIGEST,
        repositoryIdentity: scope.repositoryIdentity,
        sourceCommit: scope.sourceCommit,
        branch: scope.branch,
        cwdRoot: scope.cwdRoot,
        networkPolicy: "host",
        filesystemDisclosure: "host_user",
        resourceLimits: { cpu: 1, memoryMb: 1024, durationSeconds: 300 },
        allowedCredentialRefIds: []
      },
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    });
    expect(
      validateCommandAuthorizationAgainstEnvironment(authorization, environmentAuthorization)
    ).toEqual(authorization);
    expect(() =>
      validateCommandAuthorizationAgainstEnvironment(
        CommandAuthorizationSchema.parse({
          ...authorization,
          scope: { ...authorization.scope, resourceLimits: { ...scope.resourceLimits, cpu: 3 } }
        }),
        environmentAuthorization
      )
    ).toThrow(/broaden/i);
    const broaderScopes = [
      { ...authorization.scope, repositoryIdentity: "github:autostack/other" },
      { ...authorization.scope, sourceCommit: "c".repeat(40) },
      { ...authorization.scope, branch: "autostack/other" },
      { ...authorization.scope, cwdRoot: "packages" },
      { ...authorization.scope, resourceLimits: { ...scope.resourceLimits, cpu: 3 } },
      { ...authorization.scope, resourceLimits: { ...scope.resourceLimits, memoryMb: 2049 } },
      { ...authorization.scope, resourceLimits: { ...scope.resourceLimits, durationSeconds: 601 } },
      {
        ...authorization.scope,
        allowedCredentialRefIds: [
          ...scope.allowedCredentialRefIds,
          createId("credentialRef", "123e4567-e89b-42d3-a456-426614174001")
        ]
      }
    ];
    for (const broaderScope of broaderScopes) {
      expect(() =>
        validateCommandAuthorizationAgainstEnvironment(
          CommandAuthorizationSchema.parse({ ...authorization, scope: broaderScope }),
          environmentAuthorization
        )
      ).toThrow(/broaden/i);
    }
    for (const incompatibleScope of [
      { ...authorization.scope, networkPolicy: "none" },
      { ...authorization.scope, filesystemDisclosure: "sandbox_user" }
    ]) {
      expect(() => CommandScopeSchema.parse(incompatibleScope)).toThrow();
    }
  });

  it("validates runner capabilities, internal launch paths, and request/artifact coherence", () => {
    expect(
      RunnerCapabilitiesSchema.parse({
        runnerId: "runner-local",
        version: "1",
        platform: { os: "darwin", architecture: "arm64" },
        pty: true,
        cancellation: true,
        filesystemDisclosure: "host_user",
        maximumBytes: { liveOutput: 1, replay: 1, transcript: 1, artifact: 1 },
        supportedNetworkPolicies: ["host"],
        enforcement: {
          cpu: "advisory",
          memory: "advisory",
          duration: "hard",
          autostackPathOperations: "hard",
          childFilesystem: "advisory",
          network: "unavailable"
        }
      })
    ).toMatchObject({ runnerId: "runner-local" });
    expect(() =>
      InspectRepositoryRequestSchema.parse({ sourcePath: "relative", baseRef: "main" })
    ).toThrow();
    expect(
      GuardianLaunchDescriptorSchema.parse({
        electronExecutable: "/app/electron",
        guardianModule: "/app/guardian.mjs",
        nativeDirectory: "/app/native",
        desktopBuildRoot: "/app",
        runtimeManifestDigest: DIGEST,
        electronVersion: "43.4.0",
        nodePtyVersion: "1.1.0"
      })
    ).toBeDefined();
    expect(() =>
      GuardianLaunchDescriptorSchema.parse({
        electronExecutable: "/app/electron",
        guardianModule: "/app//guardian.mjs",
        nativeDirectory: "/app/native",
        desktopBuildRoot: "/app",
        runtimeManifestDigest: DIGEST,
        electronVersion: "43.4.0",
        nodePtyVersion: "1.1.0"
      })
    ).toThrow(/absolute POSIX/i);
    expect(() =>
      GuardianLaunchDescriptorSchema.parse({
        electronExecutable: "/app/electron",
        guardianModule: "/app/guardian.mjs",
        nativeDirectory: "/app/native",
        desktopBuildRoot: "/app",
        runtimeManifestDigest: DIGEST,
        electronVersion: "43.0.0",
        nodePtyVersion: "1.1.0"
      })
    ).toThrow();
    const environmentAuthorization = {
      id: ids.environmentAuthorizationId,
      digest: DIGEST,
      approvalId: ids.approvalId,
      approvalEvidenceDigest: DIGEST,
      scope,
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    expect(() =>
      EnvironmentAuthorizationSchema.parse({ ...environmentAuthorization, expiresAt: NOW })
    ).toThrow();
    expect(
      EnvironmentAuthorizationSchema.parse({
        ...environmentAuthorization,
        createdAt: "2026-08-21T12:00:00+05:00",
        expiresAt: "2026-08-21T08:00:00Z"
      })
    ).toBeDefined();
    const inspection = {
      repositoryIdentity: scope.repositoryIdentity,
      canonicalSourcePath: "/source",
      repositoryCommonDirectory: "/source/.git",
      resolvedBaseRef: "main",
      sourceCommit: scope.sourceCommit,
      dirty: false,
      diagnostics: []
    };
    expect(
      PrepareEnvironmentRequestSchema.parse({
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        inspection,
        sourceCommit: scope.sourceCommit,
        branch: scope.branch,
        authorization: environmentAuthorization,
        idempotency: { key: "prepare" }
      })
    ).toBeDefined();
    expect(() =>
      PrepareEnvironmentRequestSchema.parse({
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        inspection: { ...inspection, repositoryIdentity: "wrong" },
        sourceCommit: scope.sourceCommit,
        branch: scope.branch,
        authorization: environmentAuthorization,
        idempotency: { key: "prepare" }
      })
    ).toThrow();
    expect(() =>
      PrepareEnvironmentRequestSchema.parse({
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        inspection: { ...inspection, sourceCommit: "d".repeat(40) },
        sourceCommit: scope.sourceCommit,
        branch: scope.branch,
        authorization: environmentAuthorization,
        idempotency: { key: "prepare" }
      })
    ).toThrow();
    const commandAuthorization = {
      id: ids.commandAuthorizationId,
      digest: DIGEST,
      approvalId: ids.permissionApprovalId,
      approvalEvidenceDigest: DIGEST,
      scope: {
        environmentAuthorizationId: ids.environmentAuthorizationId,
        environmentAuthorizationDigest: DIGEST,
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        commandId: ids.commandId,
        action: "implement",
        commandDigest: DIGEST,
        repositoryIdentity: scope.repositoryIdentity,
        sourceCommit: scope.sourceCommit,
        branch: scope.branch,
        cwdRoot: scope.cwdRoot,
        networkPolicy: "host",
        filesystemDisclosure: "host_user",
        resourceLimits: scope.resourceLimits,
        allowedCredentialRefIds: scope.allowedCredentialRefIds
      },
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    const command = {
      executable: "true",
      args: [],
      cwd: ".",
      environment: [],
      timeoutSeconds: 1,
      terminal: { columns: 80, rows: 24 }
    };
    expect(
      StartCommandRequestSchema.parse({
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        commandId: ids.commandId,
        command,
        environmentAuthorizationId: ids.environmentAuthorizationId,
        environmentAuthorizationDigest: DIGEST,
        authorization: commandAuthorization,
        idempotency: { key: "start" }
      })
    ).toBeDefined();
    expect(() =>
      StartCommandRequestSchema.parse({
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        commandId: createId("command", "123e4567-e89b-42d3-a456-426614174001"),
        command,
        environmentAuthorizationId: ids.environmentAuthorizationId,
        environmentAuthorizationDigest: DIGEST,
        authorization: commandAuthorization,
        idempotency: { key: "start" }
      })
    ).toThrow();
    const artifact = {
      artifactId: createId("artifact", UUID),
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      commandId: ids.commandId,
      kind: "command_transcript",
      mediaType: "text/plain",
      digest: DIGEST,
      byteSize: 1,
      createdAt: NOW
    };
    expect(() =>
      ReadArtifactChunkResponseSchema.parse({
        artifact,
        offset: 0,
        bytes: "YQ==",
        nextOffset: 0,
        done: true
      })
    ).toThrow();
    expect(
      RunnerStreamEventSchema.parse({
        type: "terminal.output",
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        commandId: ids.commandId,
        sequence: 1,
        occurredAt: NOW,
        stream: "pty",
        text: "safe"
      })
    ).toMatchObject({ stream: "pty" });
  });

  it("admits only digest-bound, unexpired command requests and validates owned artifact and stream evidence", async () => {
    const command = {
      executable: "true",
      args: [""],
      cwd: ".",
      environment: [],
      timeoutSeconds: 60,
      terminal: { columns: 80, rows: 24 }
    };
    const environmentAuthorization = {
      id: ids.environmentAuthorizationId,
      digest: "0".repeat(64),
      approvalId: ids.approvalId,
      approvalEvidenceDigest: await digestExecutionScope(scope),
      scope,
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    environmentAuthorization.digest =
      await digestEnvironmentAuthorization(environmentAuthorization);
    const commandScope = {
      environmentAuthorizationId: ids.environmentAuthorizationId,
      environmentAuthorizationDigest: environmentAuthorization.digest,
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      commandId: ids.commandId,
      action: "implement",
      commandDigest: await digestCommandSpec(command),
      repositoryIdentity: scope.repositoryIdentity,
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      cwdRoot: scope.cwdRoot,
      networkPolicy: "host",
      filesystemDisclosure: "host_user",
      resourceLimits: scope.resourceLimits,
      allowedCredentialRefIds: scope.allowedCredentialRefIds
    };
    const authorization = {
      id: ids.commandAuthorizationId,
      digest: "0".repeat(64),
      approvalId: ids.permissionApprovalId,
      approvalEvidenceDigest: await digestCommandScope(commandScope),
      scope: commandScope,
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    authorization.digest = await digestCommandAuthorization(authorization);
    const request = {
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      commandId: ids.commandId,
      command,
      environmentAuthorizationId: ids.environmentAuthorizationId,
      environmentAuthorizationDigest: environmentAuthorization.digest,
      authorization,
      idempotency: { key: "command-start" }
    };
    const planApproval: Approval = {
      schemaVersion: 1,
      id: ids.approvalId,
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      kind: "plan",
      status: "approved",
      evidenceDigest: environmentAuthorization.approvalEvidenceDigest,
      eligibleApproverIds: ["local-user"],
      decision: {
        decision: "approved",
        actor: { kind: "user", id: "local-user" },
        origin: "desktop",
        decidedAt: NOW
      },
      createdAt: NOW,
      updatedAt: NOW
    };
    const permissionApproval: Approval = {
      schemaVersion: 1,
      id: ids.permissionApprovalId,
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      kind: "permission",
      status: "approved",
      evidenceDigest: authorization.approvalEvidenceDigest,
      eligibleApproverIds: ["local-user"],
      decision: {
        decision: "approved",
        actor: { kind: "user", id: "local-user" },
        origin: "desktop",
        decidedAt: NOW
      },
      createdAt: NOW,
      updatedAt: NOW
    };
    const approvals = new Map<Approval["id"], Approval>([
      [ids.approvalId, planApproval],
      [ids.permissionApprovalId, permissionApproval]
    ]);
    const dependencies: TrustedRunnerAdmissionDependencies = {
      resolveApproval: async (approvalId) => approvals.get(approvalId),
      resolveEnvironmentAuthorization: async (authorizationId) =>
        authorizationId === environmentAuthorization.id ? environmentAuthorization : undefined,
      resolveCommandAuthorization: async (authorizationId) =>
        authorizationId === authorization.id ? authorization : undefined
    };
    await expect(admitStartCommand(request, NOW, dependencies)).resolves.toMatchObject({
      request: { commandId: ids.commandId }
    });
    const prepareRequest = {
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      inspection: {
        repositoryIdentity: scope.repositoryIdentity,
        canonicalSourcePath: "/source",
        repositoryCommonDirectory: "/source/.git",
        resolvedBaseRef: "main",
        sourceCommit: scope.sourceCommit,
        dirty: false,
        diagnostics: []
      },
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      authorization: environmentAuthorization,
      idempotency: { key: "prepare" }
    };
    await expect(admitPrepareEnvironment(prepareRequest, NOW, dependencies)).resolves.toMatchObject(
      {
        request: { environmentId: ids.environmentId }
      }
    );
    approvals.set(ids.approvalId, {
      ...planApproval,
      decision: {
        decision: "approved",
        actor: { kind: "user", id: "not-eligible" },
        origin: "desktop",
        decidedAt: NOW
      }
    });
    await expect(admitPrepareEnvironment(prepareRequest, NOW, dependencies)).rejects.toThrow(
      /eligible/i
    );
    approvals.set(ids.approvalId, planApproval);
    approvals.set(ids.permissionApprovalId, {
      ...permissionApproval,
      updatedAt: "2026-08-21T11:59:59.000Z"
    });
    await expect(admitStartCommand(request, NOW, dependencies)).rejects.toThrow(/chronolog|stale/i);
    approvals.set(ids.permissionApprovalId, permissionApproval);
    await expect(
      admitStartCommand(
        { ...request, command: { ...command, args: ["substituted"] } },
        NOW,
        dependencies
      )
    ).rejects.toThrow(/specification/i);
    await expect(
      admitStartCommand(
        { ...request, command: { ...command, executable: "bash", args: ["-c", "echo safe"] } },
        NOW,
        dependencies
      )
    ).rejects.toThrow(/shell command-string/i);
    await expect(
      admitStartCommand(request, "2026-08-22T12:00:00.000Z", dependencies)
    ).rejects.toThrow(/expired/i);
    const artifact = {
      artifactId: createId("artifact", UUID),
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      commandId: ids.commandId,
      kind: "command_transcript",
      mediaType: "text/plain",
      digest: DIGEST,
      byteSize: 1,
      createdAt: NOW
    };
    const artifactRequest = {
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      commandId: ids.commandId,
      artifactId: artifact.artifactId,
      environmentAuthorizationId: ids.environmentAuthorizationId,
      environmentAuthorizationDigest: environmentAuthorization.digest,
      commandAuthorizationId: ids.commandAuthorizationId,
      commandAuthorizationDigest: authorization.digest,
      offset: 0,
      length: 1
    };
    expect(
      validateArtifactChunkResponse(artifactRequest, {
        artifact,
        offset: 0,
        bytes: "YQ==",
        nextOffset: 1,
        done: true
      })
    ).toMatchObject({ done: true });
    expect(
      validateRunnerStream([
        {
          type: "command.started",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 1,
          occurredAt: NOW,
          pty: true
        },
        {
          type: "artifact.created",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 2,
          occurredAt: NOW,
          artifact
        },
        {
          type: "command.completed",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 3,
          occurredAt: NOW,
          exitCode: 0,
          signal: null,
          durationMs: 1,
          cancelled: false,
          interrupted: false,
          transcript: artifact
        }
      ])
    ).toHaveLength(3);
    expect(() => validateRunnerStream([])).toThrow(/terminal/i);
    expect(() =>
      validateRunnerStream([
        {
          type: "command.started",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 1,
          occurredAt: NOW,
          pty: true
        },
        {
          type: "command.started",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 2,
          occurredAt: NOW,
          pty: true
        },
        {
          type: "stream.error",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 3,
          occurredAt: NOW,
          code: "protocol_failure",
          message: "safe failure"
        }
      ])
    ).toThrow(/start/i);
    expect(
      validateRunnerStream(
        [
          {
            type: "terminal.output",
            workspaceId: ids.workspaceId,
            runId: ids.runId,
            commandId: ids.commandId,
            sequence: 2,
            occurredAt: NOW,
            stream: "pty",
            text: "resumed"
          },
          {
            type: "stream.error",
            workspaceId: ids.workspaceId,
            runId: ids.runId,
            commandId: ids.commandId,
            sequence: 3,
            occurredAt: NOW,
            code: "protocol_failure",
            message: "safe failure"
          }
        ],
        {
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          after: 1
        }
      )
    ).toHaveLength(2);
    expect(() =>
      validateRunnerStream([
        {
          type: "command.started",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 1,
          occurredAt: NOW,
          pty: true
        }
      ])
    ).toThrow(/terminal/i);
    expect(() =>
      validateRunnerStream(
        [
          {
            type: "command.started",
            workspaceId: ids.workspaceId,
            runId: ids.runId,
            commandId: ids.commandId,
            sequence: 1,
            occurredAt: NOW,
            pty: true
          },
          {
            type: "stream.error",
            workspaceId: ids.workspaceId,
            runId: ids.runId,
            commandId: ids.commandId,
            sequence: 2,
            occurredAt: NOW,
            code: "protocol_failure",
            message: "safe failure"
          }
        ],
        {
          workspaceId: createId("workspace", "123e4567-e89b-42d3-a456-426614174099"),
          runId: ids.runId,
          commandId: ids.commandId,
          after: 0
        }
      )
    ).toThrow(/identity/i);
    expect(() =>
      validateArtifactChunkResponse(artifactRequest, {
        artifact: {
          ...artifact,
          commandId: createId("command", "123e4567-e89b-42d3-a456-426614174001")
        },
        offset: 0,
        bytes: "YQ==",
        nextOffset: 1,
        done: true
      })
    ).toThrow(/match/i);
    expect(() =>
      ReadArtifactChunkResponseSchema.parse({
        artifact: { ...artifact, byteSize: 2 },
        offset: 0,
        bytes: "",
        nextOffset: 0,
        done: false
      })
    ).toThrow(/progress/i);
    expect(() =>
      ReadArtifactChunkResponseSchema.parse({
        artifact,
        offset: 0,
        bytes: "YR==",
        nextOffset: 1,
        done: true
      })
    ).toThrow(/base64/i);
  });

  it("rejects a self-consistent prepare authorization that is absent from trusted approval state", async () => {
    const authorization = {
      id: ids.environmentAuthorizationId,
      digest: "0".repeat(64),
      approvalId: ids.approvalId,
      approvalEvidenceDigest: await digestExecutionScope(scope),
      scope,
      createdAt: NOW,
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    authorization.digest = await digestEnvironmentAuthorization(authorization);
    const request = {
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      inspection: {
        repositoryIdentity: scope.repositoryIdentity,
        canonicalSourcePath: "/source",
        repositoryCommonDirectory: "/source/.git",
        resolvedBaseRef: "main",
        sourceCommit: scope.sourceCommit,
        dirty: false,
        diagnostics: []
      },
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      authorization,
      idempotency: { key: "prepare" }
    };

    await expect(
      admitPrepareEnvironment(request, NOW, {
        resolveApproval: async () => undefined,
        resolveEnvironmentAuthorization: async () => authorization,
        resolveCommandAuthorization: async () => undefined
      })
    ).rejects.toThrow(/trusted approved/i);
  });
});
