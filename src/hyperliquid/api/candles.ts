/**
 * Candle history over REST.
 *
 * The websocket only ever delivers the bucket forming *now*, so a chart opened
 * cold has nothing to draw until a bucket completes — two hours of empty screen
 * on a 1h chart. History comes from `candleSnapshot`, and this module owns the
 * three details that make it awkward:
 *
 1. **A bucket gets a candle only once it has traded.** Measured by polling
 *    testnet BTC 1m across four bucket boundaries: the current bucket was absent
 *    from the response until its first trade, then appeared mid-bucket. One
 *    quiet bucket stayed missing for its whole life and was only backfilled
 *    later. So the newest row is *sometimes* the forming bar and sometimes the
 *    previous one — neither may be assumed, and the tail is not contiguous.
 * 2. **Older history is contiguous, gaps filled with `n === 0` rows.** A
 *    500-bucket window came back with no missing buckets and 40 zero-trade rows.
 *    A zero-trade candle is real data, not a defect: it carries the previous
 *    close on all four prices. Refetching therefore *upserts* rather than
 *    appends, because a bucket absent from an earlier fetch may exist now.
 * 3. **The lower bound is inclusive by containment**, and the response can run
 *    one bucket past `count` in either direction. Paging backwards with
 *    `endTime = oldest.openTime` re-fetches a bar already held — see
 *    `mergeCandles`.
 * 4. **It is a weighted request against a per-IP budget** shared with everyone
 *    behind the same carrier NAT. Every fetch here goes through the budget.
 *
 * Response rows are normalised from the wire's single letters into `Candle` at
 * this boundary, so nothing downstream reads `o`/`c` and risks transposing them.
 */

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { intervalMs } from "@/hyperliquid/state/candles";
import type { Candle, CandleInterval } from "@/hyperliquid/types/domain";
import type { ICandle, ICandleWsEvent } from "@/hyperliquid/types/sdk";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";

const logger = log.child("api.candles");

/**
 * Rows per request.
 *
 * Hyperliquid caps a `candleSnapshot` response at 5,000 rows regardless of the
 * range asked for, so a wider range silently truncates rather than erroring —
 * which is why the window is computed from the count rather than guessed.
 */
export const MAX_CANDLES_PER_REQUEST = 5_000;

/** The slice of `InfoClient` this module needs, so tests need no network. */
export interface CandleProbe {
  candleSnapshot(params: {
    coin: string;
    interval: CandleInterval;
    startTime: number;
    endTime?: number;
  }): Promise<readonly ICandle[]>;
}

/**
 * Normalise one wire row.
 *
 * Shared by REST and websocket deliberately: `CandleSnapshotResponse[number]`
 * and `CandleWsEvent` are the same ten fields, so one normaliser means the two
 * paths cannot drift into disagreeing about what a candle is.
 *
 * `i` (the interval the row was returned for) is preferred over the requested
 * interval so a row can never claim a width it does not have.
 */
export function toCandle(row: ICandle | ICandleWsEvent): Candle {
  return {
    openTime: row.t,
    closeTime: row.T,
    interval: row.i,
    coin: row.s,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
    trades: row.n,
  };
}

export interface FetchCandlesParams {
  probe: CandleProbe;
  coin: string;
  interval: CandleInterval;
  /** How many buckets back from `endTime`. Clamped to the per-request cap. */
  count?: number;
  /** Defaults to now. Paging backwards passes `oldest.openTime - 1` — see below. */
  endTime?: number;
  budget?: WeightBudget;
  now?: () => number;
}

export interface CandleHistory {
  candles: Candle[];
  /**
   * Whether the newest row's bucket is still open.
   *
   * Genuinely variable, not a constant: the forming bucket is included once it
   * has traded and absent before that. A caller seeding a chart must therefore
   * check it rather than assume either way — the store routes an unclosed row to
   * `forming`, where the websocket then revises it in place.
   */
  hasFormingBar: boolean;
  /** Set when the budget refused the request; `candles` is then empty. */
  deferred: boolean;
}

/**
 * Fetch history, newest last.
 *
 * Returns `deferred: true` rather than throwing or waiting when the weight
 * budget is exhausted: a chart that cannot load history is a degraded view, not
 * a failure, and blocking here would hide the pressure from the caller that can
 * actually decide what to do about it.
 */
export async function fetchCandles(params: FetchCandlesParams): Promise<CandleHistory> {
  const now = (params.now ?? Date.now)();
  const width = intervalMs(params.interval);
  if (!width) {
    throw new HlError(`Unknown candle interval: ${params.interval}`, {
      code: "invalid_config",
      context: { interval: params.interval },
    });
  }

  const count = Math.min(params.count ?? 500, MAX_CANDLES_PER_REQUEST);
  const endTime = params.endTime ?? now;
  // Anchored on the bucket grid, then `count` widths back. Measuring from
  // `endTime` itself is short by one whenever the forming bucket has not traded
  // yet. Anchoring makes the floor exact; the response may still run one over
  // when the forming bar is present. Verified on testnet at 1, 5, 20 and 500.
  const startTime = Math.floor(endTime / width) * width - count * width;

  const budget = params.budget ?? weightBudget;
  const rows = await budget.tryRun(
    // The published weight for candleSnapshot is 20, not l2Book's 2 — this
    // charged a tenth of the real cost until the Markets screen audit.
    "candleSnapshot",
    () =>
      params.probe.candleSnapshot({
        coin: params.coin,
        interval: params.interval,
        startTime,
        endTime,
      }),
    { now: () => now, resultCount: count }
  );

  if (rows === null) {
    logger.warn("candles.deferred", {
      context: { coin: params.coin, interval: params.interval },
    });
    return { candles: [], hasFormingBar: false, deferred: true };
  }

  const candles = rows.map(toCandle).sort((a, b) => a.openTime - b.openTime);
  const last = candles[candles.length - 1];
  return {
    candles,
    // No flag exists on the row; a close time at or after now is the only test.
    hasFormingBar: last !== undefined && last.closeTime >= now,
    deferred: false,
  };
}

/**
 * The `endTime` for the next page back.
 *
 * One millisecond before the oldest held bucket opens. Passing `openTime`
 * itself returns that same bucket again — the lower bound is inclusive by
 * containment — so a naive pager either loops on one bar or, if it prepends
 * blindly, duplicates it.
 */
export function previousPageEnd(oldest: Candle): number {
  return oldest.openTime - 1;
}

/**
 * Merge pages, newest last, de-duplicating by open time.
 *
 * `incoming` wins on collision: a later fetch of the same bucket is a revision
 * of it, and for the forming bar it is strictly more complete.
 */
export function mergeCandles(held: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  if (held.length === 0) return [...incoming];
  const byOpenTime = new Map(held.map((candle) => [candle.openTime, candle]));
  for (const candle of incoming) byOpenTime.set(candle.openTime, candle);
  return [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
}
