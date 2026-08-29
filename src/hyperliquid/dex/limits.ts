/**
 * Per-dex trading limits.
 *
 * The useful distinction here is between the three endpoints that *sound* like
 * they gate orders and the one that actually does:
 *
 * - **`perpDexStatus({dex})` gates nothing.** It returns exactly
 *   `{ totalNetDeposit }` for every dex including the main one — no halt flag,
 *   no margin restriction, nothing order-relevant. Useful for a stat, misleading
 *   as a health check.
 * - **`perpDexLimits({dex})` is capacity, not state.** `null` for the main dex;
 *   for a builder dex, static caps that say what the dex *could* hold, not what
 *   it currently holds.
 * - **`perpsAtOpenInterestCap({dex})` is the real signal.** A non-empty array is
 *   the only live, queryable indicator that opening a position in that coin will
 *   be rejected for open-interest reasons. It is dex-scoped, so asking about the
 *   main dex tells you nothing about a builder dex.
 *
 * A client that shows "this dex is fine" from `perpDexStatus` and then submits
 * an order into a capped asset gets a rejection it could have predicted.
 */

import { log } from "@/hyperliquid/core/logger";

const logger = log.child("dex.limits");

export interface DexLimits {
  /** Total open interest the dex may carry, in USD. */
  totalOiCap: string;
  /** Per-perp size cap. */
  oiSzCapPerPerp: string;
  /** Largest single transfer onto the dex. */
  maxTransferNtl: string;
  /** Per-coin OI caps, keyed by the **fully-qualified** coin (`"xyz:AAPL"`). */
  coinToOiCap: ReadonlyMap<string, string>;
}

/**
 * Parse `perpDexLimits({dex})`.
 *
 * Returns `null` for the main dex, which is what the endpoint itself returns —
 * the main dex genuinely has no such limits, and inventing zeros would render as
 * "capped at nothing".
 */
export function parseDexLimits(raw: unknown): DexLimits | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    logger.warn("limits.unexpected_shape");
    return null;
  }
  const record = raw as Record<string, unknown>;

  const pairs = Array.isArray(record.coinToOiCap) ? record.coinToOiCap : [];
  const coinToOiCap = new Map<string, string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [coin, cap] = pair;
    if (typeof coin === "string" && typeof cap === "string") coinToOiCap.set(coin, cap);
  }

  return {
    totalOiCap: typeof record.totalOiCap === "string" ? record.totalOiCap : "0",
    oiSzCapPerPerp: typeof record.oiSzCapPerPerp === "string" ? record.oiSzCapPerPerp : "0",
    maxTransferNtl: typeof record.maxTransferNtl === "string" ? record.maxTransferNtl : "0",
    coinToOiCap,
  };
}

/**
 * Coins currently at their open-interest cap on one dex.
 *
 * The only live signal that an order would be rejected for capacity. Held as a
 * set of fully-qualified coins, matching what every other surface uses.
 */
export function parseCappedCoins(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((coin): coin is string => typeof coin === "string"));
}

/**
 * Whether opening a new position in this coin would be refused for capacity.
 *
 * Scoped to one dex's cap list, because the endpoint is dex-scoped and a
 * main-dex answer says nothing about a builder dex.
 */
export function isAtOpenInterestCap(capped: ReadonlySet<string>, coin: string): boolean {
  return capped.has(coin);
}

/**
 * The largest market order allowed, by leverage tier.
 *
 * `maxMarketOrderNtls()` is **global** — no `dex` parameter — and keyed by
 * `maxLeverage` rather than by margin-table id. That matters: builder-dex assets
 * carry leverage values (up to 50) that have no entry in the table, so an exact
 * lookup misses for several of them.
 *
 * Rather than returning `null` on a miss and letting a caller treat "unknown" as
 * "unlimited", this falls back to the entry for the **next lower** leverage,
 * which is the conservative reading: a 50× asset is bounded by at most what a
 * 25× asset is bounded by.
 */
export function maxMarketOrderNotional(
  table: readonly (readonly [number, string])[],
  maxLeverage: number
): { notional: string; exact: boolean } | null {
  if (table.length === 0) return null;

  const exact = table.find(([leverage]) => leverage === maxLeverage);
  if (exact) return { notional: exact[1], exact: true };

  // Descending, so the first entry at or below the asset's leverage is the
  // tightest applicable bound.
  const candidates = [...table]
    .filter(([leverage]) => leverage <= maxLeverage)
    .sort((a, b) => b[0] - a[0]);

  if (candidates.length === 0) {
    // Every tabulated tier is above this asset's leverage: take the smallest,
    // since a lower-leverage asset is never allowed a larger market order.
    const smallest = [...table].sort((a, b) => a[0] - b[0])[0];
    return { notional: smallest[1], exact: false };
  }
  return { notional: candidates[0][1], exact: false };
}

/** Parse `maxMarketOrderNtls()` into pairs. */
export function parseMaxMarketOrderNtls(raw: unknown): [number, string][] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) return [];
    const [leverage, notional] = entry;
    if (typeof leverage !== "number" || typeof notional !== "string") return [];
    return [[leverage, notional] as [number, string]];
  });
}
