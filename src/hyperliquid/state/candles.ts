/**
 * Candle series state.
 *
 * Deliberately **not** shaped like `BookStore`. A book is a whole value that is
 * replaced; a candle series is an ordered collection where the newest bucket is
 * revised repeatedly and then frozen. Four facts from the live feed drive the
 * design:
 *
 * 1. **The websocket upserts, it never appends.** Repeated events carry the same
 *    open time `t` with rising close/volume, then `t` jumps to the next bucket.
 *    An implementation that appends every message produces thousands of
 *    duplicate bars per minute.
 * 2. **There is no "closed" flag.** `T` is always `t + intervalMs - 1`, and for
 *    the newest bucket `T` lies in the future. That comparison is the only way
 *    to tell an in-progress candle from a finished one.
 * 3. **The forming candle is kept apart from the committed ones.** Chart
 *    libraries draw a live candle *in addition to* the committed array, so a
 *    bucket present in both is drawn twice.
 * 4. **Ascending order is an invariant, not a nicety.** Chart renderers binary-
 *    search the array without validating it; an out-of-order insert silently
 *    renders a wrong window rather than failing.
 * 5. **Buckets are not guaranteed contiguous near the tail.** A bucket with no
 *    trades gets no candle until it is backfilled, so the series can hold a
 *    hole for minutes. Anything mapping bar index to time must read `openTime`
 *    rather than counting positions.
 *
 * Prices stay strings here, as everywhere in this module. Conversion to the
 * numbers a chart wants happens once, at the adapter.
 */

import { isForTarget } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { serverNow } from "@/hyperliquid/core/clock";
import { log } from "@/hyperliquid/core/logger";
import type {
  Candle,
  CandleInterval,
  Scoped,
  SubscriptionTarget,
} from "@/hyperliquid/types/domain";

const logger = log.child("state.candles");

/**
 * Fixed bucket widths in ms.
 *
 * `1M` is a fixed **30 days**, not a calendar month, and `1w` is
 * Thursday-anchored on the epoch — neither maps onto a calendar axis, and
 * treating them as if they do produces labels that drift.
 */
const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

export function intervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}

/** Seconds — what chart libraries want for bar width. */
export function intervalSeconds(interval: CandleInterval): number {
  return INTERVAL_MS[interval] / 1000;
}

/**
 * The bucket an instant falls in.
 *
 * Every interval is a pure epoch floor in UTC, so this needs no calendar
 * library — and must never be derived from local time.
 */
export function bucketStart(atMs: number, interval: CandleInterval): number {
  const width = INTERVAL_MS[interval];
  return Math.floor(atMs / width) * width;
}

/**
 * Whether a candle's bucket has closed. The only available test.
 *
 * `closeTime` is a bucket boundary the EXCHANGE decides has passed, so the
 * question is asked on its clock: `now` arrives as a device instant and is
 * translated. Untranslated, a fast phone killed the forming bar before it
 * closed — and with it the out-of-order guard that keys on the forming pointer.
 */
export function isClosed(candle: Candle, now: number): boolean {
  return candle.closeTime < serverNow(now);
}

/** How many candles to retain. Hyperliquid's own retention is ~5000 per series. */
export const MAX_CANDLES = 5_000;

type Listener = () => void;

export interface CandleSeries {
  /** Closed buckets, ascending by open time. Never contains the forming bucket. */
  committed: Candle[];
  /** The bucket currently being revised, or null. Drawn *in addition to* `committed`. */
  forming: Candle | null;
}

/**
 * Holds one candle series — a single (coin, interval) pair.
 *
 * Like `BookStore`, a plain observable rather than a React-scheduled atom: the
 * write path runs on every trade.
 */
