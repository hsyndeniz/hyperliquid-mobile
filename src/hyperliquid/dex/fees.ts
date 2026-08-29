/**
 * Per-dex fee scaling.
 *
 * Pure arithmetic on verified constants. The published `userFees` rates are
 * **global** — the endpoint has no `dex` parameter and returns byte-identical
 * data whatever you pass it — so every per-dex adjustment has to happen here,
 * client-side.
 *
 * The formula, verified against 489 live HIP-3 fills with zero misses:
 *
 *     rate = base × (1 − referralDiscount) × protoMult × (1 + deployerFeeScale)
 *
 * with two carve-outs that are easy to miss and expensive to get wrong:
 *
 * 1. **`deployerFeeScale` is per-dex, not a constant.** An earlier probe sampled
 *    only dex `xyz` (scale 1.0), where the expression collapses to exactly 2×,
 *    and generalised from it. On `hyna` (scale 0.1111) the real multiplier is
 *    1.1111 — hard-coding 2.0 overstates that dex's taker fees by 80%.
 * 2. **A maker rebate gets `protoMult` alone**, with no deployer add-on. A
 *    negative rate scaled by `(1 + deployerFeeScale)` would overstate the rebate.
 *
 * `activeStakingDiscount` is **already baked into** the published rate and must
 * not be applied again; `activeReferralDiscount` is **not**, and must be.
 */

import { BigNumber } from "bignumber.js";

/** `"enabled"` or absent — never a boolean, never `"disabled"`. */
export type GrowthMode = "enabled" | undefined;

/** A growth-mode asset is charged a tenth of the protocol rate. */
const GROWTH_MODE_MULTIPLIER = "0.1";

export interface FeeInputs {
  /** `userCrossRate` (taker) or `userAddRate` (maker). Signed: negative is a rebate. */
  baseRate: string;
  /** `activeReferralDiscount`. NOT already applied to `baseRate`. */
  referralDiscount: string;
  /**
   * `perpDexs()[i].deployerFeeScale` for the asset's dex, or `null` for the main
   * dex — where no deployer add-on exists at all.
   */
  deployerFeeScale: string | null;
  /** `meta({dex}).universe[i].growthMode`. */
  growthMode: GrowthMode;
}

/**
 * The rate this user actually pays on this asset.
 *
 * Returns a signed decimal string: negative means a rebate.
 */
export function effectiveFeeRate(inputs: FeeInputs): string {
  const base = new BigNumber(inputs.baseRate);
  // The referral discount applies to the published rate; the staking discount is
  // already inside it and applying it again understates by up to 40%.
  const discounted = base.multipliedBy(new BigNumber(1).minus(inputs.referralDiscount));

  const protoMult =
    inputs.growthMode === "enabled" ? new BigNumber(GROWTH_MODE_MULTIPLIER) : new BigNumber(1);
  const withProto = discounted.multipliedBy(protoMult);

  // Main dex: no deployer, no add-on.
  if (inputs.deployerFeeScale === null) return withProto.toFixed();

  // A rebate is not scaled by the deployer's share — the deployer takes a cut of
  // a fee, and there is no fee to cut when the user is being paid.
  if (base.isNegative()) return withProto.toFixed();

  return withProto.multipliedBy(new BigNumber(1).plus(inputs.deployerFeeScale)).toFixed();
}

/**
 * The multiplier alone, for showing "this dex charges 2× the base rate".
 *
 * Separate from `effectiveFeeRate` because a UI that wants to explain the
 * difference needs the factor, and recomputing it by division would divide by
 * zero on a zero base rate.
 */
export function feeMultiplier(params: {
  deployerFeeScale: string | null;
  growthMode: GrowthMode;
  isRebate?: boolean;
}): string {
  const proto =
    params.growthMode === "enabled" ? new BigNumber(GROWTH_MODE_MULTIPLIER) : new BigNumber(1);
  if (params.deployerFeeScale === null || params.isRebate) return proto.toFixed();
  return proto.multipliedBy(new BigNumber(1).plus(params.deployerFeeScale)).toFixed();
}

/**
 * Split a fully-qualified coin into its dex and asset parts.
 *
 * `meta({dex}).universe[].name` is **already qualified** — `"hyna:BTC"`, never
 * a bare `"BTC"` — and the same string is used for info requests, event echoes
 * and websocket subscriptions alike. Unlike spot, there is no separate
 * subscription form.
 */
export function splitCoin(coin: string): { dex: string | null; asset: string } {
  const separator = coin.indexOf(":");
  if (separator === -1) return { dex: null, asset: coin };
  return { dex: coin.slice(0, separator), asset: coin.slice(separator + 1) };
}

/** True when the coin belongs to a HIP-3 builder dex rather than the main one. */
export function isBuilderDexCoin(coin: string): boolean {
  return coin.includes(":");
}
