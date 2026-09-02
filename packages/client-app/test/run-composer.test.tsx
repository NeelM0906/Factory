// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunIdSchema } from "@autostack/contracts";

import type { FactoryActionState } from "../src/use-factory-actions.js";
import { RunComposer, type RunComposerProps } from "../src/composer/run-composer.js";

afterEach(cleanup);

const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000");
const CLARIFICATION_REF = "clarify_narrow_scope";

const idleActionState: FactoryActionState = {
  steering: false,
  cancelling: false,
  answering: false
};

function acceptedResponse() {
  return { runId: RUN_ID, accepted: true, acceptedAt: "2026-08-20T12:00:00.000Z" };
}

function cancelledResponse() {
  return { runId: RUN_ID, status: "cancelling" as const, requestedAt: "2026-08-20T12:00:00.000Z" };
}

function answeredResponse(replayed = false) {
  return {
    runId: RUN_ID,
    clarificationRef: CLARIFICATION_REF,
    answeredAt: "2026-08-20T12:00:00.000Z",
    replayed
  };
}

interface RenderOverrides {
  readonly actionState?: FactoryActionState;
  readonly steer?: RunComposerProps["steer"];
  readonly cancel?: RunComposerProps["cancel"];
  readonly answerClarification?: RunComposerProps["answerClarification"];
  readonly clarificationRef?: string | undefined;
}

/** Renders `RunComposer` with sensible defaults — `answer` mode has a pending clarification by
 * default, since most tests exercise the wired-up case; pass `clarificationRef: undefined`
 * explicitly for the no-pending-clarification tests. */
function renderComposer(overrides: RenderOverrides = {}) {
  const clarificationRef =
    "clarificationRef" in overrides ? overrides.clarificationRef : CLARIFICATION_REF;
  return render(
    <RunComposer
      runId={RUN_ID}
      actionState={overrides.actionState ?? idleActionState}
      steer={overrides.steer ?? vi.fn(async () => acceptedResponse())}
      cancel={overrides.cancel ?? vi.fn(async () => cancelledResponse())}
      answerClarification={overrides.answerClarification ?? vi.fn(async () => answeredResponse())}
      clarificationRef={clarificationRef}
    />
  );
}

describe("RunComposer — mode selection", () => {
  it("defaults to steer mode", () => {
    renderComposer();
    expect(screen.getByRole("textbox", { name: /steer/i })).toBeInTheDocument();
  });

  it("switches to answer mode and back to steer mode", () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByRole("textbox", { name: /answer/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(screen.getByRole("textbox", { name: /steer/i })).toBeInTheDocument();
  });

  it("switches to cancel mode", () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: /cancel/i })).toBeInTheDocument();
  });
});

describe("RunComposer — steer", () => {
  it("calls steer with the run id and content exactly once", async () => {
    const steer = vi.fn(async () => acceptedResponse());
    renderComposer({ steer });

    fireEvent.change(screen.getByRole("textbox", { name: /steer/i }), {
      target: { value: "narrow the diff" }
    });
    fireEvent.click(screen.getByRole("button", { name: /send instruction/i }));

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(RUN_ID, "narrow the diff");
  });

  it("does not call steer when the textarea is empty", () => {
    const steer = vi.fn(async () => acceptedResponse());
    renderComposer({ steer });

    fireEvent.click(screen.getByRole("button", { name: /send instruction/i }));

    expect(steer).not.toHaveBeenCalled();
  });

  it("disables submission while steering, but leaves the textarea editable", () => {
    renderComposer({ actionState: { ...idleActionState, steering: true } });

    const textarea = screen.getByRole("textbox", { name: /steer/i });
    fireEvent.change(textarea, { target: { value: "still typing" } });

    expect(textarea).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /send instruction/i })).toBeDisabled();
  });

  it("renders the step 1 validation error, naming the field", () => {
    renderComposer({
      actionState: {
        ...idleActionState,
        steerError: {
          field: "instruction",
          message: 'The "instruction" field failed request validation.'
        }
      }
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/"instruction"/);
  });

  it("clears the validation error once actionState reports success", () => {
    const { rerender } = renderComposer({
      actionState: {
        ...idleActionState,
        steerError: {
          field: "instruction",
          message: 'The "instruction" field failed request validation.'
        }
      }
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <RunComposer
        runId={RUN_ID}
        actionState={idleActionState}
        steer={vi.fn(async () => acceptedResponse())}
        cancel={vi.fn(async () => cancelledResponse())}
        answerClarification={vi.fn(async () => answeredResponse())}
        clarificationRef={CLARIFICATION_REF}
      />
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("RunComposer — cancel (two-step confirm)", () => {
  it("does not call cancel on the first submit; requires the confirm step", () => {
    const cancel = vi.fn(async () => cancelledResponse());
    renderComposer({ cancel });

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
    renderComposer({ cancel });

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
    renderComposer({ actionState: { ...idleActionState, cancelling: true } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const textarea = screen.getByRole("textbox", { name: /cancel/i });
    fireEvent.change(textarea, { target: { value: "still typing" } });

    expect(textarea).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel run/i })).toBeDisabled();
  });

  it("renders the step 1 cancel validation error, naming the field", () => {
    renderComposer({
      actionState: {
        ...idleActionState,
        cancelError: { field: "reason", message: 'The "reason" field failed request validation.' }
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/"reason"/);
  });
});

describe("RunComposer — answer (E1 resolved, real wiring)", () => {
  it("calls answerClarification with the run id, clarificationRef, and content exactly once", () => {
    const answerClarification = vi.fn(async () => answeredResponse());
    const steer = vi.fn(async () => acceptedResponse());
    const cancel = vi.fn(async () => cancelledResponse());
    renderComposer({ answerClarification, steer, cancel });

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.change(screen.getByRole("textbox", { name: /answer/i }), {
      target: { value: "Use the existing token schema." }
    });
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    expect(answerClarification).toHaveBeenCalledTimes(1);
    expect(answerClarification).toHaveBeenCalledWith(
      RUN_ID,
      CLARIFICATION_REF,
      "Use the existing token schema."
    );
    // Positive companions (per the interim ruling's inversion): steer and cancel are untouched.
    expect(steer).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not call answerClarification when the textarea is empty", () => {
    const answerClarification = vi.fn(async () => answeredResponse());
    renderComposer({ answerClarification });

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    expect(answerClarification).not.toHaveBeenCalled();
  });

  it("disables submission while answering, but leaves the textarea editable", () => {
    const answerClarification = vi.fn(async () => answeredResponse());
    renderComposer({
      actionState: { ...idleActionState, answering: true },
      answerClarification
    });

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const textarea = screen.getByRole("textbox", { name: /answer/i });
    fireEvent.change(textarea, { target: { value: "still typing" } });
    const submit = screen.getByRole("button", { name: /send answer/i });
    fireEvent.click(submit);

    expect(textarea).not.toBeDisabled();
    expect(submit).toBeDisabled();
    expect(answerClarification).not.toHaveBeenCalled();
  });

  it("renders the answerClarification validation error, naming the field", () => {
    renderComposer({
      actionState: {
        ...idleActionState,
        answerError: { field: "answer", message: 'The "answer" field failed request validation.' }
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/"answer"/);
  });

  it("shows a named 'no clarification pending' state, without an interactive composer, when clarificationRef is undefined", () => {
    const answerClarification = vi.fn(async () => answeredResponse());
    renderComposer({ answerClarification, clarificationRef: undefined });

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    expect(
      screen.getByText(/no clarification is pending to answer for this run/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send answer/i })).toBeNull();
    expect(answerClarification).not.toHaveBeenCalled();
  });
});
