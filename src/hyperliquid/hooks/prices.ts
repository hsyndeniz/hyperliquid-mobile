/**
 * Spot mid prices, for valuing a balance in USD.
 *
 * A `SpotBalance` carries an amount and a cost basis but **no value** — the
 * wire never sends one. Without a price join every non-USDC row can only show
 * `--`, which is honest but useless, and a total that ignores them is worse
 * than no total.
 *
 * ## Why the coin key is not the ticker
 *
 * `allMids` returns spot markets under their **pair id** (`@107`), not the
 * token name, while `spotClearinghouseState` returns balances under the token
 * name (`HYPE`). Joining them needs `spotMeta`'s universe to map one to the
 * other — the same "a wire coin is not a ticker" trap the icon module hit, in a
 * different spelling.
 *
 * Outcome shares hit the SAME trap in a third spelling. `allMids` does carry
 * them — but under `#102251`, while the balance row says `+102251`. Checking
 * only the balance spelling reports "no price" for a market the exchange is
 * actively quoting; both are mapped here.
 *
 * That mark is also better than anything derivable from the book. Prediction
 * books are thin and routinely one-sided — measured live, `#102251` had asks
 * and no bids, because the two sides SHARE one book (side 0's 0.49 bid *is*
 * side 1's 0.51 ask, same sizes) — so a bid/ask mid is `null` exactly when a
 * holding most needs a number. The exchange's own mark has no such gap: 310 of
 * 310 testnet sides sum to exactly 1.000000, matching the mainnet invariant in
 * `predictions/types.ts`.
 *
 * ## What is deliberately NOT priced
 *
 * - **USDC** is the unit of account: its value is its amount, no lookup.
 * - A token with no market at all stays `null`. Pricing it at 0 would
 *   understate a portfolio, and pricing it at cost would pretend a holding
 *   never moves.
 *
 * Prices are a snapshot, refreshed on demand — not a subscription. A portfolio
 * list does not need tick-rate updates, and `allMids` at 2 weight is cheap
 * enough to re-read on pull-to-refresh.
 */

import { useCallback, useEffect, useState } from "react";

import { getInfoClient } from "@/hyperliquid/api/clients";
import { restCache, PRICE_CACHE_TTL_MS } from "@/hyperliquid/api/restCache";
import { toBigNumber } from "@/hyperliquid/core/precision";
import { weightBudget } from "@/hyperliquid/api/weightBudget";
import { log } from "@/hyperliquid/core/logger";

const logger = log.child("hooks.prices");

/** Mid price per **token name**, already joined through the spot universe. */
export type SpotPrices = ReadonlyMap<string, string>;

interface SpotMetaShape {
  tokens?: { name?: unknown; index?: unknown }[];
  universe?: { name?: unknown; tokens?: unknown }[];
}

/**
 * Build token-name → mid from `spotMeta` + `allMids`.
 *
 * Exported for tests. The join is the whole point: a naive `mids[balance.coin]`
 * misses every spot token, because mids are keyed `@107` and balances `HYPE`.
 */
export function joinSpotPrices(
  spotMeta: unknown,
  mids: Record<string, string>
): Map<string, string> {
  const prices = new Map<string, string>();
  const meta = (spotMeta ?? {}) as SpotMetaShape;

  const tokenNames = new Map<number, string>();
  for (const token of meta.tokens ?? []) {
    if (typeof token?.name === "string" && typeof token?.index === "number") {
      tokenNames.set(token.index, token.name);
    }
  }

  for (const pair of meta.universe ?? []) {
    if (typeof pair?.name !== "string" || !Array.isArray(pair.tokens)) continue;
    const mid = mids[pair.name];
    if (typeof mid !== "string") continue;

    // `tokens` is [baseIndex, quoteIndex]; the BASE is what the balance names.
    const baseIndex = pair.tokens[0];
    if (typeof baseIndex !== "number") continue;
    const base = tokenNames.get(baseIndex);
    if (base === undefined) continue;

    // First pair wins: a token quoted against several assets would otherwise
    // take whichever came last, which is arbitrary rather than chosen.
    if (!prices.has(base)) prices.set(base, mid);
  }

  // Outcome markets, keyed to the spelling a BALANCE uses. This is a pure
  // re-key of the same value, not a second source — `#102251` and `+102251`
  // are one market under two names.
  for (const [coin, mid] of Object.entries(mids)) {
    if (typeof mid !== "string" || !coin.startsWith("#")) continue;
    prices.set(`+${coin.slice(1)}`, mid);
  }
  return prices;
}

