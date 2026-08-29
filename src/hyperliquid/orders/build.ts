/**
 * Order construction.
 *
 * Every order leg is built here so the exchange's silent-corruption hazards are
 * impossible to hit by hand:
 *
 * - **Unknown keys are silently stripped**, not rejected. Writing `cloid:`
 *   instead of `c:`, or `reduceOnly:` instead of `r:`, produces a *valid* order
 *   with no client id and no reduce-only flag. Legs are therefore only ever
 *   constructed by the builders below, never spread together ad hoc.
 * - **The `t` union picks the first structurally valid variant.** An object
 *   carrying both `limit` and `trigger` silently becomes one of them — a TP/SL
 *   downgraded to a plain limit order. The builders emit exactly one variant.
 * - **Exponential notation is rejected by the wire schema** (`1e-7` fails), so
 *   prices and sizes leave here as already-formatted decimal strings.
 *
 * Nothing here talks to the network; it is pure and fully testable.
 */

import { BigNumber } from "bignumber.js";

import type { HlConfig } from "@/hyperliquid/config/env";
import { HlError } from "@/hyperliquid/core/errors";
import { formatPrice, formatSize, snapPriceToGrid } from "@/hyperliquid/core/precision";
import type { MarketType } from "@/hyperliquid/types/domain";
import type { Cloid } from "@/hyperliquid/orders/cloid";

/** User-selectable time-in-force. */
export type Tif = "Gtc" | "Ioc" | "Alo";

/**
 * A single order leg, in the exact wire shape.
 *
 * Field names are the terse wire ones deliberately — they are what the schema
 * accepts, and anything else is dropped without complaint.
 */
export interface OrderLeg {
  /** Asset id. */
  a: number;
  /** True = buy/long. */
  b: boolean;
  /** Limit price. Must be > 0. */
  p: string;
  /** Size in base units. May be `"0"` only for a position-scaled TP/SL leg. */
  s: string;
  /** Reduce-only. */
  r: boolean;
  /** Exactly one of `limit` or `trigger` — never both. */
  t:
    | { limit: { tif: Tif } }
    | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  /** Client order id. */
  c?: Cloid;
}

export type Grouping = "na" | "normalTpsl" | "positionTpsl";

export interface BuilderFee {
  b: string;
  f: number;
}

/**
 * Hyperliquid's minimum order value, in USDC of notional.
 *
 * Enforced **server-side only** — nothing in the SDK checks it. Worth checking
 * locally because a rejected order still costs an action from the rate-limit
 * budget, and the budget is earned by traded volume.
 */
export const MIN_ORDER_NOTIONAL_USDC = 10;

/** Builder-fee ceilings, in tenths of a basis point (1 = 0.001%). */
const MAX_BUILDER_FEE = { perp: 100, spot: 1000 } as const;

/** Default slippage for a market order. */
export const DEFAULT_SLIPPAGE = 0.08;

export interface AssetSpec {
  assetId: number;
  /** Size precision. For an outcome market this is 0 — sizes are whole shares. */
  szDecimals: number;
  /**
   * The szDecimals value to use when formatting a PRICE, when it differs.
   *
   * Normally it does not, and this stays undefined. **Outcome markets are the
   * exception and the reason this field exists**: their prices carry 5 decimals
   * (perp rule `6 - szDecimals`, so 1) while their sizes are whole shares (0). No
   * single number describes both, and the SDK's hard-coded 5 satisfies neither —
   * `formatPrice("0.99283", 5, "perp")` returns `"0.9"`, a 9.3% error, silently.
   *
   * Read it through {@link priceSzDecimalsOf}, never directly, so a new call site
   * cannot forget the fallback.
   */
  priceSzDecimals?: number;
  /**
   * Perp vs spot decimal ceiling.
   *
   * Must come from resolved metadata, **never inferred from the asset id**:
   * builder-DEX perps start at 100000 and outcome markets at 100000000, so an
   * `id >= 10000` test would misclassify both as spot and use the wrong
   * decimal cap.
   */
  marketType: MarketType;
}

