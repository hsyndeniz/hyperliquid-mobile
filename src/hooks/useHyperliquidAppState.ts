/**
 * Feeds React Native's app lifecycle to the Hyperliquid session.
 *
 * App-level rather than inside `src/hyperliquid/`, because `AppState` comes from
 * `react-native` and the module deliberately imports nothing from it — the same
 * reason the Sentry SDK is injected rather than imported.
 *
 * Mount this once, high in the tree. Without it, `AppStatePolicy` never receives
 * a transition: an app returning from ten minutes in the background renders a
 * book that stopped updating, with no staleness marker and no rebuild. iOS
 * suspends the JS thread and drops the socket without telling anyone.
 *
 * `inactive` is deliberately **not** treated as backgrounded. On iOS it fires
 * for a notification-centre pull or an incoming call banner — a second or two,
 * with the socket untouched. Treating it as background would mark every surface
 * stale each time a notification arrived.
 */

import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";

import type { HyperliquidSession } from "@/hyperliquid/session";
import type { ResumeDecision } from "@/hyperliquid/state/appState";

/**
 * @param onResume Called with the policy's verdict each time the app returns to
 *   the foreground. Optional, and observation-only — the resubscribe has
 *   already happened by the time it fires. It exists because this path is
 *   otherwise **unobservable**: `onAppStateChange` returns a decision that had
 *   no caller, so the only evidence a resume did anything was a log line in a
 *   dev build. That is not enough to verify the one behaviour here that cannot
 *   be tested off a device.
 */
export function useHyperliquidAppState(
  session: HyperliquidSession | null,
  onResume?: (decision: ResumeDecision) => void
): void {
  useEffect(() => {
    if (!session) return;

    const handle = (status: AppStateStatus): void => {
      if (status === "active") {
        void session.onAppStateChange("active").then((decision) => {
          if (decision) onResume?.(decision);
        });
      } else if (status === "background") {
        void session.onAppStateChange("background");
      }
    };

    const subscription = AppState.addEventListener("change", handle);
    return () => subscription.remove();
  }, [session, onResume]);
}
