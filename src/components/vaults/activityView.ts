/**
 * Sorting, filtering and linking for the vault activity feeds.
 *
 * The official page gives every table its own dropdowns — Type, Side, Role,
 * Market — hard-coded per table. That does not port: seven bespoke filter sets
 * is seven things to keep in sync with seven wire shapes.
 *
 * Instead each feed labels its own rows with a **flag** at map time ("Buy",
 * "Close Long", "Received", "canceled", "deposit"…), and one adaptive control
 * offers exactly the flags present in the rows on screen. It is the same
 * affordance, it needs no per-feed code, and it can never offer a filter that
 * matches nothing — the list is derived from the data, not declared ahead of it.
 */

import type { HlEnv } from "@/hyperliquid/types/domain";

export type FeedSort = "newest" | "oldest" | "largest";

export const FEED_SORTS: [FeedSort, string][] = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
  ["largest", "Largest"],
];

/** How far back a feed reaches. A window, deliberately not cursor paging. */
export type FeedWindow = "day" | "week" | "month";

export const FEED_WINDOWS: [FeedWindow, string][] = [
  ["day", "24h"],
  ["week", "7d"],
  ["month", "30d"],
];

const WINDOW_MS: Record<FeedWindow, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export function windowMs(window: FeedWindow): number {
  return WINDOW_MS[window];
}

/** The minimum a row must carry to be filtered, sorted and linked. */
export interface FeedRow {
  timeMs: number;
  /** `|amount|` for the "largest" sort; `null` when the feed has no figure. */
  sortValue: number | null;
  /** The adaptive filter label; `null` when this row cannot be categorised. */
  flag: string | null;
}

/**
 * The filter tags to offer — the distinct flags actually present, in the order
 * they first appear.
 *
 * First-appearance order rather than alphabetical: the rows arrive
 * newest-first, so the tags lead with what the vault is doing *now*.
 */
export function distinctFlags(rows: readonly FeedRow[]): readonly string[] {
  const seen: string[] = [];
  for (const row of rows) {
    if (row.flag !== null && !seen.includes(row.flag)) seen.push(row.flag);
  }
  return seen;
}

/** `null` selects everything; anything else matches the flag exactly. */
export function applyFlag<T extends FeedRow>(rows: readonly T[], flag: string | null): T[] {
  if (flag === null) return [...rows];
  return rows.filter((row) => row.flag === flag);
}

/**
 * Sort a copy — never in place, since the caller's array is memoised state.
 *
 * Under "largest", a row with no figure sorts LAST rather than as zero: an
 * open order has no P&L, and ranking it below every loss would assert it broke
 * even.
 */
export function sortFeed<T extends FeedRow>(rows: readonly T[], mode: FeedSort): T[] {
  const copy = [...rows];
  if (mode === "largest") {
    return copy.sort((a, b) => {
      if (a.sortValue === null && b.sortValue === null) return b.timeMs - a.timeMs;
      if (a.sortValue === null) return 1;
      if (b.sortValue === null) return -1;
      const delta = Math.abs(b.sortValue) - Math.abs(a.sortValue);
      return delta !== 0 ? delta : b.timeMs - a.timeMs;
    });
  }
  return copy.sort((a, b) => (mode === "oldest" ? a.timeMs - b.timeMs : b.timeMs - a.timeMs));
}

/** All-zero after `0x` — the wire's "no L1 transaction", not a missing field. */
const ZERO_HASH = /^0x0*$/;

/**
 * A link to the L1 transaction, or `null` when there isn't one.
 *
 * `null` on the all-zero hash is load-bearing: 18 of 22,832 measured ledger
 * rows carry it, and it means the row has **no on-chain transaction** rather
 * than a lost field. Linking it would send someone to an explorer 404 and
 * imply the transfer is missing from the chain.
 */
export function explorerTxUrl(env: HlEnv, hash: string | null | undefined): string | null {
  if (typeof hash !== "string") return null;
  const trimmed = hash.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed) || ZERO_HASH.test(trimmed)) return null;
  const host = env === "testnet" ? "app.hyperliquid-testnet.xyz" : "app.hyperliquid.xyz";
  return `https://${host}/explorer/tx/${trimmed}`;
}
