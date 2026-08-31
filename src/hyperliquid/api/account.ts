/**
 * REST seeds for account state.
 *
 * The websocket delivers a full snapshot every ~5 s, so these exist for the
 * gap before the first push and for history the subscription does not carry:
 * its fills snapshot is only the newest ~30 rows.
 *
 * Every call goes through the per-IP weight budget and returns `deferred`
 * rather than throwing or waiting when refused. A phone behind carrier NAT
 * shares that budget with strangers, and the caller — not this module — is the
 * one that can decide whether to degrade, retry or tell the user.
 *
 * Template and conventions follow `api/candles.ts`.
 */

import { log } from "@/hyperliquid/core/logger";
import { type WeightBudget, weightBudget, weightOf } from "@/hyperliquid/api/weightBudget";
import { FILL_AGGREGATION } from "@/hyperliquid/state/channels";
import {
  parseClearinghouseState,
  parseFills,
  parseOpenOrders,
  parseSpotState,
  parseTwapSliceFills,
} from "@/hyperliquid/state/accountWire";
import type { AccountSnapshot, Fill, OpenOrderRow, SpotState } from "@/hyperliquid/types/domain";

const logger = log.child("api.account");

/** Rows `userFillsByTime` returns before it truncates. */
export const FILLS_PAGE_SIZE = 2_000;

/** The slice of `InfoClient` these seeds need, so tests need no network. */
export interface AccountProbe {
  clearinghouseState(params: { user: string; dex?: string }): Promise<unknown>;
  spotClearinghouseState(params: { user: string }): Promise<unknown>;
  frontendOpenOrders(params: { user: string; dex?: string }): Promise<unknown>;
  openOrders(params: { user: string; dex?: string }): Promise<unknown>;
  userFillsByTime(params: {
    user: string;
    startTime: number;
    endTime?: number;
    aggregateByTime?: boolean;
  }): Promise<unknown>;
  userTwapSliceFills(params: { user: string }): Promise<unknown>;
}

export interface SeedResult<T> {
  value: T | null;
  /** Set when the weight budget refused the call; `value` is then null. */
  deferred: boolean;
}

interface BaseParams {
  probe: AccountProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}

function deferred<T>(): SeedResult<T> {
  return { value: null, deferred: true };
}

/** Perp account summary and positions. */
export async function fetchAccountSnapshot(
  params: BaseParams & { dex?: string }
): Promise<SeedResult<AccountSnapshot>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;
  const dex = params.dex ?? "";

  const raw = await budget.tryRun(
    "clearinghouseState",
    () => params.probe.clearinghouseState({ user: params.user, dex }),
    { now: () => now }
  );
  if (raw === null) {
    logger.warn("account.snapshot_deferred", {});
    return deferred();
  }
  return {
    value: parseClearinghouseState(raw, {
      dex,
      onUnknownKeys: (keys) => logger.warn("account.unknown_keys", { context: { keys } }),
    }),
    deferred: false,
  };
}

export async function fetchSpotState(params: BaseParams): Promise<SeedResult<SpotState>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "spotClearinghouseState",
    () => params.probe.spotClearinghouseState({ user: params.user }),
    { now: () => now }
  );
  return raw === null ? deferred() : { value: parseSpotState(raw), deferred: false };
}

export interface OpenOrdersSeed {
  rows: OpenOrderRow[];
  /**
   * True when the exchange holds more orders than the detailed endpoint
   * returned.
   *
   * Observed on testnet: `frontendOpenOrders` returned 100 rows for a
   * 3,196-order account, covering 5 of 154 coins, and the 100 were **not** the
   * newest. Not reproduced on mainnet up to 1,058 orders — so this fails in the
   * development environment and passes production QA, which is the worst way
   * round for a bug to behave.
   */
  truncated: boolean;
  /** The plain endpoint's count, which is the true total. */
  totalKnown: number;
}

/**
 * Open orders, with a truncation check.
 *
 * The two endpoints are fetched **concurrently, in one `Promise.all`**, and
 * that is load-bearing rather than an optimisation: sequential calls against an
 * active account produced a false "21 missing" reading purely because orders
 * changed between them, while concurrent calls agreed exactly across 12 rounds.
 *
 * `frontendOpenOrders` is the row source because it is the only one carrying
 * `triggerPx`, `orderType` and `tif` — a stop-loss read from the plain endpoint
 * renders as a resting limit order at its trigger price.
 */
