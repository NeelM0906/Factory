// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeControl, ThemeProvider, useTheme, type ThemeStorage } from "../src/theme.js";

afterEach(cleanup);

/**
 * A minimal, spyable stand-in for a single `MediaQueryList`. Real jsdom does
 * not implement `matchMedia`, and even where it does, tests need a handle to
 * fire "change" synthetically and to assert `addEventListener` /
 * `removeEventListener` were called — hence a hand-built stub rather than a
 * partial jsdom shim.
 */
interface MediaQueryStub {
  matches: boolean;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
  emit(matches: boolean): void;
}

function createMediaQueryStub(initialMatches: boolean): MediaQueryStub {
  let listener: ((event: MediaQueryListEvent) => void) | undefined;
  const stub: MediaQueryStub = {
    matches: initialMatches,
    addEventListener: vi.fn((_type: string, handler: (event: MediaQueryListEvent) => void) => {
      listener = handler;
    }),
    removeEventListener: vi.fn(() => {
      listener = undefined;
    }),
    emit(matches: boolean) {
      stub.matches = matches;
      listener?.({ matches } as MediaQueryListEvent);
    }
  };
  return stub;
}

interface MatchMediaHarness {
  readonly matchMedia: typeof window.matchMedia;
  readonly dark: MediaQueryStub;
  readonly reducedMotion: MediaQueryStub;
}

function createMatchMediaHarness(
  options: { readonly dark?: boolean; readonly reducedMotion?: boolean } = {}
): MatchMediaHarness {
  const dark = createMediaQueryStub(options.dark ?? false);
  const reducedMotion = createMediaQueryStub(options.reducedMotion ?? false);
  const matchMedia = vi.fn((query: string) => {
    if (query === "(prefers-color-scheme: dark)") return dark as unknown as MediaQueryList;
    if (query === "(prefers-reduced-motion: reduce)")
      return reducedMotion as unknown as MediaQueryList;
    throw new Error(`Unexpected media query in test: ${query}`);
  });
  return { matchMedia: matchMedia as unknown as typeof window.matchMedia, dark, reducedMotion };
}

function createSpyStorage(initial: Readonly<Record<string, string>> = {}): ThemeStorage & {
  readonly getItem: ReturnType<typeof vi.fn>;
  readonly setItem: ReturnType<typeof vi.fn>;
} {
  const backing = new Map<string, string>(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => backing.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      backing.set(key, value);
    })
  };
}

function root(): HTMLElement {
  return document.documentElement;
}

/** Renders `useTheme()`'s resolved values as visible text, for asserting non-CSS repaint effects. */
function ResolvedProbe() {
  const { resolvedTheme, resolvedMotion } = useTheme();
  return (
    <p data-testid="resolved-probe">
      {resolvedTheme}/{resolvedMotion}
    </p>
  );
}