export class CandleStore {
  private target: SubscriptionTarget | null = null;
  /** Keyed by open time so an upsert is O(1) and duplicates are impossible. */
  private buckets = new Map<number, Candle>();
  private formingOpenTime: number | null = null;
  private lastUpdateAt = 0;
  /** Memoised ascending view; `null` means "recompute on next read". */
  private sorted: Candle[] | null = null;
  /** Memoised split view. Must be referentially stable — see `read`. */
  private view: CandleSeries | null = null;
  /**
   * The committed slice, memoised independently of {@link view}.
   *
   * `view` dies on every accepted frame because the forming bar really did
   * change. `committed` must not: a revision of the forming bucket leaves every
   * committed bar identical, and the chart decides whether to re-upload the
   * whole series from this array's IDENTITY. Cleared only by the writes that
   * can alter the committed set — a new bucket, a graduation, a trim, and the
   * wholesale resets.
   */
  private committed: Candle[] | null = null;
  private readonly listeners = new Set<Listener>();
  private droppedCount = 0;

  /** Point at a different series. Clears — a BTC/1m series is not BTC/1h data. */
  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      this.buckets.clear();
      this.formingOpenTime = null;
      this.sorted = null;
      this.view = null;
      // The committed set really did change here — unlike a forming-bar revision.
      this.committed = null;
      this.lastUpdateAt = 0;
      this.droppedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  /**
   * Seed from REST history.
   *
   * Needed because chart libraries typically render an empty state until a
   * couple of committed candles exist — a websocket-only chart shows "no data"
   * for two full bucket periods, which on a 1h chart is two hours.
   *
   * The snapshot's last row is the forming bucket **only when that bucket has
   * already traded** — measured on testnet, it appears partway through the
   * bucket and is simply absent before then. So `forming` is derived per row
   * rather than assumed of the last one, and on a quiet market a seed
   * legitimately leaves nothing forming until the first websocket event.
   */
  seed(target: SubscriptionTarget, candles: readonly Candle[], now: number): void {
    if (!this.target || subscriptionKey(this.target) !== subscriptionKey(target)) {
      this.droppedCount += 1;
      return;
    }
    // Recomputed from the snapshot, not carried over: a bucket that was forming
    // before this seed may well have closed since, and leaving the pointer on it
    // presents a dead bucket as live — the failure `settle` exists to prevent.
    this.formingOpenTime = null;
    for (const candle of candles) {
      this.buckets.set(candle.openTime, candle);
      if (!isClosed(candle, now)) this.formingOpenTime = candle.openTime;
    }
    this.sorted = null;
    this.view = null;
    // The committed set really did change here — unlike a forming-bar revision.
    this.committed = null;
    this.trim();
    this.lastUpdateAt = now;
    this.emit();
  }

  /**
   * Apply a streamed candle.
   *
   * Upserts by open time. When `t` advances, the previous forming bucket has
   * closed and graduates into the committed set simply by no longer being
   * pointed at — no copying, no risk of it existing in both.
   */
  apply(event: Scoped<Candle>, now: number): void {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return;
    }
    const candle = event.value;

    // Monotonicity. A late event for a bucket older than the one forming would
    // otherwise overwrite a finished candle's OHLC with a partial view of it.
    if (this.formingOpenTime !== null && candle.openTime < this.formingOpenTime) {
      this.droppedCount += 1;
      return;
    }

    // Did this frame change the COMMITTED set, or only revise the forming bar?
    //
    // The overwhelmingly common frame is the latter: the channel pushes a
    // revised forming bucket on every trade batch — 1-4 Hz on a liquid perp —
    // while the other 299 bars cannot change for the rest of the interval.
    // Invalidating `committed` on those rebuilt a 300-element array per push,
    // and `CandleChartCard`'s effect keys on that array's identity ("the
    // store's committed array reference only changes when its content did"), so
    // every tick re-uploaded 300 unchanged bars across the JS->UI bridge.
    const wasForming = this.formingOpenTime;
    const isNewBucket = !this.buckets.has(candle.openTime);

