/**
 * Price and size precision.
 *
 * The SDK owns the wire formatting rules (`formatPrice` / `formatSize`); this
 * module re-exports them through our error type and adds the derived maths the
 * SDK does not provide — tick grids and liquidation price.
 *
 * Two invariants hold throughout:
 * - Values stay **strings** on the wire and `BigNumber` in maths. `Number` is
 *   never used for a price or size, because float rounding silently produces a
 *   value the exchange will reject or, worse, accept at the wrong level.
 * - A value that cannot be represented is an **error**, not an empty string.
 *   The reference returned `''` here, which callers could ignore.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
 */

import { BigNumber } from "bignumber.js";
import {
  formatPrice as sdkFormatPrice,
  formatSize as sdkFormatSize,
} from "@nktkas/hyperliquid/utils";

import {
  MAX_DECIMALS_PERP,
  MAX_DECIMALS_SPOT,
  MAX_SIGNIFICANT_FIGURES,
} from "@/hyperliquid/config/constants";
import type { MarketType } from "@/hyperliquid/types/domain";
import { PrecisionError } from "@/hyperliquid/core/errors";

// ---------------------------------------------------------------------------
// Wire formatting (SDK-backed)
// ---------------------------------------------------------------------------

/**
 * Reject values the exchange's wire schema will not accept.
 *
 * The SDK's formatters pass **negatives straight through** (`formatPrice(-5, 0)`
 * → `"-5"`), even though the action schema is `UnsignedDecimal` and rejects
 * them. Caught here so a sign error surfaces at the call site with context,
 * rather than as an opaque validation failure at submit time.
 */
function assertUnsigned(value: string | number, label: string, context: Record<string, unknown>) {
  const isNegative = typeof value === "number" ? value < 0 : value.trim().startsWith("-");
  if (isNegative) {
    throw new PrecisionError(`${label} must not be negative, got ${String(value)}`, context);
  }
}

/**
 * Format a price for the wire.
 *
 * The two caps apply together and the **stricter wins**: decimals are capped to
 * `(perp ? 6 : 8) - szDecimals` first, then to 5 significant figures, with
 * integers exempt from the significant-figure cap. Rounding is **toward zero**,
 * never half-up — for a buy that makes the limit less aggressive, for a sell
 * more so.
 *
 * @throws {PrecisionError} if the value is negative, not finite, or truncates
 *   to zero.
 */
export function formatPrice(
  price: string | number,
  szDecimals: number,
  type: MarketType = "perp"
): string {
  assertUnsigned(price, "Price", { price, szDecimals, type });
  try {
    return sdkFormatPrice(price, szDecimals, type);
  } catch (cause) {
    throw new PrecisionError(
      `Price ${String(price)} is not valid at szDecimals=${szDecimals}`,
      { price, szDecimals, type },
      cause
    );
  }
}

/**
 * Format a size for the wire: truncated to `szDecimals`.
 *
 * @throws {PrecisionError} if the value is negative, not finite, or truncates
 *   to zero. Note a size of exactly zero is legal on the wire for a
 *   position-scaled TP/SL leg — such legs bypass this and pass `"0"` directly.
 */
export function formatSize(size: string | number, szDecimals: number): string {
  assertUnsigned(size, "Size", { size, szDecimals });
  try {
    return sdkFormatSize(size, szDecimals);
  } catch (cause) {
    throw new PrecisionError(
      `Size ${String(size)} is not valid at szDecimals=${szDecimals}`,
      { size, szDecimals },
      cause
    );
  }
}

/** Non-throwing variants, for live input fields where a partial value is normal. */
export function tryFormatPrice(
  price: string | number,
  szDecimals: number,
  type: MarketType = "perp"
): string | undefined {
  try {
    return sdkFormatPrice(price, szDecimals, type);
  } catch {
    return undefined;
  }
}

