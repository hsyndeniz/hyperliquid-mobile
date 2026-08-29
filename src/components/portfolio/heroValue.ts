/**
 * The hero balance, split so its cents can be dimmed.
 *
 * The references render an account balance as bright units over MUTED cents —
 * `$1` at full contrast, `.00` grey — so the eye lands on the magnitude rather
 * than on the two digits that change on every tick. That needs the figure as
 * two strings, and both halves have a way of going quietly wrong:
 *
 * - **The carry.** Splitting first and rounding the halves separately renders
 *   `"1.999"` as `$1` + `.100`: an integer that never learned about the carry
 *   out of the cents. So the value is rounded ONCE, as a BigNumber, and the
 *   split is taken from the rounded string.
 * - **The `"$"`.** Hard-coding it puts a dollar sign on a euro balance, and in
 *   `fr-FR`/`de-DE` it puts the symbol on the wrong END of the number — those
 *   locales print `1 234,50 €`. Every affix here comes from
 *   `Intl.NumberFormat.formatToParts`, never from a literal.
 *
 * A currency with no minor unit has no cents to dim: `ja-JP`/JPY formats as
 * `￥1,235` with no decimal part at all. `currencyAffixes` returns `null` there
 * and the caller renders one undivided figure, rather than appending a `.00`
 * that would claim a precision the currency does not have.
 *
 * Pure and locale-parameterised so both hazards are testable — a wrong carry
 * and a misplaced symbol are both things the eye reads straight past.
 */

import { toBigNumber } from "@/hyperliquid/core/precision";

/** The hero shows two minor-unit digits; `currencyAffixes` gates on the currency having them. */
const CENTS_DIGITS = 2;

/**
 * A probe, not a balance.
 *
 * `1` formats with the locale's full affix set and a SINGLE integer digit, so
 * the first `integer` part is unambiguously where the number begins — a probe
 * large enough to be grouped would interleave `group` parts with it.
 */
const AFFIX_PROBE = 1;

export interface CurrencyAffixes {
  /** Everything printed BEFORE the units — `"$"` in en-US, `""` in fr-FR. */
  prefix: string;
  /** Everything printed AFTER the minor units — `""` in en-US, `" €"` in fr-FR. */
  suffix: string;
  /** The locale's decimal separator — `"."` in en-US, `","` in fr-FR. */
  decimal: string;
  /** The locale Intl actually resolved, so grouping is read from the same one as the affixes. */
  locale: string;
}

/**
 * Where this locale puts the currency symbol, and what separates its cents.
 *
 * `null` when there are no cents to separate — either the currency has no minor
 * unit (JPY), or the runtime has no `formatToParts` to read. Both mean the same
 * thing to the caller: render one figure, do not invent a split.
 */
export function currencyAffixes(locale?: string, currency: string = "USD"): CurrencyAffixes | null {
  let parts: Intl.NumberFormatPart[];
  let resolved: string;
  try {
    const format = new Intl.NumberFormat(locale, { style: "currency", currency });
    resolved = format.resolvedOptions().locale;
    parts = format.formatToParts(AFFIX_PROBE);
  } catch {
    // Hermes' Intl is platform-backed rather than a full ICU build, so
    // `formatToParts` is not guaranteed to exist on every runtime this ships to.
    return null;
  }

  const firstInteger = parts.findIndex((part) => part.type === "integer");
  const decimal = parts.find((part) => part.type === "decimal");
  if (firstInteger === -1 || decimal === undefined) return null;

  // The LAST fraction part, so anything trailing it is genuinely suffix. Read
  // backwards rather than with `findLastIndex`, which Hermes does not carry.
  let lastFraction = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].type === "fraction") {
      lastFraction = i;
      break;
    }
  }
  if (lastFraction === -1) return null;

  return {
    prefix: parts
      .slice(0, firstInteger)
      .map((part) => part.value)
      .join(""),
    suffix: parts
      .slice(lastFraction + 1)
      .map((part) => part.value)
      .join(""),
    decimal: decimal.value,
    locale: resolved,
  };
}

export interface EquitySplit {
  /** Signed, UNGROUPED units — `"2"` for `"1.999"`. Grouping is the locale's job. */
  whole: string;
  /** Exactly two digits, with the carry already applied — `"00"` for `"1.999"`. */
  cents: string;
}

/**
 * A wire balance as units and cents, rounded once.
 *
 * `null` for anything that is not a finite number. A read that failed is not a
 * balance: the caller renders the Skeleton, never the zero the account does not
 * have.
 */
export function splitEquity(wire: string): EquitySplit | null {
  const value = toBigNumber(wire);
  if (!value.isFinite()) return null;

  // Rounded first, split second. Taking the integer part off the top and then
  // rounding what is left is what turns 1.999 into "1" + "100".
  const fixed = value.toFixed(CENTS_DIGITS);
  const dot = fixed.lastIndexOf(".");
  const whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const cents = dot === -1 ? "0".repeat(CENTS_DIGITS) : fixed.slice(dot + 1);

  // `-0.004` fixes to `"-0.00"`, and a hero reading "-$0.00" asserts a debt of
  // nothing. Dropped only when the ROUNDED figure is zero — `"-0.50"` keeps its
  // sign in `whole` so the composed figure still reads "-$0.50".
  const roundedToNothing = whole === "-0" && /^0*$/.test(cents);
  return { whole: roundedToNothing ? "0" : whole, cents };
}

export interface HeroFigure {
  /** The bright half: sign, symbol and grouped units — `"$1,234"`. */
  major: string;
  /** The dim half: separator, cents, trailing symbol — `".56"`. Empty when there are no cents. */
  minor: string;
}

/**
 * The two strings the hero draws, or `null` when the balance is not a number.
 *
 * `minor` is empty — not `".00"` — for a currency with no minor unit, which is
 * the caller's signal to render the major half alone.
 */
export function heroFigure(
  wire: string,
  options: { locale?: string; currency?: string } = {}
): HeroFigure | null {
  const split = splitEquity(wire);
  if (split === null) return null;

  const currency = options.currency ?? "USD";
  const affixes = currencyAffixes(options.locale, currency);
  if (affixes === null) {
    return { major: wholeCurrency(split, options.locale, currency), minor: "" };
  }

  const isNegative = split.whole.startsWith("-");
  const units = isNegative ? split.whole.slice(1) : split.whole;
  // The minus leads the symbol — "-$1,234.50" — which is what en-US, fr-FR and
  // de-DE all do. The parenthesised accounting pattern a few locales prefer is
  // unreachable here: a perp account is liquidated before its value goes below
  // zero, so this branch exists for arithmetic honesty, not for display taste.
  return {
    major: `${isNegative ? "-" : ""}${affixes.prefix}${groupUnits(units, affixes.locale)}`,
    minor: `${affixes.decimal}${split.cents}${affixes.suffix}`,
  };
}

/**
 * Group the units the way the locale does.
 *
 * Not a three-digit rule: hi-IN groups `12345678` as `1,23,45,678`, which no
 * fixed interval produces. `Number()` at a display leaf, which the house rules
 * permit — the value was already rounded as a BigNumber, and this is the last
 * step before it is drawn. Above 2^53 units the grouping degrades; a balance
 * that large is not reachable through this exchange.
 */
function groupUnits(units: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      useGrouping: true,
    }).format(Number(units));
  } catch {
    return units;
  }
}

/** The undivided figure, for a currency whose minor unit does not exist. */
function wholeCurrency(split: EquitySplit, locale: string | undefined, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      Number(`${split.whole}.${split.cents}`)
    );
  } catch {
    return `${split.whole}.${split.cents}`;
  }
}
