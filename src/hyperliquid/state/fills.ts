/**
 * Trade history.
 *
 * Shaped like `CandleStore` rather than `BookStore`: a keyed collection that is
 * upserted, never a whole value that is replaced. Two measured facts force it.
 *
 * **The snapshot replays.** The SDK's `WebSocketTransport` defaults to
 * `resubscribe: true` and re-issues every subscription on every socket open,
 * delivering into the same listener. Every backgrounding, network switch and
 * keepalive timeout therefore replays the newest ~30 fills — 28–30 duplicate
 * rows per reconnect, measured. A store that appends shows the same trade
 * repeatedly and doubles any running total built from it.
 *
 * **The obvious keys are wrong.** Deduplicating by `hash` silently drops 31.2%
 * of rows (5.6% of mainnet fills carry the all-zero hash, and one recorded
 * testnet account had 1,322 collisions in 2,000 rows); by `oid` 26.4%, since a
 * partially-filled order produces many fills; by bare `tid` every Spot Dust
 * Conversion an account has ever had, as they all carry `tid: 0`. The composite
 * `oid:tid` had zero collisions across 113,984 rows on both networks.
 *
 * TWAP slices live in the same keyspace on purpose. They arrive on their own
 * channel and appear in no other feed, but sharing the key means a future
 * server-side merge cannot double-count them.
 *
 * That last point forces one deviation from the other stores. `isForTarget`
 * compares a full `subscriptionKey`, which **includes the channel** — so a
 * store targeting `userFills` rejects every `userTwapSliceFills` event, and the
 * TWAP rows this store exists to capture would never arrive. Acceptance here is
 * therefore by **identity plus a channel allowlist**: same account, either of
 * the two fill channels. The scoping guarantee is unchanged; only the
 * single-channel assumption is relaxed, and only where it is wrong.
 */

import { identityKey, subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Fill, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const logger = log.child("state.fills");

/**
 * Retention bound.
 *
 * Deep history is a paged REST concern, not something to hold in memory on a
 * phone; the websocket's own snapshot is only ~30 rows.
 */
export const MAX_FILLS = 500;

type Listener = () => void;

/**
 * Called for fills that are genuinely new — never for a replayed snapshot.
 *
 * This is where a toast or a haptic belongs. Firing it on the reconnect
 * backfill would buzz the phone thirty times for trades the user saw an hour
 * ago, which is the visible symptom of getting snapshot handling wrong.
 */
export type FillSideEffect = (fills: readonly Fill[]) => void;

/** The two channels that deliver fills for one account. */
const FILL_CHANNELS = new Set<SubscriptionTarget["channel"]>(["userFills", "userTwapSliceFills"]);

export class FillsStore {
  private target: SubscriptionTarget | null = null;
  private fills = new Map<string, Fill>();
  /** Arrival order. More reliable than `time` for ordering within a connection. */
  private sequence = new Map<string, number>();
  private nextSequence = 0;
  private sorted: Fill[] | null = null;
  private lastUpdateAt = 0;
  private staleOverride = false;
  private readonly listeners = new Set<Listener>();
  private droppedCount = 0;

  constructor(private readonly onNewFills?: FillSideEffect) {}

  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      this.fills.clear();
      this.sequence.clear();
      this.sorted = null;
      this.lastUpdateAt = 0;
      this.staleOverride = false;
      this.droppedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  /**
   * Whether an event belongs to this store.
   *
   * Identity must match exactly — that guarantee is never relaxed. The channel
   * may be either fill channel, because both feed one keyspace.
   */
  private accepts(target: SubscriptionTarget): boolean {
    if (!this.target) return false;
    if (identityKey(target.identity) !== identityKey(this.target.identity)) return false;
    return FILL_CHANNELS.has(target.channel);
  }

  /**
   * Apply a batch of fills.
   *
   * A snapshot **merges** rather than replaces: it carries only the newest ~30
   * rows while a REST seed goes much deeper, so replacing would throw away
   * history the user already had. It also suppresses side effects, since none of
   * it is news.
   */
  apply(event: Scoped<readonly Fill[]>): Fill[] {
    if (!this.target || !this.accepts(event.target)) {
      this.droppedCount += 1;
      return [];
    }

    const fresh: Fill[] = [];
    for (const fill of event.value) {
      if (!this.fills.has(fill.key)) {
        this.sequence.set(fill.key, this.nextSequence++);
        fresh.push(fill);
      }
      this.fills.set(fill.key, fill);
    }

    this.sorted = null;
    this.lastUpdateAt = event.receivedAt;
    this.staleOverride = false;
    this.trim();

    if (fresh.length > 0) {
      // `=== true` deliberately: the flag is ABSENT on deltas, not false, so
      // `!event.isSnapshot` would classify every live fill as a replay.
      if (event.isSnapshot !== true) this.onNewFills?.(fresh);
      this.emit();
    }
    return fresh;
  }

  /** Seed from REST. Deeper than the websocket snapshot, and never a side effect. */
  seed(target: SubscriptionTarget, fills: readonly Fill[], now: number): void {
    if (!this.target || subscriptionKey(this.target) !== subscriptionKey(target)) {
      this.droppedCount += 1;
      return;
    }
    for (const fill of fills) {
      if (!this.fills.has(fill.key)) this.sequence.set(fill.key, this.nextSequence++);
      this.fills.set(fill.key, fill);
    }
    this.sorted = null;
    this.lastUpdateAt = now;
    this.trim();
    this.emit();
  }

  /**
   * Newest first.
   *
   * Tiebroken on arrival order rather than on `time` alone: the server clock can
   * lead the device clock, and several fills routinely share a millisecond.
   */
  read(): readonly Fill[] {
    return (this.sorted ??= [...this.fills.values()].sort((a, b) => {
      if (b.time !== a.time) return b.time - a.time;
      return (this.sequence.get(b.key) ?? 0) - (this.sequence.get(a.key) ?? 0);
    }));
  }

  byKey(key: string): Fill | null {
    return this.fills.get(key) ?? null;
  }

  get size(): number {
    return this.fills.size;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  isStale(now: number, maxAgeMs: number): boolean {
    // A quiet account genuinely produces no fills, so silence here says nothing
    // about the feed. Callers wanting feed health should read `AccountStore`.
    return this.staleOverride || this.lastUpdateAt === 0 || now - this.lastUpdateAt > maxAgeMs;
  }

  markStale(): void {
    if (this.fills.size === 0) return;
    this.staleOverride = true;
    this.emit();
  }

  clear(): void {
    this.fills.clear();
    this.sequence.clear();
    this.sorted = null;
    this.lastUpdateAt = 0;
    this.staleOverride = false;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop the oldest by trade time, past the retention bound. */
  private trim(): void {
    if (this.fills.size <= MAX_FILLS) return;
    const oldestFirst = [...this.fills.values()].sort((a, b) => a.time - b.time);
    for (const fill of oldestFirst.slice(0, this.fills.size - MAX_FILLS)) {
      this.fills.delete(fill.key);
      this.sequence.delete(fill.key);
    }
    this.sorted = null;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn("fills.listener_failed", { error });
      }
    }
  }
}