export async function fetchOpenOrders(
  params: BaseParams & { dex?: string }
): Promise<SeedResult<OpenOrdersSeed>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;
  const dex = params.dex ?? "";

  // TWO requests, and the budget must be told about both. They ran inside a
  // single `tryRun`, which spends the weight of ONE — so a call sent 40 and
  // recorded 20. The sole caller is a family fan-out (one per member), so an
  // eight-member family spent 320 while recording 160 from a single tap, and
  // the 200-weight gap between the enforced 1000 and the documented 1200 —
  // whose entire job is absorbing drift quietly — was being eaten by drift the
  // app created itself. `REQUEST_WEIGHTS.openOrders` was already defined and
  // never passed to anything, which is the evidence the charge was intended.
  //
  // The concurrency is deliberate and preserved: the gate is taken once for
  // the combined cost, then both probes fly together.
  const raw = await budget.tryRun(
    "frontendOpenOrders",
    () =>
      Promise.all([
        params.probe.frontendOpenOrders({ user: params.user, dex }),
        params.probe.openOrders({ user: params.user, dex }),
      ]),
    { now: () => now, extraWeight: weightOf("openOrders") }
  );
  if (raw === null) return deferred();

  const [detailed, plain] = raw;
  const rows = parseOpenOrders(detailed);
  const totalKnown = Array.isArray(plain) ? plain.length : rows.length;
  const truncated = totalKnown > rows.length;

  if (truncated) {
    logger.warn("account.open_orders_truncated", {
      context: { returned: rows.length, totalKnown },
    });
  }
  return { value: { rows, truncated, totalKnown }, deferred: false };
}

/**
 * Fills, paged **forward** from `startTime`.
 *
 * Forward rather than backward because `userFillsByTime` truncates from the
 * *start* of the window: asking for a range wider than a page silently drops
 * the **newest** fills, which is the half a user is actually looking at. Paging
 * forward and advancing `startTime` past the last row keeps every page anchored.
 *
 * `aggregateByTime` is pinned to the shared constant. An aggregated row reuses a
 * constituent fill's `tid` with a summed size and arrives indistinguishable from
 * an unaggregated one, so mixing the two modes double-counts and no dedup key
 * repairs it.
 */
export async function fetchFillsPage(
  params: BaseParams & {
    startTime: number;
    endTime?: number;
    /**
     * Merge partial fills of one order at one instant into a single row —
     * the official app's "Aggregate" toggle. Defaults to the module-wide
     * `FILL_AGGREGATION` (false), so the raw fills the reconciler needs are
     * still the default everywhere else.
     */
    aggregateByTime?: boolean;
  }
): Promise<SeedResult<{ fills: Fill[]; hasMore: boolean; nextStartTime: number | null }>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "userFillsByTime",
    () =>
      params.probe.userFillsByTime({
        user: params.user,
        startTime: params.startTime,
        ...(params.endTime === undefined ? {} : { endTime: params.endTime }),
        aggregateByTime: params.aggregateByTime ?? FILL_AGGREGATION,
      }),
    // The PAGE CAP, not the count that comes back: the charge is made before
    // the request goes out, and `userFillsByTime` bills an extra unit per 20
    // rows. Charging the base weight alone under-reported a full page by 100 —
    // so a ten-page history walk recorded 200 locally while the server debited
    // roughly 1,200, the entire per-minute budget, and the tracker kept
    // approving reads straight into a 429.
    { now: () => now, resultCount: FILLS_PAGE_SIZE }
  );
  if (raw === null) return deferred();

  const fills = parseFills(raw);
  const hasMore = fills.length >= FILLS_PAGE_SIZE;
  const newest = fills.reduce((max, f) => Math.max(max, f.time), 0);

  return {
    value: {
      fills,
      hasMore,
      // The newest row's OWN time, NOT `+ 1`.
      //
      // `startTime` is inclusive, so `+ 1` avoided repeating the boundary row
      // — and skipped every OTHER fill sharing that millisecond, which is
      // exactly where the page cap tends to cut. `history/fills.ts` already
      // walks this way (`startTime = last.time`) and drops the repeat with a
      // `seen` set keyed on `fill.key`; this matches it, and the ledger page
      // was corrected the same way.
      //
      // CONTRACT for anyone who starts using this: the boundary row comes back
      // again, so dedupe by `fill.key` (oid + tid) and stop when a page adds
      // nothing. Today the only caller reads a single page and ignores this
      // field entirely.
      nextStartTime: hasMore && newest > 0 ? newest : null,
    },
    deferred: false,
  };
}

/**
 * TWAP slice executions.
 *
 * A separate call because these appear in **no other feed** — 0 of 1,159 slices
 * overlapped `userFillsByTime` on a matched window across three accounts, and 0
 * of 42,000 ordinary mainnet fills carried a `twapId`. Without it a user running
 * a TWAP watches the position move with no fills and a PnL that never
 * reconciles.
 */
export async function fetchTwapSliceFills(params: BaseParams): Promise<SeedResult<Fill[]>> {
  const now = (params.now ?? Date.now)();
  const budget = params.budget ?? weightBudget;

  const raw = await budget.tryRun(
    "userTwapSliceFills",
    () => params.probe.userTwapSliceFills({ user: params.user }),
    // Same per-20-rows surcharge as its sibling; capped the same way.
    { now: () => now, resultCount: FILLS_PAGE_SIZE }
  );
  return raw === null ? deferred() : { value: parseTwapSliceFills(raw), deferred: false };
}