export function tryFormatSize(size: string | number, szDecimals: number): string | undefined {
  try {
    return sdkFormatSize(size, szDecimals);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tick grid
// ---------------------------------------------------------------------------

/**
 * Convert without throwing.
 *
 * bignumber.js v11 throws on clearly-invalid input such as `"abc"` or `""`
 * rather than yielding NaN, which would break the `null` contract these helpers
 * promise to callers stepping prices from live input.
 *
 * Exported because the hazard is not local to this module: **any** wire string
 * reaching a `new BigNumber()` can be empty or malformed, and the throw lands
 * wherever the value is used — inside a render, for a display path.
 */
export function toBigNumber(value: BigNumber.Value): BigNumber {
  if (value instanceof BigNumber) return value;
  try {
    return new BigNumber(value);
  } catch {
    return new BigNumber(Number.NaN);
  }
}

function maxDecimalsFor(szDecimals: number, type: MarketType): number {
  return Math.max((type === "perp" ? MAX_DECIMALS_PERP : MAX_DECIMALS_SPOT) - szDecimals, 0);
}

/**
 * The smallest price increment valid at this price level.
 *
 * Hyperliquid's grid is the *coarser* of two constraints — the significant
 * figure step and the decimal step — so the tick widens as price grows. Needed
 * for order-book aggregation and for stepping a price input.
 *
 * Returns `null` for input that has no meaningful tick (non-finite,
 * non-positive, or invalid decimals) rather than throwing: callers step prices
 * from live UI state where those are transient.
 */
export function getPriceTick(
  price: BigNumber.Value,
  szDecimals: number,
  type: MarketType = "perp"
): BigNumber | null {
  const priceBN = toBigNumber(price);
  if (!priceBN.isFinite() || priceBN.lte(0) || !Number.isInteger(szDecimals) || szDecimals < 0) {
    return null;
  }

  const exponent = Number(priceBN.toExponential().split("e")[1]);
  const significantFigureStep = BigNumber.minimum(
    new BigNumber(10).pow(exponent - MAX_SIGNIFICANT_FIGURES + 1),
    1
  );
  const decimalStep = new BigNumber(10).pow(-maxDecimalsFor(szDecimals, type));

  return BigNumber.maximum(significantFigureStep, decimalStep);
}

/** Snap a price onto the valid grid. `up`/`down` matter for order placement bias. */
export function snapPriceToGrid(
  price: BigNumber.Value,
  direction: "up" | "down" | "nearest",
  szDecimals: number,
  type: MarketType = "perp"
): BigNumber | null {
  const priceBN = toBigNumber(price);
  const tick = getPriceTick(priceBN, szDecimals, type);
  if (!tick) return null;

  const roundingMode =
    direction === "up"
      ? BigNumber.ROUND_CEIL
      : direction === "down"
        ? BigNumber.ROUND_FLOOR
        : BigNumber.ROUND_HALF_UP;

  const snapped = priceBN.dividedBy(tick).integerValue(roundingMode).multipliedBy(tick);
  return snapped.gt(0) ? snapped : null;
}

/**
 * The next valid price one tick away.
 *
 * Not simply `price ± tick`: stepping can cross a significant-figure boundary
 * where the tick size itself changes, so the tick is recomputed at the probe
 * price.
 */
export function getNextPrice(
  price: BigNumber.Value,
  direction: "up" | "down",
  szDecimals: number,
  type: MarketType = "perp"
): BigNumber | null {
  const priceBN = toBigNumber(price);
  if (!priceBN.isFinite() || priceBN.lte(0) || !Number.isInteger(szDecimals) || szDecimals < 0) {
    return null;
  }

  const minimumStep = new BigNumber(10).pow(-maxDecimalsFor(szDecimals, type));
  const probe = direction === "up" ? priceBN.plus(minimumStep) : priceBN.minus(minimumStep);
  if (probe.lte(0)) return null;

  const tick = getPriceTick(probe, szDecimals, type);
  if (!tick) return null;

  const snapped = snapPriceToGrid(probe, direction, szDecimals, type);
  if (!snapped) return null;

  // Snapping can land back on the original price when the probe sits inside the
  // current tick; step once more so the result always moves.
  if (snapped.isEqualTo(priceBN)) {
    const stepped = direction === "up" ? priceBN.plus(tick) : priceBN.minus(tick);
    return stepped.gt(0) ? stepped : null;
  }
  return snapped;
}

// ---------------------------------------------------------------------------
// Risk maths
// ---------------------------------------------------------------------------

export interface MarginTier {
  lowerBound: string | number;
  maxLeverage: number;
}

/**
 * The margin tier covering a position's notional value.
 *
 * Tiers arrive sorted by increasing lower bound; scanning in reverse finds the
 * highest tier the value clears.
 */
export function findMarginTier(
  totalValue: BigNumber.Value,
  marginTiers: readonly MarginTier[]
): MarginTier | null {
  if (!marginTiers.length) return null;
  const value = toBigNumber(totalValue);
  for (let i = marginTiers.length - 1; i >= 0; i -= 1) {
    const tier = marginTiers[i];
    if (value.gte(new BigNumber(tier.lowerBound))) return tier;
  }
  return null;
}

/**
 * Liquidation price for an order the user has not placed yet.
 *
 * `price - side * marginAvailable / positionSize / (1 - mmr * side)`
 * where side is +1 long, -1 short.
 *
 * **Pre-trade only.** For a position that already exists, display the server's
 * `liquidationPx` and nothing else. This formula sees only perp margin, while
 * the exchange computes against spot collateral too — measured divergence on a
 * live account was 64x (709.41 implied against 10.98 perp-only), and one
 * account's blended maintenance rate was a flat 1% inconsistent with every one
 * of its own 154 position tiers. It is an order-form estimate, not a fact.
 *
 * `positionSize` must be **unsigned**. Passing a signed `szi` with the matching
 * `side` cancels two negations and puts a short's liquidation price *below* its
 * entry — worked example: entry 100, margin 10, szi "-1", mmr 0.01 gives 90.10
 * where the truth is 109.90. That is a wrong number with no error, so it throws.
 *
 * Returns `null` for a zero-size position rather than dividing by zero.
 */
export function calculateLiquidationPrice(params: {
  entryPrice: BigNumber.Value;
  marginAvailable: BigNumber.Value;
  positionSize: BigNumber.Value;
  /** Maintenance margin rate, as a fraction (0.01 = 1%). */
  mmr: BigNumber.Value;
  side: "long" | "short";
}): BigNumber | null {
  const positionSize = toBigNumber(params.positionSize);
  if (!positionSize.isFinite() || positionSize.isZero()) return null;
  if (positionSize.isNegative()) {
    throw new PrecisionError("calculateLiquidationPrice requires an unsigned position size", {
      positionSize: positionSize.toFixed(),
      side: params.side,
    });
  }

  const sideMultiplier = new BigNumber(params.side === "long" ? 1 : -1);
  const denominator = new BigNumber(1).minus(toBigNumber(params.mmr).multipliedBy(sideMultiplier));
  if (denominator.isZero()) return null;

  const liquidationPrice = toBigNumber(params.entryPrice).minus(
    sideMultiplier
      .multipliedBy(toBigNumber(params.marginAvailable))
      .dividedBy(positionSize)
      .dividedBy(denominator)
  );
  // `toBigNumber` yields NaN rather than throwing for an unparseable input, and
  // an order form feeds this half-typed values on every keystroke. Returning a
  // NaN BigNumber breaks the documented `null` contract and renders as "NaN".
  return liquidationPrice.isFinite() ? liquidationPrice : null;
}

/**
 * The maintenance margin rate implied by an asset's max leverage.
 *
 * Hyperliquid's published rule: "maintenance margin is half of the initial
 * margin at max leverage. E.g., if max leverage is 20x, the maintenance margin
 * is 2.5%" — so `mmr = 1 / (2 * maxLeverage)`, which is the `l =
 * 1 / MAINTENANCE_LEVERAGE` term of their own liquidation formula and exactly
 * what {@link calculateLiquidationPrice} takes as `mmr`.
 *
 * **Tier zero only.** Assets with margin tiers carry a per-tier rate plus a
 * `maintenance_deduction`, both keyed on the position's notional at the
 * liquidation price; this returns the FIRST tier's rate, which is the correct
 * one for positions below the first tier bound and OPTIMISTIC (liquidation
 * further away than reality) above it. That is acceptable for an order-form
 * estimate the docs already call approximate, and wrong for anything else —
 * an open position must display the server's `liquidationPx`.
 *
 * Returns null for an unknown or nonsensical cap rather than a fabricated
 * rate: no number is better than a wrong one on a liquidation estimate.
 */
export function maintenanceMarginRate(maxLeverage: number | null): string | null {
  if (maxLeverage === null || !Number.isFinite(maxLeverage) || maxLeverage <= 0) return null;
  return new BigNumber(1).dividedBy(new BigNumber(maxLeverage).multipliedBy(2)).toFixed();
}
