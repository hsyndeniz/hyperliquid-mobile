/**
 * Per-IP request-weight budget.
 *
 * The second, independent rate limit. `rateLimit.ts` models the per-**address**
 * action budget, which info requests are exempt from; this models the per-**IP**
 * weight budget, which they very much are not.
 *
 * Why it matters more on mobile than elsewhere: a phone behind carrier NAT
 * **shares its public IP with other users**, so the budget can be partly
 * consumed by people the app has never heard of. Polling that would be
 * harmless on a desktop can tip a shared IP over the limit, and the failure
 * lands on everyone behind it.
 *
 * It is a sliding window rather than fixed buckets: a fixed minute boundary
 * lets a burst spend the whole budget twice across the boundary, which is
 * exactly the shape a "refresh everything on launch" sweep has.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 */

import { log } from "@/hyperliquid/core/logger";

const logger = log.child("api.weight");

/** Documented REST allowance: 1200 weight per minute, per IP. */
export const IP_WEIGHT_PER_MINUTE = 1200;
export const WEIGHT_WINDOW_MS = 60_000;

/**
 * Weight of each info request.
 *
 * Most requests cost 2; the expensive ones are called out. `historicalOrders`
 * costs 20 **plus** more per page of results, which is why reconciliation
 * prefers `orderStatus` — see `orders/reconcile`.
 */
export const REQUEST_WEIGHTS = {
  default: 20,
  orderStatus: 2,
  l2Book: 2,
  allMids: 2,
  clearinghouseState: 2,
  historicalOrders: 20,
  userFills: 20,
  /**
   * Account-state reads. Docs-derived and UNMEASURED — the published rate-limit
   * page was already wrong about the unique-user cap (it says 10; the server
   * enforces 15), so treat these as a guard rather than a guarantee and expect
   * to handle a 429 anyway.
   */
  spotClearinghouseState: 2,
  frontendOpenOrders: 20,
  openOrders: 20,
  userFillsByTime: 20,
  userTwapSliceFills: 20,
  userFunding: 20,
  userFees: 20,
  portfolio: 20,
  perpDexs: 20,
  subAccounts2: 20,
  // Phase 7 additions. Docs-derived and unmeasured, like their neighbours — the
  // published rate-limit page was already wrong about the unique-user cap, so
  // this budget is a guard rather than a guarantee.
  spotMeta: 20,
  meta: 20,
  perpDexLimits: 20,
  perpDexStatus: 20,
  perpsAtOpenInterestCap: 20,
  userAbstraction: 20,
  userRole: 60,
  preTransferCheck: 20,
  usdcRouting: 20,
  activeAssetData: 20,
  userNonFundingLedgerUpdates: 20,
  /** User-scoped historical read, weighted like `historicalOrders`. Unmeasured. */
  twapHistory: 20,
  /** User-scoped staking read, weighted like its user-scoped neighbours. Unmeasured. */
  delegatorSummary: 20,
  /**
   * Market-data reads for the Markets screen. Docs-derived and unmeasured: the
   * published weight-2 set is only l2Book/allMids/clearinghouseState/
   * orderStatus/spotClearinghouseState/exchangeStatus — every other info
   * request, these included, is 20.
   */
  candleSnapshot: 20,
  metaAndAssetCtxs: 20,
  spotMetaAndAssetCtxs: 20,
  marginTable: 20,
  maxMarketOrderNtls: 20,
  userRateLimit: 20,
  /**
   * Phase 9. **Measured, unlike its neighbours** — and the measurement is bad
   * news: `vaultDetails` throttles at roughly **one call per second**, far below
   * anything the published weight table implies, and retrying inside the penalty
   * prolongs it. The weight below is deliberately punitive so the local budget
   * runs out before the server's does; the real protection is never hydrating a
   * list from this endpoint.
   */
  vaultDetails: 60,
  /**
   * Phase 10. Small responses — mainnet returns 8 outcomes, testnet ~300 — but
   * `outcomeMeta` is the catalog every prediction screen starts from, so it is
   * weighted like the other user-scoped reads rather than like a cheap ping.
   */
  outcomeMeta: 20,
  settledOutcome: 20,
  outcomeTemplates: 20,
  /**
   * Unmeasured, and weighted like its `user`-keyed neighbours. Polled rather
   * than pushed — `webData3` carries only the aggregate — so this is the one
   * vault endpoint a client calls repeatedly.
   */
  userVaultEquities: 20,
  /** The only ownership check for a vault; a vault never appears in `subAccounts2`. */
  leadingVaults: 20,
  /** Weight added per 20 rows returned by a paginated request. */
  perResultPage: 1,
} as const;

export type WeightedRequest = keyof Omit<typeof REQUEST_WEIGHTS, "perResultPage">;

/**
 * The endpoints that charge EXTRA per page of results, and how big a page is.
 *
 * From the docs' rate-limit page, because the surcharge is not universal: it
 * applies to this list and to nothing else, and `candleSnapshot` counts in 60s
 * where every other member counts in 20s. Charging it everywhere would
 * over-defer cheap reads, and charging candles in 20s over-charges them
 * threefold — neither is a guard, both are noise.
 *
 * The docs also list `recentTrades`, `fundingHistory`, `nonUserFundingUpdates`,
 * `userTwapSliceFillsByTime`, `delegatorHistory`, `delegatorRewards` and
 * `validatorStats`; this app calls none of them, so they are absent from
 * `REQUEST_WEIGHTS` rather than listed here with no weight to attach to. Add
 * both together if one is ever called.
 */
