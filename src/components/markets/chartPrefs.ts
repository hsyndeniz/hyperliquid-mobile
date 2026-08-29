/**
 * The chart's own settings, persisted.
 *
 * These are TASTE knobs on the plot — volume bars, momentum shading, how many
 * buckets fit on screen — not market state, so they live in MMKV under one
 * key and apply to every market's chart alike. Validated on read the way
 * `appearance.ts` validates its choice: a schema-drifted entry must fall back
 * to the defaults, never crash a screen over a preference.
 */

import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

const STORE_KEY = "hl.chart.prefs";

/** Buckets visible at once — the seed holds 300; the rest are a pan away. */
export const BAR_CHOICES = [40, 60, 90] as const;
export type BarChoice = (typeof BAR_CHOICES)[number];

export interface ChartPrefs {
  /** Volume bars under the plot. */
  volume: boolean;
  /** Momentum shading on the line / wick colouring emphasis. */
  momentum: boolean;
  /** Fade the oldest bars into the left edge. */
  leftEdgeFade: boolean;
  /** Gradient fill under the line (line mode only). */
  gradient: boolean;
  bars: BarChoice;
}

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  volume: true,
  momentum: true,
  leftEdgeFade: true,
  gradient: true,
  bars: 60,
};

function isBarChoice(value: unknown): value is BarChoice {
  return BAR_CHOICES.includes(value as BarChoice);
}

export function readChartPrefs(): ChartPrefs {
  const raw = hlStringStorage.getItem(STORE_KEY);
  if (raw === null) return DEFAULT_CHART_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_CHART_PREFS;
    const held = parsed as Record<string, unknown>;
    return {
      volume: typeof held.volume === "boolean" ? held.volume : DEFAULT_CHART_PREFS.volume,
      momentum: typeof held.momentum === "boolean" ? held.momentum : DEFAULT_CHART_PREFS.momentum,
      leftEdgeFade:
        typeof held.leftEdgeFade === "boolean"
          ? held.leftEdgeFade
          : DEFAULT_CHART_PREFS.leftEdgeFade,
      gradient: typeof held.gradient === "boolean" ? held.gradient : DEFAULT_CHART_PREFS.gradient,
      bars: isBarChoice(held.bars) ? held.bars : DEFAULT_CHART_PREFS.bars,
    };
  } catch {
    return DEFAULT_CHART_PREFS;
  }
}

export function writeChartPrefs(prefs: ChartPrefs): void {
  hlStringStorage.setItem(STORE_KEY, JSON.stringify(prefs));
}
