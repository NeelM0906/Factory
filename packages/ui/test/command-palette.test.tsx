// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { useState } from "react";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette, type CommandPaletteCommand } from "../src/command-palette.js";

afterEach(cleanup);

const COMMANDS: readonly CommandPaletteCommand[] = [
  { id: "create-run", title: "Create run" },
  { id: "locate-run", title: "Locate run" },
  { id: "cancel-run", title: "Cancel run", disabledReason: "No run is selected" }
];

/**
 * A realistic host: a button that opens the palette (the invoker) and the
 * palette itself, wired the way a real caller would wire it — `open` is
 * state the palette does not own, `onClose` flips it back.
 */
function Harness({
  commands = COMMANDS,
  onInvoke = () => {}
}: {
  commands?: readonly CommandPaletteCommand[];
  onInvoke?: (commandId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette
        open={open}
        label="Commands"
        commands={commands}
        onClose={() => setOpen(false)}
        onInvoke={onInvoke}
      />
    </div>
  );
}

describe("CommandPalette — structure", () => {
  it("renders a modal dialog with an accessible name when open", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const dialog = screen.getByRole("dialog", { name: "Commands" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("renders nothing when closed", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves focus to the filter input on open", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("lists commands as options inside a listbox", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Create run")])
    );
    expect(options).toHaveLength(3);
  });

  it("filters commands by a case-insensitive substring match on the title", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "LOC" } });

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Locate run");
  });

  it("keeps an unavailable command visible with aria-disabled rather than omitting it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const disabledOption = screen.getByRole("option", { name: /Cancel run/ });
    expect(disabledOption).toHaveAttribute("aria-disabled", "true");
    expect(disabledOption).toBeVisible();
  });
});

describe("CommandPalette — arrow navigation keeps DOM focus on the input", () => {
  it("ArrowDown moves aria-activedescendant to the next option without moving DOM focus", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const input = screen.getByRole("combobox");
    const firstOption = screen.getByRole("option", { name: "Create run" });
    expect(input).toHaveAttribute("aria-activedescendant", firstOption.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });

    const secondOption = screen.getByRole("option", { name: "Locate run" });
    expect(input).toHaveAttribute("aria-activedescendant", secondOption.id);
    expect(document.activeElement).toBe(input);
  });

  it("ArrowUp moves the cursor back up, still without moving DOM focus", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    const firstOption = screen.getByRole("option", { name: "Create run" });
    expect(input).toHaveAttribute("aria-activedescendant", firstOption.id);
    expect(document.activeElement).toBe(input);
  });
});

describe("CommandPalette — Enter invokes the active command (guard)", () => {
  it("invokes the active, available command on Enter", () => {
    const onInvoke = vi.fn();
    render(<Harness onInvoke={onInvoke} />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(onInvoke).toHaveBeenCalledWith("create-run");
  });

  it("does NOT invoke a command rendered aria-disabled, even though it is the active option", () => {
    const onInvoke = vi.fn();
    render(<Harness onInvoke={onInvoke} />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const input = screen.getByRole("combobox");
    // Move the cursor to "Cancel run", the disabled command, then try to invoke it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Cancel run/ }).id
    );

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onInvoke).not.toHaveBeenCalled();
  });
});

describe("CommandPalette — Escape returns focus to the invoker (guard)", () => {
  it("closes the dialog and restores focus to the element that opened it", () => {
    render(<Harness />);
    const invoker = screen.getByRole("button", { name: "Open palette" });
    // jsdom, unlike a real browser, does not focus a button as a side effect
    // of fireEvent.click — focus it explicitly, matching how a real click
    // leaves the invoker focused before the palette takes focus away.
    invoker.focus();
    fireEvent.click(invoker);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(invoker);
  });
});

describe("CommandPalette — focus trap wrap-around (guard)", () => {
  it("Shift+Tab from the filter input (first) wraps to the close button (last)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const input = screen.getByRole("combobox");
    const closeButton = screen.getByRole("button", { name: /close/i });

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(closeButton);
  });

  it("Tab from the close button (last) wraps to the filter input (first)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));

    const closeButton = screen.getByRole("button", { name: /close/i });
    closeButton.focus();

    fireEvent.keyDown(closeButton, { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });
});