const PAGE_SIZE: Partial<Record<WeightedRequest, number>> = {
  historicalOrders: 20,
  userFills: 20,
  userFillsByTime: 20,
  userFunding: 20,
  userNonFundingLedgerUpdates: 20,
  twapHistory: 20,
  userTwapSliceFills: 20,
  candleSnapshot: 60,
};

/**
 * Weight of one request, including the paging surcharge where it applies.
 *
 * `resultCount` is what the caller EXPECTS to receive — the page cap for a
 * paginated read, not what came back, since the charge has to be made before
 * the request goes out. Passing nothing charges the base weight only, which
 * under-reports for a paged endpoint: every paginated caller should pass its
 * cap.
 */
export function weightOf(request: WeightedRequest, resultCount = 0): number {
  const base = REQUEST_WEIGHTS[request] ?? REQUEST_WEIGHTS.default;
  const pageSize = PAGE_SIZE[request];
  if (pageSize === undefined || resultCount <= 0) return base;
  return base + Math.floor(resultCount / pageSize) * REQUEST_WEIGHTS.perResultPage;
}

interface Spend {
  at: number;
  weight: number;
}

/**
 * Sliding-window weight tracker.
 *
 * One instance per process: the limit is per IP, and every request from this
 * device shares one.
 */
export class WeightBudget {
  private spends: Spend[] = [];

  constructor(
    private readonly limit = IP_WEIGHT_PER_MINUTE,
    private readonly windowMs = WEIGHT_WINDOW_MS
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    if (this.spends.length && this.spends[0].at <= cutoff) {
      this.spends = this.spends.filter((spend) => spend.at > cutoff);
    }
  }

  /** Weight spent in the trailing window. */
  /**
   * The ceiling this instance actually enforces.
   *
   * Exposed because the gauge needs it and had been reading the DOCUMENTED
   * 1200 instead: `used` is provably bounded by the soft limit, so the arc
   * could never pass 83% and its danger band at 85% was unreachable. Reading
   * the number off the instance is the only version of this that cannot drift
   * apart again.
   */
  capacity(): number {
    return this.limit;
  }

  used(now: number): number {
    this.prune(now);
    return this.spends.reduce((total, spend) => total + spend.weight, 0);
  }

  remaining(now: number): number {
    return Math.max(0, this.limit - this.used(now));
  }

  /** Whether a request of this weight fits right now. */
  canSpend(weight: number, now: number): boolean {
    return this.remaining(now) >= weight;
  }

  /** Record a request. Call at send time, so a burst cannot slip past the check. */
  spend(weight: number, now: number): void {
    this.prune(now);
    this.spends.push({ at: now, weight });
  }

  /**
   * How long until `weight` fits, in ms.
   *
   * Derived from when the oldest spends age out, so a caller waits exactly long
   * enough instead of guessing — and never busy-retries into a limit it is
   * already over.
   */
  retryAfterMs(weight: number, now: number): number {
    if (this.canSpend(weight, now)) return 0;
    this.prune(now);

    let freed = 0;
    const needed = weight - this.remaining(now);
    for (const spend of this.spends) {
      freed += spend.weight;
      if (freed >= needed) {
        return Math.max(0, spend.at + this.windowMs - now);
      }
    }
    // Even an empty window cannot fit it — the request is larger than the limit.
    return this.windowMs;
  }

  /**
   * Run `operation` if the budget allows, otherwise return `null`.
   *
   * Deliberately does **not** wait: the caller decides whether to defer, skip,
   * or surface the delay. Blocking inside here would hide the pressure.
   */
  async tryRun<T>(
    request: WeightedRequest,
    operation: () => Promise<T>,
    options: {
      now?: () => number;
      resultCount?: number;
      /**
       * Weight for requests the operation makes ALONGSIDE `request`.
       *
       * A `tryRun` whose operation fires two endpoints spends the weight of one
       * and the server charges for both — silent drift the app creates itself,
       * eating the very gap that exists to absorb the server's. `fetchOpenOrders`
       * did exactly this, and multiplied it by a family fan-out.
       */
      extraWeight?: number;
    } = {}
  ): Promise<T | null> {
    const now = options.now ?? Date.now;
    const weight = weightOf(request, options.resultCount) + (options.extraWeight ?? 0);
    const timestamp = now();

    if (!this.canSpend(weight, timestamp)) {
      logger.warn("weight.exhausted", {
        context: { request, weight, retryAfterMs: this.retryAfterMs(weight, timestamp) },
      });
      return null;
    }
    this.spend(weight, timestamp);
    return operation();
  }

  clear(): void {
    this.spends = [];
  }
}

/**
 * The limit the LIVE budget runs at — deliberately under the documented 1200.
 *
 * The server's accounting and ours cannot agree exactly: its window boundaries
 * differ from our sliding one, responses carry paging surcharges we estimate,
 * and the IP allowance is shared with anything else on the network. Running at
 * the printed limit means the drift surfaces as REAL 429s, which cost a
 * cooldown and an error the user sees; running under it means the drift is
 * absorbed by our own "deferred" state, which retries quietly. A deferral is
 * always cheaper than a 429.
 */
export const SOFT_WEIGHT_PER_MINUTE = 1000;

/** Process-wide budget — the limit is per IP, so one instance is correct. */
export const weightBudget = new WeightBudget(SOFT_WEIGHT_PER_MINUTE);
