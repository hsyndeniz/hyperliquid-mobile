/**
 * Trade tape.
 *
 * The public `trades` feed for the market on screen — the scrolling list of
 * recent executions next to the book. Shaped like `BookStore`, not `FillsStore`:
 * the tape is a per-coin display surface, so a target switch **clears** rather
 * than retains, and anything for another coin is dropped rather than stored.
 * Showing ETH prints under a BTC header is the same class of bug as showing the
 * wrong book, and it is prevented the same way.
 *
 * Two deviations from `BookStore`, both forced by the payload:
 *
 * - **The channel delivers an array of rows, not a replaceable snapshot.** The
 *   subscribe-time backlog and every reconnect replay overlap with rows already
 *   held (the SDK resubscribes on every socket open, same as the fills feed),
 *   so rows are merged and deduplicated rather than replacing the whole value.
 * - **Dedup is by bare `tid`.** `FillsStore` documents why bare `tid` is wrong
 *   *there* — every Spot Dust Conversion carries `tid: 0`, and those rows come
 *   from the user-fill channels. This feed carries only matched trades for one
 *   coin, where `tid` is the exchange's own trade id; and because the store
 *   clears on every target switch, the keyspace never spans coins.
 *
 * Retention is a small fixed window (`TAPE_CAP`): a tape is a feel-of-the-market
 * surface, not history — deep history is a REST concern — and on a liquid market
 * the feed can print many rows per second, so an unbounded store grows without
 * limit for no rendering benefit.
 */

import { isForTarget } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const logger = log.child("state.trades");

/**
 * The wire shape of one `trades` row (verified against SDK 0.33.3).
 *
 * The channel delivers an **array** of these — one message can carry several
 * prints. `side` is the aggressor: `"B"` means a buyer lifted the ask, `"A"`
 * means a seller hit the bid. `users` is `[buyer, seller]` regardless of side.
 */
export interface TradeRow {
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
  users: [string, string];
}

/**
 * One tape entry, in our own naming.
 *
 * `side` is normalised from the wire's `"B"`/`"A"` once, at the boundary, so no
 * render branch re-decodes single letters. Prices and sizes stay **strings** —
 * the same rule as everywhere else in this module. `hash` and `users` are
 * deliberately not carried: nothing on a tape renders them, and `hash` is not
 * even unique (see `Fill.hash`).
 */
export type TradeTick = {
  tid: number;
  side: "buy" | "sell";
  px: string;
  sz: string;
  time: number;
};

/**
 * Retention bound.
 *
 * Sized to a screenful and a bit of scroll-back; a busy market refills this in
 * seconds, and a quiet one is better served by fewer, older prints than by an
 * empty list.
 */
export const TAPE_CAP = 60;

/** How long the feed may be silent before the tape stops counting as live. */
export const TAPE_MAX_AGE_MS = 10_000;

type Listener = () => void;

/**
 * Holds the tape for the currently selected target.
 *
 * One instance per surface, same as `BookStore`: not keyed by target
 * internally, because exactly one market's tape is ever current and rows for
 * anything else are discarded rather than retained.
 */
export class TradesStore {
  private target: SubscriptionTarget | null = null;
  private ticks = new Map<number, TradeTick>();
  private sorted: TradeTick[] | null = null;
  private lastReceivedAtMs = 0;
  private readonly listeners = new Set<Listener>();
  /** Counts drops so a silent mismatch is visible without per-tick logging. */
  private droppedCount = 0;

  /**
   * Point the store at a different market.
   *
   * Clears immediately. A tape from the previous coin must never survive the
   * switch, even for a frame — stale prints render as *wrong*, not as loading.
   */
  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      this.ticks.clear();
      this.sorted = null;
      this.lastReceivedAtMs = 0;
      this.droppedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  /**
   * Apply an inbound batch of rows.
   *
   * Two echo checks, both silent — a mismatch is the normal consequence of a
   * switch, not an error, and logging per print would itself cost latency:
   *
   * - The **envelope** must be for the current target, same as `BookStore`.
   * - Each **row** must carry the target's coin. The envelope check alone would
   *   pass a mixed batch through wholesale; the row's own `coin` field is the
   *   wire's echo, so it is the thing to verify.
   *
   * Duplicate `tid`s (the reconnect replay) are skipped without emitting: a
   * batch that adds nothing must leave `read()` referentially unchanged, or
   * every replay forces a pointless re-render of the whole tape.
   */
  apply(event: Scoped<readonly TradeRow[]>): void {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return;
    }
    // Even an all-duplicate replay proves the feed is alive, so freshness is
    // stamped before the dedup can conclude there is nothing new to store.
    this.lastReceivedAtMs = event.receivedAt;

    let added = false;
    for (const row of event.value) {
      if (row.coin !== this.target.coin) {
        this.droppedCount += 1;
        continue;
      }
      if (this.ticks.has(row.tid)) continue;
      this.ticks.set(row.tid, {
        tid: row.tid,
        side: row.side === "B" ? "buy" : "sell",
        px: row.px,
        sz: row.sz,
        time: row.time,
      });
      added = true;
    }
    if (!added) return;

    this.sorted = null;
    this.trim();
    this.emit();
  }

  /**
   * Newest first, tiebroken on `tid`.
   *
   * Several prints routinely share a millisecond on a busy market; `tid` is
   * assigned in execution order, so it is the correct tiebreak — arrival order
   * is not, because a reconnect replays old rows late.
   *
   * Memoised: the array is rebuilt only when the contents changed, so a caller
   * (or a React selector) can compare by reference.
   */
  read(): readonly TradeTick[] {
    return (this.sorted ??= [...this.ticks.values()].sort((a, b) => {
      if (b.time !== a.time) return b.time - a.time;
      return b.tid - a.tid;
    }));
  }

  /** When the feed last delivered for the current target; `0` before anything arrives. */
  get lastReceivedAt(): number {
    return this.lastReceivedAtMs;
  }

  /**
   * True when prints are held but the feed has gone quiet past the gate.
   *
   * Same shape as `BookStore`'s gate: an empty store is "nothing yet", not
   * stale — the distinction a surface needs to choose between a loading state
   * and greying out last-known prints.
   */
  isStale(now: number, maxAgeMs = TAPE_MAX_AGE_MS): boolean {
    return this.ticks.size > 0 && now - this.lastReceivedAtMs > maxAgeMs;
  }

  get size(): number {
    return this.ticks.size;
  }

  /** How many events or rows were discarded as belonging to another target. */
  get dropped(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.ticks.clear();
    this.sorted = null;
    this.lastReceivedAtMs = 0;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop the oldest by trade time (then `tid`), past the retention bound. */
  private trim(): void {
    if (this.ticks.size <= TAPE_CAP) return;
    const oldestFirst = [...this.ticks.values()].sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      return a.tid - b.tid;
    });
    for (const tick of oldestFirst.slice(0, this.ticks.size - TAPE_CAP)) {
      this.ticks.delete(tick.tid);
    }
    this.sorted = null;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // A throwing consumer must not break the feed for the others.
        logger.warn("trades.listener_failed", { error });
      }
    }
  }
}