/**
 * USD value of a balance, or `null` when it cannot be known.
 *
 * `null` is the honest answer for an unpriced token, and callers must render it
 * as such — a `0` here would read as "worthless" for a holding that simply has
 * no quote.
 */
export function valueOf(coin: string, amount: string, prices: SpotPrices): string | null {
  if (coin === "USDC") return amount;
  const mid = prices.get(coin);
  if (mid === undefined) return null;
  // `toBigNumber`, not the constructor: bignumber.js THROWS on `""` and on any
  // unparseable string, and this runs inside a render.
  const value = toBigNumber(amount).times(toBigNumber(mid));
  return value.isFinite() ? value.toFixed(2) : null;
}

/**
 * Unrealised PnL against the cost basis, or `null`.
 *
 * `costBasisNtl` is `"0.0"` for USDC and for anything never bought, where a PnL
 * figure would be meaningless rather than zero.
 */
export function pnlOf(value: string | null, costBasis: string): string | null {
  if (value === null) return null;
  const cost = toBigNumber(costBasis);
  if (!cost.isFinite() || cost.lte(0)) return null;
  const pnl = toBigNumber(value).minus(cost);
  return pnl.isFinite() ? pnl.toFixed(2) : null;
}

/**
 * Snapshot of spot and outcome mids.
 *
 * Two reads, no per-holding cost: `allMids` covers every market on the
 * exchange, so an account with one token and an account with thirty pay the
 * same. Refreshed on demand rather than subscribed — a portfolio list does not
 * need tick-rate updates.
 */
/** Prices are exchange-wide, not account-scoped — one key for the whole app. */
const PRICES_KEY = "joinedSpotPrices";

export function useSpotPrices(): { prices: SpotPrices; refresh: () => void } {
  // Seeded from the cache so a remount inside the TTL renders real numbers on
  // the first frame instead of "--" followed by a flash of correct values.
  const [prices, setPrices] = useState<SpotPrices>(
    () => restCache.read<SpotPrices>(PRICES_KEY, Date.now(), PRICE_CACHE_TTL_MS) ?? new Map()
  );

  const load = useCallback(async (force: boolean) => {
    if (!force) {
      const hit = restCache.read<SpotPrices>(PRICES_KEY, Date.now(), PRICE_CACHE_TTL_MS);
      if (hit !== undefined) {
        setPrices(hit);
        return;
      }
    }
    try {
      const info = getInfoClient();
      // Through the weight budget: this screen also loads portfolio history,
      // and the per-IP allowance is shared with everything else.
      const meta = await weightBudget.tryRun("spotMeta", () => info.spotMeta());
      const mids = await weightBudget.tryRun("allMids", () => info.allMids());
      // Deferred by the budget is not a failure — the rows keep their last
      // prices and a refresh retries.
      if (meta === null || mids === null) return;
      const joined = joinSpotPrices(meta, mids as Record<string, string>);
      restCache.write(PRICES_KEY, joined, Date.now());
      setPrices(joined);
    } catch (error) {
      logger.warn("prices.unavailable", { error });
    }
  }, []);

  useEffect(() => {
    let live = true;
    // Deferred a tick so the mount effect never sets state synchronously.
    const timer = setTimeout(() => {
      void load(false).then(() => {
        if (!live) return;
      });
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [load]);

  return { prices, refresh: () => void load(true) };
}
