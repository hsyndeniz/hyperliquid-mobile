/**
 * The app's light/dark/system preference — the rules, where Jest can reach
 * them.
 *
 * **Uniwind owns the live theme; this module owns only the memory of it.**
 * `Uniwind.setTheme()` is a singleton that notifies its own subscribers, so
 * `useUniwind()` already re-renders every styled view on a change. Mirroring
 * that into React state would create a second source of truth that can drift
 * from the one actually painting the screen. So the control reads its selected
 * value back out of Uniwind ({@link resolveChoice}) and this module's storage
 * exists for one job: surviving a relaunch.
 *
 * `hasAdaptiveThemes` is the flag that makes the tri-state work — it is `true`
 * exactly when the theme is following the OS, which is what separates "System"
 * from an explicit choice that happens to match the OS right now.
 *
 * ## Two systems have to agree
 *
 * Uniwind paints from its OWN theme state; React Native's `Appearance` is what
 * `useColorScheme()`, native views and the system keyboard read. Uniwind does
 * call `Appearance.setColorScheme` internally, but that write only lands once
 * a window exists — applied at module scope (before the root mounts) it is
 * silently dropped, and the two desync: measured on device with the OS in dark
 * and the app painting dark, `Appearance.getColorScheme()` still said `light`.
 *
 * So `applyAppearance` (its own module — this one stays pure so Jest can reach
 * it; `uniwind` resolves to TypeScript source that the transform allowlist
 * does not cover) sets both, and the root applies the stored value again from
 * an EFFECT — see `_layout.tsx` for the split: Uniwind at module scope so
 * there is no flash of the wrong theme, `Appearance` after mount so the write
 * has a window to land on.
 */

import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

/** What the user picked — not what is currently painted. */
export type AppearanceChoice = "system" | "light" | "dark";

/** The theme Uniwind resolved to. Never `"system"` — that is not a palette. */
export type ResolvedTheme = "light" | "dark";

const APPEARANCE_KEY = "hl:app:appearance";

/**
 * Following the OS is the default.
 *
 * A fresh install has no opinion about this, and the OS does — inheriting it
 * is the only choice that is right without asking. An app that opens dark on a
 * phone set to light has made a decision it had no basis for.
 */
export const DEFAULT_APPEARANCE: AppearanceChoice = "system";

/** Segment order: the default first, then the two overrides. */
export const APPEARANCE_OPTIONS: readonly { value: AppearanceChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function isAppearanceChoice(value: string | null): value is AppearanceChoice {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The stored preference, or the default.
 *
 * Validated rather than cast: a schema-drifted or hand-edited MMKV entry must
 * not become live state, and `Uniwind.setTheme()` THROWS on a theme it does
 * not know — so an unchecked read here would be a crash at startup, not a
 * cosmetic bug.
 */
export function readAppearance(): AppearanceChoice {
  const stored = hlStringStorage.getItem(APPEARANCE_KEY);
  return isAppearanceChoice(stored) ? stored : DEFAULT_APPEARANCE;
}

export function writeAppearance(next: AppearanceChoice): void {
  hlStringStorage.setItem(APPEARANCE_KEY, next);
}

/**
 * Which segment is selected, derived from Uniwind's own state.
 *
 * `hasAdaptiveThemes` beats `theme`: on a phone set to dark, "System" and
 * "Dark" both resolve `theme` to `"dark"`, and only this flag tells them
 * apart. Reading `theme` alone would light up the wrong segment for every
 * user on the default setting.
 */
export function resolveChoice(theme: string, hasAdaptiveThemes: boolean): AppearanceChoice {
  if (hasAdaptiveThemes) return "system";
  return theme === "light" ? "light" : "dark";
}

/**
 * What the collapsed section header says.
 *
 * "System" alone would be the one measure on this screen that tells you
 * nothing — the whole point of the closed accordion is that it still reports
 * state, so the system row names what the system currently resolves to.
 *
 * Always `muted`: the other sections use tone semantically — `danger` means
 * money or access is at risk — and an appearance preference is never a problem
 * to escalate. Colouring it would spend a signal the screen needs elsewhere.
 */
export function appearanceMeasure(
  choice: AppearanceChoice,
  resolved: ResolvedTheme
): { label: string; tone: "muted" } {
  const resolvedLabel = resolved === "light" ? "Light" : "Dark";
  return {
    label: choice === "system" ? `System · ${resolvedLabel}` : resolvedLabel,
    tone: "muted",
  };
}
