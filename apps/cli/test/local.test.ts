import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runLocalCommand } from "../src/local.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

const artifactChunk = (bytes: Buffer, whole: Buffer, done: boolean, offset = 0) => ({
  artifact: {
    artifactId: `art_${UUID}`,
    digest: createHash("sha256").update(whole).digest("hex"),
    byteSize: whole.byteLength
  },
  offset,
  bytes: bytes.toString("base64"),
  nextOffset: offset + bytes.byteLength,
  done
});

const stream = (items: readonly unknown[]) =>
  (async function* () {
    for (const item of items) yield item;
  })();

const defaultClient = () => ({
  localStart: vi.fn(async (_request: unknown, _idempotencyKey: string) => ({
    commandId: `cmd_${UUID}`,
    acceptedAt: "2026-08-21T12:00:00.000Z",
    replayed: false
  })),
  localInspect: vi.fn(async (_request: unknown) => ({
    repositoryIdentity: "github:example/repo",
    canonicalSourcePath: "/repo",
    repositoryCommonDirectory: "/repo/.git",
    resolvedBaseRef: "main",
    sourceCommit: "b".repeat(40),
    dirty: false,
    diagnostics: []
  })),
  localPrepare: vi.fn(async (_request: unknown, _idempotencyKey: string) => ({
    environment: { environmentId: `env_${UUID}`, state: "prepared" },
    replayed: false
  })),
  localCancel: vi.fn(async (_request: unknown) => ({
    commandId: `cmd_${UUID}`,
    cancelled: true,
    replayed: false
  })),
  localDispose: vi.fn(async (_request: unknown) => ({
    environmentId: `env_${UUID}`,
    disposed: true,
    replayed: false
  })),
  localEvents: vi.fn((_request: unknown) => stream([])),
  localArtifact: vi.fn(async (_request: unknown) =>
    artifactChunk(Buffer.alloc(0), Buffer.alloc(0), true)
  )
});

type FakeClient = ReturnType<typeof defaultClient>;

const harness = (overrides: Partial<FakeClient> = {}) => {
  let stdout = "";
  let stderr = "";
  const client = { ...defaultClient(), ...overrides };
  return {
    dependencies: {
      client: client as never,
      stdout: { write: (value: string) => void (stdout += value) },
      stderr: { write: (value: string) => void (stderr += value) }
    },
    client,
    output: () => ({ stdout, stderr })
  };
};

