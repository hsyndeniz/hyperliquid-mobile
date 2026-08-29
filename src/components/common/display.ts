/**
 * The display leaves: where a wire string stops being a wire string.
 *
 * `Number()` happens HERE and nowhere upstream. Wire prices and sizes stay
 * strings through every derivation — that is the module rule that keeps tick
 * and lot precision out of float rounding — and these are the functions that
 * convert at the very end, for a chart point or a rendered figure.
 *
 * They lived in `portfolio/primitives.tsx` until markets, trade and the charts
 * all grew imports of them. Two reasons to move: they are not portfolio's, and
 * a component file that also exports plain functions cannot keep component
 * state across a Fast Refresh, so editing those screens forced a full reload.
 */

import { useEffect, useState } from "react";

/** Wire string → number, for display components only. NaN-safe. */
export function displayNumber(wire: string): number {
  const parsed = Number(wire);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Signed wire string → trend direction. */
export function trendOf(wire: string): "up" | "down" | "neutral" {
  const value = displayNumber(wire);
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "neutral";
}

/** Tailwind colour class for a signed figure. */
export function signColor(wire: string): string {
  const trend = trendOf(wire);
  if (trend === "up") return "text-success";
  if (trend === "down") return "text-danger";
  return "text-muted";
}

/**
 * A server timestamp as a short local time.
 *
 * Server clock, which can lead the device clock by seconds — so this formats
 * the instant it was given and never computes "x seconds ago", which would
 * render "in 3 seconds" for a fill that already happened.
 */
export function shortTime(ms: number, nowMs: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--";
  const date = new Date(ms);
  const today = new Date(nowMs);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * "Now", for the day-boundary comparison above, as a value that CHANGES.
 *
 * `shortTime` used to read the clock itself with an argless `new Date()`, and
 * under React Compiler that is a trap rather than a style point: a call like
 * `shortTime(fill.time)` memoises on its one argument, so the clock reading is
 * captured on first render and frozen. Every timestamp rendered before
 * midnight keeps claiming to be today's, indefinitely, because `fill.time`
 * never changes again. (This project has already shipped one bug from a
 * frozen render-phase read; the rule is that anything time-dependent is an
 * input, not something render fetches.)
 *
 * Ticks on the hour rather than per second: the only thing `nowMs` decides is
 * which calendar day it is, so anything finer is re-rendering a list for no
 * visible change.
 */
export function useNowHourly(): number {
  const [now, setNow] = useState(hourlyNow);
  useEffect(() => subscribeHourly(setNow), []);
  return now;
}

const HOUR_MS = 3_600_000;

/**
 * ONE timer for every consumer, not one per component.
 *
 * The callers are list ROWS — fills, ledger entries, funding payments — so a
 * `setInterval` inside the hook would be an interval per visible row, and a
 * fifty-row history would hold fifty timers to answer the same question. A
 * module-level tick with a subscriber set costs one timer for the app, and it
 * only exists while something is mounted.
 */
const hourlyListeners = new Set<(ms: number) => void>();
let hourlyTimer: ReturnType<typeof setInterval> | null = null;
let hourlyValue = Date.now();

function hourlyNow(): number {
  return hourlyValue;
}

function subscribeHourly(listener: (ms: number) => void): () => void {
  hourlyListeners.add(listener);
  if (hourlyTimer === null) {
    hourlyTimer = setInterval(() => {
      hourlyValue = Date.now();
      for (const entry of hourlyListeners) entry(hourlyValue);
    }, HOUR_MS);
  }
  return () => {
    hourlyListeners.delete(listener);
    if (hourlyListeners.size === 0 && hourlyTimer !== null) {
      clearInterval(hourlyTimer);
      hourlyTimer = null;
    }
  };
}

/**
 * Round a display number to the fraction digits that will actually be rendered.
 *
 * The point is identity, not arithmetic: a live price feed moves below the
 * precision on screen constantly, and handing an animated formatter a value
 * that formats to the same string is asking it to animate nothing. On the
 * market-detail hero that meant rebuilding 174 `Text` and 84 `StripDigit`
 * elements several times a second for a change no one could see.
 *
 * Formatting to `digits` afterwards gives the same string either way, so this
 * is free for a plain-text consumer and decisive for a rolling one.
 */
export function quantizeToDigits(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const places = Math.max(0, Math.min(MAX_INTL_FRACTION_DIGITS, Math.trunc(digits)));
  return Number(quantizerFor(places).format(value));
}

/**
 * Rounded THROUGH the formatter, not alongside it.
 *
 * `Math.round(v * 10 ** d) / 10 ** d` looks equivalent and is not: on values
 * that sit near a representable half the two disagree, and they disagree in
 * different directions (`1.005` at 2 digits renders `1.01` but rounds to
 * `1.00`; `8.575` renders `8.58` but rounds to `8.57`). `toFixed` is worse
 * again. Any of those would move the last digit of a PRICE by one, which is
 * exactly what a quantiser must never do.
 *
 * Formatting and parsing back cannot disagree with the renderer, because it is
 * the same operation. `en-US` with grouping off only so `Number` can read the
 * result — rounding in `Intl` is locale-independent, punctuation is not, and
 * the display still formats in the device's own locale.
 */
const QUANTIZERS = new Map<number, Intl.NumberFormat>();

/** `Intl`'s own ceiling for fraction digits. */
const MAX_INTL_FRACTION_DIGITS = 20;

function quantizerFor(places: number): Intl.NumberFormat {
  const held = QUANTIZERS.get(places);
  if (held) return held;
  const made = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
    useGrouping: false,
  });
  QUANTIZERS.set(places, made);
  return made;
}

/**
 * A wire price rendered the way the exchange itself quantises one: five
 * significant figures, with any trailing zeros left off.
 *
 * Not `maximumFractionDigits`. A FIXED fraction cap is wrong at both ends of
 * the price range, and a position row proved it in both directions: at one
 * digit a real liquidation price of `0.1534` rendered `0.2` and `0.04`
 * rendered `0` — which reads as no liquidation risk at all — while rendering
 * the wire string verbatim gave `66879.2151898734`, because a server-COMPUTED
 * price (unlike a traded one) carries the full float. Significant figures is
 * the rule that holds for BTC and for a sub-cent token at the same time, and
 * it is Hyperliquid's own price rule, so what is shown is what the exchange
 * would accept.
 *
 * Returns the input unchanged when it is not a finite number, so an unexpected
 * wire value renders as itself instead of as `NaN` or a silent `0`.
 */
export function formatWirePrice(wire: string): string {
  // `Number("")` and `Number("   ")` are both 0 — and finite — so an empty
  // value would otherwise render as a confident "0" price.
  if (wire.trim() === "") return wire;
  const parsed = Number(wire);
  if (!Number.isFinite(parsed)) return wire;
  if (parsed === 0) return "0";
  // `toPrecision` is the only built-in that counts SIGNIFICANT digits; it can
  // return exponential form for extremes, which `Number()` normalises back
  // before the final render.
  return String(Number(parsed.toPrecision(PRICE_SIGNIFICANT_DIGITS)));
}

/** Hyperliquid quotes every price to five significant figures. */
const PRICE_SIGNIFICANT_DIGITS = 5;
