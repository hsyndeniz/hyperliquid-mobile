/**
 * Hyperliquid protocol constants.
 *
 * Only values that are genuinely fixed by the protocol belong here. Anything
 * operator-configurable (builder address, referral code, network) comes from
 * `@/hyperliquid/config/env` instead.
 */

import type { Hex } from "@/hyperliquid/types/domain";

// ---------------------------------------------------------------------------
// Tick and lot sizes
// ---------------------------------------------------------------------------

/**
 * Price/size precision ceilings from HL's tick & lot size rules.
 *
 * The SDK's `formatPrice` / `formatSize` already enforce these — these
 * constants exist for the derived helpers the SDK does not provide (tick grid
 * snapping, input validation), which need the raw numbers.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
 */
export const MAX_DECIMALS_PERP = 6;
export const MAX_DECIMALS_SPOT = 8;
export const MAX_SIGNIFICANT_FIGURES = 5;
export const MAX_PRICE_INTEGER_DIGITS = 12;

// ---------------------------------------------------------------------------
// Agent (API wallet) lifecycle
// ---------------------------------------------------------------------------

/** Zero address — used to revoke an agent via `approveAgent`. */
export const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

/**
 * Rotate an agent once it is within this window of expiry, rather than waiting
 * for it to lapse mid-session and interrupt a trade with a signing prompt.
 *
 * Note: `approveAgent` takes **no expiry parameter**. Expiry is reported back by
 * `extraAgents` as `validUntil`, which may be `null` (never expires). So this is
 * a threshold applied to whatever the server reports — not a TTL we choose. Any
 * client-side TTL constant would be fiction.
 */
export const AGENT_ROTATION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 1 day

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Action-rate-limit facts. These govern *actions* only; info requests are
 * exempt. Sub-accounts are treated as separate users, which is why the budget
 * is keyed by full identity.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 */
export const RATE_LIMIT = {
  /** Requests granted to a brand-new address before any volume is traded. */
  initialBuffer: 10_000,
  /** Additional requests earned per 1 USDC of cumulative traded volume. */
  requestsPerUsdcVolume: 1,
  /** Once limited, HL permits only one request per this interval. */
  throttledIntervalMs: 10_000,
  /** Cancels get their own, larger allowance: min(limit + flat, limit * mult). */
  cancelBonusFlat: 100_000,
  cancelBonusMultiplier: 2,
} as const;

/**
 * Open-order ceilings. Past `baseMax`, new reduce-only and trigger orders are
 * **rejected** — which silently breaks TP/SL — so anything that fans out orders
 * must count against this.
 */
export const OPEN_ORDER_LIMIT = {
  base: 1_000,
  perUsdcVolume: 1 / 5_000_000,
  hardCap: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Deposits / withdrawals
// ---------------------------------------------------------------------------

/**
 * The flat fee HL charges on `withdraw3`.
 *
 * A **string**, because it is arithmetic on a signed amount and nothing in a
 * money path may become a float.
 *
 * **Deducted FROM the signed amount, not added to it.** Sign `X`, HL debits `X`,
 * and `X - 1` arrives on Arbitrum. Verified on 8 matched signed-action/ledger
 * pairs across both networks — the difference was exactly 1.000000 every time —
 * and across 1,517 mainnet plus 28 testnet `withdraw` ledger deltas, whose set
 * of distinct fee values is exactly `["1.0"]`.
 *
 * The direction matters at the extremes: a "max" button that pre-subtracts the
 * fee strands 1 USDC in the account forever, and one that adds it overdraws and
 * is rejected every time.
 */
export const WITHDRAW_FEE_USDC = "1";

/**
 * A **UI floor only — not a protocol rule.**
 *
 * No minimum withdrawal is documented and none was ever observed: 2.2 succeeded
 * live on testnet and 3.76 on mainnet. The only amount-related rejection seen in
 * the wild is "Withdrawal amount cannot be zero."
 *
 * The real protocol floor is `amount > WITHDRAW_FEE_USDC`, so that the net is
 * positive. This constant exists to stop a user withdrawing 1.01 and receiving
 * a cent; it must never be presented as an exchange rule.
 */
export const MIN_WITHDRAW_USDC_UI_FLOOR = "2";

/**
 * ASSUMPTION (documentation only, never verified): below this a bridge deposit
 * is not credited. Deposit is out of Phase 7 scope — this is kept for the
 * eventual deposit flow and must be confirmed before that ships.
 */
export const MIN_DEPOSIT_USDC = "5";

/**
 * Observed timing envelope for a withdrawal, from signature to arrival.
 *
 * Population: 989 mainnet and 28 testnet withdrawals. These are measurements,
 * not guarantees — but a withdrawal has no cancel and no status endpoint, so
 * the only honest thing a client can show is a measured expectation.
 */
/**
 * Which balance `withdraw3` debits: **PERP. Measured, no longer an assumption.**
 *
 * Phase 7 could not settle this — a testnet withdrawal was refused with
 * `"Error withdrawing from bridge"` and both balances were unchanged, so the
 * conclusion at the time was that testnet withdrawal never completes and only
 * mainnet could answer it.
 *
 * That is now out of date. A withdrawal signed during the end-to-end suite went
 * through: perp `accountValue` moved **6.0 -> 4.0** while spot stayed at 14.0,
 * and the ledger row confirmed `{type:"withdraw", usdc:"1.0", fee:"1.0"}` — the
 * gross leaves the perp balance and the fee is deducted from it, exactly as the
 * signing convention says.
 *
 * Kept under its original name so nothing silently changes behaviour; only the
 * evidence behind it changed.
 */
export const WITHDRAW_SOURCE_POT = "perpWithdrawable" as const;

/** @deprecated Renamed to {@link WITHDRAW_SOURCE_POT} — it is no longer unverified. */
export const WITHDRAW_SOURCE_POT_UNVERIFIED = WITHDRAW_SOURCE_POT;

export const WITHDRAW_TIMINGS = {
  /** The L1 explorer row appears this fast (observed 1.0-8.9 s). */
  onChainVisibleMs: 10_000,
  /** Median ledger settlement (mainnet p50 236.8 s). What the UI should promise. */
  expectedArrivalMs: 240_000,
  /**
   * Observed maxima: 530.8 s mainnet, 738.7 s testnet.
   *
   * Nothing may be called failed before this, and — decisively — **no second
   * withdrawal may be signed before it.** There is no idempotency key, so a
   * retry inside this window produces a second, equally final withdrawal.
   */
  settlementFloorMs: 900_000,
} as const;
