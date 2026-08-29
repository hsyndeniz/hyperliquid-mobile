/**
 * Spot balances.
 *
 * The simplest of the account stores: a whole-value replace, like `BookStore`
 * but without its TTL. It matters more than its size suggests, because an
 * account that looks empty on the perp side is routinely holding its whole
 * balance in spot.
 *
 * **It is not where a bridge deposit arrives.** This file used to say it was.
 * Measured against first-time depositors on mainnet — accounts whose entire
 * history is one `{type:"deposit"}` ledger row — the money credits the **perp**
 * account: 1000.3367 deposited, `accountValue` 1000.3367, `balances: []`. Three
 * of four such accounts matched to the cent. So a "deposit received" screen that
 * watches this store waits forever.
 *
 * Deliberately **not** dex-scoped. `spotState` has no `dex` parameter and its
 * event carries no `dex` field; the target inherits the identity's dex only
 * because the subscription key is built from the whole identity.
 */

import { isForTarget } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type {
  Scoped,
  SpotBalance,
  SpotState,
  SubscriptionTarget,
} from "@/hyperliquid/types/domain";

const logger = log.child("state.spot");

type Listener = () => void;

export class SpotBalanceStore {
  private target: SubscriptionTarget | null = null;
  private scoped: Scoped<SpotState> | null = null;
  private signature: string | null = null;
  private staleOverride = false;
  private readonly listeners = new Set<Listener>();
  private droppedCount = 0;

  setTarget(target: SubscriptionTarget | null): void {
    const changed =
      !this.target || !target || subscriptionKey(this.target) !== subscriptionKey(target);
    this.target = target;
    if (changed) {
      this.scoped = null;
      this.signature = null;
      this.staleOverride = false;
      this.droppedCount = 0;
      this.emit();
    }
  }

  currentTarget(): SubscriptionTarget | null {
    return this.target;
  }

  apply(event: Scoped<SpotState>): boolean {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return false;
    }
    // A ~5s heartbeat that re-sends an identical payload; emitting on each would
    // give the balance list a new object identity every 5s forever.
    const signature = JSON.stringify(event.value.balances);
    const unchanged = this.scoped !== null && signature === this.signature;

    // Keep the OLD value object on an identical push — `read()` is a
    // `getSnapshot`, and a fresh object for identical content re-renders every
    // balance row on each heartbeat even though nothing moved.
    this.scoped = unchanged ? { ...event, value: this.scoped!.value } : event;
    this.staleOverride = false;

    if (unchanged) return false;

    this.signature = signature;
    this.emit();
    return true;
  }

  /** No freshness gate: a blank balance list reads as "your funds are gone". */
  read(): SpotState | null {
    return this.target ? (this.scoped?.value ?? null) : null;
  }

  readScoped(): Scoped<SpotState> | null {
    return this.scoped;
  }

  /**
   * One balance by coin.
   *
   * Keyed on `coin` rather than `token` because outcome-market rows carry no
   * `token` at all — 142 of 196 rows on one recorded account — so a token-keyed
   * index collides every one of them under a single `undefined` key.
   */
  balanceOf(coin: string): SpotBalance | null {
    return this.scoped?.value.balances.find((b) => b.coin === coin) ?? null;
  }

  isStale(now: number, maxAgeMs: number): boolean {
    if (this.staleOverride) return true;
    if (!this.scoped) return true;
    return now - this.scoped.receivedAt > maxAgeMs;
  }

  markStale(): void {
    if (!this.scoped) return;
    this.staleOverride = true;
    this.emit();
  }

  get dropped(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.scoped = null;
    this.signature = null;
    this.staleOverride = false;
    this.emit();
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
        logger.warn("spot.listener_failed", { error });
      }
    }
  }
}