/**
 * The szDecimals a price must be formatted with.
 *
 * Falls back to the size precision, which is correct for every market except an
 * outcome market. Exists so the fallback lives in one place.
 */
export function priceSzDecimalsOf(asset: AssetSpec): number {
  return asset.priceSzDecimals ?? asset.szDecimals;
}

function assertPositivePrice(price: string, context: Record<string, unknown>) {
  if (new BigNumber(price).lte(0)) {
    throw new HlError(`Order price must be greater than zero, got ${price}`, {
      code: "invalid_precision",
      context,
    });
  }
}

/**
 * Notional value of a leg, for the minimum-order check.
 */
export function notionalOf(price: string, size: string): BigNumber {
  return new BigNumber(price).multipliedBy(size);
}

/**
 * Whether a leg clears Hyperliquid's $10 minimum.
 *
 * A zero-size leg is exempt: that is the legal encoding of a position-scaled
 * TP/SL, which carries no notional of its own.
 */
export function meetsMinNotional(price: string, size: string): boolean {
  if (new BigNumber(size).isZero()) return true;
  return notionalOf(price, size).gte(MIN_ORDER_NOTIONAL_USDC);
}

export function assertMinNotional(price: string, size: string): void {
  if (!meetsMinNotional(price, size)) {
    throw new HlError(
      `Order notional ${notionalOf(price, size).toFixed()} is below the ${MIN_ORDER_NOTIONAL_USDC} USDC minimum`,
      { code: "invalid_config", context: { price, size } }
    );
  }
}

/**
 * The limit price that expresses a market order.
 *
 * Hyperliquid has no market order type: a market order is an IOC limit priced
 * far enough through the book to fill. Buys are adjusted up, sells down.
 *
 * The arithmetic happens **before** formatting, and the result is formatted
 * with the asset's real `szDecimals` — formatting first would round to a tick
 * and then move off it again.
 */
export function marketLimitPrice(params: {
  referencePrice: BigNumber.Value;
  isBuy: boolean;
  asset: AssetSpec;
  /** Fraction, e.g. 0.08 for 8%. Defaults to {@link DEFAULT_SLIPPAGE}. */
  slippage?: number;
}): string {
  // `??` not `||`: an explicit slippage of 0 is meaningful and must not fall
  // back to the default — a bug the reference implementation has.
  const slippage = params.slippage ?? DEFAULT_SLIPPAGE;
  if (!Number.isFinite(slippage) || slippage < 0) {
    throw new HlError(`Slippage must be a non-negative number, got ${slippage}`, {
      code: "invalid_config",
    });
  }
  const reference = new BigNumber(params.referencePrice);
  if (!reference.isFinite() || reference.lte(0)) {
    throw new HlError(`Reference price must be positive, got ${String(params.referencePrice)}`, {
      code: "invalid_precision",
    });
  }
  // `1 ± slippage` in BigNumber, not in floats. `1 - 0.07` is
  // 0.9299999999999999 in IEEE-754, and multiplying a reference price by that
  // yields a wire price one tick off what the user asked for — 92.9 instead of
  // 93 at szDecimals 5. The error is silent: the order rests at the wrong price.
  const one = new BigNumber(1);
  const multiplier = params.isBuy ? one.plus(slippage) : one.minus(slippage);
  const adjusted = reference.multipliedBy(multiplier);
  return formatPrice(adjusted.toFixed(), priceSzDecimalsOf(params.asset), params.asset.marketType);
}

export interface LimitOrderInput {
  asset: AssetSpec;
  isBuy: boolean;
  price: BigNumber.Value;
  size: BigNumber.Value;
  tif?: Tif;
  reduceOnly?: boolean;
  cloid?: Cloid;
}

