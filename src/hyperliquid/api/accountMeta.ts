/**
 * Account metadata: fees, limits, dex validation, funding and portfolio history.
 *
 * Read-only reporting data. Nothing in the trading path depends on it, with one
 * exception — `fetchPerpDexes` + `isKnownDex` are what validate `identity.dex` *before* a
 * subscription is opened, and that guard is load-bearing: a real-but-wrong dex
 * answers HTTP 200 with a fully-formed empty account, so a user holding live
 * positions sees a calm "no positions" screen. The store's echo check is a
 * backstop; this is the prevention.
 *
 * Everything goes through the per-IP weight budget and returns `deferred`
 * rather than throwing, as `api/account.ts` does.
 */

import { BigNumber } from "bignumber.js";

import { log } from "@/hyperliquid/core/logger";
import { toBigNumber } from "@/hyperliquid/core/precision";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";

const logger = log.child("api.accountMeta");

export interface MetaProbe {
  userFees(params: { user: string }): Promise<unknown>;
  userFunding(params: { user: string; startTime: number; endTime?: number }): Promise<unknown>;
  portfolio(params: { user: string }): Promise<unknown>;
  userRateLimit(params: { user: string }): Promise<unknown>;
  perpDexs(): Promise<unknown>;
  marginTable(params: { id: number }): Promise<unknown>;
  delegatorSummary(params: { user: string }): Promise<unknown>;
}

export interface MetaResult<T> {
  value: T | null;
  deferred: boolean;
}

