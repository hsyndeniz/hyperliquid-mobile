/**
 * Applying an appearance choice — the side-effecting half of
 * `appearance.ts`, kept apart so that module stays pure and testable.
 *
 * (`uniwind` resolves to TypeScript source inside `node_modules` under the
 * `react-native` export condition, which Jest's transform allowlist does not
 * cover; importing it from a rules module would make that module unloadable
 * under test.)
 */

import { Appearance } from "react-native";
import { Uniwind } from "uniwind";

import type { AppearanceChoice } from "@/components/account/appearance";

/**
 * The RN token for "follow the OS".
 *
 * `ColorSchemeName` is `'light' | 'dark' | 'unspecified'` on RN 0.86 (0.87
 * renames it to `'auto'`). Passing the wrong one throws nothing and simply
 * fails to reset the override, so it is pinned here rather than inlined.
 */
const FOLLOW_SYSTEM = "unspecified" as const;

/**
 * Apply a choice to BOTH theme systems.
 *
 * Uniwind paints; React Native's `Appearance` is what `useColorScheme()`,
 * native views and the system keyboard read.
 *
 * ## The explicit cases are simple
 *
 * `light`/`dark` set both directly. `Appearance.setColorScheme` caches the
 * value it was handed, so there is no read-back to get wrong.
 *
 * ## `system` needs a second pass, and this is the whole reason this function
 * exists
 *
 * Two caches have to be defeated, and they compound:
 *
 * 1. **The native trait change is asynchronous.** Clearing the override lands
 *    on the next runloop turn, so the native scheme read back in the same tick
 *    is the value from BEFORE the reset. Measured on device (OS dark,
 *    override light): same tick `"light"`, one macrotask later `"dark"`.
 * 2. **`Appearance.getColorScheme()` does not read the native side.** RN
 *    serves a JS cache, refreshed only by `setColorScheme` or a native
 *    `appearanceChanged` event. And `setColorScheme("unspecified")` fills that
 *    cache by reading the native value *right then* — i.e. with the stale one
 *    from (1). So the cache is poisoned by the very call meant to clear the
 *    override.
 *
 * `Uniwind.setTheme("system")` resolves the theme through that cache, so it
 * inherits the stale answer. At startup the stale value is `light` regardless
 * of the OS (no window exists yet to carry a trait collection), and iOS does
 * NOT emit `appearanceChanged` for an override reset — only for a genuine OS
 * change — so Uniwind's listener never corrects it. The app then paints light
 * on a dark phone, permanently.
 *
 * The fix is to run the reset TWICE. The second `setColorScheme` is not
 * redundant: the override is already cleared by then, so its only effect is to
 * re-read the now-settled native value into RN's cache — which is what the
 * `Uniwind.setTheme` after it finally reads. The first pass stays so an
 * already-correct theme does not flicker; Uniwind only notifies subscribers
 * when the resolved theme actually changes, so the second pass is silent when
 * the first was right.
 *
 * Found by comparing `Appearance.getColorScheme()` in the running app against
 * `xcrun simctl ui <device> appearance`, and confirmed against RN's
 * `Libraries/Utilities/Appearance.js`.
 */
export function applyAppearance(choice: AppearanceChoice): void {
  if (choice !== "system") {
    Uniwind.setTheme(choice);
    Appearance.setColorScheme(choice);
    return;
  }

  Appearance.setColorScheme(FOLLOW_SYSTEM);
  Uniwind.setTheme("system");
  setTimeout(() => {
    // Refreshes RN's cache from the settled native value — see above.
    Appearance.setColorScheme(FOLLOW_SYSTEM);
    Uniwind.setTheme("system");
  }, 0);
}