/** A plain limit order. */
export function buildLimitOrder(input: LimitOrderInput): OrderLeg {
  const p = formatPrice(
    new BigNumber(input.price).toFixed(),
    priceSzDecimalsOf(input.asset),
    input.asset.marketType
  );
  const s = formatSize(new BigNumber(input.size).toFixed(), input.asset.szDecimals);
  assertPositivePrice(p, { asset: input.asset.assetId });

  return {
    a: input.asset.assetId,
    b: input.isBuy,
    p,
    s,
    r: input.reduceOnly ?? false,
    t: { limit: { tif: input.tif ?? "Gtc" } },
    ...(input.cloid ? { c: input.cloid } : {}),
  };
}

export interface MarketOrderInput {
  asset: AssetSpec;
  isBuy: boolean;
  size: BigNumber.Value;
  /** Mid or mark price to slip from. */
  referencePrice: BigNumber.Value;
  slippage?: number;
  reduceOnly?: boolean;
  cloid?: Cloid;
}

/**
 * A market order — an IOC limit at a slipped price.
 *
 * `tif` is `Ioc`, never `FrontendMarket`: that value exists on the wire purely
 * as a label and must not be surfaced as a user-selectable option.
 */
export function buildMarketOrder(input: MarketOrderInput): OrderLeg {
  const p = marketLimitPrice({
    referencePrice: input.referencePrice,
    isBuy: input.isBuy,
    asset: input.asset,
    slippage: input.slippage,
  });
  const s = formatSize(new BigNumber(input.size).toFixed(), input.asset.szDecimals);
  assertPositivePrice(p, { asset: input.asset.assetId });

  return {
    a: input.asset.assetId,
    b: input.isBuy,
    p,
    s,
    r: input.reduceOnly ?? false,
    t: { limit: { tif: "Ioc" } },
    ...(input.cloid ? { c: input.cloid } : {}),
  };
}

/**
 * Snap a trigger price so it fires **no later** than the user asked.
 *
 * `formatPrice` truncates toward zero unconditionally. For a stop-loss on a
 * long — a sell trigger below the market — truncating moves the stop *further
 * away*, so it fires later and at a worse price than the user chose.
 *
 * The safe direction depends on which way the mark must travel to reach the
 * trigger, and that depends on **both** the side and whether it is a stop or a
 * take-profit — a stop sits against the position, a take-profit with it, so at
 * the same side they are exact inverses:
 *
 * | tpsl | side          | Trigger sits | Mark travels | Safe rounding |
 * | ---- | ------------- | ------------ | ------------ | ------------- |
 * | sl   | sell (long)   | below        | down         | **up**        |
 * | sl   | buy  (short)  | above        | up           | **down**      |
 * | tp   | sell (long)   | above        | up           | **down**      |
 * | tp   | buy  (short)  | below        | down         | **up**        |
 *
 * Snapping to the tick grid first keeps the value on-grid, so the subsequent
 * `formatPrice` is a no-op rather than a second, undirected truncation.
 */
export function snapTriggerPrice(
  triggerPrice: BigNumber.Value,
  isBuy: boolean,
  asset: AssetSpec,
  tpsl: "tp" | "sl"
): string {
  const marketTravelsDown = tpsl === "sl" ? !isBuy : isBuy;
  const direction = marketTravelsDown ? "up" : "down";
  const snapped = snapPriceToGrid(
    new BigNumber(triggerPrice).toFixed(),
    direction,
    // `priceSzDecimalsOf`, not `asset.szDecimals`. The grid snapped to and the
    // precision formatted at have to be the SAME, or the docstring's promise
    // that the following `formatPrice` is a no-op is false — it becomes a
    // second, UNDIRECTED truncation that can walk the price back across the
    // trigger. Measured on an outcome spec: `snapTriggerPrice("0.0123456",
    // isBuy=false, sl)` returned "0.01234", i.e. a long's stop moved further
    // away, the exact failure this directional snap exists to prevent.
    priceSzDecimalsOf(asset),
    asset.marketType
  );
  const value = snapped ?? new BigNumber(triggerPrice);
  return formatPrice(value.toFixed(), priceSzDecimalsOf(asset), asset.marketType);
}