function deferred<T>(): MetaResult<T> {
  return { value: null, deferred: true };
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

/** One volume-stepped fee tier, as `feeSchedule.tiers.vip` publishes it. */
export interface VipFeeTier {
  /** 14-day volume required to enter this tier, as a wire string ("5000000.0"). */
  ntlCutoff: string;
  /** Perps taker rate at this tier. */
  cross: string;
  /** Perps maker rate at this tier. */
  add: string;
  spotCross: string;
  spotAdd: string;
}

export interface UserFeeRates {
  /** wire `userCrossRate` — the published taker rate, **before** any referral discount. */
  crossRate: string;
  /** wire `userAddRate` — maker. Negative on a rebate tier. */
  addRate: string;
  /** wire `activeReferralDiscount`, as a fraction (0.04 = 4%). */
  referralDiscount: string;
  /**
   * Whether `referralDiscount` is actually charged.
   *
   * `false` on a sub-account: Hyperliquid's docs state that sub-accounts share
   * the master's fee *tier* but that "referral discounts do not apply to
   * sub-accounts". Reported separately from a zeroed discount so a fee sheet can
   * say *why* the number is not being applied.
   */
  referralApplies: boolean;
  /** wire `activeStakingDiscount.discount`. Reported for display only — see below. */
  stakingDiscount: string;
  /** wire `userSpotCrossRate` — spot taker. */
  spotCrossRate: string;
  /** wire `userSpotAddRate` — spot maker. */
  spotAddRate: string;
  /**
   * The user's own volume over the `dailyUserVlm` window (14–15 daily rows),
   * as a BigNumber sum of `userCross + userAdd` per day.
   *
   * The wire's `exchange` column is the WHOLE exchange's volume that day and
   * must never be summed in — on this account it was ~5M/day against a user
   * volume of 0, so the mistake is off by six orders of magnitude and looks
   * plausible on a busy account.
   */
  volume14d: string;
  /**
   * Volume-stepped VIP tiers from `feeSchedule.tiers.vip`, sorted by cutoff
   * ascending. Empty when the wire omits the schedule. The `mm` (maker-share)
   * tiers are deliberately NOT parsed: their cutoff is a fraction of exchange
   * maker volume, a number this account cannot know its own share of.
   */
  tiers: readonly VipFeeTier[];
  /**
   * `crossRate × (1 − referralDiscount)` — what a referred user is actually charged.
   *
   * Measured against real mainnet fills: on two referred accounts the published
   * `crossRate` overstated the charge by exactly 4.17% and this expression
   * matched to the precision of the data (4.5e-4 published, 4.32e-4 charged).
   *
   * The staking discount is **not** applied here: an account with a 0.1 staking
   * discount was charged exactly its published `crossRate`, so that one is
   * already baked in and applying it again would understate by 10%.
   *
   * On a **sub-account** the referral factor is dropped entirely — see
   * `referralApplies`.
   *
   * Caveat, stated because it is not fully settled: a third referred account's
   * fill history matched the *undiscounted* rate. Referral status and tier both
   * change over time, so historical fills cannot definitively validate a
   * present-day rate. Both figures are exposed; a surface showing a single
   * number should show this one and label it an estimate.
   */
  effectiveTakerRate: string;
}

/**
 * Fee rates for the current account.
 *
 * **Forward-looking only.** Rates step discretely as the 14-day volume window
 * rolls — two of eight sampled mainnet accounts were being charged a rate 11–12%
 * away from their published one. For a "fees paid" total, sum the `fee` field on
 * the fills themselves; never multiply historical fills by today's rate.
 *
 * There is deliberately no `dex` parameter: the endpoint accepts one and ignores
 * it, so a per-dex call would return 200 and be silently wrong.
 */
export async function fetchUserFees(params: {
  probe: MetaProbe;
  user: string;
  /**
   * Set when `user` is a sub-account, which never receives a referral discount.
   *
   * Applied client-side rather than trusted from the wire. The evidence is
   * partial and worth stating: Hyperliquid documents the rule, and the one live
   * master/sub pair reachable for comparison reported `activeReferralDiscount:
   * "0.0"` on both — consistent with the endpoint already zeroing it, but not
   * proof, since that master had no referral discount to begin with. No pair
   * with a non-zero master discount could be found to settle it. Zeroing here is
   * therefore either the fix or a no-op, and never wrong in the direction that
   * matters: it will not understate a fee.
   */
  isSubAccount?: boolean;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<MetaResult<UserFeeRates>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun("userFees", () => params.probe.userFees({ user: params.user }), {
    now: () => now,
  });
  if (raw === null) return deferred();

  const source = raw as Record<string, unknown>;
  const crossRate = asAmount(source.userCrossRate, "0");
  const referralDiscount = asAmount(source.activeReferralDiscount, "0");
  // Always an object, on every account including never-funded ones — a null
  // check would never take the zero path.
  const staking = source.activeStakingDiscount as { discount?: unknown } | undefined;

  const referralApplies = params.isSubAccount !== true;

  return {
    value: {
      crossRate,
      addRate: asAmount(source.userAddRate, "0"),
      spotCrossRate: asAmount(source.userSpotCrossRate, "0"),
      spotAddRate: asAmount(source.userSpotAddRate, "0"),
      volume14d: sumDailyUserVolume(source.dailyUserVlm),
      tiers: parseVipTiers(source.feeSchedule),
      referralDiscount,
      referralApplies,
      stakingDiscount: asAmount(staking?.discount, "0"),
      effectiveTakerRate: referralApplies
        ? new BigNumber(crossRate).times(new BigNumber(1).minus(referralDiscount)).toFixed()
        : crossRate,
    },
    deferred: false,
  };
}

/**
 * Parse `feeSchedule.tiers.vip`, defensively and sorted by cutoff ascending.
 *
 * Exported for tests. A row without a string `ntlCutoff` is dropped whole —
 * a tier whose threshold is unknown cannot be placed on the ladder, and
 * guessing its position would mis-state the next tier's requirement.
 */
export function parseVipTiers(feeSchedule: unknown): VipFeeTier[] {
  const vip = ((feeSchedule ?? {}) as { tiers?: { vip?: unknown } }).tiers?.vip;
  if (!Array.isArray(vip)) return [];
  const parsed: VipFeeTier[] = [];
  for (const entry of vip) {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (typeof row.ntlCutoff !== "string") continue;
    if (!toBigNumber(row.ntlCutoff).isFinite()) continue;
    parsed.push({
      ntlCutoff: row.ntlCutoff,
      cross: asAmount(row.cross, "0"),
      add: asAmount(row.add, "0"),
      spotCross: asAmount(row.spotCross, "0"),
      spotAdd: asAmount(row.spotAdd, "0"),
    });
  }
  return parsed.sort((a, b) => toBigNumber(a.ntlCutoff).comparedTo(toBigNumber(b.ntlCutoff)) ?? 0);
}

/**
 * The user's own volume across the `dailyUserVlm` window.
 *
 * `userCross + userAdd` only — the `exchange` column is everyone's volume and
 * summing it in would be off by orders of magnitude. Malformed rows contribute
 * zero rather than poisoning the total with NaN.
 */
export function sumDailyUserVolume(raw: unknown): string {
  if (!Array.isArray(raw)) return "0";
  let total = new BigNumber(0);
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>;
    // `toBigNumber`, never the constructor: bignumber.js v11 THROWS on "abc",
    // and one malformed wire row must cost its own value, not the whole sum.
    const cross = toBigNumber(asAmount(row.userCross, "0"));
    const add = toBigNumber(asAmount(row.userAdd, "0"));
    if (cross.isFinite()) total = total.plus(cross);
    if (add.isFinite()) total = total.plus(add);
  }
  return total.toFixed();
}

/**
 * Realised fees from fills, in USDC only.
 *
 * Grouped by token because `feeToken` is not always USDC — 15 distinct tokens
 * were observed, so a blind sum adds token quantities to dollars. Rebates stay
 * negative, and the builder fee is separated out because it is an absolute
 * amount in `feeToken` units, not a rate, and is not a protocol fee.
 */
export function totalFeesPaid(
  fills: readonly { fee: string; feeToken: string; builderFee: string | null }[]
): { byToken: Map<string, string>; usdcProtocolFees: string; usdcBuilderFees: string } {
  const byToken = new Map<string, BigNumber>();
  let protocol = new BigNumber(0);
  let builder = new BigNumber(0);

  for (const fill of fills) {
    byToken.set(fill.feeToken, (byToken.get(fill.feeToken) ?? new BigNumber(0)).plus(fill.fee));
    if (fill.feeToken !== "USDC") continue;
    const builderFee = new BigNumber(fill.builderFee ?? 0);
    protocol = protocol.plus(new BigNumber(fill.fee).minus(builderFee));
    builder = builder.plus(builderFee);
  }

  return {
    byToken: new Map([...byToken].map(([token, total]) => [token, total.toFixed()])),
    usdcProtocolFees: protocol.toFixed(),
    usdcBuilderFees: builder.toFixed(),
  };
}

// ---------------------------------------------------------------------------
// Dex validation
// ---------------------------------------------------------------------------

export interface PerpDexInfo {
  /** `null` is the main dex — `perpDexs()[0]` is literally null on both networks. */
  name: string | null;
  fullName: string | null;
}

/**
 * The builder DEXs this network exposes.
 *
 * Call before building subscription targets. A dex name that exists but is not
 * the user's returns a well-formed empty account; a name that does not exist at
 * all returns a 500 — so the dangerous case is precisely the one that looks
 * valid, and only an allow-list distinguishes them.
 *
 * Testnet exposed 245 dexs against mainnet's 10, so this is not a short list to
 * hard-code.
 */
export async function fetchPerpDexes(params: {
  probe: MetaProbe;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<MetaResult<PerpDexInfo[]>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun("perpDexs", () => params.probe.perpDexs(), { now: () => now });
  if (raw === null) return deferred();
  if (!Array.isArray(raw)) return { value: [], deferred: false };

  return {
    value: raw.map((entry) => {
      if (entry === null || typeof entry !== "object") return { name: null, fullName: null };
      const record = entry as Record<string, unknown>;
      return {
        name: typeof record.name === "string" ? record.name : null,
        // `fullName`, not `full_name` — verified against both networks. The
        // snake_case spelling reads as `undefined` and lands here as null for
        // every dex, forever, with no error anywhere.
        fullName: typeof record.fullName === "string" ? record.fullName : null,
      };
    }),
    deferred: false,
  };
}

/**
 * Whether a dex is one this network actually serves.
 *
 * `""` and `null` both mean the main dex and are always valid.
 */
export function isKnownDex(dex: string | null | undefined, dexes: readonly PerpDexInfo[]): boolean {
  if (dex === null || dex === undefined || dex === "") return true;
  return dexes.some((entry) => entry.name === dex);
}

// ---------------------------------------------------------------------------
// Margin tiers
// ---------------------------------------------------------------------------

export interface MarginTierRow {
  lowerBound: string;
  maxLeverage: number;
}

/**
 * The margin-tier table for an asset.
 *
 * Asserts ascending order rather than sorting, because `core/precision`'s
 * `findMarginTier` scans in reverse and does **not** sort — if the API ever
 * returned an unsorted table it would silently pick the wrong tier and show a
 * wrong maximum leverage. Twenty-one tables across both networks were sorted, so
 * this fires only on a genuine change, and logging is the right response: the
 * data is still usable once sorted here.
 */
export async function fetchMarginTable(params: {
  probe: MetaProbe;
  id: number;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<MetaResult<MarginTierRow[]>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "marginTable",
    () => params.probe.marginTable({ id: params.id }),
    { now: () => now }
  );
  if (raw === null) return deferred();

  const tiers = ((raw as { marginTiers?: unknown }).marginTiers ?? []) as Record<string, unknown>[];
  const rows: MarginTierRow[] = tiers.map((tier) => ({
    lowerBound: asAmount(tier.lowerBound, "0"),
    maxLeverage: typeof tier.maxLeverage === "number" ? tier.maxLeverage : 1,
  }));

  const sorted = [...rows].sort(
    (a, b) => new BigNumber(a.lowerBound).comparedTo(b.lowerBound) ?? 0
  );
  if (sorted.some((row, i) => row !== rows[i])) {
    logger.warn("marginTable.unsorted", { context: { id: params.id } });
  }
  return { value: sorted, deferred: false };
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

export interface RateLimitStatus {
  cumVlm: string;
  nRequestsUsed: number;
  nRequestsCap: number;
  nRequestsSurplus: number;
}

/** The server's own view of this address's action budget. */
export async function fetchUserRateLimit(params: {
  probe: MetaProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<MetaResult<RateLimitStatus>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "userRateLimit",
    () => params.probe.userRateLimit({ user: params.user }),
    { now: () => now }
  );
  if (raw === null) return deferred();

  const source = raw as Record<string, unknown>;
  return {
    value: {
      cumVlm: asAmount(source.cumVlm, "0"),
      nRequestsUsed: asInt(source.nRequestsUsed),
      nRequestsCap: asInt(source.nRequestsCap),
      nRequestsSurplus: asInt(source.nRequestsSurplus),
    },
    deferred: false,
  };
}

// ---------------------------------------------------------------------------
// Funding history
// ---------------------------------------------------------------------------

export interface FundingLedgerRow {
  time: number;
  coin: string;
  /**
   * The wire's `usdc` value, unmodified — the **account's cash delta**:
   * negative means funding was PAID, positive means it was RECEIVED.
   *
   * Verified live (2026-08-14) by the reconciliation this doc used to demand:
   * over the BTC position's whole life, `cumFunding.allTime = 0.005326` while
   * `Σ ledger usdc = -0.005326` — the sum is zero to the sixth decimal, so the
   * two conventions are exactly opposite. (`cumFunding` counts paid as
   * positive; this ledger counts it as negative.) Mechanics agree: every
   * positive-rate row against the long position is a negative `usdc`.
   */
  usdc: string;
  szi: string;
  fundingRate: string;
}

/**
 * Funding payments over a window.
 *
 * Handles both wire shapes: REST nests the row under `delta` and adds
 * `type`/`hash`, while the websocket reportedly sends the same fields flat. One
 * parser for both, so neither path reads `undefined`.
 */
export async function fetchUserFunding(params: {
  probe: MetaProbe;
  user: string;
  startTime: number;
  endTime?: number;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<MetaResult<FundingLedgerRow[]>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "userFunding",
    () =>
      params.probe.userFunding({
        user: params.user,
        startTime: params.startTime,
        ...(params.endTime === undefined ? {} : { endTime: params.endTime }),
      }),
    { now: () => now }
  );
  if (raw === null) return deferred();
  if (!Array.isArray(raw)) return { value: [], deferred: false };

  return { value: raw.map(parseFundingRow), deferred: false };
}

/** Accepts the REST shape (nested under `delta`) and the flat websocket shape alike. */
export function parseFundingRow(row: unknown): FundingLedgerRow {
  const outer = (row ?? {}) as Record<string, unknown>;
  const inner = (outer.delta ?? outer) as Record<string, unknown>;
  return {
    time: asInt(outer.time ?? inner.time),
    coin: typeof inner.coin === "string" ? inner.coin : "",
    usdc: asAmount(inner.usdc, "0"),
    szi: asAmount(inner.szi, "0"),
    fundingRate: asAmount(inner.fundingRate, "0"),
  };
}

// ---------------------------------------------------------------------------
// Portfolio history
// ---------------------------------------------------------------------------

export interface PortfolioSeries {
  /** `[timestampMs, value]` pairs. */
  accountValueHistory: [number, string][];
  /**
   * The series a PnL chart should plot.
   *
   * `accountValueHistory` deltas attribute a deposit to trading performance — a
   * user who funded their account sees it as profit. `pnlHistory` is the
   * deposit-adjusted series. Which of the two is correct for a given surface is
   * the whole reason both are exposed rather than one being picked here.
   */
  pnlHistory: [number, string][];
}

/** Portfolio history, keyed by the periods the API returns (`day`, `week`, …). */
export async function fetchPortfolio(params: {
  probe: MetaProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<MetaResult<Map<string, PortfolioSeries>>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "portfolio",
    () => params.probe.portfolio({ user: params.user }),
    { now: () => now }
  );
  if (raw === null) return deferred();
  if (!Array.isArray(raw)) return { value: new Map(), deferred: false };

  const byPeriod = new Map<string, PortfolioSeries>();
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [period, series] = entry as [unknown, Record<string, unknown>];
    if (typeof period !== "string" || series === null || typeof series !== "object") continue;
    byPeriod.set(period, {
      accountValueHistory: asSeries(series.accountValueHistory),
      pnlHistory: asSeries(series.pnlHistory),
    });
  }
  return { value: byPeriod, deferred: false };
}

// ---------------------------------------------------------------------------
// Staking
// ---------------------------------------------------------------------------

/**
 * The `delegatorSummary` response, verbatim wire strings. Amounts are **HYPE**,
 * not USDC — staking is denominated in the native token.
 *
 * Measured live on this project's account: `{delegated: "0.0", undelegated:
 * "0.0", totalPendingWithdrawal: "0.0", nPendingWithdrawals: 0}` — an account
 * that has never staked reports zeros, not null.
 */
export interface DelegatorSummary {
  delegated: string;
  undelegated: string;
  pendingWithdrawal: string;
  pendingWithdrawalCount: number;
}

export async function fetchDelegatorSummary(params: {
  probe: MetaProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<MetaResult<DelegatorSummary>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "delegatorSummary",
    () => params.probe.delegatorSummary({ user: params.user }),
    { now: () => now }
  );
  if (raw === null) return deferred();

  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    value: {
      delegated: asAmount(source.delegated, "0"),
      undelegated: asAmount(source.undelegated, "0"),
      pendingWithdrawal: asAmount(source.totalPendingWithdrawal, "0"),
      pendingWithdrawalCount: asInt(source.nPendingWithdrawals),
    },
    deferred: false,
  };
}

/**
 * Whether the summary is worth a card at all.
 *
 * An account that has never staked reports genuine zeros — a card of zeros
 * asserts nothing and earns no place on the screen. Any single non-zero field
 * makes the whole summary showable, including a bare pending-withdrawal count.
 */
export function stakingIsEmpty(summary: DelegatorSummary): boolean {
  return (
    toBigNumber(summary.delegated).isZero() &&
    toBigNumber(summary.undelegated).isZero() &&
    toBigNumber(summary.pendingWithdrawal).isZero() &&
    summary.pendingWithdrawalCount === 0
  );
}

function asAmount(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asSeries(value: unknown): [number, string][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((point): point is [number, string] => Array.isArray(point) && point.length >= 2)
    .map((point) => [asInt(point[0]), asAmount(point[1], "0")]);
}
