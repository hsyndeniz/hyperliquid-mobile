/**
 * Order-book state.
 *
 * The highest-rate feed in the app and the one with the most damaging failure
 * mode: showing one market's book under another market's name. Three rules,
 * inherited directly from the reference's hardest bugs:
 *
 * 1. **A write for a non-current target is dropped, not stored.** In-flight
 *    events from the previous coin keep arriving after a switch; storing them
 *    is how the wrong book gets displayed.
 * 2. **Switching target clears the book immediately.** An empty book renders as
 *    a loading state; a stale one renders as a *wrong* state. Ticker recovery
 *    does not prove book recovery, so the book must prove its own.
 * 3. **A cached book may seed a cold start but never displays as fresh.**
 *    Reads go through a freshness check, so a seeded book cannot be mistaken
 *    for live data.
 *
 * Deliberately a plain observable rather than a jotai atom family: the write
 * path runs at tick rate, and this keeps it free of React scheduling. The jotai
 * layer subscribes to it.
 */

import { deviceInstantOf, freshValue, isForTarget } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const logger = log.child("state.book");

/** One side of the book, as the wire delivers it — prices and sizes as strings. */
export interface BookLevel {
  px: string;
  sz: string;
  n?: number;
}

/**
 * The wire shape of an `l2Book` event.
 *
 * `levels` is a **tuple**, `[bids, asks]` — not an object with named sides.
 * Modelling it as `{ bids, asks }` typechecks against a hand-written mock and
 * then reads `undefined` against the real feed, which is exactly how this was
 * originally got wrong.
 */
export interface BookSnapshot {
  coin: string;
  /** Server timestamp of the snapshot. */
  time: number;
  levels: [bids: BookLevel[], asks: BookLevel[]];
  /** Present only when subscribed with `nSigFigs`. */
  spread?: string;
  /** Present only on a `fast: true` subscription. */
  fast?: true;
}

/**
 * Whether an arriving event predates what is already held.
 *
 * Prefers the server clock; falls back to receive time only when the channel
 * supplies no timestamp.
 */
function isOlderThanHeld(incoming: Scoped<BookSnapshot>, held: Scoped<BookSnapshot>): boolean {
  // Both onto the device clock before comparing. With the bare `??` these two
  // could land on DIFFERENT clocks — one frame stamped by the exchange, the
  // other not — and the ordering verdict became a measure of skew.
  const incomingAt = deviceInstantOf(incoming);
  const heldAt = deviceInstantOf(held);
  return incomingAt < heldAt;
}

/** Bid side. Named accessors so no call site indexes the tuple by hand. */
export function bidsOf(book: BookSnapshot): BookLevel[] {
  return book.levels?.[0] ?? [];
}

export function asksOf(book: BookSnapshot): BookLevel[] {
  return book.levels?.[1] ?? [];
}

/** Best bid / best ask, or `null` when that side is empty. */
export function bestBid(book: BookSnapshot): BookLevel | null {
  return bidsOf(book)[0] ?? null;
}

export function bestAsk(book: BookSnapshot): BookLevel | null {
  return asksOf(book)[0] ?? null;
}

/** How old a book may be before it stops counting as live. */
export const BOOK_MAX_AGE_MS = 10_000;

type Listener = () => void;

/**
 * Holds the book for the currently selected target.
 *
 * One instance per surface. Not keyed by target internally: the point is that
 * exactly one book is current, and anything else is discarded rather than
 * retained for a market nobody is looking at.
 */
export class BookStore {
  private target: SubscriptionTarget | null = null;
  private scoped: Scoped<BookSnapshot> | null = null;
  private readonly listeners = new Set<Listener>();
  /** Set by `markStale`; cleared by the next accepted event. */
  private staleOverride = false;
  /** Counts drops so a silent mismatch is visible without per-tick logging. */
  private droppedCount = 0;

