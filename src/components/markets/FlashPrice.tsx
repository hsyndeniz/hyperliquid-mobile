/**
 * A live price with a directional colour flash — and, only where one price
 * deserves it, rolling digits.
 *
 * **The default is a plain `Text`.** Profiled on device: NumberFlow renders a
 * stack of ten digit elements per slot (~150 components per price), which
 * made a 20-row list switch commit 1.4s and every 15s mids tick over 1s in
 * dev — the digits WERE the Markets tab's performance problem. A text swap
 * with the same 500ms colour flash keeps the liveness at ~1% of the cost.
 * The `rolling` prop opts back into NumberFlow, and **only the market-detail
 * hero uses it** — one instance, on a screen the user is deliberately looking
 * at. It is not free: profiled there, a rolling hero renders 174 `Text` + 84
 * `StripDigit` per tick, ~33 ms a commit in dev (~11 ms production, inside a
 * frame). That is the whole reason list rows and the Markets tab get the text
 * variant — the cost is per instance, and a list multiplies it.
 *
 * What makes it affordable is that it only rolls when a rendered digit
 * actually changes: the value is quantised to `digits` before it reaches
 * NumberFlow (see below). Unquantised, sub-precision jitter from `allMids`
 * rebuilt every digit strip several times a second to animate nothing.
 *
 * Three rules stay, identical in both modes:
 *
 * - **Fraction digits are pinned to the widest spelling this mount has
 *   seen** — `allMids` trims trailing zeros (`69.07` → `69.1`), and a format
 *   that follows each spelling makes the width jitter (and made NumberFlow
 *   clip mid-roll). Held as state adjusted DURING render — the documented
 *   derived-state pattern; a render-phase ref write is compiler-unsafe here.
 * - **The flash is text-colour only**, 500 ms, and it is an assertion:
 *   `flashDirection` stays silent on first render, on re-spellings, and
 *   while the source is stale.
 * - **`Number()` happens here**, at the display leaf, per the house rule.
 *
 * Styling is a style OBJECT, not a className, so the font rule is met with
 * explicit `fontFamily` values in both modes.
 */

import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { NumberFlow } from "number-flow-react-native";
import { useThemeColor } from "heroui-native";

import { decimalsOf, flashDirection } from "@/components/markets/marketsView";
import { displayNumber, quantizeToDigits } from "@/components/common/display";

/** How long a direction colour holds before the price returns to neutral. */
const FLASH_MS = 500;

/**
 * `Intl.NumberFormat` throws past 20 fraction digits; the wire never sends
 * more than 8 (spot's own cap), so the clamp is a guard, not a policy.
 */
const MAX_FRACTION_DIGITS = 8;

export function FlashPrice({
  value,
  isStale = false,
  asProbability = false,
  fontSize = 16,
  weight = "semibold",
  rolling = false,
  trendTone = null,
}: {
  /** The wire string, verbatim — `"63645.0"`, `"0.624"`. */
  value: string;
  /** Suppresses the flash only; dimming is the caller's presentation. */
  isStale?: boolean;
  /** Render `"0.624"` as `62.4%` — one decimal, the probability rule. */
  asProbability?: boolean;
  fontSize?: number;
  weight?: "semibold" | "bold";
  /** Rolling digits (NumberFlow). Detail-hero only — see the header. */
  rolling?: boolean;
  /**
   * Base colour by day direction — the reference exchanges paint the hero
   * price green/red with the 24h move. A tick flash still overrides it for
   * its moment; `null` keeps the plain foreground.
   */
  trendTone?: "up" | "down" | null;
}): JSX.Element {
  const [foreground, success, danger] = useThemeColor(["foreground", "success", "danger"]);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prevRef = useRef<string | null>(null);
  const [heldDigits, setHeldDigits] = useState(() =>
    Math.min(decimalsOf(value), MAX_FRACTION_DIGITS)
  );
  const spelled = Math.min(decimalsOf(value), MAX_FRACTION_DIGITS);
  if (spelled > heldDigits) setHeldDigits(spelled);

  useEffect(() => {
    const prev = prevRef.current;
    // Always advanced, even while stale: on recovery the comparison must span
    // one tick, not the whole gap.
    prevRef.current = value;
    if (isStale) return;
    const direction = flashDirection(prev, value);
    if (direction === null) return;
    setFlash(direction);
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [value, isStale]);

  const digits = asProbability ? 1 : Math.max(heldDigits, spelled);
  // Quantised to the digits actually RENDERED. `allMids` moves below the
  // displayed precision constantly, and the full-precision number handed
  // NumberFlow a "change" whose formatted output was identical — 174 `Text` and
  // 84 `StripDigit` rebuilt to animate nothing anyone can see. The plain-text
  // branch formats to the same `digits`, so its output is unaffected either way.
  const raw = asProbability ? displayNumber(value) * 100 : displayNumber(value);
  const shown = quantizeToDigits(raw, digits);
  const base = trendTone === "up" ? success : trendTone === "down" ? danger : foreground;
  const color = flash === "up" ? success : flash === "down" ? danger : base;
  const style = {
    fontFamily: weight === "bold" ? "SFProRounded-Bold" : "SFProRounded-Semibold",
    fontSize,
    color,
    fontVariant: ["tabular-nums" as const],
  };

  if (rolling) {
    return (
      <NumberFlow
        value={shown}
        format={{ minimumFractionDigits: digits, maximumFractionDigits: digits }}
        suffix={asProbability ? "%" : undefined}
        respectMotionPreference
        style={style}
      />
    );
  }

  // The same locale formatting NumberFlow applies, without the digit stacks.
  const label = `${shown.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${asProbability ? "%" : ""}`;
  return <Text style={style}>{label}</Text>;
}