    this.buckets.set(candle.openTime, candle);
    this.formingOpenTime = isClosed(candle, now) ? null : candle.openTime;
    this.sorted = null;
    this.view = null;
    // The ONLY revision that leaves the committed set untouched is one to the
    // bucket that was forming and still is. Everything else can change it.
    //
    // Stated the other way round — `isNewBucket || wasForming !== forming` — it
    // missed a late revision of an ALREADY-CLOSED bucket: `settle()` fires on a
    // timer the instant a bucket closes, so `wasForming` is already null when
    // the exchange's final frame for that bucket lands milliseconds later. New
    // bucket? No. Forming pointer moved? No, null to null. So `committed` kept
    // the pre-settle OHLC while `buckets` held the settled one, and the chart
    // showed a last closed bar that no longer matched the store — permanently,
    // because `CandleChartCard` keys its upload effect on this array's identity.
    const revisedForming =
      !isNewBucket && wasForming === candle.openTime && this.formingOpenTime === candle.openTime;
    if (!revisedForming) this.committed = null;
    this.trim();
    this.lastUpdateAt = event.receivedAt;
    this.emit();
  }

  /**
   * Close out a bucket whose time has passed.
   *
   * **Required, not an optimisation.** The feed only emits when a trade occurs,
   * so on an illiquid market a bucket can pass its close time with no further
   * event — measured on testnet, BTC 1m produced two events in eighty seconds
   * and none at all for a bucket with no trades. Without a wall-clock check the
   * forming bar is presented as live indefinitely, and any "current price" read
   * from it is pinned to a dead close.
   *
   * Call on a timer and on resume from background.
   */
  settle(now: number): boolean {
    if (this.formingOpenTime === null) return false;
    const forming = this.buckets.get(this.formingOpenTime);
    if (!forming || !isClosed(forming, now)) return false;
    // Graduating is just ceasing to point at it; the candle is already stored.
    this.formingOpenTime = null;
    this.sorted = null;
    this.view = null;
    // The committed set really did change here — unlike a forming-bar revision.
    this.committed = null;
    this.emit();
    return true;
  }

  /**
   * The series, split for rendering.
   *
   * Sorted ascending on read. Renderers binary-search without validating, so
   * the ordering guarantee has to come from here.
   *
   * **Referentially stable between mutations.** This is the `getSnapshot` a
   * `useSyncExternalStore` binding calls on every render, and React compares the
   * result with `Object.is` — returning a fresh object each call is an infinite
   * render loop, not a slow one. The view is therefore memoised alongside the
   * sorted array and invalidated by the same writes.
   */
  read(): CandleSeries {
    if (this.view) return this.view;
    // Cached: a chart reads once per frame, and re-sorting 5,000 buckets at
    // 60fps is real work. Invalidated by every mutation.
    const all = (this.sorted ??= [...this.buckets.values()].sort(
      (a, b) => a.openTime - b.openTime
    ));
    const forming =
      this.formingOpenTime === null ? null : (this.buckets.get(this.formingOpenTime) ?? null);
    // Memoised SEPARATELY from `view`: `view` is invalidated by every accepted
    // frame (the forming bar genuinely changed), but `committed` only by the
    // writes that alter the committed set. Holding the same array across a
    // forming-bar revision is the whole point — its identity is what the chart
    // effect uses to decide whether to re-upload the series.
    this.committed ??= forming ? all.filter((c) => c.openTime !== forming.openTime) : all;
    this.view = { committed: this.committed, forming };
    return this.view;
  }

  /** Latest close, forming bucket included — what a live price readout wants. */
  latestClose(): string | null {
    const { committed, forming } = this.read();
    return forming?.close ?? committed[committed.length - 1]?.close ?? null;
  }

  /** True when nothing has arrived within `maxAgeMs`. */
  isStale(now: number, maxAgeMs: number): boolean {
    return this.lastUpdateAt === 0 || now - this.lastUpdateAt > maxAgeMs;
  }

  get size(): number {
    return this.buckets.size;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.buckets.clear();
    this.formingOpenTime = null;
    this.sorted = null;
    this.view = null;
    // The committed set really did change here — unlike a forming-bar revision.
    this.committed = null;
    this.lastUpdateAt = 0;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop the oldest buckets past the retention bound. */
  private trim(): void {
    if (this.buckets.size <= MAX_CANDLES) return;
    const ordered = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const openTime of ordered.slice(0, this.buckets.size - MAX_CANDLES)) {
      if (openTime !== this.formingOpenTime) this.buckets.delete(openTime);
    }
    this.sorted = null;
    this.view = null;
    // The committed set really did change here — unlike a forming-bar revision.
    this.committed = null;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn("candles.listener_failed", { error });
      }
    }
  }
}
