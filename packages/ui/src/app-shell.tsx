import type { ReactNode } from "react";

export const NAVIGATION_DESTINATIONS = [
  "factory",
  "projects",
  "automations",
  "approvals",
  "integrations",
  "settings"
] as const;

export type NavigationDestination = (typeof NAVIGATION_DESTINATIONS)[number];

const NAVIGATION_LABELS: Record<NavigationDestination, string> = {
  factory: "Factory",
  projects: "Projects",
  automations: "Automations",
  approvals: "Approvals",
  integrations: "Integrations",
  settings: "Settings"
};

export interface AppShellProps {
  readonly activeDestination: NavigationDestination;
  readonly sidebar: ReactNode;
  readonly inspector?: ReactNode;
  readonly children: ReactNode;
  readonly disabledDestinations?: ReadonlySet<NavigationDestination>;
  readonly disabledDescriptions?: Readonly<Partial<Record<NavigationDestination, string>>>;
}

export function AppShell({
  activeDestination,
  sidebar,
  inspector,
  children,
  disabledDestinations,
  disabledDescriptions
}: AppShellProps) {
  return (
    <div className="as-shell">
      <a className="as-skip-link" href="#autostack-main">
        Skip to factory workspace
      </a>
      <nav className="as-rail" aria-label="Primary">
        <a className="as-brand" href="#factory" aria-label="AutoStack home">
          <span className="as-brand__mark" aria-hidden="true">
            AS
          </span>
          <span>AutoStack</span>
        </a>
        <ul className="as-rail__list">
          {NAVIGATION_DESTINATIONS.map((destination) => {
            const isDisabled = disabledDestinations?.has(destination) === true;
            const description = isDisabled ? disabledDescriptions?.[destination] : undefined;
            return (
              <li key={destination}>
                <a
                  className="as-rail__link"
                  href={isDisabled ? undefined : `#${destination}`}
                  aria-current={destination === activeDestination ? "page" : undefined}
                  {...(isDisabled ? { "aria-disabled": "true" as const } : {})}
                  {...(description !== undefined ? { "aria-description": description } : {})}
                >
                  <span className="as-rail__glyph" aria-hidden="true">
                    {NAVIGATION_LABELS[destination].slice(0, 1)}
                  </span>
                  <span>{NAVIGATION_LABELS[destination]}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <aside className="as-sidebar" aria-label="Project and run navigation">
        {sidebar}
      </aside>
      <main id="autostack-main" className="as-main" aria-label="Factory workspace" tabIndex={-1}>
        {children}
      </main>
      {inspector === undefined ? null : (
        <aside className="as-inspector" aria-label="Run inspector">
          {inspector}
        </aside>
      )}
    </div>
  );
}
