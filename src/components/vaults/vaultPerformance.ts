/**
 * The vault's own numbers for a period, from the portfolio series it already
 * fetched — every one of these costs zero extra weight.
 *
 * **On the return percentage.** The official web app shows a "Past Month
 * Return" whose denominator it does not document, and the obvious guess is
 * wrong: HLP's account value fell from $252M to $187M over the measured month
 * while the vault *made* $6,188, because the change is dominated by
 * withdrawals rather than trading. `(endValue − startValue) / startValue`
 * would print −26% for a profitable month.
 *
 * So the return here is defined explicitly as **P&L over starting equity**, and
 * the label says so. It is a number this module can defend rather than a guess
 * at someone else's convention, and the dollar P&L beside it is exact either
 * way.
 *
 * `null` throughout means "not computable", never zero — the distinction
 * `maxDrawdown` already draws in `chartView.ts`.
 */

import { BigNumber } from "bignumber.js";

import { toBigNumber } from "@/hyperliquid/core/precision";
import type { PortfolioPeriod } from "@/hyperliquid/vaults/types";

/** Find one period's series; the wire ships eight keys, we read four. */
export function periodOf(
  portfolio: readonly PortfolioPeriod[],
  period: string
): PortfolioPeriod | null {
  return portfolio.find((entry) => entry.period === period) ?? null;
}

/**
 * P&L over the window: last minus first of `pnlHistory`.
 *
 * Over the P&L series, never the value series — a value delta attributes a
 * depositor's withdrawal to the leader's trading, which is the whole reason
 * both series exist.
 */
export function periodPnl(entry: PortfolioPeriod | null): string | null {
  if (entry === null || entry.pnlHistory.length < 2) return null;
  const first = toBigNumber(entry.pnlHistory[0]![1]);
  const last = toBigNumber(entry.pnlHistory[entry.pnlHistory.length - 1]![1]);
  if (!first.isFinite() || !last.isFinite()) return null;
  return last.minus(first).toFixed(2);
}

/**
 * P&L as a fraction of the equity the window OPENED with (`"0.0025"` = 0.25%).
 *
 * `null` when that opening equity is not positive — measured on HLP's
 * `allTime` window, which starts at zero because the vault began empty. A
 * ratio against zero is undefined, and rendering it as 0% would claim a flat
 * all-time return for a vault that has made millions.
 */
export function periodReturn(entry: PortfolioPeriod | null): string | null {
  const pnl = periodPnl(entry);
  if (pnl === null || entry === null || entry.accountValueHistory.length === 0) return null;
  const start = toBigNumber(entry.accountValueHistory[0]![1]);
  if (!start.isFinite() || start.lte(0)) return null;
  return new BigNumber(pnl).dividedBy(start).toFixed();
}

/** `"0.0025"` → `"+0.25%"`. A true zero stays unsigned. */
export function returnPercent(fraction: string | null): string | null {
  if (fraction === null) return null;
  const value = toBigNumber(fraction);
  if (!value.isFinite()) return null;
  const percent = value.multipliedBy(100);
  if (percent.isZero()) return "0.00%";
  return `${percent.gt(0) ? "+" : ""}${percent.toFixed(2)}%`;
}

/**
 * Traded volume for the window.
 *
 * Measured `"0.0"` on every HLP period — and the official app agrees, showing
 * "Volume $0.00" for the same vault. A zero here is the wire's answer, so it
 * renders as zero; only an ABSENT period is `null`.
 */
export function periodVolume(entry: PortfolioPeriod | null): string | null {
  if (entry === null) return null;
  const value = toBigNumber(entry.vlm);
  return value.isFinite() ? value.toFixed() : null;
}
