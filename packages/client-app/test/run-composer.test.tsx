// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunIdSchema } from "@autostack/contracts";

import type { FactoryActionState } from "../src/use-factory-actions.js";
import { RunComposer } from "../src/composer/run-composer.js";

afterEach(cleanup);

const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000");

const idleActionState: FactoryActionState = { steering: false, cancelling: false };

function acceptedResponse() {
  return { runId: RUN_ID, accepted: true, acceptedAt: "2026-08-20T12:00:00.000Z" };
}

function cancelledResponse() {
  return { runId: RUN_ID, status: "cancelling" as const, requestedAt: "2026-08-20T12:00:00.000Z" };
}

describe("RunComposer — mode selection", () => {
  it("defaults to steer mode", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );
    expect(screen.getByRole("textbox", { name: /steer/i })).toBeInTheDocument();
  });

  it("switches to answer mode and back to steer mode", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByRole("textbox", { name: /answer/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(screen.getByRole("textbox", { name: /steer/i })).toBeInTheDocument();
  });

  it("switches to cancel mode", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: /cancel/i })).toBeInTheDocument();
  });
});

describe("RunComposer — steer", () => {
  it("calls steer with the run id and content exactly once", async () => {
    const steer = vi.fn(async () => acceptedResponse());
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={steer}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    fireEvent.change(screen.getByRole("textbox", { name: /steer/i }), {
      target: { value: "narrow the diff" }
    });
    fireEvent.click(screen.getByRole("button", { name: /send instruction/i }));

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(RUN_ID, "narrow the diff");
  });

  it("does not call steer when the textarea is empty", () => {
    const steer = vi.fn(async () => acceptedResponse());
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={steer}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /send instruction/i }));

    expect(steer).not.toHaveBeenCalled();
  });

  it("disables submission while steering, but leaves the textarea editable", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={{ ...idleActionState, steering: true }}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    const textarea = screen.getByRole("textbox", { name: /steer/i });
    fireEvent.change(textarea, { target: { value: "still typing" } });

    expect(textarea).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send instruction/i })).toBeDisabled();
  });

  it("renders the step 1 validation error, naming the field", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={{
          ...idleActionState,
          steerError: {
            field: "instruction",
            message: 'The "instruction" field failed request validation.'
          }
        }}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/"instruction"/);
  });

  it("clears the validation error once actionState reports success", () => {
    const { rerender } = render(
      <RunComposer
        runId={RUN_ID}
        actionState={{
          ...idleActionState,
          steerError: {
            field: "instruction",
            message: 'The "instruction" field failed request validation.'
          }
        }}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("RunComposer — cancel (two-step confirm)", () => {
  it("does not call cancel on the first submit; requires the confirm step", () => {
    const cancel = vi.fn(async () => cancelledResponse());
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={cancel}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("textbox", { name: /cancel/i }), {
      target: { value: "duplicate work" }
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));

    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be undone/i);
  });

  it("calls cancel with the run id and reason exactly once, after the confirm step", () => {
    const cancel = vi.fn(async () => cancelledResponse());
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={cancel}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("textbox", { name: /cancel/i }), {
      target: { value: "duplicate work" }
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm cancellation/i }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(RUN_ID, "duplicate work");
  });

  it("disables submission while cancelling, but leaves the textarea editable", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={{ ...idleActionState, cancelling: true }}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const textarea = screen.getByRole("textbox", { name: /cancel/i });
    fireEvent.change(textarea, { target: { value: "still typing" } });

    expect(textarea).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel run/i })).toBeDisabled();
  });

  it("renders the step 1 cancel validation error, naming the field", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={{
          ...idleActionState,
          cancelError: { field: "reason", message: 'The "reason" field failed request validation.' }
        }}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/"reason"/);
  });
});

describe("RunComposer — answer mode is visible but not served", () => {
  it("stays selectable and shows a typed, named unavailable state", () => {
    render(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    expect(
      screen.getByText(/answering clarifications is not served by this build/i)
    ).toBeInTheDocument();
  });

  it("keeps the submit affordance present (not absent) but disabled, and it never calls a network function", () => {
    const steer = vi.fn(async () => acceptedResponse());
    const cancel = vi.fn(async () => cancelledResponse());
    render(
      <RunComposer runId={RUN_ID} actionState={idleActionState} steer={steer} cancel={cancel} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.change(screen.getByRole("textbox", { name: /answer/i }), {
      target: { value: "the answer" }
    });
    const submit = screen.getByRole("button", { name: /send answer/i });
    expect(submit).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.click(submit);

    expect(steer).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
