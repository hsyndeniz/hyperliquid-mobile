/**
 * The chart's own settings, persisted.
 *
 * These are TASTE knobs on the plot — volume bars, momentum shading, how many
 * buckets fit on screen — not market state, so they live in MMKV under one
 * key and apply to every market's chart alike. Validated on read the way
 * `appearance.ts` validates its choice: a schema-drifted entry must fall back
 * to the defaults, never crash a screen over a preference.
 *
 * **Every field here is a real `LiveChart` prop**, and each default matches
 * that prop's own default, so a fresh install draws exactly what the chart
 * drew before any of this existed. Nothing in this file invents a setting the
 * chart cannot honour — a toggle that does nothing is worse than no toggle.
 *
 * **There is deliberately no price-axis toggle, and the asymmetry with
 * `timeAxis` is the bug, not the design.** Hiding an axis unmounts its hook,
 * and `LiveChart`'s `useYAxis` seeds `useSharedValue<Record<number, number>>({})`
 * then mutates that object in place from a worklet — which throws
 * `cannot add a new property` the moment it remounts with candles already
 * loaded, i.e. every time someone switches it back on. `useXAxis` carries a
 * copy-on-write fix for exactly this ("SharedValue payloads may be frozen
 * after crossing the JS/UI boundary"), and it was never applied to the Y one,
 * so the time axis is safe to toggle and the price axis is not. Verified on
 * device against livechart 4.20; if a later version copies that fix across,
 * `priceAxis` can come back as a plain `yAxis` pass-through.
 */

import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

// v2: `bars` was [40, 60, 90] with a default of 60. The choices changed, so a
// stored 60 is still valid and would have pinned every existing install to the
// old default forever. A chart preference is worth nothing to preserve across
// a redesign — bumping the key is cheaper than a migration nobody can verify.
const STORE_KEY = "hl.chart.prefs.v2";

/**
 * Buckets visible at once — the seed holds 300; the rest are a pan away.
 *
 * A range rather than a handful of choices, because framing is a taste with
 * no natural stops: four buttons made the reader pick the nearest of someone
 * else's answers. The step keeps every stop a round number, which is what
 * lets a wheel list them all.
 */
export const BARS_MIN = 20;
export const BARS_MAX = 120;
export const BARS_STEP = 5;

/** In range and whole — any such value is renderable, step or not. */
export function isBarCount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= BARS_MIN && value <= BARS_MAX
  );
}

export interface ChartPrefs {
  /** Volume bars under the plot. */
  volume: boolean;
  /** Momentum shading on the line / wick colouring emphasis. */
  momentum: boolean;
  /** Fade the oldest bars into the left edge. */
  leftEdgeFade: boolean;
  /** Gradient fill under the line (line mode only). */
  gradient: boolean;
  /** Time labels along the bottom. */
  timeAxis: boolean;
  /** Dashed guide across the plot at the live price. */
  priceLine: boolean;
  /** Drag across the plot to read a bucket. */
  scrub: boolean;
  /** Pinch the plot to change how many buckets fit. */
  zoom: boolean;
  /** Drag sideways to pan into older buckets (and load more). */
  timeScroll: boolean;
  bars: number;
}

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  volume: true,
  momentum: true,
  leftEdgeFade: true,
  gradient: true,
  timeAxis: true,
  priceLine: false,
  scrub: true,
  zoom: false,
  timeScroll: true,
  bars: 25,
};

/** The boolean half of the schema — every key validates identically. */
const FLAGS = [
  "volume",
  "momentum",
  "leftEdgeFade",
  "gradient",
  "timeAxis",
  "priceLine",
  "scrub",
  "zoom",
  "timeScroll",
] as const satisfies readonly (keyof ChartPrefs)[];

export function readChartPrefs(): ChartPrefs {
  const raw = hlStringStorage.getItem(STORE_KEY);
  if (raw === null) return DEFAULT_CHART_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_CHART_PREFS;
    const held = parsed as Record<string, unknown>;
    const prefs = { ...DEFAULT_CHART_PREFS };
    for (const flag of FLAGS) {
      const value = held[flag];
      if (typeof value === "boolean") prefs[flag] = value;
    }
    if (isBarCount(held.bars)) prefs.bars = held.bars;
    return prefs;
  } catch {
    return DEFAULT_CHART_PREFS;
  }
}

export function writeChartPrefs(prefs: ChartPrefs): void {
  hlStringStorage.setItem(STORE_KEY, JSON.stringify(prefs));
}
