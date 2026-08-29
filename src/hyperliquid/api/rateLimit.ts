/**
 * Action budget tracking.
 *
 * Hyperliquid rate-limits **actions** (orders, cancels, transfers) per address.
 * The allowance is earned by trading volume, so a new account has a small fixed
 * budget and a heavy trader has a large one. Exhaust it and the address is
 * throttled to one request per 10 seconds — which, for a trading client, means
 * the user cannot close a position.
 *
 * Scope: this tracks the **per-address action** limit only. Info requests are
 * exempt from *that* limit, but Hyperliquid separately enforces a per-IP weight
 * budget which info polling does consume — and a mobile client behind carrier
 * NAT can share an IP with other users. Polling volume is therefore still a
 * real constraint; it is simply not the one this module models. Prefer
 * websocket subscriptions over polling regardless of what this reports.
 *
 * Two details shape this module:
 *
 * - **Cancels have their own, larger allowance** — deliberately, so open orders
 *   can always be cancelled. Cancels therefore must not draw down the same
 *   bucket as placements, or a burst of orders could make a position
 *   uncloseable.
 * - **Sub-accounts are separate users** for rate limiting, so budgets are keyed
 *   by full identity, not by wallet address.
 *
 * The reference implementation tracks none of this.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 */

import { BigNumber } from "bignumber.js";

import { OPEN_ORDER_LIMIT, RATE_LIMIT } from "@/hyperliquid/config/constants";
import { identityKey } from "@/hyperliquid/core/identity";
import type { HlIdentity } from "@/hyperliquid/types/domain";

/** Actions draw from different buckets; cancels are privileged. */
export type ActionKind = "cancel" | "other";

export interface BudgetSnapshot {
  /** Total actions this address may have made, per the volume formula. */
  limit: number;
  /** Actions already counted against the limit. */
  used: number;
  /** `limit - used`, floored at zero. */
  remaining: number;
  /** The larger allowance that applies to cancels. */
  cancelLimit: number;
  cancelRemaining: number;
  /** True when a non-cancel action would exceed the budget. */
  isThrottled: boolean;
}

/**
 * Requests earned for a given lifetime traded volume.
 *
 * `initialBuffer + floor(volume * requestsPerUsdcVolume)`.
 * BigNumber because cumulative volume exceeds safe float precision for active
 * accounts.
 */
export function limitForVolume(cumulativeVolumeUsdc: BigNumber.Value): number {
  const volume = new BigNumber(cumulativeVolumeUsdc);
  if (!volume.isFinite() || volume.lte(0)) return RATE_LIMIT.initialBuffer;
  return (
    RATE_LIMIT.initialBuffer +
    volume
      .multipliedBy(RATE_LIMIT.requestsPerUsdcVolume)
      .integerValue(BigNumber.ROUND_FLOOR)
      .toNumber()
  );
}

/** `min(limit + 100000, limit * 2)` — the documented cancel allowance. */
export function cancelLimitFor(limit: number): number {
  return Math.min(limit + RATE_LIMIT.cancelBonusFlat, limit * RATE_LIMIT.cancelBonusMultiplier);
}

/**
 * Maximum open orders: 1000, plus one per 5M USDC of volume, capped at 5000.
 *
 * Matters because **past the base limit, new reduce-only and trigger orders are
 * rejected** — which silently breaks TP/SL. Anything that fans out orders
 * (scale, grids) must check this first.
 */
export function openOrderLimitForVolume(cumulativeVolumeUsdc: BigNumber.Value): number {
  const volume = new BigNumber(cumulativeVolumeUsdc);
  const earned =
    volume.isFinite() && volume.gt(0)
      ? volume
          .multipliedBy(OPEN_ORDER_LIMIT.perUsdcVolume)
          .integerValue(BigNumber.ROUND_FLOOR)
          .toNumber()
      : 0;
  return Math.min(OPEN_ORDER_LIMIT.base + earned, OPEN_ORDER_LIMIT.hardCap);
}

/**
 * True when placing more orders would exceed the account's open-order ceiling.
 *
 * This is the *general* ceiling, which scales with volume. Reduce-only and
 * trigger orders have a stricter rule — see
 * {@link wouldRejectProtectiveOrder}.
 */
