/**
 * Which of the five presentations a one-shot read gets — as data, not markup.
 *
 * Split out of `FetchedList` so it can be tested. Rendering a `heroui-native`
 * component under Jest pulls in Reanimated, Worklets and Skia, none of which
 * have native modules there, and the project's Jest config is documented as
 * load-bearing and easy to break. The *decision* is the part with rules in it;
 * the markup is markup. This is the decision.
 *
 * The rule being protected: **four of these five would render as an empty list
 * in a naive version, and only one of them means the account is empty.**
 */

import { BigNumber } from "bignumber.js";

import { toBigNumber } from "@/hyperliquid/core/precision";

import type { Fetched } from "@/hyperliquid/hooks/history";

export type FetchedView =
  /** No session. Not "you have none". */
  | { kind: "idle"; title: string; description: string }
  /** In flight. Skeleton rows, never an empty state. */
  | { kind: "loading" }
  /**
   * The weight budget declined, or the read failed. Both offer a retry; only
   * one is styled as an error — a deferral is the app protecting a shared
   * allowance and resolves on its own, so a red banner would train the user to
   * distrust a working client.
   */
  | { kind: "notice"; tone: "neutral" | "danger"; label: string; detail: string }
  /** A successful read that genuinely returned nothing. */
  | { kind: "empty"; title: string; description: string }
  /** A successful read with rows. */
  | { kind: "rows" };

export function describeFetched<T>(
  state: Fetched<T>,
  options: { isEmpty: (value: T) => boolean; emptyTitle: string; emptyDescription: string }
): FetchedView {
  switch (state.kind) {
    case "idle":
      return {
        kind: "idle",
        title: "Not connected",
        description: "Start a session to load this history.",
      };

    case "loading":
      return { kind: "loading" };

    case "deferred":
      return {
        kind: "notice",
        // Neutral, deliberately: this is expected on a busy screen.
        tone: "neutral",
        label: "paused to stay inside the rate limit",
        detail: "This read shares a per-IP allowance with the rest of the screen.",
      };

    case "error":
      return {
        kind: "notice",
        tone: "danger",
        label: "could not load",
        detail: state.message,
      };

    case "ready":
      return options.isEmpty(state.value)
        ? { kind: "empty", title: options.emptyTitle, description: options.emptyDescription }
        : { kind: "rows" };
  }
}

/**
 * `"0.00045"` → `"0.045%"`. Full precision with trailing zeros trimmed —
 * fee tiers differ in the third and fourth decimal of a percent, and a 2dp
 * round collapses adjacent tiers into the same number.
 *
 * Lives here rather than in `FeeCard.tsx` so it is testable: importing the
 * component under Jest drags in Reanimated/Worklets, which do not load there.
 */
export function rateAsPercent(rate: string): string {
  const ratio = toBigNumber(rate);
  if (!ratio.isFinite()) return "--";
  return `${ratio.multipliedBy(100).toFixed()}%`;
}

/**
 * A `[0,1]` fraction as a whole percent — `"0.5"` → `"50%"`.
 *
 * This exists because `twapProgress` returns a FRACTION, and suffixing it with
 * `%` directly rendered a half-done TWAP as "0.5%" — off by two orders of
 * magnitude in the reassuring direction. Whole percents: a progress readout
 * gains nothing from decimals.
 */
export function progressPercent(fraction: string): string {
  const value = toBigNumber(fraction);
  if (!value.isFinite()) return "--";
  return `${value.multipliedBy(100).toFixed(0)}%`;
}

/** What the next volume tier asks and offers, for the fee card's progress row. */
export interface NextTierView {
  /** Volume required, wire string — format with `compactUsd`. */
  cutoff: string;
  /** The taker rate that tier grants. */
  cross: string;
  /** `volume ÷ cutoff` as a fraction string, `"0"`–`"1"`. */
  progress: string;
}

/**
 * The lowest tier whose cutoff the 14-day volume has not reached.
 *
 * `null` for "nothing to show": no published tiers, or the account is already
 * at (or beyond) the top tier — a progress bar to a level that does not exist
 * would invite chasing nothing.
 */
export function nextFeeTier(
  volume14d: string,
  tiers: readonly { ntlCutoff: string; cross: string }[]
): NextTierView | null {
  const volume = toBigNumber(volume14d);
  if (!volume.isFinite()) return null;

  // Sorted locally rather than trusted: this is a display decision and the
  // wire's ordering is someone else's promise.
  const sorted = [...tiers].sort(
    (a, b) => toBigNumber(a.ntlCutoff).comparedTo(toBigNumber(b.ntlCutoff)) ?? 0
  );
  for (const tier of sorted) {
    const cutoff = toBigNumber(tier.ntlCutoff);
    if (!cutoff.isFinite() || !cutoff.gt(0)) continue;
    if (cutoff.gt(volume)) {
      return {
        cutoff: tier.ntlCutoff,
        cross: tier.cross,
        progress: volume.dividedBy(cutoff).toFixed(4),
      };
    }
  }
  return null;
}

/**
 * `"5000000.0"` → `"$5M"` — tier cutoffs as the ladder states them.
 * Rounded DOWN so a threshold is never understated: $4.97M is "$4.9M",
 * because calling it "$5M" would claim a tier the volume has not reached.
 *
 * The gates read the MAGNITUDE and the sign is re-attached afterwards. Gated on
 * the signed value, every `gte` fails for a negative and it falls through to the
 * plain branch — `-351818.09` rendered as `$-351818.09`, sixteen characters
 * where three were budgeted, in the one case (a loss, a net outflow) where the
 * compact form matters most. Rounding DOWN still applies to the magnitude, so
 * the abs is never overstated in either direction.
 */
export function compactUsd(amount: string): string {
  const value = toBigNumber(amount);
  if (!value.isFinite()) return "--";
  // `isLessThan(0)`, not `isNegative()`: bignumber.js keeps the sign of `-0`,
  // and "-$0" is not a thing.
  const sign = value.isLessThan(0) ? "-" : "";
  const magnitude = value.abs();
  const unit = (divisor: number, suffix: string): string =>
    `${sign}$${magnitude.dividedBy(divisor).decimalPlaces(1, BigNumber.ROUND_DOWN).toFixed()}${suffix}`;
  if (magnitude.gte(1e9)) return unit(1e9, "B");
  if (magnitude.gte(1e6)) return unit(1e6, "M");
  if (magnitude.gte(1e3)) return unit(1e3, "K");
  return `${sign}$${magnitude.decimalPlaces(2, BigNumber.ROUND_DOWN).toFixed()}`;
}
