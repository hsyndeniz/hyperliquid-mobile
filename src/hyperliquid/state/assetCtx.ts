/**
 * Per-market asset context — the live side of a market detail screen.
 *
 * `activeAssetCtx` pushes `{ coin, ctx }` for exactly one perp market: mark,
 * oracle, funding, open interest, day volume. Same honesty rules as the order
 * book (`state/book.ts`), for the same reasons:
 *
 * 1. **A write for a non-current target is dropped, not stored.** In-flight
 *    events from the previous coin keep arriving after a switch; storing one
 *    puts the wrong market's funding under this market's name.
 * 2. **Switching target clears immediately.** Empty renders as loading; stale
 *    renders as wrong.
 * 3. **Reads go through a freshness gate.** A held ctx older than
 *    {@link CTX_MAX_AGE_MS} reads as `null`, never as live numbers.
 *
 * Two facts specific to this channel, measured on testnet (2026-08-15):
 *
 * - `midPx` / `premium` / `impactPxs` are **co-null on 55/210 perps** (bookless
 *   markets). Null passes through to the view — a `"0"` default would render a
 *   fabricated price of zero as if the wire had said so.
 * - The payload carries **no server timestamp** (`readServerTime` finds no
 *   `time` field, so `Scoped.serverTime` is null). Ordering falls back to
 *   `receivedAt`, which is stamped in arrival order — book.ts's out-of-order
 *   drop would be vacuous here and is deliberately absent.
 *
 * The ctx is parsed **once per accepted event**, never per read:
 * `useSyncExternalStore` compares snapshots with `Object.is`, and a `read` that
 * built a fresh view object each call would re-render forever.
 */

import { freshValue, isForTarget } from "@/hyperliquid/core/freshness";
import { subscriptionKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";
import type { IActiveAssetCtxEvent, IPerpAssetCtx } from "@/hyperliquid/types/sdk";

const logger = log.child("state.assetCtx");

/** How old a ctx may be before it stops counting as live. */
export const CTX_MAX_AGE_MS = 10_000;

/**
 * The slice of a perp ctx a detail surface renders. Wire strings, verbatim —
 * BigNumber consumers parse them, display leaves format them.
 */
export interface AssetCtxView {
  markPx: string;
  /** Null on bookless markets. Renders as an absence, never as 0. */
  midPx: string | null;
  oraclePx: string;
  /** Hourly rate as a signed fraction (`0.0000125` = 0.00125%/hr), wire unit. */
  funding: string;
  /** In base currency; the USD figure is `openInterest × markPx`. */
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  impactPxs: readonly [string, string] | null;
}

/**
 * Map the wire ctx to the view.
 *
 * `?? null` on the nullable trio so an absent field lands as an honest `null`
 * rather than `undefined` leaking through a `string | null` type.
 */
export function toAssetCtxView(ctx: IPerpAssetCtx): AssetCtxView {
  return {
    markPx: ctx.markPx,
    midPx: ctx.midPx ?? null,
    oraclePx: ctx.oraclePx,
    funding: ctx.funding,
    openInterest: ctx.openInterest,
    prevDayPx: ctx.prevDayPx,
    dayNtlVlm: ctx.dayNtlVlm,
    premium: ctx.premium ?? null,
    impactPxs: ctx.impactPxs ?? null,
  };
}

type Listener = () => void;

/**
 * Holds the ctx for the currently selected market.
 *
 * One instance per surface. Not keyed by target internally: exactly one market
 * is on screen, and anything else is discarded rather than retained.
 */
export class AssetCtxStore {
  private target: SubscriptionTarget | null = null;
  private scoped: Scoped<AssetCtxView> | null = null;
  private readonly listeners = new Set<Listener>();
  /** Set by `markStale`; cleared by the next accepted event. */
  private staleOverride = false;
  /** Counts drops so a silent mismatch is visible without per-tick logging. */
  private droppedCount = 0;

  /**
   * Point the store at a different market.
   *
   * Clears immediately. A ctx from the previous coin must never survive the
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
   * Apply an inbound event.
   *
   * Silently ignores anything for a different target — the normal consequence
   * of a switch, not an error, and logging per tick would itself cost latency.
   * Parsing happens here, once, so `read` can hand back the same object until
   * the next accepted event.
   */
  apply(event: Scoped<IActiveAssetCtxEvent>): void {
    if (!this.target || !isForTarget(event, this.target)) {
      this.droppedCount += 1;
      return;
    }
    this.scoped = { ...event, value: toAssetCtxView(event.value.ctx) };
    this.staleOverride = false;
    this.emit();
  }

  /**
   * The view, or `null` when there is nothing safe to show.
   *
   * `null` covers both "nothing yet" and "too old" deliberately: a surface
   * should render its empty state in either case rather than showing numbers it
   * cannot vouch for.
   */
  read(now: number, maxAgeMs = CTX_MAX_AGE_MS): AssetCtxView | null {
    if (!this.target || this.staleOverride) return null;
    return freshValue(this.scoped, this.target, maxAgeMs, now);
  }

  /** The raw envelope, for surfaces that want to show *why* data is stale. */
  readScoped(): Scoped<AssetCtxView> | null {
    return this.scoped;
  }

  /** True when a ctx is held but too old to display. */
  isStale(now: number, maxAgeMs = CTX_MAX_AGE_MS): boolean {
    return this.scoped !== null && this.read(now, maxAgeMs) === null;
  }

  /**
   * Mark the held ctx unusable without discarding it.
   *
   * Used on resume from background: keeping it lets a surface show last-known
   * values greyed out rather than flashing empty, while `read` still refuses to
   * call it fresh.
   */
  markStale(): void {
    if (!this.scoped) return;
    // A separate flag rather than zeroing the timestamps: the greyed-out render
    // this exists for wants to say "as of 14:32", and destroying receivedAt
    // removes exactly that. Freshness reads the flag.
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
        logger.warn("assetctx.listener_failed", { error });
      }
    }
  }
}