export function wouldExceedOpenOrderLimit(params: {
  currentOpenOrders: number;
  additionalOrders: number;
  cumulativeVolumeUsdc?: BigNumber.Value;
}): boolean {
  const limit = params.cumulativeVolumeUsdc
    ? openOrderLimitForVolume(params.cumulativeVolumeUsdc)
    : OPEN_ORDER_LIMIT.base;
  return params.currentOpenOrders + params.additionalOrders > limit;
}

/**
 * True when a reduce-only or trigger order would be rejected outright.
 *
 * Hyperliquid rejects these at a **flat 1000 other open orders**, regardless of
 * how much extra headroom the account has earned through volume. Using the
 * volume-scaled ceiling here would wave through a stop-loss that the exchange
 * then silently refuses — leaving a position the user believes is protected
 * with no protection at all.
 */
export function wouldRejectProtectiveOrder(currentOpenOrders: number): boolean {
  return currentOpenOrders >= OPEN_ORDER_LIMIT.base;
}

interface BudgetState {
  limit: number;
  used: number;
  cancelUsed: number;
}

/**
 * Per-identity action budgets.
 *
 * Local accounting, seeded from the server's view. It is deliberately
 * conservative: it counts optimistically at submit time rather than waiting for
 * a response, so a burst cannot slip past the check.
 */
export class ActionBudget {
  private readonly states = new Map<string, BudgetState>();

  /**
   * Seed from the server's own accounting (`userRateLimit`). Call on session
   * start and after any long gap — local counts drift, the server's do not.
   */
  seed(identity: HlIdentity, params: { limit: number; used: number }): void {
    this.states.set(identityKey(identity), {
      limit: Math.max(0, params.limit),
      used: Math.max(0, params.used),
      cancelUsed: 0,
    });
  }

  /** Seed from cumulative traded volume when `userRateLimit` is unavailable. */
  seedFromVolume(identity: HlIdentity, cumulativeVolumeUsdc: BigNumber.Value, used = 0): void {
    this.seed(identity, { limit: limitForVolume(cumulativeVolumeUsdc), used });
  }

  snapshot(identity: HlIdentity): BudgetSnapshot {
    const state = this.states.get(identityKey(identity)) ?? {
      // An unseeded identity is assumed to be new rather than unlimited —
      // guessing high here is what would get a user throttled mid-trade.
      limit: RATE_LIMIT.initialBuffer,
      used: 0,
      cancelUsed: 0,
    };
    const cancelLimit = cancelLimitFor(state.limit);
    const remaining = Math.max(0, state.limit - state.used);
    return {
      limit: state.limit,
      used: state.used,
      remaining,
      cancelLimit,
      cancelRemaining: Math.max(0, cancelLimit - state.cancelUsed),
      isThrottled: remaining <= 0,
    };
  }

  /**
   * Whether an action may proceed.
   *
   * Cancels are checked against the cancel allowance, so an exhausted placement
   * budget never blocks closing a position.
   */
  canSpend(identity: HlIdentity, kind: ActionKind, count = 1): boolean {
    const snapshot = this.snapshot(identity);
    return kind === "cancel" ? snapshot.cancelRemaining >= count : snapshot.remaining >= count;
  }

  /** Record an action. Call at submit time, not on response. */
  spend(identity: HlIdentity, kind: ActionKind, count = 1): void {
    const key = identityKey(identity);
    const state = this.states.get(key) ?? {
      limit: RATE_LIMIT.initialBuffer,
      used: 0,
      cancelUsed: 0,
    };
    if (kind === "cancel") state.cancelUsed += count;
    else state.used += count;
    this.states.set(key, state);
  }

  /**
   * How long to wait before retrying, in ms.
   *
   * Returns 0 when budget remains. Once throttled Hyperliquid permits one
   * request per 10s, so retrying sooner burns the allowance without progress —
   * backoff here is budget-aware, not merely error-driven.
   */
  retryDelayMs(identity: HlIdentity, kind: ActionKind): number {
    return this.canSpend(identity, kind) ? 0 : RATE_LIMIT.throttledIntervalMs;
  }

  /** Drop an identity's accounting, e.g. on sign-out. */
  forget(identity: HlIdentity): void {
    this.states.delete(identityKey(identity));
  }

  clear(): void {
    this.states.clear();
  }
}

/** Process-wide budget. Tests construct their own `ActionBudget`. */
export const actionBudget = new ActionBudget();