  /**
   * Point the store at a different market.
   *
   * Clears immediately. A book from the previous coin must never survive the
   * switch, even for a frame.
   */
  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      this.scoped = null;
      this.staleOverride = false;
      this.droppedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  /**
   * Apply an inbound book.
   *
   * Silently ignores anything for a different target — that is the normal
   * consequence of a switch, not an error, and logging per tick would itself
   * cost latency.
   */
  apply(event: Scoped<BookSnapshot>): void {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return;
    }
    // A frame from the OTHER book stream is not this store's, even though it
    // is for this coin and this target.
    //
    // Measured on the wire: when a `fast: true` and a `fast: false`
    // subscription for one coin are open on the SAME socket, the server fans
    // BOTH streams to BOTH — each listener saw all 34 frames of a 15 s window
    // (30 five-level, 4 twenty-level). The subscription request is not a
    // filter; it only asks for a stream to start. The `fast` marker on the
    // payload is the only thing that separates them, and it is exact: marked
    // frames carried 5 levels and unmarked ones 20, without exception, both
    // alone and interleaved.
    //
    // Without this the deeper store is overwritten ~10x a second by the fast
    // stream and holds 5 levels forever — a merged ladder that silently never
    // deepens, which is precisely how this was first observed on device.
    if ((event.value.fast === true) !== (this.target.aggregation?.fast === true)) {
      this.droppedCount += 1;
      return;
    }
    // The same trap one axis over: GROUPING.
    //
    // The SDK dispatches on the channel name and its per-method wrapper filters
    // on coin alone, so a frame from an nSigFigs subscription reaches every
    // l2Book listener for that coin — including one that has just switched
    // grouping and is waiting for its own stream. `setTarget` clears the store
    // on the switch, and the OLD stream then repopulates the ladder with the
    // previous price grid until the unsubscribe round-trip lands.
    //
    // `spread` is the discriminator the payload actually offers: the SDK
    // documents it as "only present when `nSigFigs` is non-null", which is
    // exact. It separates ungrouped from grouped in both directions.
    //
    // It does NOT separate one nSigFigs from another — a 2-figs frame and a
    // 5-figs frame both carry a spread — so switching BETWEEN two groupings is
    // still briefly exposed. Closing that needs a confirmed-subscription epoch
    // threaded from the registry, which is a lifecycle change rather than a
    // payload check; this covers the null<->grouped transitions for free.
    if ((event.value.spread !== undefined) !== (this.target.aggregation?.nSigFigs != null)) {
      this.droppedCount += 1;
      return;
    }
    // Monotonicity. Websocket frames are not guaranteed in order, and a late
    // OLDER snapshot overwriting a newer one puts the book visibly backwards —
    // the price ticks the wrong way with no error anywhere.
    if (this.scoped && isOlderThanHeld(event, this.scoped)) {
      this.droppedCount += 1;
      return;
    }
    this.scoped = event;
    this.staleOverride = false;
    this.emit();
  }

  /**
   * The book, or `null` when there is nothing safe to show.
   *
   * `null` covers both "nothing yet" and "too old" deliberately: a surface
   * should render its empty state in either case rather than showing numbers it
   * cannot vouch for.
   */
  read(now: number, maxAgeMs = BOOK_MAX_AGE_MS): BookSnapshot | null {
    if (!this.target || this.staleOverride) return null;
    return freshValue(this.scoped, this.target, maxAgeMs, now);
  }

  /**
   * The last applied snapshot, regardless of age.
   *
   * The trade screen's stale-book UX shows held values at reduced opacity with
   * taps disabled rather than flashing empty; `read(now)` stays the freshness
   * authority and this is the display path once `read` returns `null`. Still
   * `null` before the first frame and after a target switch clears — a held
   * book may be *old*, but it must never be *another market's*.
   *
   * Returns the same reference `read` served while fresh, so consumers keyed on
   * identity do not re-render when the book merely crosses the age limit.
   */
  readHeld(): BookSnapshot | null {
    return this.scoped?.value ?? null;
  }

  /** The raw envelope, for surfaces that want to show *why* data is stale. */
  readScoped(): Scoped<BookSnapshot> | null {
    return this.scoped;
  }

  /** True when a book is held but too old to display. */
  isStale(now: number, maxAgeMs = BOOK_MAX_AGE_MS): boolean {
    return this.scoped !== null && this.read(now, maxAgeMs) === null;
  }

  /**
   * Mark the held book unusable without discarding it.
   *
   * Used on resume from background: the book is almost certainly stale, but
   * keeping it lets a surface show last-known values greyed out rather than
   * flashing empty, while `read` still refuses to call it fresh.
   */
  markStale(): void {
    if (!this.scoped) return;
    // A separate flag rather than zeroing the timestamps: the greyed-out render
    // this exists for wants to say "as of 14:32", and destroying receivedAt and
    // serverTime removes exactly that. Freshness reads the flag.
    this.staleOverride = true;
    this.emit();
  }

  clear(): void {
    this.scoped = null;
    this.staleOverride = false;
    this.emit();
  }

  /** How many events were discarded as belonging to another target. */
  get dropped(): number {
    return this.droppedCount;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // A throwing consumer must not break the feed for the others.
        logger.warn("book.listener_failed", { error });
      }
    }
  }
}
