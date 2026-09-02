import { NAVIGATION_DESTINATIONS, type NavigationDestination } from "@autostack/ui";

/**
 * The six AppShell destinations surfaced to the workbench, re-exported from the UI layer.
 * Spec section 4.2 references these as the top-level navigation targets.
 */
export const WORKBENCH_DESTINATIONS: readonly NavigationDestination[] = NAVIGATION_DESTINATIONS;

/**
 * Destinations that are disabled in the current build. The `automations` destination is a
 * future-stage feature (spec section 4.2) and renders as `aria-disabled` with a description.
 */
export const DISABLED_DESTINATIONS: ReadonlySet<NavigationDestination> =
  new Set<NavigationDestination>(["automations"]);

/** Human-readable description shown on disabled destinations. */
export const DISABLED_DESCRIPTIONS: Readonly<Partial<Record<NavigationDestination, string>>> = {
  automations: "Automations is a future-stage feature and is not yet available."
};
