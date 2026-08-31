/**
 * Account hooks — the module's public API for a portfolio surface.
 *
 * Each hook takes its store explicitly rather than reaching for a singleton.
 * That keeps the module headless (the app decides where stores live and how
 * they are provided), and it makes every hook testable without a React context.
 *
 * **Select narrowly.** `usePosition(store, "BTC")` re-renders only when that
 * coin's row actually changes, because `AccountStore` preserves object identity
 * for unchanged positions across a push. `useAccountSnapshot` re-renders on any
 * change and should back a header, not a list of rows.
 */

import { useCallback } from "react";

import { useStoreValue } from "@/hyperliquid/hooks/useStore";
import type { AccountStore } from "@/hyperliquid/state/account";
import type { FillsStore } from "@/hyperliquid/state/fills";
import type { OpenOrdersStore, OpenOrdersView } from "@/hyperliquid/state/openOrders";
import type { SpotBalanceStore } from "@/hyperliquid/state/spot";
import type {
  AccountSnapshot,
  AccountSummary,
  Fill,
  Position,
  SpotBalance,
  SpotState,
} from "@/hyperliquid/types/domain";

/**
 * The whole snapshot. `null` until the first push, and after an account switch.
 *
 * Prefer a narrower hook for anything rendered per row.
 */
export function useAccountSnapshot(store: AccountStore): AccountSnapshot | null {
  return useStoreValue(
    store,
    useCallback((s: AccountStore) => s.read(), [])
  );
}

/**
 * The margin summary alone.
 *
 * Still re-renders whenever any position moves, because the summary and the
 * positions arrive in one payload and share one store — which is deliberate:
 * splitting them would let the header and the rows disagree by a tick.
 */
export function useAccountSummary(store: AccountStore): AccountSummary | null {
  return useStoreValue(
    store,
    useCallback((s: AccountStore) => s.read()?.summary ?? null, [])
  );
}

/** Every open position. Backs a list; individual rows should use `usePosition`. */
export function usePositions(store: AccountStore): readonly Position[] {
  return useStoreValue(
    store,
    useCallback((s: AccountStore) => s.read()?.positions ?? EMPTY, [])
  );
}

/**
 * Has an account snapshot arrived at all?
 *
 * `usePositions` answers `[]` both for "the exchange says you hold nothing"
 * and for "nothing has been read yet", because it collapses a null snapshot
 * into the empty array. Those are opposite facts to a trader: one means flat,
 * the other means unknown, and a screen that renders "No open positions" over
 * the second is asserting something it has not been told.
 */
export function useHasAccountSnapshot(store: AccountStore): boolean {
  return useStoreValue(
    store,
    useCallback((s: AccountStore) => s.read() !== null, [])
  );
}

/**
 * One coin's position, or `null` when it is closed.
 *
 * The per-row subscription. Every row wakes on every push, but React bails out
 * unless *this* coin's object changed — so a 40-position screen does 40 cheap
 * identity comparisons per heartbeat instead of 40 re-renders.
 */
export function usePosition(store: AccountStore, coin: string): Position | null {
  return useStoreValue(
    store,
    useCallback((s: AccountStore) => s.positionByCoin(coin), [coin])
  );
}

/**
 * Whether the account feed has gone quiet.
 *
 * Takes `now` from the caller so the hook stays pure and testable; a surface
 * refreshing this on a timer is deciding its own cadence, which is correct —
 * the store deliberately never expires its value.
 */
export function useAccountIsStale(store: AccountStore, now: number, maxAgeMs?: number): boolean {
  return useStoreValue(
    store,
    useCallback((s: AccountStore) => s.isStale(now, maxAgeMs), [now, maxAgeMs])
  );
}

/** Confirmed rows plus our own unconfirmed submissions. */
export function useOpenOrders(store: OpenOrdersStore): OpenOrdersView {
  return useStoreValue(
    store,
    useCallback((s: OpenOrdersStore) => s.read(), [])
  );
}

/** Trade history, newest first. */
export function useFills(store: FillsStore): readonly Fill[] {
  return useStoreValue(
    store,
    useCallback((s: FillsStore) => s.read(), [])
  );
}

export function useSpotState(store: SpotBalanceStore): SpotState | null {
  return useStoreValue(
    store,
    useCallback((s: SpotBalanceStore) => s.read(), [])
  );
}

/** One spot balance. Keyed on `coin`, since outcome rows carry no `token`. */
export function useSpotBalance(store: SpotBalanceStore, coin: string): SpotBalance | null {
  return useStoreValue(
    store,
    useCallback((s: SpotBalanceStore) => s.balanceOf(coin), [coin])
  );
}

/**
 * A shared empty array.
 *
 * `?? []` would allocate a new array on every render and re-render forever —
 * the exact `getSnapshot` footgun this binding is built around.
 */
const EMPTY: readonly Position[] = [];
