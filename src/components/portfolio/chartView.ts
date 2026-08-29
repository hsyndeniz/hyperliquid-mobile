/**
 * The chart's pure decisions: which wire series a scope+period selects, and
 * what the worst decline in a series was.
 *
 * Lives beside `fetchedView.ts` for the same reason it does: importing the
 * chart component under Jest drags in Reanimated/Worklets/Skia, none of which
 * load there, so the logic with rules in it is a `.ts` module and the markup
 * stays markup.
 */

import { BigNumber } from "bignumber.js";

import { toBigNumber } from "@/hyperliquid/core/precision";

export type ChartScope = "all" | "perp";
export type ChartPeriod = "day" | "week" | "month" | "allTime";

/**
 * The `portfolio` endpoint returns eight period keys, not four: `day`, `week`,
 * `month`, `allTime` for the whole account, and `perpDay`…`perpAllTime` for
 * perps alone — measured live, and `fetchPortfolio`'s parser is key-agnostic,
 * so the perp series are already in the cached map. The perp key is exactly
 * the period with its first letter raised: `perp` + `AllTime`.
 */
export function periodKey(scope: ChartScope, period: ChartPeriod): string {
  if (scope === "all") return period;
  return `perp${period.charAt(0).toUpperCase()}${period.slice(1)}`;
}

/**
 * Largest peak-to-trough decline over a value series, as a fraction of the
 * peak (`"0.1816"` = 18.16%). BigNumber throughout — the series is account
 * value in USD strings, and float dust in a running ratio compounds.
 *
 * `null` means "not computable", which is different from zero:
 * - fewer than two points — one number has no drawdown, and rendering 0%
 *   for an empty chart would claim a flat history nobody measured;
 * - no positive peak — a ratio against a zero peak is undefined, and an
 *   all-zero series is an unused account, not a drawdown-free one.
 *
 * A monotonic rise genuinely IS `"0"` — that one is a measurement.
 */
export function maxDrawdown(history: readonly (readonly [number, string])[]): string | null {
  if (history.length < 2) return null;

  let peak: BigNumber | null = null;
  let worst = new BigNumber(0);
  let measurable = false;

  for (const [, raw] of history) {
    const value = toBigNumber(raw);
    if (!value.isFinite()) continue;
    if (peak === null || value.gt(peak)) peak = value;
    // Only a positive peak yields a meaningful ratio; until one appears the
    // walk records nothing rather than dividing by zero.
    if (peak.gt(0)) {
      measurable = true;
      const decline = peak.minus(value).dividedBy(peak);
      if (decline.gt(worst)) worst = decline;
    }
  }

  return measurable ? worst.toFixed() : null;
}

export interface PnlStats {
  /** ΔP&L over the window: last point minus first. */
  change: string;
  /** Largest single-day gain. `null` when the window spans fewer than two days. */
  bestDay: string | null;
  /** Largest single-day loss (most negative delta). Same null rule. */
  worstDay: string | null;
}

/**
 * P&L movement over a series — deliberately over `pnlHistory`, never the value
 * series: value deltas attribute a deposit to trading performance, which is
 * the documented reason both series exist.
 *
 * Days are UTC calendar days, each represented by its LAST point; a day's
 * delta is against the previous day's close. A window inside one day has a
 * `change` but no best/worst day — one day has no day-over-day delta, and
 * echoing `change` there would present the same number as two facts.
 */
export function pnlStats(history: readonly (readonly [number, string])[]): PnlStats | null {
  const points: [number, BigNumber][] = [];
  for (const [time, raw] of history) {
    const value = toBigNumber(raw);
    if (value.isFinite()) points.push([time, value]);
  }
  if (points.length < 2) return null;

  const change = points[points.length - 1]![1].minus(points[0]![1]);

  // Last point per UTC day; insertion order is chronological because the wire
  // series is time-ascending.
  const closes = new Map<string, BigNumber>();
  for (const [time, value] of points) {
    closes.set(new Date(time).toISOString().slice(0, 10), value);
  }
  const days = [...closes.values()];
  let best: BigNumber | null = null;
  let worst: BigNumber | null = null;
  for (let i = 1; i < days.length; i += 1) {
    const delta = days[i]!.minus(days[i - 1]!);
    if (best === null || delta.gt(best)) best = delta;
    if (worst === null || delta.lt(worst)) worst = delta;
  }

  return {
    change: change.toFixed(2),
    bestDay: best === null ? null : best.toFixed(2),
    worstDay: worst === null ? null : worst.toFixed(2),
  };
}

export interface SeriesBounds {
  /** Highest and lowest points in the window. */
  high: string;
  low: string;
  /** The window's ends — `first` is what the dashed baseline marks. */
  first: string;
  last: string;
}

/**
 * The four extremes of a window, as the ORIGINAL wire strings.
 *
 * Comparison is BigNumber (a value series in USD strings is money), but the
 * returned values are the untouched inputs rather than a re-rendered
 * `toFixed()`: the caller formats for display, and normalising here would
 * quietly restate `"63000.10"` as `"63000.1"` before that formatter ever sees
 * it — the trailing-zero trap `FlashPrice` already pays for once.
 *
 * `null` under two points, matching the chart's own "not enough history"
 * threshold exactly — a high and a low drawn from a single reading are that
 * one reading twice, which reads as a measured range and is not one.
 *
 * Non-finite entries are skipped rather than failing the window: unlike a
 * sparkline (where one bad close drags the whole shape to an invented
 * extreme), these are four independent readings and the survivors are each
 * still true.
 */
export function seriesBounds(history: readonly (readonly [number, string])[]): SeriesBounds | null {
  let high: [BigNumber, string] | null = null;
  let low: [BigNumber, string] | null = null;
  let first: string | null = null;
  let last: string | null = null;
  let seen = 0;

  for (const [, raw] of history) {
    const value = toBigNumber(raw);
    if (!value.isFinite()) continue;
    seen += 1;
    if (high === null || value.gt(high[0])) high = [value, raw];
    if (low === null || value.lt(low[0])) low = [value, raw];
    if (first === null) first = raw;
    last = raw;
  }

  if (seen < 2 || high === null || low === null || first === null || last === null) return null;
  return { high: high[1], low: low[1], first, last };
}

/** `"0.1816"` → `"-18.16%"`; a genuine zero shows unsigned as `"0.00%"`. */
export function drawdownPercent(fraction: string): string {
  const value = toBigNumber(fraction);
  if (!value.isFinite()) return "--";
  const percent = value.multipliedBy(100).toFixed(2);
  return value.isZero() ? "0.00%" : `-${percent}%`;
}