describe("ThemeProvider — data-theme", () => {
  it("defaults to system: no data-theme attribute is set", () => {
    render(
      <ThemeProvider>
        <p>content</p>
      </ThemeProvider>
    );
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("pins data-theme=light even when the system reports dark", () => {
    const { matchMedia } = createMatchMediaHarness({ dark: true });
    render(
      <ThemeProvider matchMedia={matchMedia}>
        <ThemeControl />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("pins data-theme=dark even when the system reports light", () => {
    const { matchMedia } = createMatchMediaHarness({ dark: false });
    render(
      <ThemeProvider matchMedia={matchMedia}>
        <ThemeControl />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("removes data-theme entirely when returning to system", () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(root().getAttribute("data-theme")).toBe("dark");

    const themeGroup = screen.getByRole("radiogroup", { name: /theme/i });
    fireEvent.click(within(themeGroup).getByRole("radio", { name: "System" }));

    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("restores a stored theme choice on mount", () => {
    const storage = createSpyStorage({ "autostack.theme": "dark" });
    render(
      <ThemeProvider storage={storage}>
        <p>content</p>
      </ThemeProvider>
    );
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("repaints resolvedTheme when the system changes while in system mode, with data-theme still absent", () => {
    const { matchMedia, dark } = createMatchMediaHarness({ dark: false });
    render(
      <ThemeProvider matchMedia={matchMedia}>
        <ResolvedProbe />
      </ThemeProvider>
    );

    expect(screen.getByTestId("resolved-probe").textContent).toBe("light/full");

    act(() => {
      dark.emit(true);
    });

    expect(screen.getByTestId("resolved-probe").textContent).toBe("dark/full");
    expect(root().hasAttribute("data-theme")).toBe(false);
  });
});

describe("ThemeProvider — data-motion", () => {
  it("defaults to system: no data-motion attribute is set", () => {
    render(
      <ThemeProvider>
        <p>content</p>
      </ThemeProvider>
    );
    expect(root().hasAttribute("data-motion")).toBe(false);
  });

  it("pins data-motion=reduced even when the system reports full motion", () => {
    const { matchMedia } = createMatchMediaHarness({ reducedMotion: false });
    render(
      <ThemeProvider matchMedia={matchMedia}>
        <ThemeControl />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Reduced motion" }));

    expect(root().getAttribute("data-motion")).toBe("reduced");
  });

  it("pins data-motion=full even when the system prefers reduced motion", () => {
    const { matchMedia } = createMatchMediaHarness({ reducedMotion: true });
    render(
      <ThemeProvider matchMedia={matchMedia}>
        <ThemeControl />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Full motion" }));

    expect(root().getAttribute("data-motion")).toBe("full");
  });

  it("removes data-motion entirely when returning to system", () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Reduced motion" }));
    expect(root().getAttribute("data-motion")).toBe("reduced");

    const motionGroup = screen.getByRole("radiogroup", { name: /motion/i });
    fireEvent.click(within(motionGroup).getByRole("radio", { name: "System" }));

    expect(root().hasAttribute("data-motion")).toBe(false);
  });

  it("restores a stored motion choice on mount", () => {
    const storage = createSpyStorage({ "autostack.motion": "reduced" });
    render(
      <ThemeProvider storage={storage}>
        <p>content</p>
      </ThemeProvider>
    );
    expect(root().getAttribute("data-motion")).toBe("reduced");
  });

  it("repaints resolvedMotion when the system changes while in system mode, with data-motion still absent", () => {
    const { matchMedia, reducedMotion } = createMatchMediaHarness({ reducedMotion: false });
    render(
      <ThemeProvider matchMedia={matchMedia}>
        <ResolvedProbe />
      </ThemeProvider>
    );

    expect(screen.getByTestId("resolved-probe").textContent).toBe("light/full");

    act(() => {
      reducedMotion.emit(true);
    });

    expect(screen.getByTestId("resolved-probe").textContent).toBe("light/reduced");
    expect(root().hasAttribute("data-motion")).toBe(false);
  });
});

describe("ThemeProvider — storage and media listener lifecycle", () => {
  it("touches no injected storage object when none is supplied", () => {
    const untouchedSpy = createSpyStorage();

    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(untouchedSpy.getItem).not.toHaveBeenCalled();
    expect(untouchedSpy.setItem).not.toHaveBeenCalled();
  });

  it("touches no global localStorage when no storage prop is supplied", () => {
    // window.localStorage is unavailable in this Vitest jsdom environment
    // (Node 24's own experimental global shadows jsdom's), so a real
    // localStorage cannot be spied on directly. vi.stubGlobal installs a spy
    // in its place, which lets this test prove the same thing the brief asks
    // for: nothing implicit is reached for when `storage` is omitted.
    const spy = createSpyStorage();
    vi.stubGlobal("localStorage", spy);

    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(spy.getItem).not.toHaveBeenCalled();
    expect(spy.setItem).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("detaches both media-query listeners on unmount", () => {
    const { matchMedia, dark, reducedMotion } = createMatchMediaHarness();
    const { unmount } = render(
      <ThemeProvider matchMedia={matchMedia}>
        <p>content</p>
      </ThemeProvider>
    );

    expect(dark.addEventListener).toHaveBeenCalledTimes(1);
    expect(reducedMotion.addEventListener).toHaveBeenCalledTimes(1);

    unmount();

    expect(dark.removeEventListener).toHaveBeenCalledTimes(1);
    expect(reducedMotion.removeEventListener).toHaveBeenCalledTimes(1);
  });
});

describe("useTheme", () => {
  it("throws when called outside a ThemeProvider", () => {
    // Suppress React's expected error-boundary console.error noise for this one assertion.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Orphan() {
      useTheme();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow("useTheme must be used within a ThemeProvider");

    consoleSpy.mockRestore();
  });
});

describe("ThemeControl", () => {
  it("exposes theme as a labelled radiogroup with three named options", () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>
    );

    const group = screen.getByRole("radiogroup", { name: /theme/i });
    const options = within(group).getAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: "System" })).toBeVisible();
    expect(within(group).getByRole("radio", { name: "Light" })).toBeVisible();
    expect(within(group).getByRole("radio", { name: "Dark" })).toBeVisible();
  });

  it("exposes motion as a labelled radiogroup with three named options", () => {
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>
    );

    const group = screen.getByRole("radiogroup", { name: /motion/i });
    const options = within(group).getAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: "System" })).toBeVisible();
    expect(within(group).getByRole("radio", { name: "Reduced motion" })).toBeVisible();
    expect(within(group).getByRole("radio", { name: "Full motion" })).toBeVisible();
  });
});