export interface TriggerOrderInput {
  asset: AssetSpec;
  isBuy: boolean;
  /** Price that fires the order. */
  triggerPrice: BigNumber.Value;
  /**
   * Price the triggered order rests at. Ignored when `isMarket` is true, where
   * a slipped price is derived from the trigger instead.
   */
  limitPrice?: BigNumber.Value;
  /** True = the triggered order executes at market. */
  isMarket: boolean;
  tpsl: "tp" | "sl";
  /** `"0"` is legal here and means "track the whole position". */
  size: BigNumber.Value;
  slippage?: number;
  reduceOnly?: boolean;
  cloid?: Cloid;
}

/**
 * A trigger (take-profit / stop-loss) order.
 *
 * `p` and `triggerPx` are independent: the trigger fires the order, `p` is
 * where it rests. Note trigger orders carry **no tif** — emitting one would
 * push the object into the `limit` branch of the union and silently downgrade
 * the order.
 */
export function buildTriggerOrder(input: TriggerOrderInput): OrderLeg {
  const { szDecimals, marketType } = input.asset;
  const triggerPx = snapTriggerPrice(input.triggerPrice, input.isBuy, input.asset, input.tpsl);
  assertPositivePrice(triggerPx, { asset: input.asset.assetId, field: "triggerPx" });

  const p = input.isMarket
    ? marketLimitPrice({
        referencePrice: triggerPx,
        isBuy: input.isBuy,
        asset: input.asset,
        slippage: input.slippage,
      })
    : formatPrice(
        new BigNumber(input.limitPrice ?? input.triggerPrice).toFixed(),
        // Through the accessor, per its own contract: "read it through
        // `priceSzDecimalsOf`, never directly, so a new call site cannot
        // forget the fallback". `marketLimitPrice`, `buildLimitOrder` and the
        // isMarket branch all honour it; these two reads did not, which made
        // this internal inconsistency rather than a documented exception.
        priceSzDecimalsOf(input.asset),
        marketType
      );
  assertPositivePrice(p, { asset: input.asset.assetId, field: "p" });

  // Size zero is the legal encoding for a position-scaled TP/SL, and would be
  // rejected by formatSize, so it bypasses formatting entirely.
  const s = new BigNumber(input.size).isZero()
    ? "0"
    : formatSize(new BigNumber(input.size).toFixed(), szDecimals);

  return {
    a: input.asset.assetId,
    b: input.isBuy,
    p,
    s,
    r: input.reduceOnly ?? false,
    t: { trigger: { isMarket: input.isMarket, triggerPx, tpsl: input.tpsl } },
    ...(input.cloid ? { c: input.cloid } : {}),
  };
}

/**
 * The action-level builder-fee object, or `undefined` when disabled.
 *
 * Returns `undefined` rather than `null`: the field is optional and `null` is a
 * hard validation error.
 *
 * The fee is **per request**, not per order — one builder applies to the whole
 * batch. The schema's own ceiling is the spot limit of 1000, so the tighter
 * perp ceiling of 100 is enforced here.
 */
export function buildBuilderFee(
  config: Pick<HlConfig, "builderAddress" | "maxBuilderFee">,
  marketType: MarketType
): BuilderFee | undefined {
  if (!config.builderAddress) return undefined;

  const ceiling = MAX_BUILDER_FEE[marketType];
  if (config.maxBuilderFee > ceiling) {
    throw new HlError(
      `Builder fee ${config.maxBuilderFee} exceeds the ${marketType} ceiling of ${ceiling} (tenths of a basis point)`,
      { code: "invalid_config", context: { marketType, ceiling } }
    );
  }
  if (!Number.isInteger(config.maxBuilderFee) || config.maxBuilderFee < 0) {
    throw new HlError(`Builder fee must be a non-negative integer, got ${config.maxBuilderFee}`, {
      code: "invalid_config",
    });
  }
  return { b: config.builderAddress, f: config.maxBuilderFee };
}