describe("local CLI", () => {
  it("preserves executable and arguments only after the literal delimiter", async () => {
    const test = harness();
    const result = await runLocalCommand(
      [
        "exec",
        "--run",
        `run_${UUID}`,
        "--approval",
        `apr_${UUID}`,
        "--command-authorization",
        `cmdauth_${UUID}`,
        "--environment",
        `env_${UUID}`,
        "--command-id",
        `cmd_${UUID}`,
        "--idempotency-key",
        "exec-1",
        "--",
        "pnpm",
        "test",
        "--filter",
        "@autostack/contracts"
      ],
      test.dependencies
    );
    expect(result).toBe(0);
    expect(test.client.localStart.mock.calls[0]?.[0]).toMatchObject({
      command: { executable: "pnpm", args: ["test", "--filter", "@autostack/contracts"] }
    });
    expect(test.output().stderr).toBe("");
  });

  it("rejects exec without the literal delimiter and maps inspect without shell parsing", async () => {
    const invalid = harness();
    expect(await runLocalCommand(["exec", "pnpm", "test"], invalid.dependencies)).toBe(1);
    expect(invalid.client.localStart).not.toHaveBeenCalled();

    const inspect = harness();
    expect(
      await runLocalCommand(
        ["inspect", "--repo", "/repo", "--base", "main", "--json"],
        inspect.dependencies
      )
    ).toBe(0);
    expect(inspect.client.localInspect).toHaveBeenCalledWith({
      sourcePath: "/repo",
      baseRef: "main"
    });
    expect(JSON.parse(inspect.output().stdout)).toMatchObject({
      repositoryIdentity: "github:example/repo"
    });
  });

  it("rejects exec whose delimiter is the final argument", async () => {
    const test = harness();

    expect(await runLocalCommand(["exec", "--run", `run_${UUID}`, "--"], test.dependencies)).toBe(
      1
    );
    expect(test.client.localStart).not.toHaveBeenCalled();
    expect(test.output().stderr).toContain("Usage error");
  });

  it("pretty-prints by default and emits one dense line under --json", async () => {
    const pretty = harness();
    const dense = harness();

    await runLocalCommand(["inspect", "--repo", "/repo", "--base", "main"], pretty.dependencies);
    await runLocalCommand(
      ["inspect", "--repo", "/repo", "--base", "main", "--json"],
      dense.dependencies
    );

    expect(pretty.output().stdout.split("\n").length).toBeGreaterThan(2);
    expect(dense.output().stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(pretty.output().stdout)).toEqual(JSON.parse(dense.output().stdout));
  });

  it("sends prepare with its idempotency key alongside the parsed request", async () => {
    const test = harness();

    expect(
      await runLocalCommand(
        [
          "prepare",
          "--run",
          `run_${UUID}`,
          "--approval",
          `apr_${UUID}`,
          "--environment-authorization",
          `envauth_${UUID}`,
          "--environment-id",
          `env_${UUID}`,
          "--repo",
          "/repo",
          "--base",
          "main",
          "--slug",
          "issue-42",
          "--idempotency-key",
          "prepare-1"
        ],
        test.dependencies
      )
    ).toBe(0);
    expect(test.client.localPrepare).toHaveBeenCalledWith(
      {
        runId: `run_${UUID}`,
        approvalId: `apr_${UUID}`,
        environmentAuthorizationId: `envauth_${UUID}`,
        environmentId: `env_${UUID}`,
        sourcePath: "/repo",
        baseRef: "main",
        branchSlug: "issue-42"
      },
      "prepare-1"
    );
  });

  it("routes cancel and dispose to their own client calls", async () => {
    const cancel = harness();
    const dispose = harness();

    expect(
      await runLocalCommand(
        [
          "cancel",
          "--environment",
          `env_${UUID}`,
          "--command",
          `cmd_${UUID}`,
          "--command-authorization",
          `cmdauth_${UUID}`,
          "--idempotency-key",
          "cancel-1"
        ],
        cancel.dependencies
      )
    ).toBe(0);
    expect(cancel.client.localCancel).toHaveBeenCalledWith({
      environmentId: `env_${UUID}`,
      commandId: `cmd_${UUID}`,
      commandAuthorizationId: `cmdauth_${UUID}`,
      idempotencyKey: "cancel-1"
    });
    expect(JSON.parse(cancel.output().stdout)).toMatchObject({ cancelled: true });

    expect(
      await runLocalCommand(
        [
          "dispose",
          "--environment",
          `env_${UUID}`,
          "--environment-authorization",
          `envauth_${UUID}`,
          "--idempotency-key",
          "dispose-1"
        ],
        dispose.dependencies
      )
    ).toBe(0);
    expect(dispose.client.localDispose).toHaveBeenCalledWith({
      environmentId: `env_${UUID}`,
      environmentAuthorizationId: `envauth_${UUID}`,
      idempotencyKey: "dispose-1"
    });
  });

  it("returns a usage error for an unknown or missing subcommand", async () => {
    const unknown = harness();
    const empty = harness();

    expect(await runLocalCommand(["teleport"], unknown.dependencies)).toBe(1);
    expect(await runLocalCommand([], empty.dependencies)).toBe(1);
    expect(unknown.output().stderr).toContain("Usage error");
  });

  it.each([
    ["a flag with no value", ["inspect", "--repo"]],
    ["a value that reads as another flag", ["inspect", "--repo", "--base"]],
    ["a bare positional where a flag belongs", ["inspect", "repo", "main"]],
    ["a required flag that is missing", ["inspect", "--repo", "/repo"]],
    ["a required flag that is empty", ["inspect", "--repo", "", "--base", "main"]],
    [
      "an identifier the contract refuses",
      [
        "cancel",
        "--environment",
        "env_not-a-uuid",
        "--command",
        `cmd_${UUID}`,
        "--command-authorization",
        `cmdauth_${UUID}`,
        "--idempotency-key",
        "cancel-1"
      ]
    ]
  ])("fails with the command exit code on %s", async (_label, arguments_) => {
    const test = harness();

    expect(await runLocalCommand(arguments_, test.dependencies)).toBe(3);
    expect(test.output().stderr).toBe("Local command failed.\n");
    expect(test.output().stdout).toBe("");
  });

  it("returns the command exit code when the control plane rejects the call", async () => {
    const test = harness({
      localInspect: vi.fn(async (_request: unknown) => {
        throw new Error("Control plane unavailable.");
      }) as never
    });

    expect(
      await runLocalCommand(["inspect", "--repo", "/repo", "--base", "main"], test.dependencies)
    ).toBe(3);
    expect(test.output().stderr).toBe("Local command failed.\n");
  });
});

