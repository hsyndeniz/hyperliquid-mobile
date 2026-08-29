/**
 * Traded volume, fees paid and win rate, derived from fills.
 *
 * ## Why not `userFees`
 *
 * `api/accountMeta.ts` is explicit: `userFees` returns **forward-looking
 * rates**, they step discretely as the 14-day window rolls, and two of eight
 * sampled mainnet accounts were being charged a rate 11–12% away from their
 * published one. Its docstring says it outright — *"For a 'fees paid' total,
 * sum the `fee` field on the fills themselves; never multiply historical fills
 * by today's rate."* So this reads fills, which are already live in the store
 * and cost nothing extra.
 *
 * ## The four traps in the numbers
 *
 * - **`feeToken` is not always USDC.** 15 distinct tokens observed, and this
 *   project's own testnet account paid an outcome-market fee in `+102251`
 *   shares. Summing blind adds share counts to dollars, so only USDC is totalled
 *   and the other tokens are named rather than dropped.
 * - **`fee` is signed.** A negative fee is a maker rebate — real on 433 of 4,000
 *   measured fills — so `Math.abs` would turn a rebate into a cost.
 * - **`closedPnl` is only meaningful on a CLOSING fill.** An opening fill
 *   reports `"0.0"`, so counting every fill drags the win rate toward zero. Only
 *   fills that actually closed something are counted.
 * - **A win rate over zero closes is `null`, not 0%.** "0% win rate" is a
 *   damning claim about a user who has simply never closed a trade.
 *
 * ## Scope is disclosed, not implied
 *
 * The fills store holds what the websocket has pushed plus whatever a REST seed
 * reached — not an account's whole history. `fillCount` is returned so a screen
 * can say "over your last N fills" instead of implying all-time.
 */

import { BigNumber } from "bignumber.js";

import { totalFeesPaid } from "@/hyperliquid/api/accountMeta";
import { toBigNumber } from "@/hyperliquid/core/precision";
import { useFills } from "@/hyperliquid/hooks/account";
import type { FillsStore } from "@/hyperliquid/state/fills";
import type { Fill } from "@/hyperliquid/types/domain";

export interface ActivitySummary {
  /** How many fills these numbers cover. Show it — the set is not all-time. */
  fillCount: number;
  /** Σ price × size, in USD. */
  volumeUsd: string;
  /** Protocol + builder fees, **USDC only**. Signed: rebates reduce it. */
  feesUsdc: string;
  /** Tokens whose fees are NOT in `feesUsdc`, so the total can be qualified. */
  otherFeeTokens: readonly string[];
  /** Fills that actually closed something. */
  closedCount: number;
  /** Of those, how many were profitable. */
  wins: number;
  /** `"0"`–`"1"`, or `null` when nothing has been closed. Never 0 for "none". */
  winRate: string | null;
  /** Σ closedPnl. Gross of fees, per the wire. */
  realizedPnl: string;
}

/** A fill closed something iff it reports a non-zero realised PnL. */
function isClosing(fill: Fill): boolean {
  return !toBigNumber(fill.closedPnl).isZero();
}

/** Exported for tests: the whole point is the arithmetic, not the hook. */
export function summariseActivity(fills: readonly Fill[]): ActivitySummary {
  let volume = new BigNumber(0);
  let realized = new BigNumber(0);
  let closedCount = 0;
  let wins = 0;

  for (const fill of fills) {
    // BigNumber throughout: `px` on BTC times `sz` at 5 decimals loses cents to
    // float error, and this is money the user compares against the exchange.
    volume = volume.plus(toBigNumber(fill.px).times(toBigNumber(fill.sz)));
    if (!isClosing(fill)) continue;
    closedCount += 1;
    const pnl = toBigNumber(fill.closedPnl);
    realized = realized.plus(pnl);
    if (pnl.isGreaterThan(0)) wins += 1;
  }

  const fees = totalFeesPaid(fills);
  const otherFeeTokens = [...fees.byToken.keys()]
    .filter((token) => token !== "USDC")
    // Only tokens that actually carried a fee — a zero-fee row would name a
    // token the user was never charged in.
    .filter((token) => !toBigNumber(fees.byToken.get(token) ?? "0").isZero());

  return {
    fillCount: fills.length,
    volumeUsd: volume.toFixed(2),
    // Protocol + builder: both came out of the user's pocket. They are split in
    // `totalFeesPaid` because only one is a rate, which does not matter here.
    feesUsdc: toBigNumber(fees.usdcProtocolFees).plus(fees.usdcBuilderFees).toFixed(),
    otherFeeTokens,
    closedCount,
    wins,
    // `null`, not 0 — see the header.
    winRate: closedCount === 0 ? null : new BigNumber(wins).dividedBy(closedCount).toFixed(4),
    realizedPnl: realized.toFixed(2),
  };
}

/** One coin's realised outcome, for the by-coin breakdown. */
export interface CoinRealized {
  coin: string;
  /** Σ `closedPnl` over this coin's closing fills. Gross of fees, per the wire. */
  pnl: string;
  closedCount: number;
}

/**
 * Realised P&L per coin, largest absolute impact first.
 *
 * Only CLOSING fills count, for the same reason the win rate only counts them:
 * an opening fill reports `closedPnl: "0.0"`, and including those rows would
 * list every coin ever touched with a meaningless $0.00. A coin the user only
 * ever opened simply does not appear — absence is the honest rendering of
 * "nothing realised yet".
 */
export function realizedByCoin(fills: readonly Fill[]): CoinRealized[] {
  const byCoin = new Map<string, { pnl: BigNumber; closedCount: number }>();
  for (const fill of fills) {
    if (!isClosing(fill)) continue;
    const entry = byCoin.get(fill.coin) ?? { pnl: new BigNumber(0), closedCount: 0 };
    entry.pnl = entry.pnl.plus(toBigNumber(fill.closedPnl));
    entry.closedCount += 1;
    byCoin.set(fill.coin, entry);
  }
  return (
    [...byCoin.entries()]
      .map(([coin, entry]) => ({ coin, pnl: entry.pnl.toFixed(2), closedCount: entry.closedCount }))
      // Largest absolute impact first: a big loss belongs next to a big win,
      // not buried under small positives.
      .sort((a, b) => toBigNumber(b.pnl).abs().comparedTo(toBigNumber(a.pnl).abs()) ?? 0)
  );
}

/** The same summary, over the live fills store. */
export function useActivity(store: FillsStore): ActivitySummary {
  return summariseActivity(useFills(store));
}
