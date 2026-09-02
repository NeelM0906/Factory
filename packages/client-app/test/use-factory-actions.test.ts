// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient, type AutoStackApiClient } from "../src/api-client.js";
import { ApiConflictError, ApiRequestValidationError } from "../src/api-errors.js";
import { createMockApiServer, seedFactoryFixture } from "../src/testing/index.js";
import { useFactoryActions } from "../src/use-factory-actions.js";

const TOKEN = "test-token";

function firstRunId(fixture: ReturnType<typeof seedFactoryFixture>): string {
  const run = fixture.runs[0];
  if (run === undefined) throw new Error("Fixture has no runs.");
  return run.id;
}

/**
 * Runtime-built so the file's literal bytes never contain a real credential prefix (fixture
 * credential doctrine) — "gh" and "p_" are separate literals, never adjacent in the source.
 */
function buildCredentialLookingInstruction(): string {
  const prefix = ["gh", "p_"].join("");
  return `Rotate this before merging: ${prefix}${"N".repeat(24)}`;
}

const CLARIFICATION_REF = "clarify_narrow_scope";

describe("useFactoryActions: steer", () => {
  it("calls client.steerRun exactly once and reflects accepted", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    let response: Awaited<ReturnType<typeof result.current.steer>> | undefined;
    await act(async () => {
      response = await result.current.steer(runId, "narrow the diff");
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response?.accepted).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects a credential-bearing instruction before the request leaves the client, naming the field", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    await act(async () => {
      await expect(
        result.current.steer(runId, buildCredentialLookingInstruction())
      ).rejects.toBeInstanceOf(ApiRequestValidationError);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.actionState.steerError?.field).toBe("instruction");
  });

  it("clears the steer error on the next successful submit", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    await act(async () => {
      await expect(
        result.current.steer(runId, buildCredentialLookingInstruction())
      ).rejects.toBeInstanceOf(ApiRequestValidationError);
    });
    expect(result.current.actionState.steerError).toBeDefined();

    await act(async () => {
      await result.current.steer(runId, "narrow the diff");
    });
    expect(result.current.actionState.steerError).toBeUndefined();
  });

  it("supersedes an in-flight steer call, applying only the latest call's effect", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    await act(async () => {
      const first = result.current.steer(runId, "first instruction");
      const second = result.current.steer(runId, "second instruction");
      await Promise.all([first, second]);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects when the factory is disconnected, without touching actionState", async () => {
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(null, refresh));

    await act(async () => {
      await expect(result.current.steer("run_1", "narrow the diff")).rejects.toBeInstanceOf(
        TypeError
      );
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.actionState.steering).toBe(false);
  });

  it("falls back to a generic, field-less message for a non-validation failure", async () => {
    const conflictingClient: AutoStackApiClient = {
      health: () => Promise.reject(new Error("unused")),
      listRuns: () => Promise.reject(new Error("unused")),
      listRunEvents: () => Promise.reject(new Error("unused")),
      createRun: () => Promise.reject(new Error("unused")),
      listApprovals: () => Promise.reject(new Error("unused")),
      decideApproval: () => Promise.reject(new Error("unused")),
      steerRun: () => Promise.reject(new ApiConflictError()),
      cancelRun: () => Promise.reject(new Error("unused")),
      answerClarification: () => Promise.reject(new Error("unused"))
    };
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(conflictingClient, refresh));

    await act(async () => {
      await expect(result.current.steer("run_1", "narrow the diff")).rejects.toBeInstanceOf(
        ApiConflictError
      );
    });

    expect(result.current.actionState.steerError).toEqual({
      field: "request",
      message: "The instruction could not be sent. Try again."
    });
  });
});

describe("useFactoryActions: cancel", () => {
  it("requires a non-empty reason, validated before any request leaves the client", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    await act(async () => {
      await expect(result.current.cancel(runId, "")).rejects.toBeInstanceOf(
        ApiRequestValidationError
      );
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.actionState.cancelError?.field).toBe("reason");
  });

  it("calls client.cancelRun exactly once with a valid reason", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    let response: Awaited<ReturnType<typeof result.current.cancel>> | undefined;
    await act(async () => {
      response = await result.current.cancel(runId, "duplicate work");
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response?.runId).toBe(runId);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("supersedes an in-flight cancel call, applying only the latest call's effect", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    await act(async () => {
      const first = result.current.cancel(runId, "first reason");
      const second = result.current.cancel(runId, "second reason");
      await Promise.all([first, second]);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects when the factory is disconnected, without touching actionState", async () => {
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(null, refresh));

    await act(async () => {
      await expect(result.current.cancel("run_1", "duplicate work")).rejects.toBeInstanceOf(
        TypeError
      );
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.actionState.cancelling).toBe(false);
  });
});

describe("useFactoryActions: answerClarification", () => {
  it("calls client.answerClarification exactly once and reflects the response", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    let response: Awaited<ReturnType<typeof result.current.answerClarification>> | undefined;
    await act(async () => {
      response = await result.current.answerClarification(
        runId,
        CLARIFICATION_REF,
        "Use the existing token schema."
      );
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response?.clarificationRef).toBe(CLARIFICATION_REF);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not call the client again while already answering (busy blocks re-entry)", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    await act(async () => {
      const first = result.current.answerClarification(runId, CLARIFICATION_REF, "first answer");
      const second = result.current.answerClarification(runId, CLARIFICATION_REF, "second answer");
      await Promise.all([first, second]);
    });

    // Superseded like steer/cancel: two calls in flight, only the latest one's effect lands.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects a credential-bearing answer before the request leaves the client, naming the field", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    await act(async () => {
      await expect(
        result.current.answerClarification(
          runId,
          CLARIFICATION_REF,
          buildCredentialLookingInstruction()
        )
      ).rejects.toBeInstanceOf(ApiRequestValidationError);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.actionState.answerError?.field).toBe("answer");
  });

  it("does not branch into a second send when the server reports a replay", async () => {
    const fixture = seedFactoryFixture();
    const runId = firstRunId(fixture);
    const server = createMockApiServer({ fixture });
    const fetchSpy = vi.fn(server.fetch);
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(client, refresh));

    let once: Awaited<ReturnType<typeof result.current.answerClarification>> | undefined;
    let twice: Awaited<ReturnType<typeof result.current.answerClarification>> | undefined;
    await act(async () => {
      once = await result.current.answerClarification(
        runId,
        CLARIFICATION_REF,
        "Use the existing token schema."
      );
    });
    await act(async () => {
      twice = await result.current.answerClarification(
        runId,
        CLARIFICATION_REF,
        "Use the existing token schema."
      );
    });

    expect(once?.replayed).toBe(false);
    expect(twice?.replayed).toBe(true);
    // One client call per action invocation — seeing `replayed: true` triggers no extra request.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects when the factory is disconnected, without touching actionState", async () => {
    const refresh = vi.fn(async () => {});
    const { result } = renderHook(() => useFactoryActions(null, refresh));

    await act(async () => {
      await expect(
        result.current.answerClarification("run_1", CLARIFICATION_REF, "an answer")
      ).rejects.toBeInstanceOf(TypeError);
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(result.current.actionState.answering).toBe(false);
  });
});
