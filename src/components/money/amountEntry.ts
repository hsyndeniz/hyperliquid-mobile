/**
 * Typing a money amount on a number pad.
 *
 * A pad appends characters blindly, so every rule about what a wire amount may
 * look like has to live somewhere. It lives here, as a filter on the *proposed*
 * value: the pad is controlled, so a rejected keystroke simply leaves the value
 * where it was — no error state, no flash, nothing to dismiss.
 *
 * ## Why not just let them type and validate later
 *
 * `canonicalAmount` throws on anything it does not like, and it is the last stop
 * before a signature. Letting `"1.2.3"` or `"0.0000001"` accumulate in the field
 * means the failure surfaces as a thrown error at confirm time, pointing at a
 * value the user believed was fine. Refusing the keystroke is the same rule
 * enforced where it costs nothing.
 *
 * ## Strings, all the way
 *
 * Nothing here parses to a `number`. `"0.10"` and `"0.1"` are different strings
 * a user may be midway through typing, and a round trip through a float would
 * settle that question for them — wrongly, and silently.
 */

import { BigNumber } from "bignumber.js";

import { AMOUNT_DECIMALS } from "@/hyperliquid/transfers/amount";

/** Digits, optionally one dot, optionally more digits. Nothing else, ever. */
const SHAPE = /^[0-9]*(\.[0-9]*)?$/;

/** Enough for any balance a person holds, and a hard stop on pathological input. */
const MAX_CHARS = 20;

/**
 * What the field should become, given what the pad proposes.
 *
 * Returns `null` to reject the keystroke outright. The caller keeps the current
 * value, which is what makes an illegal key a no-op rather than an error.
 */
export function acceptEdit(next: string): string | null {
  if (next.length === 0) return "";
  if (next.length > MAX_CHARS) return null;

  // The LOCALE separator first, before anything judges the shape.
  //
  // A `decimal-pad` renders the locale's separator — a comma across most of
  // Europe, including this project's own simulator. Every filter below speaks
  // only ".", so a comma-locale user pressing their single separator key got a
  // silent no-op and could not type a fraction AT ALL; on any asset priced
  // under 1 USDC the field was unusable. It lives HERE rather than at the call
  // sites because it was at the call sites — one of four remembered it, and
  // the three that forgot are exactly the money fields that broke.
  //
  // Every comma is replaced, not just the first: "1,5,5" becomes "1.5.5",
  // which the shape test then rejects for two dots — the same answer a
  // dot-locale user typing "1.5.5" gets. Normalising must not make an invalid
  // string valid.
  const localised = next.replace(/,/g, ".");

  // A leading dot is the one edit worth *fixing* rather than refusing: tapping
  // "." on an empty field plainly means "nought point".
  const normalised = localised.startsWith(".") ? `0${localised}` : localised;

  if (!SHAPE.test(normalised)) return null;

  const [whole, fraction] = normalised.split(".");
  if (fraction !== undefined && fraction.length > AMOUNT_DECIMALS) return null;

  // `"007"` is not a thing anyone means. Leading zeros are stripped, except the
  // single `"0"` that has to survive long enough to become `"0."`.
  const trimmed = whole.replace(/^0+(?=[0-9])/, "");
  return fraction === undefined ? trimmed : `${trimmed}.${fraction}`;
}

/**
 * How much of the balance this amount is, as a fraction of 1.
 *
 * `Number()` at a display leaf, which is where the house rule allows it: this
 * feeds a progress bar's width and nothing that gets signed. Out-of-range and
 * unparseable inputs clamp to `0`, so a half-typed amount never renders a bar
 * running off the end of its track.
 */
export function fractionOf(amount: string, available: string | null): number {
  if (available === null) return 0;
  const value = Number(amount);
  const total = Number(available);
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, value / total));
}

/**
 * The amount a slider position means, as a wire-legal string.
 *
 * The inverse of {@link fractionOf}, for the drag direction: the slider hands
 * back a float in [0, 1], and this turns it into the string the rest of the
 * flow signs. The float is the *input gesture*, never the money — it goes
 * through BigNumber and is rounded **down** to the six decimals the wire
 * accepts, so no thumb position can ever produce an amount `canonicalAmount`
 * rejects or one that exceeds the balance.
 *
 * At the extremes it is exact, not approximate: fraction 1 returns the whole
 * available balance verbatim (the same value Max uses), and fraction 0 returns
 * the empty field rather than the illegal amount `"0"`.
 */
export function amountForFraction(available: string | null, fraction: number): string {
  if (available === null || !Number.isFinite(fraction) || fraction <= 0) return "";
  const total = new BigNumber(available);
  if (!total.isFinite() || total.isLessThanOrEqualTo(0)) return "";
  if (fraction >= 1) return total.decimalPlaces(AMOUNT_DECIMALS, BigNumber.ROUND_DOWN).toFixed();
  return total
    .multipliedBy(fraction)
    .decimalPlaces(AMOUNT_DECIMALS, BigNumber.ROUND_DOWN)
    .toFixed();
}

/**
 * The amount rendered as a hero figure.
 *
 * Deliberately **not** formatted — no thousands separators, no padding to two
 * decimals. What is displayed is what will be signed, and a separator inserted
 * here is a character the user did not type appearing in the number they are
 * about to approve. The only substitution is a placeholder `"0"` for an empty
 * field, which is a prompt rather than a value.
 */
export function heroText(amount: string): string {
  return amount.length === 0 ? "0" : amount;
}

/**
 * Display size for the hero figure, chosen from its length.
 *
 * Deterministic rather than measured. `adjustsFontSizeToFit` needs a bounded
 * width to work against and, given an unbounded flex row, shrinks the text to
 * its floor immediately — a 64pt display figure rendered at body size, which is
 * exactly the layout this screen exists to avoid. Three steps cover everything
 * a six-decimal amount can be.
 */
export function heroFontSize(text: string): number {
  if (text.length <= 8) return 64;
  if (text.length <= 12) return 48;
  return 34;
}
