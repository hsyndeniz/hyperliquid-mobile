/**
 * Messages the exchange sends directly to a user.
 *
 * Liquidation warnings and anything else Hyperliquid wants to tell someone.
 * Until now this client could not receive one — and the gap was two links deep,
 * which is worth recording because only one of them was obvious:
 *
 * 1. `state/channels.ts` could subscribe the channel, but `ACCOUNT_CHANNELS` in
 *    `state/accountSession.ts` never listed it, so no session opened it.
 * 2. `sessionRouting.ts` had no case for it, and its `default` branch returns
 *    silently — not even counted — so a message would have vanished without
 *    trace even once the feed was open.
 *
 * ## The payload is a bare string
 *
 * ```ts
 * type NotificationEvent = { notification: string };
 * ```
 *
 * No id, no severity, no type, no timestamp, and no `user`. Three consequences
 * shape this store:
 *
 * - **The id is minted here.** Two identical strings a millisecond apart are two
 *   real events, so `seq` is a local monotonic counter. Nothing on the wire can
 *   serve as a dedup key, and inventing one from the text would collapse a
 *   repeated warning into a single row.
 * - **The timestamp is ours.** `readServerTime` has no case for this channel and
 *   the payload carries no `time`, so `receivedAt` from the `Scoped` envelope is
 *   the only clock available.
 * - **It is a log, not a snapshot.** Every other account store holds a
 *   whole-value replacement; this one appends, bounded to
 *   {@link NOTIFICATION_LOG_CAP}. A burst during a liquidation must not overwrite
 *   the messages that explain it.
 *
 * ## Unobserved
 *
 * The shape above is the SDK's declaration. **This project has never seen a live
 * frame** — the exchange only emits one on a real account event, and none can be
 * provoked read-only. `apply` therefore degrades rather than corrupts: an
 * unrecognised frame is counted in `dropped` and stored nowhere. A caller should
 * not read silence as health; it is the same caveat recorded for
 * `outcomeMetaUpdates` in `predictions/catalogStore.ts`.
 */

import { isForTarget } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const logger = log.child("state.notifications");

/**
 * How many messages are kept.
 *
 * A cap rather than unbounded growth, because nothing else evicts: notifications
 * arrive for the life of a session and no store elsewhere trims on their behalf.
 * Fifty is far more than a user will read and small enough to hold forever.
 */
export const NOTIFICATION_LOG_CAP = 50;

/** One message, with the identity the wire could not give it. */
export interface Notification {
  /**
   * Monotonic within this store, minted locally.
   *
   * The only usable key: the wire supplies no id, and text and timestamp both
   * collide in practice.
   */
  seq: number;
  text: string;
  /** Device clock — the channel carries no server time. */
  receivedAt: number;
}

type Listener = () => void;

export class NotificationStore {
  private target: SubscriptionTarget | null = null;
  private entries: Notification[] = [];
  /** Memoised so `read()` is referentially stable between mutations. */
  private view: readonly Notification[] | null = null;
  /** `unacknowledged()`'s memo, keyed on the two inputs it derives from. */
  private unackedView: readonly Notification[] | null = null;
  private unackedFrom: readonly Notification[] | null = null;
  private unackedThrough = -1;
  private nextSeq = 1;
  private acknowledgedThrough = 0;
  private staleOverride = false;
  private lastReceivedAt = 0;
  private readonly listeners = new Set<Listener>();
  private droppedCount = 0;

  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      // Everything, including the sequence and the acknowledgement watermark.
      // One account's liquidation warning appearing under another's header is
      // the whole reason this clears rather than merely guarding.
      this.entries = [];
      this.view = null;
      this.nextSeq = 1;
      this.acknowledgedThrough = 0;
      this.staleOverride = false;
      this.lastReceivedAt = 0;
      this.droppedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  /**
   * Append one message.
   *
   * @returns whether anything was stored.
   */
  apply(event: Scoped<unknown>): boolean {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return false;
    }