describe("local CLI event streaming", () => {
  const frames = [
    {
      type: "runner.event",
      event: { type: "terminal.output", stream: "pty", text: "compiling..." }
    },
    { type: "runner.event", event: { type: "command.completed" } },
    { type: "subscription.lagged", lastDurableSequence: 4, resumeCursor: 4 }
  ];

  const events = ["events", "--environment", `env_${UUID}`, "--command", `cmd_${UUID}`];

  it("writes terminal output to stdout and every other frame kind to stderr", async () => {
    const test = harness({ localEvents: vi.fn((_request: unknown) => stream(frames)) as never });

    expect(await runLocalCommand([...events, "--after", "4"], test.dependencies)).toBe(0);
    expect(test.output()).toEqual({
      stdout: "compiling...",
      stderr: "runner.event\nsubscription.lagged\n"
    });
    expect(test.client.localEvents).toHaveBeenCalledWith({
      environmentId: `env_${UUID}`,
      commandId: `cmd_${UUID}`,
      after: 4
    });
  });

  it("defaults the cursor to the start of the stream", async () => {
    const test = harness();

    expect(await runLocalCommand(events, test.dependencies)).toBe(0);
    expect(test.client.localEvents.mock.calls[0]?.[0]).toMatchObject({ after: 0 });
  });

  it("emits every frame verbatim on one line each under --json", async () => {
    const test = harness({ localEvents: vi.fn((_request: unknown) => stream(frames)) as never });

    expect(await runLocalCommand([...events, "--json"], test.dependencies)).toBe(0);
    const lines = test.output().stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line))).toEqual(frames);
    expect(test.output().stderr).toBe("");
  });

  it("returns the command exit code when the stream fails mid-flight", async () => {
    const test = harness({
      localEvents: vi.fn((_request: unknown) =>
        (async function* () {
          yield frames[0];
          throw new Error("Control plane unavailable.");
        })()
      ) as never
    });

    expect(await runLocalCommand(events, test.dependencies)).toBe(3);
    expect(test.output().stdout).toBe("compiling...");
    expect(test.output().stderr).toBe("Local command failed.\n");
  });
});

describe("local CLI artifact download", () => {
  let directory: string | undefined;

  const workspace = async (): Promise<string> => {
    directory = await mkdtemp(join(tmpdir(), "autostack-cli-artifact-"));
    return directory;
  };

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const download = (output: string) => [
    "artifact",
    "--artifact",
    `art_${UUID}`,
    "--output",
    output
  ];

  const chunked = (whole: Buffer, size: number) => {
    const responses: ReturnType<typeof artifactChunk>[] = [];
    for (let offset = 0; offset < whole.byteLength; offset += size) {
      const slice = whole.subarray(offset, Math.min(offset + size, whole.byteLength));
      responses.push(
        artifactChunk(slice, whole, offset + slice.byteLength >= whole.byteLength, offset)
      );
    }
    return vi.fn(
      async (_request: unknown) => responses.shift() ?? artifactChunk(Buffer.alloc(0), whole, true)
    );
  };

  it("writes the reassembled bytes once every chunk has been verified", async () => {
    const whole = Buffer.from("the quick brown fox");
    const output = join(await workspace(), "transcript.txt");
    const test = harness({ localArtifact: chunked(whole, 7) as never });

    expect(await runLocalCommand(download(output), test.dependencies)).toBe(0);
    expect(await readFile(output)).toEqual(whole);
    expect(test.client.localArtifact).toHaveBeenCalledTimes(3);
    expect(test.client.localArtifact.mock.calls[1]?.[0]).toMatchObject({
      offset: 7,
      length: 1_048_576
    });
    expect(test.output()).toEqual({ stdout: "", stderr: "" });
  });

  it("refuses to overwrite an existing output path", async () => {
    const whole = Buffer.from("hello");
    const output = join(await workspace(), "transcript.txt");
    const first = harness({ localArtifact: chunked(whole, 5) as never });
    expect(await runLocalCommand(download(output), first.dependencies)).toBe(0);

    const second = harness({ localArtifact: chunked(whole, 5) as never });
    expect(await runLocalCommand(download(output), second.dependencies)).toBe(3);
    expect(second.client.localArtifact).not.toHaveBeenCalled();
    expect(await readFile(output)).toEqual(whole);
  });

  it.each([
    [
      "the digest does not cover the bytes received",
      (whole: Buffer) =>
        vi.fn(async (_request: unknown) => ({
          ...artifactChunk(Buffer.from("tampered"), whole, true),
          nextOffset: whole.byteLength
        }))
    ],
    [
      "the descriptor changes between chunks",
      (whole: Buffer) => {
        let served = 0;
        return vi.fn(async (_request: unknown) => {
          served += 1;
          const half = whole.subarray(0, 3);
          if (served === 1) return artifactChunk(half, whole, false);
          return {
            ...artifactChunk(whole.subarray(3), whole, true, 3),
            artifact: { artifactId: `art_${UUID}` }
          };
        });
      }
    ],
    [
      "the stream ends short of the declared size",
      (whole: Buffer) =>
        vi.fn(async (_request: unknown) => artifactChunk(whole.subarray(0, 2), whole, true))
    ]
  ])("leaves no file behind when %s", async (_label, makeClient) => {
    const whole = Buffer.from("the quick brown fox");
    const target = await workspace();
    const output = join(target, "transcript.txt");
    const test = harness({ localArtifact: makeClient(whole) as never });

    expect(await runLocalCommand(download(output), test.dependencies)).toBe(3);
    expect(test.output().stderr).toBe("Local command failed.\n");
    expect(await readdir(target)).toEqual([]);
  });
});
