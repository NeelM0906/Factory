import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from "react";

const THEME_STORAGE_KEY = "autostack.theme";
const MOTION_STORAGE_KEY = "autostack.motion";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type MotionPreference = "system" | "reduced" | "full";
export type ResolvedMotion = "reduced" | "full";

const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];
const MOTION_PREFERENCES: readonly MotionPreference[] = ["system", "reduced", "full"];

const THEME_OPTIONS: ReadonlyArray<{ readonly value: ThemePreference; readonly label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

const MOTION_OPTIONS: ReadonlyArray<{ readonly value: MotionPreference; readonly label: string }> =
  [
    { value: "system", label: "System" },
    { value: "reduced", label: "Reduced motion" },
    { value: "full", label: "Full motion" }
  ];

/** Matches the `{ getItem, setItem }` shape already used for `autostack.local-api-token`. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeContextValue {
  readonly theme: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly setTheme: (theme: ThemePreference) => void;
  readonly motion: MotionPreference;
  readonly resolvedMotion: ResolvedMotion;
  readonly setMotion: (motion: MotionPreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  readonly storage?: ThemeStorage;
  readonly matchMedia?: typeof window.matchMedia;
  readonly children: ReactNode;
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && (THEME_PREFERENCES as readonly string[]).includes(value);
}

function isMotionPreference(value: string | null): value is MotionPreference {
  return value !== null && (MOTION_PREFERENCES as readonly string[]).includes(value);
}

function readInitialPreference<T extends string>(
  storage: ThemeStorage | undefined,
  key: string,
  isValid: (value: string | null) => value is T,
  fallback: T
): T {
  if (storage === undefined) return fallback;
  const stored = storage.getItem(key);
  return isValid(stored) ? stored : fallback;
}

/**
 * Owns the theme and motion preferences and reflects them onto
 * `document.documentElement` as `data-theme` / `data-motion` (absent for
 * "system", so the CSS media queries in tokens.css stay authoritative).
 *
 * `storage` and `matchMedia` are both injected and both optional: with
 * neither supplied, the provider touches no persistence and no browser
 * media API, and simply defaults every axis to "system".
 */
export function ThemeProvider({ storage, matchMedia, children }: ThemeProviderProps): ReactElement {
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    readInitialPreference(storage, THEME_STORAGE_KEY, isThemePreference, "system")
  );
  const [motion, setMotionState] = useState<MotionPreference>(() =>
    readInitialPreference(storage, MOTION_STORAGE_KEY, isMotionPreference, "system")
  );

  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(
    () => matchMedia?.(DARK_SCHEME_QUERY).matches ?? false
  );
  const [systemPrefersReducedMotion, setSystemPrefersReducedMotion] = useState<boolean>(
    () => matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false
  );

  useEffect(() => {
    if (matchMedia === undefined) return undefined;

    const darkQuery = matchMedia(DARK_SCHEME_QUERY);
    const reducedMotionQuery = matchMedia(REDUCED_MOTION_QUERY);
    const handleDarkChange = (event: MediaQueryListEvent): void =>
      setSystemPrefersDark(event.matches);
    const handleReducedMotionChange = (event: MediaQueryListEvent): void =>
      setSystemPrefersReducedMotion(event.matches);

    darkQuery.addEventListener("change", handleDarkChange);
    reducedMotionQuery.addEventListener("change", handleReducedMotionChange);

    return () => {
      darkQuery.removeEventListener("change", handleDarkChange);
      reducedMotionQuery.removeEventListener("change", handleReducedMotionChange);
    };
  }, [matchMedia]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (motion === "system") {
      root.removeAttribute("data-motion");
    } else {
      root.setAttribute("data-motion", motion);
    }
  }, [motion]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setThemeState(next);
      storage?.setItem(THEME_STORAGE_KEY, next);
    },
    [storage]
  );

  const setMotion = useCallback(
    (next: MotionPreference) => {
      setMotionState(next);
      storage?.setItem(MOTION_STORAGE_KEY, next);
    },
    [storage]
  );

  const resolvedTheme: ResolvedTheme =
    theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;
  const resolvedMotion: ResolvedMotion =
    motion === "system" ? (systemPrefersReducedMotion ? "reduced" : "full") : motion;

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, motion, resolvedMotion, setMotion }),
    [theme, resolvedTheme, setTheme, motion, resolvedMotion, setMotion]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Reads the current theme/motion preference and resolved values. Must be used within `ThemeProvider`. */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return value;
}

/** Two labelled radiogroups letting the operator pin theme and motion, or return to following the system. */
export function ThemeControl(): ReactElement {
  const { theme, setTheme, motion, setMotion } = useTheme();

  return (
    <div className="as-theme-control">
      <div className="as-theme-control__group" role="radiogroup" aria-label="Theme">
        {THEME_OPTIONS.map((option) => (
          <label key={option.value} className="as-theme-control__option">
            <input
              type="radio"
              name="as-theme-preference"
              value={option.value}
              checked={theme === option.value}
              onChange={() => setTheme(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      <div className="as-theme-control__group" role="radiogroup" aria-label="Motion">
        {MOTION_OPTIONS.map((option) => (
          <label key={option.value} className="as-theme-control__option">
            <input
              type="radio"
              name="as-motion-preference"
              value={option.value}
              checked={motion === option.value}
              onChange={() => setMotion(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}
