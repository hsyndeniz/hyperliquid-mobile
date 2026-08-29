/**
 * The React binding for the Hyperliquid stores.
 *
 * `useSyncExternalStore` directly against the observable stores — **no jotai in
 * the read path.** That is a correctness decision, established by running the
 * alternatives rather than by preference:
 *
 * - **A jotai `atomFamily` over a store produces a permanently wrong number.**
 *   Measured on jotai 2.20.2: with a family whose factory captured a snapshot,
 *   unmounting a screen, switching account, and remounting rendered account A's
 *   position size under account B's address — and it never self-corrected. A
 *   primitive atom retains its value across a full unmount, `onMount` re-runs
 *   but a subscribe-only `onMount` pushes nothing, and the family hands back the
 *   same cached atom object. A fresh `createStore()` does not rescue it.
 * - **A derived atom reading an external store is computed once and never
 *   re-read.** `atom((get) => store.read())` with no tracked dependency ran its
 *   read function exactly once across eleven `store.get()` calls. jotai
 *   invalidates on a *tracked* dependency's epoch; an external mutation is
 *   invisible to it.
 * - **`atomFamily.remove()` is invisible to React.** Calling it while mounted
 *   produced zero re-renders and left the component subscribed to an orphaned
 *   atom that kept pushing updates.
 * - **`atomFamily` is deprecated** in the installed version and is slated for
 *   removal in jotai v3.
 *
 * `useSyncExternalStore` has none of these failure modes because `getSnapshot`
 * re-runs on **every** render, so a cleared store cannot be missed. The cost is
 * one rule, enforced by tests on each store: `getSnapshot` must be
 * referentially stable between mutations, or React loops forever.
 *
 * **What React Compiler does and does not do here.** It memoises renders. It
 * does not memoise *subscriptions*, and it cannot make a stale read fresh. It
 * saves us from re-rendering a child whose props did not change; it does not
 * save us from a hook that reads the wrong slice.
 */

import { useCallback, useSyncExternalStore } from "react";

/** The shape every store in this module exposes. */
export interface Observable {
  subscribe(listener: () => void): () => void;
}

/**
 * Subscribe to a store and select a slice of it.
 *
 * `select` must return a referentially stable value while nothing has changed —
 * React compares successive snapshots with `Object.is` and re-renders on any
 * difference, so a `select` that builds a fresh object or array each call
 * re-renders forever. Select an existing object; do not construct one.
 *
 * `select` is not a dependency of the subscription: it is called on every
 * render, so an inline arrow is fine here in a way it is not with `selectAtom`
 * (where an inline selector mints a new derived atom per render and runs away).
 */
export function useStoreValue<S extends Observable, T>(store: S, select: (store: S) => T): T {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => select(store), [store, select]);
  // Third argument is the server snapshot. React Native never server-renders,
  // but Jest's node environment does, and omitting it throws there rather than
  // in production — the worst place for the difference to show up.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
