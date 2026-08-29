/**
 * The notification log, as a screen needs it.
 *
 * These are the exchange's own free-text messages to the user — liquidation
 * warnings among them — so the routing already treats the channel as
 * load-bearing. This is the read side.
 *
 * ## The referential-stability rule, and where it bites here
 *
 * `useStoreValue` calls `select` on every render and compares with `Object.is`,
 * so a selector that builds a fresh array re-renders forever. `read()` is
 * memoised in the store for exactly this reason — but `unacknowledged()` is
 * **not**: it is `read().filter(...)`, a new array each call. So the selector
 * here is `read()`, and the unacknowledged split happens after, in ordinary
 * render code where a fresh array is harmless.
 *
 * That is not a workaround; it is the store's contract. Anything that filters
 * must do so outside `getSnapshot`.
 */

import { useCallback } from "react";

import type { Notification, NotificationStore } from "@/hyperliquid/state/notifications";
import { useStoreValue } from "@/hyperliquid/hooks/useStore";

/** Every message this session has received, oldest first. */
export function useNotifications(store: NotificationStore): readonly Notification[] {
  return useStoreValue(store, (s) => s.read());
}

/**
 * The messages not yet dismissed, plus the dismissal.
 *
 * `acknowledge` marks up to and including the newest message the caller was
 * actually shown — passing the seq rather than "all" so a message that arrives
 * between render and tap is not swallowed unseen.
 */
export function useUnacknowledged(store: NotificationStore): {
  pending: readonly Notification[];
  acknowledge: (seq: number) => void;
} {
  // Through `useStoreValue`, NOT called raw in render.
  //
  // Calling `store.unacknowledged()` directly looked safe — `read()` was
  // already subscribed — but the React Compiler caches such a call against the
  // store's identity, and this store is built once per app and outlives every
  // identity switch. The banner froze at whatever the log held when Portfolio
  // first mounted: a later liquidation warning never showed, and a dismissal
  // never cleared. Subscribing makes the read reactive; the store memoises the
  // slice so the selector stays referentially stable.
  const pending = useStoreValue(store, (s) => s.unacknowledged());
  const acknowledge = useCallback((seq: number) => store.acknowledge(seq), [store]);
  return { pending, acknowledge };
}
