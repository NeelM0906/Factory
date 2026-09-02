// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CommandPalette } from "@autostack/ui";

import {
  buildCommandRegistry,
  useCommandPaletteShortcut,
  type CommandSelection
} from "../src/commands/command-registry.js";

afterEach(cleanup);

const idleSelection: CommandSelection = { selectedRunStatus: undefined, creating: false };

const COMMAND_IDS = [
  "create-run",
  "locate-run",
  "open-run",
  "cancel-run",
  "retry-run",
  "hand-off-run"
];

function findCommand(commands: ReturnType<typeof buildCommandRegistry>, id: string) {
  const command = commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`No "${id}" command in the registry output.`);
  return command;
}

describe("buildCommandRegistry — every command is always emitted", () => {
  it("emits exactly the six required commands, every time, regardless of selection", () => {
    const commands = buildCommandRegistry(idleSelection);
    expect(commands.map((command) => command.id).sort()).toEqual([...COMMAND_IDS].sort());
  });
});

describe("buildCommandRegistry — create (per-branch: creating flag)", () => {
  it("is available when no create request is in flight", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, creating: false }),
      "create-run"
    );
    expect(command.disabledReason).toBeUndefined();
  });

  it("is unavailable while a create request is already in flight", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, creating: true }),
      "create-run"
    );
    expect(command.disabledReason).toBeDefined();
  });
});

describe("buildCommandRegistry — locate (per-branch: selection presence)", () => {
  it("is available when a run is selected", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, selectedRunStatus: "implementing" }),
      "locate-run"
    );
    expect(command.disabledReason).toBeUndefined();
  });

  it("is unavailable when no run is selected", () => {
    const command = findCommand(buildCommandRegistry(idleSelection), "locate-run");
    expect(command.disabledReason).toBeDefined();
  });
});

describe("buildCommandRegistry — open (per-branch: selection presence)", () => {
  it("is available when a run is selected", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, selectedRunStatus: "implementing" }),
      "open-run"
    );
    expect(command.disabledReason).toBeUndefined();
  });

  it("is unavailable when no run is selected", () => {
    const command = findCommand(buildCommandRegistry(idleSelection), "open-run");
    expect(command.disabledReason).toBeDefined();
  });
});

describe("buildCommandRegistry — cancel (per-branch: selection presence and cancellable status)", () => {
  it("is available when the selected run is still cancellable", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, selectedRunStatus: "implementing" }),
      "cancel-run"
    );
    expect(command.disabledReason).toBeUndefined();
  });

  it("is unavailable when no run is selected", () => {
    const command = findCommand(buildCommandRegistry(idleSelection), "cancel-run");
    expect(command.disabledReason).toBeDefined();
  });

  it("is unavailable when the selected run is already terminal", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, selectedRunStatus: "completed" }),
      "cancel-run"
    );
    expect(command.disabledReason).toBeDefined();
  });
});

describe("buildCommandRegistry — retry (per-branch: selection presence and failed status)", () => {
  it("is available when the selected run has failed", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, selectedRunStatus: "failed" }),
      "retry-run"
    );
    expect(command.disabledReason).toBeUndefined();
  });

  it("is unavailable when no run is selected", () => {
    const command = findCommand(buildCommandRegistry(idleSelection), "retry-run");
    expect(command.disabledReason).toBeDefined();
  });

  it("is unavailable when the selected run has not failed", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, selectedRunStatus: "implementing" }),
      "retry-run"
    );
    expect(command.disabledReason).toBeDefined();
  });
});

describe("buildCommandRegistry — hand-off (per-branch: transferable work vs finished)", () => {
  // Lead ruling (Task 7 step 3 review): hand-off = hand work to another coding-agent teammate
  // (spec §4.1), so it tracks transferable work, not human-decision states.
  it.each(["implementing", "needs_clarification", "waiting_for_user", "retry_scheduled"] as const)(
    "is available while work remains transferable (%s)",
    (status) => {
      const command = findCommand(
        buildCommandRegistry({ ...idleSelection, selectedRunStatus: status }),
        "hand-off-run"
      );
      expect(command.disabledReason).toBeUndefined();
    }
  );

  it("is available for a failed run — the moment to pick a different agent instead of retrying", () => {
    const command = findCommand(
      buildCommandRegistry({ ...idleSelection, selectedRunStatus: "failed" }),
      "hand-off-run"
    );
    expect(command.disabledReason).toBeUndefined();
  });

  it("is unavailable when no run is selected", () => {
    const command = findCommand(buildCommandRegistry(idleSelection), "hand-off-run");
    expect(command.disabledReason).toBeDefined();
  });

  it.each(["completed", "cancelled", "cancelling"] as const)(
    "is unavailable once the work is finished or being torn down (%s)",
    (status) => {
      const command = findCommand(
        buildCommandRegistry({ ...idleSelection, selectedRunStatus: status }),
        "hand-off-run"
      );
      expect(command.disabledReason).toBeDefined();
    }
  );
});

/**
 * A realistic host, matching `packages/ui/test/command-palette.test.tsx`'s own harness pattern:
 * a button elsewhere in "the shell" and the palette, wired through the hook under test rather
 * than local `useState` — proving `useCommandPaletteShortcut` and `buildCommandRegistry` compose
 * with the real `CommandPalette` primitive exactly the way a future shell composition will.
 */
function Harness({ selection = idleSelection }: { selection?: CommandSelection }) {
  const { open, closePalette } = useCommandPaletteShortcut();
  const commands = buildCommandRegistry(selection);
  return (
    <div>
      <button type="button">Elsewhere in the shell</button>
      <CommandPalette
        open={open}
        label="Commands"
        commands={commands}
        onClose={closePalette}
        onInvoke={() => {}}
      />
    </div>
  );
}

describe("useCommandPaletteShortcut — Cmd/Ctrl+K opens from anywhere in the shell", () => {
  it("opens on metaKey+K", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens on ctrlKey+K", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("ignores a bare 'k' with neither modifier", () => {
    render(<Harness />);

    fireEvent.keyDown(document, { key: "k" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("useCommandPaletteShortcut — Escape returns focus to the invoker (guard)", () => {
  it("restores focus to the element that had it before the palette opened", () => {
    render(<Harness />);
    const invoker = screen.getByRole("button", { name: "Elsewhere in the shell" });
    // Third vacuous-guard vector: fireEvent.click does not move focus in this jsdom, so focus
    // the invoker explicitly — otherwise the assertion below passes against <body> regardless of
    // whether focus restoration actually works.
    invoker.focus();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(invoker);
  });
});

describe("useCommandPaletteShortcut — re-entrant open guard", () => {
  it("does not close (toggle) the palette on a second Cmd+K while already open", () => {
    render(<Harness />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("command palette — an unavailable command stays visible and aria-disabled", () => {
  it("renders 'Open run' present and aria-disabled when no run is selected", () => {
    render(<Harness selection={idleSelection} />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });

    const option = screen.getByRole("option", { name: /open run/i });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toBeVisible();
  });
});
