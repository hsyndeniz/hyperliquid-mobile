/**
 * Open orders.
 *
 * **The `openOrders` feed is the sole authority for a row.** `orders/pending`
 * and `orders/reconcile` never write one; they populate a separate `unconfirmed`
 * overlay keyed by cloid, merged only at read time.
 *
 * That separation exists because three producers claim knowledge of one order
 * and two of them can hand back a null `oid`. `startupReconcile`'s `landed`
 * verdicts carry `oid: number | null`, and its `identity` parameter is optional
 * — called without it, it sweeps every journalled account. An oid-keyed store
 * fed those verdicts gets a permanent phantom the user cannot cancel, possibly
 * belonging to a different account.
 *
 * Rows are keyed by `oid`, never by `cloid`: a real trader reused cloid
 * `0xa1c759b8…` across oid 57378687005 (filled) and oid 57378791975 (open) one
 * second apart on the same account. cloid is a correlation tag, not a key.
 *
 * The snapshot is a **whole replace**. The event carries the full array with no
 * delta marker, so a merging store keeps cancelled orders on screen forever.
 */

import { isForTarget } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Cloid } from "@/hyperliquid/orders/cloid";
import type { OpenOrderRow, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const logger = log.child("state.openOrders");

/**
 * How long past its reconciliation deadline an unconfirmed order may linger.
 *
 * A backstop only: the first three eviction rules should always fire first.
 * Without it a broken feed leaves a ghost row forever.
 */
export const UNCONFIRMED_TTL_MS = 60_000;

/** Snapshot size past which the bandwidth cost is worth a single log line. */
const LARGE_SNAPSHOT = 200;

/**
 * An order this client submitted that no authoritative snapshot has confirmed.
 *
 * Rendered distinctly — it is a claim, not a fact.
 */
export interface UnconfirmedOrder {
  cloid: Cloid;
  /** Null when the reconciler could not read one from the response body. */
  oid: number | null;
  label: string | null;
  submittedAt: number;
  /** When reconciliation gave up waiting for it to appear. */
  expiresAt: number;
}

export interface OpenOrdersView {
  /** Confirmed by the exchange. */
  rows: readonly OpenOrderRow[];
  /** Submitted by us, not yet seen in a snapshot. */
  unconfirmed: readonly UnconfirmedOrder[];
  /**
   * True when the row source returned fewer rows than the exchange holds.
   *
   * Observed on testnet: `frontendOpenOrders` returned 100 rows for a
   * 3,196-order account, covering 5 of 154 coins, and the 100 were not the
   * newest. Not reproduced on mainnet — so it passes production QA and fails in
   * the development environment.
   */
  truncated: boolean;
  totalKnown: number | null;
}

type Listener = () => void;

export class OpenOrdersStore {
  private target: SubscriptionTarget | null = null;
  private rows = new Map<number, OpenOrderRow>();
  private unconfirmed = new Map<Cloid, UnconfirmedOrder>();
  private signature: string | null = null;
  /** Memoised merged view. Must be referentially stable — see `read`. */
  private view: OpenOrdersView | null = null;
  private lastSnapshotAt = 0;
  private truncated = false;
  private totalKnown: number | null = null;
  private staleOverride = false;
  private warnedLarge = false;
  private readonly listeners = new Set<Listener>();
  private droppedCount = 0;
  private rejectedCount = 0;

  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      this.rows.clear();
      this.unconfirmed.clear();
      this.signature = null;
      this.lastSnapshotAt = 0;
      this.truncated = false;
      this.totalKnown = null;
      this.staleOverride = false;
      this.warnedLarge = false;
      this.droppedCount = 0;
      this.rejectedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  /**
   * Replace the authoritative set.
   *
   * `echoDex` guards the same failure `AccountStore` guards: a real-but-wrong
   * dex answers 200 with an empty list, which renders as "no open orders" to
   * someone with live resting risk.
   */
  apply(event: Scoped<readonly OpenOrderRow[]>, echoDex?: string): boolean {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return false;
    }
    if (echoDex !== undefined && echoDex !== (this.target.identity.dex ?? "")) {
      this.rejectedCount += 1;
      logger.warn("openOrders.echo_mismatch", { context: { receivedDex: echoDex } });
      return false;
    }

    if (event.value.length > LARGE_SNAPSHOT && !this.warnedLarge) {
      // Once per target. This channel re-sends the full array every ~5s, so a
      // large account is a real, silent bandwidth cost worth making visible.
      this.warnedLarge = true;
      logger.warn("openOrders.large_snapshot", { context: { rows: event.value.length } });
    }

    this.lastSnapshotAt = event.receivedAt;
    this.staleOverride = false;
    const evicted = this.evictUnconfirmed(event.value, event.receivedAt);

    const signature = JSON.stringify(event.value);
    if (signature === this.signature) {
      // Rows unchanged, but `evictUnconfirmed` above may have dropped an overlay
      // entry — a visible change even when the authoritative set is not, and one
      // that reaches nobody unless we say so. Dropping the memoised view is not
      // enough: `useSyncExternalStore` only re-reads on a commit, so without an
      // emit a component subscribed to this store alone renders the evicted
      // pending row indefinitely. The common case is exactly this one — an order
      // that never rested produces a byte-identical snapshot, so the eviction
      // that removes it always lands on this path.
      //
      // Emitting unconditionally here would re-render every 5s for a stable
      // book, which is what the signature check exists to prevent; hence the
      // flag rather than a blanket emit.
      this.view = null;
      if (evicted) this.emit();
      return false;
    }

    this.signature = signature;
    this.rows = new Map(event.value.map((row) => [row.oid, row]));
    this.emit();
    return true;
  }

  /** Record the dual-endpoint truncation check performed by the REST seed. */
  setCoverage(params: { truncated: boolean; totalKnown: number | null }): void {
    this.truncated = params.truncated;
    this.totalKnown = params.totalKnown;
    this.emit();
  }

  /**
   * Track an order we submitted but have not yet seen confirmed.
   *
   * Ignored when the authoritative rows already carry that cloid: `read()`
   * spreads rows and overlay into two arrays with no de-duplication, so adding
   * one that is already confirmed renders the same order twice — once as a real
   * row, once as a pending claim. The case is routine rather than exotic:
   * startup reconciliation probes a journalled cloid over HTTP while the ~5 s
   * websocket snapshot has usually already delivered the row.
   */
  addUnconfirmed(order: UnconfirmedOrder): boolean {
    for (const row of this.rows.values()) {
      if (row.cloid === order.cloid) return false;
    }
    this.unconfirmed.set(order.cloid, order);
    this.emit();
    return true;
  }

  /** Drop an overlay entry — an `orderUpdates` frame reporting a terminal status. */
  removeUnconfirmed(cloid: Cloid): boolean {
    const removed = this.unconfirmed.delete(cloid);
    if (removed) this.emit();
    return removed;
  }

  /**
   * Overlay eviction, in order of authority.
   *
   * 1. The cloid is in the snapshot — the real row wins.
   * 2. A snapshot taken *after* we submitted does not contain it, and its
   *    reconciliation deadline has passed — it never rested, or it is terminal.
   * 3. Hard TTL, so a broken feed cannot leave a ghost forever.
   *
   * @returns whether anything was removed, so the caller knows a subscriber has
   *   to be told even when the authoritative rows did not change.
   */
  private evictUnconfirmed(rows: readonly OpenOrderRow[], receivedAt: number): boolean {
    if (this.unconfirmed.size === 0) return false;
    const confirmed = new Set(rows.map((row) => row.cloid).filter((c): c is Cloid => c !== null));
    let evicted = false;

    for (const [cloid, order] of this.unconfirmed) {
      if (confirmed.has(cloid)) {
        this.unconfirmed.delete(cloid);
        evicted = true;
        continue;
      }
      const snapshotIsNewer = receivedAt > order.submittedAt;
      if (snapshotIsNewer && receivedAt > order.expiresAt) {
        this.unconfirmed.delete(cloid);
        evicted = true;
        continue;
      }
      if (receivedAt > order.expiresAt + UNCONFIRMED_TTL_MS) {
        this.unconfirmed.delete(cloid);
        evicted = true;
      }
    }
    return evicted;
  }

  /**
   * The merged view: confirmed rows plus our own unconfirmed submissions.
   *
   * **Referentially stable between mutations.** This is the `getSnapshot` a
   * `useSyncExternalStore` binding calls on every render, and React compares it
   * with `Object.is` — a fresh object each call is an infinite render loop.
   */
  read(): OpenOrdersView {
    return (this.view ??= {
      rows: [...this.rows.values()],
      unconfirmed: [...this.unconfirmed.values()],
      truncated: this.truncated,
      totalKnown: this.totalKnown,
    });
  }

  byOid(oid: number): OpenOrderRow | null {
    return this.rows.get(oid) ?? null;
  }

  get size(): number {
    return this.rows.size;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get rejected(): number {
    return this.rejectedCount;
  }

  isStale(now: number, maxAgeMs: number): boolean {
    return this.staleOverride || this.lastSnapshotAt === 0 || now - this.lastSnapshotAt > maxAgeMs;
  }

  markStale(): void {
    this.staleOverride = true;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // Every mutation path ends here, so this is the one place the memoised view
    // has to be dropped — a store that emits a stale snapshot is worse than one
    // that recomputes.
    this.view = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        logger.warn("openOrders.listener_failed", { error });
      }
    }
  }
}
