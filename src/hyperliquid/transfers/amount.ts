/**
 * The only place a number becomes a signable amount.
 *
 * This module exists because of a specific, verified failure: the SDK
 * **normalises the amount string before signing it**. `"25.00"` is signed as
 * `"25"`. That is harmless until you consider what else it means — the string
 * inside the signed message is not necessarily the string the user read and
 * approved. Anywhere a float can reach it, the gap becomes dangerous:
 *
 * - `0.1 + 0.2` produces `"0.30000000000000004"`
 * - any JS number ≥ 1e21 serialises as `"1e+21"`
 * - `String(1/3)` produces 17 significant digits
 *
 * So `WireAmount` is branded and this is its only producer. Everything is
 * BigNumber; `Number()` and `parseFloat()` appear nowhere in the file, and a
 * structural test asserts that.
 *
 * The cap is **6 decimal places**, matching USDC's on-chain precision. More
 * digits than that cannot survive the round trip and would be silently dropped
 * somewhere the user cannot see.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import type { MicroUsd, WireAmount } from "@/hyperliquid/transfers/types";

/** USDC's on-chain precision. Digits beyond this cannot survive the round trip. */
export const AMOUNT_DECIMALS = 6;

/** Matches what the exchange accepts: a plain decimal, no sign, no exponent. */
const CANONICAL = /^[0-9]+(\.[0-9]+)?$/;

function fail(noun: string, detail: string, received: unknown): never {
  throw new HlError(`${noun} ${detail}`, {
    code: "validation_error",
    context: { received: typeof received === "string" ? received : String(received) },
  });
}

/**
 * Turn a user-entered amount into the exact string that will be signed.
 *
 * Accepts a string or a BigNumber — **never a `number`**, by type. A caller
 * holding a float has already lost precision, and taking one here would make
 * this module complicit rather than protective.
 *
 * The returned string is what the exchange will normalise to, so a caller can
 * display it and be certain the user read what they signed.
 *
 * @param noun what the amount *is*, for the error message. Defaults to the
 *   transfer wording this was written for; prediction-market conversions pass
 *   "outcome shares" or "quote tokens", because "transfer amount is zero" sends a
 *   user looking at the wrong field.
 */
export function canonicalAmount(input: string | BigNumber, noun = "transfer amount"): WireAmount {
  const raw = typeof input === "string" ? input.trim() : input.toFixed();
  if (raw.length === 0) fail(noun, "is empty", input);

  // Reject before BigNumber sees it: BigNumber happily parses "1e21" and
  // " 1.5 ", and both would then serialise into a signed message.
  if (!CANONICAL.test(raw)) fail(noun, "is not a plain positive decimal", raw);

  const value = new BigNumber(raw);
  if (!value.isFinite()) fail(noun, "is not finite", raw);
  if (value.isZero()) fail(noun, "is zero — the exchange rejects this outright", raw);
  if (value.decimalPlaces()! > AMOUNT_DECIMALS) {
    fail(noun, `has more than ${AMOUNT_DECIMALS} decimal places`, raw);
  }

  // `toFixed()` with no argument is BigNumber's plain-decimal form: never
  // exponential, whatever the magnitude. `toString()` would switch to
  // exponential notation past 1e21.
  return value.toFixed() as WireAmount;
}

/**
 * Whether two amounts are numerically equal.
 *
 * String comparison is wrong here: `"25.00"` and `"25"` are the same amount, and
 * the SDK will turn the first into the second on its way to the signature.
 */
export function amountsEqual(a: string, b: string): boolean {
  return new BigNumber(a).isEqualTo(b);
}

/**
 * What actually arrives, after the withdrawal fee.
 *
 * The fee is **deducted from** the signed amount rather than added to it, so
 * this is the figure to show as "you will receive" — and the gross is the figure
 * to sign. Getting the direction backwards either strands the fee in the account
 * forever or overdraws on every maximum withdrawal.
 *
 * @throws {HlError} if the fee would consume the whole amount, which is the real
 *   protocol floor — a withdrawal must leave something to arrive.
 */
export function netAfterFee(gross: WireAmount, feeUsdc: string): WireAmount {
  const net = new BigNumber(gross).minus(feeUsdc);
  if (net.isLessThanOrEqualTo(0)) {
    fail(
      "transfer amount",
      `of ${gross} does not exceed the ${feeUsdc} fee, so nothing would arrive`,
      gross
    );
  }
  return net.toFixed() as WireAmount;
}

/** True when `amount` is at least `floor`. Numeric, not lexicographic. */
export function meetsFloor(amount: WireAmount, floor: string): boolean {
  return new BigNumber(amount).isGreaterThanOrEqualTo(floor);
}

/** True when `amount` fits within `available`. */
export function withinBalance(amount: WireAmount, available: string): boolean {
  return new BigNumber(amount).isLessThanOrEqualTo(available);
}

/**
 * The largest withdrawable amount given a balance.
 *
 * Deliberately **not** fee-adjusted: the gross is what gets signed, so the
 * maximum gross is the whole available balance. Pre-subtracting the fee here is
 * the mistake that strands a dollar in the account permanently.
 *
 * Returns `null` when the balance cannot cover the fee, because then no
 * withdrawal is possible at all.
 */
export function maxWithdrawable(available: string, feeUsdc: string): WireAmount | null {
  const balance = new BigNumber(available).decimalPlaces(AMOUNT_DECIMALS, BigNumber.ROUND_DOWN);
  if (balance.isLessThanOrEqualTo(feeUsdc)) return null;
  return balance.toFixed() as WireAmount;
}

/**
 * Micro-USD, as `subAccountTransfer` and `vaultTransfer` expect it.
 *
 * **Not unique to sub-accounts** — `vaultTransfer.usd` is byte-identical, and
 * `cDeposit`/`cWithdraw`/`tokenDelegate` use `wei` at `× 1e8`. What is unique is
 * how close the opposite convention sits: `subAccountSpotTransfer`, one function
 * away, takes whole token units as a decimal string.
 *
 * The conversion lives here, not at a call site, for the same reason
 * `core/assetIds` owns ID arithmetic: passing `100` where `100_000_000` is meant
 * moves $0.0001 and validates cleanly.
 */
export function toMicroUsd(amount: WireAmount): MicroUsd {
  const micro = new BigNumber(amount).multipliedBy(1_000_000);
  if (!micro.isInteger()) fail("transfer amount", "does not convert to whole micro-USD", amount);
  if (micro.isLessThan(1)) fail("transfer amount", "is below the 1 micro-USD minimum", amount);
  // Past 2^53 the integer is no longer exactly representable, so the number
  // that reaches the wire is not the one computed here. BigNumber got us this
  // far exactly; the JS `number` the schema demands is where precision can
  // still be lost, and silently.
  if (micro.isGreaterThan(Number.MAX_SAFE_INTEGER)) {
    fail("transfer amount", "exceeds the largest exactly-representable micro-USD amount", amount);
  }
  return micro.toNumber() as MicroUsd;
}
