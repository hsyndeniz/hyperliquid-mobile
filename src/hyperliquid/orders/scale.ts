/**
 * Scale (ladder) orders.
 *
 * **Hyperliquid has no scale order.** There is no scale action and no group
 * primitive — a ladder is N ordinary limit legs submitted in one batch, built
 * entirely client-side. Three consequences follow, and each is a place the
 * reference implementation gets into trouble:
 *
 * 1. **Every leg is validated independently.** A ladder whose total clears the
 *    $10 minimum can still contain legs that do not; the exchange rejects those
 *    individually.
 * 2. **Mixed outcomes are normal.** Because it is an ordinary batch, some legs
 *    can rest while others are rejected — and the SDK reports that by throwing.
 *    A ladder must never be collapsed into one success or failure message.
 * 3. **Rounding leaves a remainder.** Sizes are truncated to the asset's lot
 *    size, so the placed total is slightly *less* than requested. The remainder
 *    is returned rather than silently dropped, which the reference does not do.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { formatPrice, formatSize } from "@/hyperliquid/core/precision";
import {
  MIN_ORDER_NOTIONAL_USDC,
  priceSzDecimalsOf,
  meetsMinNotional,
  type AssetSpec,
  type OrderLeg,
  type Tif,
} from "@/hyperliquid/orders/build";

export interface ScaleOrderInput {
  asset: AssetSpec;
  isBuy: boolean;
  /** Ladder bounds. Order does not matter; they are normalised. */
  startPrice: BigNumber.Value;
  endPrice: BigNumber.Value;
  /** Total size across all legs. */
  totalSize: BigNumber.Value;
  legCount: number;
  /**
   * Size distribution across the ladder.
   * - `flat` — equal size per leg.
   * - `ascending` — weight toward `endPrice`.
   * - `descending` — weight toward `startPrice`.
   */
  distribution?: "flat" | "ascending" | "descending";
  tif?: Tif;
  reduceOnly?: boolean;
}

export interface ScaleOrderPlan {
  legs: OrderLeg[];
  /**
   * Size that could not be placed because of lot-size truncation. Non-zero
   * means the ladder places slightly less than requested — surface it rather
   * than under-delivering silently.
   */
  remainder: string;
}

/** Relative weight of each leg before normalisation. */
function weights(legCount: number, distribution: ScaleOrderInput["distribution"]): number[] {
  if (distribution === "ascending") {
    return Array.from({ length: legCount }, (_, i) => i + 1);
  }
  if (distribution === "descending") {
    return Array.from({ length: legCount }, (_, i) => legCount - i);
  }
  return Array.from({ length: legCount }, () => 1);
}

/**
 * Build the ladder.
 *
 * Prices are spread inclusively between the bounds; a single-leg ladder sits at
 * `startPrice`.
 *
 * @throws {HlError} if any leg would be below the exchange's minimum notional —
 *   checked up front, since a partially-rejected ladder is far more awkward to
 *   recover from than one never sent.
 */
export function buildScaleOrder(input: ScaleOrderInput): ScaleOrderPlan {
  const { asset, legCount } = input;
  if (!Number.isInteger(legCount) || legCount < 1) {
    throw new HlError(`Scale order needs at least one leg, got ${legCount}`, {
      code: "invalid_config",
    });
  }

  const start = new BigNumber(input.startPrice);
  const end = new BigNumber(input.endPrice);
  const total = new BigNumber(input.totalSize);
  if (!start.isFinite() || !end.isFinite() || start.lte(0) || end.lte(0)) {
    throw new HlError("Scale order bounds must be positive", { code: "invalid_precision" });
  }
  if (!total.isFinite() || total.lte(0)) {
    throw new HlError("Scale order total size must be positive", { code: "invalid_precision" });
  }

  const rawWeights = weights(legCount, input.distribution);
  const weightTotal = rawWeights.reduce((sum, w) => sum + w, 0);
  const step = legCount === 1 ? new BigNumber(0) : end.minus(start).dividedBy(legCount - 1);

  let placed = new BigNumber(0);
  const legs: OrderLeg[] = [];

  for (let i = 0; i < legCount; i += 1) {
    const rawPrice = start.plus(step.multipliedBy(i));
    const p = formatPrice(rawPrice.toFixed(), priceSzDecimalsOf(asset), asset.marketType);
    const rawSize = total.multipliedBy(rawWeights[i]).dividedBy(weightTotal);
    const s = formatSize(rawSize.toFixed(), asset.szDecimals);

    if (!meetsMinNotional(p, s)) {
      throw new HlError(
        `Scale leg ${i + 1} of ${legCount} is below the ${MIN_ORDER_NOTIONAL_USDC} USDC minimum ` +
          `(${p} x ${s}); use fewer legs or a larger size`,
        { code: "invalid_config", context: { leg: i + 1, price: p, size: s } }
      );
    }

    placed = placed.plus(s);
    legs.push({
      a: asset.assetId,
      b: input.isBuy,
      p,
      s,
      r: input.reduceOnly ?? false,
      t: { limit: { tif: input.tif ?? "Gtc" } },
    });
  }

  return { legs, remainder: total.minus(placed).toFixed() };
}