    const text = readNotification(event.value);
    if (text === null) {
      // A shape change costs the message and is counted — never stored as
      // `undefined`, which would render as an empty toast.
      this.droppedCount += 1;
      logger.warn("notification.unreadable", { context: { channel: event.target.channel } });
      return false;
    }

    this.entries.push({ seq: this.nextSeq++, text, receivedAt: event.receivedAt });
    if (this.entries.length > NOTIFICATION_LOG_CAP) {
      this.entries = this.entries.slice(-NOTIFICATION_LOG_CAP);
    }
    this.lastReceivedAt = event.receivedAt;
    this.emit();
    return true;
  }

  /** Oldest first, so a list reads in the order the messages arrived. */
  read(): readonly Notification[] {
    return (this.view ??= [...this.entries]);
  }

  /**
   * Messages a caller has not yet acknowledged.
   *
   * Same shape as `predictions/catalogStore.ts`'s settlement log, and for the
   * same reason: a toast must be shown once, and the store is the only place
   * that can say which ones already were.
   */
  unacknowledged(): readonly Notification[] {
    // Memoised, and memoised on its INPUTS rather than by nulling a field at
    // every mutation site. Two reasons it has to be stable at all:
    //
    // 1. A caller reads it through `useStoreValue`, whose selector runs every
    //    render and is compared with `Object.is`. A fresh array each call
    //    re-renders forever.
    // 2. It used to be called raw in render instead, and the React Compiler
    //    cached the result against the store's identity — which never changes,
    //    because the store outlives every identity switch. The banner froze at
    //    whatever the log held when Portfolio first mounted, so a later
    //    liquidation warning never appeared and a dismissal never cleared.
    //
    // Keying off `read()`'s identity and the watermark means the cache cannot
    // go stale even if a future mutation forgets to invalidate anything.
    const rows = this.read();
    if (
      this.unackedView !== null &&
      this.unackedFrom === rows &&
      this.unackedThrough === this.acknowledgedThrough
    ) {
      return this.unackedView;
    }
    this.unackedFrom = rows;
    this.unackedThrough = this.acknowledgedThrough;
    this.unackedView = rows.filter((entry) => entry.seq > this.acknowledgedThrough);
    return this.unackedView;
  }

  /**
   * Mark everything up to and including `seq` as shown.
   *
   * Deliberately not "acknowledge all": a message arriving while a toast is on
   * screen would then be swallowed unseen. The caller acknowledges what it
   * actually rendered.
   */
  acknowledge(seq: number): void {
    if (seq <= this.acknowledgedThrough) return;
    this.acknowledgedThrough = seq;
    this.emit();
  }

  /**
   * Whether the feed looks dead.
   *
   * **A quiet notification channel is normal** — most accounts receive none for
   * days — so this reports staleness only once something has arrived. Before
   * that there is nothing to be stale about, and reporting `true` would put a
   * warning on every healthy new session.
   */
  isStale(now: number, maxAgeMs: number): boolean {
    if (this.staleOverride) return true;
    if (this.lastReceivedAt === 0) return false;
    return now - this.lastReceivedAt > maxAgeMs;
  }

  markStale(): void {
    this.staleOverride = true;
    this.emit();
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** Empties the log without disturbing the target or the counters. */
  clear(): void {
    this.entries = [];
    this.view = null;
    this.acknowledgedThrough = 0;
    this.staleOverride = false;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.view = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn("notifications.listener_failed", { error });
      }
    }
  }
}

/**
 * Pull the message out of a frame, or `null`.
 *
 * Accepts the documented `{ notification }` envelope and a bare string, because
 * the shape has never been observed live and the second form costs one line. An
 * empty string is rejected: it is indistinguishable from a missing field to a
 * reader, and an empty toast is worse than none.
 */
export function readNotification(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value !== "object" || value === null) return null;
  const text = (value as { notification?: unknown }).notification;
  return typeof text === "string" && text.length > 0 ? text : null;
}
