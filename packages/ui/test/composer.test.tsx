// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../src/composer.js";

afterEach(cleanup);

describe("Composer — modes each have their own label and submit affordance", () => {
  it("labels the steer mode distinctly", () => {
    render(<Composer mode="steer" onSubmit={() => {}} />);
    expect(screen.getByRole("textbox", { name: /steer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("labels the answer mode distinctly", () => {
    render(<Composer mode="answer" onSubmit={() => {}} />);
    expect(screen.getByRole("textbox", { name: /answer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /answer/i })).toBeInTheDocument();
  });

  it("labels the cancel mode distinctly, and its own submit affordance differs from steer/answer", () => {
    render(<Composer mode="cancel" onSubmit={() => {}} />);
    expect(screen.getByRole("textbox", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel run/i })).toBeInTheDocument();
  });
});

describe("Composer — submitting empty content does nothing", () => {
  it("does not call onSubmit when the textarea is empty", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="steer" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not call onSubmit when the textarea holds only whitespace", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="steer" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit with the trimmed content once real content is present", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="steer" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  narrow the diff  " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("narrow the diff");
  });
});

describe("Composer — cancel mode requires an explicit confirm step", () => {
  it("does not call onSubmit on the first click; it surfaces a confirm step instead", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="cancel" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "duplicate of run-4" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be undone/i);
  });

  it("calls onSubmit once the confirm step is itself confirmed", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="cancel" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "duplicate of run-4" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("duplicate of run-4");
  });

  it("backing out of the confirm step does not call onSubmit", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="cancel" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "duplicate of run-4" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Composer — busy disables submission without removing the control (guard)", () => {
  it("keeps the submit button in the accessibility tree, but disabled, while busy", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="steer" busy onSubmit={onSubmit} />);

    // The control must still be findable by role — an unmounted button would fail this line.
    const button = screen.getByRole("button", { name: /send/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it("does not call onSubmit when clicked while busy, even with content present", () => {
    const onSubmit = vi.fn();
    render(<Composer mode="steer" busy onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "narrow the diff" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("the same content submits once busy is lifted, proving the button truly re-enables", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Composer mode="steer" busy onSubmit={onSubmit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "narrow the diff" } });
    rerender(<Composer mode="steer" busy={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
