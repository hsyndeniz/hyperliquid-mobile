/**
 * Screen-capture protection for the surfaces that show secrets.
 *
 * Applies to exactly two things — the recovery phrase and the private-key
 * import field — because those are the only places where what is on screen IS
 * the wallet. Everywhere else, a screenshot costs the user nothing.
 *
 * ## What this actually stops
 *
 TWO calls, because on iOS one API does not cover the whole threat — verified
 * against the module on a real build rather than assumed:
 *
 * - `preventScreenCaptureAsync` blocks **screenshots and screen recordings**.
 *   On Android it sets `FLAG_SECURE`, which also blanks the recents preview,
 *   so Android needs nothing further.
 * - `enableAppSwitcherProtectionAsync` (iOS only) covers the **app-switcher
 *   preview and the background snapshot** — which iOS writes to disk
 *   unprompted the moment the user leaves the app, and which the first call
 *   does NOT touch. That is the threat this exists for: it needs no attacker
 *   action at all, just a notification arriving while the phrase is on screen.
 *
 * Calling only the first (as this did until the native module was actually
 * built and its surface inspected) protects against the deliberate capture and
 * leaves the automatic one wide open — the weaker half of the problem.
 *
 * ## Why every call is guarded
 *
 * `expo-screen-capture` is a native module, so a JS bundle running against a
 * dev client built before it was added has nothing behind the import — and the
 * call throws at runtime. Throwing out of the effect that reveals the phrase
 * would break the reveal itself, i.e. the security fix would take out the
 * feature. So a failure is logged and swallowed, and the protection simply is
 * not there until the app is rebuilt.
 *
 * That is a genuine gap and it is stated rather than hidden: on a build without
 * the native module this is a no-op, which is exactly the state the app was in
 * before. It does not degrade anything; it just does not help yet.
 */

import { log } from "@/hyperliquid/core/logger";

const logger = log.child("account.screenCapture");

/**
 * Guard the screen while `active` is true, releasing on false and on unmount.
 *
 * Written as a plain async function rather than a hook so the caller can drive
 * it from its own effect and keep the cleanup obvious at the call site.
 */
export async function setCaptureProtection(active: boolean, tag: string): Promise<void> {
  try {
    // Required lazily so a build without the native module fails HERE, inside
    // the try, rather than at module evaluation — where it would take down
    // every screen that imports the dialog.
    const capture = (await import("expo-screen-capture")) as {
      preventScreenCaptureAsync: (key?: string) => Promise<void>;
      allowScreenCaptureAsync: (key?: string) => Promise<void>;
      enableAppSwitcherProtectionAsync: (blurIntensity?: number) => Promise<void>;
      disableAppSwitcherProtectionAsync: () => Promise<void>;
    };
    if (active) {
      await capture.preventScreenCaptureAsync(tag);
      // No-op off iOS, where FLAG_SECURE already covers the recents preview.
      await capture.enableAppSwitcherProtectionAsync();
    } else {
      await capture.allowScreenCaptureAsync(tag);
      await capture.disableAppSwitcherProtectionAsync();
    }
  } catch (error) {
    // Never rethrow: the caller is rendering a secret the user asked for, and
    // failing to protect it must not also fail to show it.
    logger.warn("screen_capture.unavailable", { context: { active, tag }, error });
  }
}
