/**
 * Identity-switch orchestration for account state.
 *
 * The stores each guard their own writes with `isForTarget`, but a guard drops
 * *incoming* events — it does not clear what is already held. A store without a
 * `setTarget(null)` call site therefore keeps the previous account's balance on
 * screen indefinitely. This module is that call site, and it owns the order the
 * steps have to happen in.
 *
 * **One websocket transport per identity.** This is not tidiness. Measured on
 * live testnet: two accounts subscribed on one transport, and listener A and
 * listener B each received an *identical* 4,815-update `orderUpdates` stream and
 * identical `userEvents` streams. Only `userFills` is filtered by the SDK; the
 * `orderUpdates` and `userEvents` wire frames carry **no user field at all**, so
 * nothing downstream can filter them. Account B's fills would appear in account
 * A's history with no way to tell.
 */

import { HlError } from "@/hyperliquid/core/errors";
import { effectiveAddress, identityKey } from "@/hyperliquid/core/identity";
import type { ResubscribeMode } from "@/hyperliquid/state/appState";
import { log } from "@/hyperliquid/core/logger";
import type { HlIdentity, SubscriptionTarget } from "@/hyperliquid/types/domain";

const logger = log.child("state.accountSession");

/**
 * The server's own cap on distinct users per websocket connection.
 *
 * 15, not the 10 the published rate-limit page claims — verified by exceeding
 * it and reading the error frame back.
 */
export const MAX_USERS_PER_CONNECTION = 15;

/** Channels an account needs. Ordered cheapest-first so a partial open is useful. */
export const ACCOUNT_CHANNELS = [
  "clearinghouseState",
  "spotState",
  "openOrders",
  "userFills",
  "userTwapSliceFills",
  "orderUpdates",
  // Last: cheap, and near-silent on most accounts. It carries liquidation
  // warnings, so it must be open — but nothing else waits on it.
  "notification",
] as const;

/** `ACCOUNT_CHANNELS` as a set, for the scoped reconcile. */
const ACCOUNT_CHANNEL_SET: ReadonlySet<string> = new Set(ACCOUNT_CHANNELS);

/**
 * Channels whose wire frames carry no user field.
 *
 * These are the ones that make a shared transport unsafe: with no user on the
 * frame, a second identity's updates are indistinguishable from the first's.
 */
export const UNFILTERABLE_CHANNELS = new Set<string>([
  "orderUpdates",
  "userEvents",
  // Its frame is `{notification: string}` — no user, nothing to filter on.
  "notification",
]);

/** The store operations this module drives. Structural, so tests need no stores. */
export interface ScopedStore {
  setTarget(target: SubscriptionTarget | null): void;
  markStale(): void;
}

/**
 * A store bound to the channel it serves.
 *
 * The binding is explicit because the obvious shortcut is wrong: a store's
 * `apply` guard compares a full `subscriptionKey`, which **includes the
 * channel**, so handing every store the same target makes each one reject every
 * event except the one channel that happens to match. Measured before this was
 * fixed: the open-orders and spot stores dropped 100% of their events and
 * displayed nothing at all, while positions worked — so the app looked alive.
 */
export interface BoundStore {
  store: ScopedStore;
  /** The channel whose target this store takes. */
  channel: SubscriptionTarget["channel"];
}

export interface AccountRegistry {
  removeForIdentity(identity: HlIdentity): Promise<void>;
  reconcile(targets: readonly SubscriptionTarget[]): Promise<void>;
  /** Reconcile within one channel set, leaving every other subscription alone. */
  reconcileWithin(
    channels: ReadonlySet<string>,
    targets: readonly SubscriptionTarget[]
  ): Promise<{ requested: number; opened: number; failed: string[] } | void>;
  closeAll(): Promise<void>;
  /** Bumps the generation so an in-flight subscribe discards itself. */
  invalidateInFlight(): void;
  /** Drops handles without unsubscribing — for a socket already dead. */
  releaseAll(): Promise<void>;
  /** The SDK tore down a confirmed subscription; drop our stale handle for it. */
  onFailed(target: SubscriptionTarget): void;
  readonly activeCount: number;
  distinctUserCount(): number;
}

export interface AccountBudget {
  forget(identity: HlIdentity): void;
}

/** Rebuilds the websocket transport. One per identity — see the module note. */
export type TransportRebuilder = () => void | Promise<void>;

export interface AccountSessionOptions {
  registry: AccountRegistry;
  /** Each store with the channel it serves. See `BoundStore`. */
  stores: readonly BoundStore[];
  budget?: AccountBudget;
  rebuildTransport?: TransportRebuilder;
  /** Restricts the channel set — e.g. to skip `orderUpdates` on a read-only view. */
  channels?: readonly SubscriptionTarget["channel"][];
}

/** The subscription targets one identity needs. */
export function accountTargetsFor(
  identity: HlIdentity,
  channels: readonly SubscriptionTarget["channel"][] = ACCOUNT_CHANNELS
): SubscriptionTarget[] {
  return channels.map((channel) => ({
    identity,
    channel,
    coin: null,
    aggregation: null,
    interval: null,
  }));
}

export class AccountSession {
  private current: HlIdentity | null = null;

  constructor(private readonly options: AccountSessionOptions) {}

  currentIdentity(): HlIdentity | null {
    return this.current;
  }

  /**
   * Point every account store and subscription at a different identity.
   *
   * The order matters and is not interchangeable:
   *
   * 1. Stop the writers, so nothing lands mid-clear.
   * 2. Clear the stores — the guard drops future writes, this removes the past.
   * 3. Forget the old action budget, which is per-address.
   * 4. Rebuild the transport, because `orderUpdates` cannot be filtered by user.
   * 5. Point the stores at the new target, then subscribe.
   *
   * The per-cloid order journal is deliberately **not** cleared: it is
   * identity-tagged and has to survive so a submit that was in flight during the
   * switch can still be reconciled.
   */
  async switchTo(next: HlIdentity | null): Promise<SubscriptionTarget[]> {
    // SERIALISED per instance. Every switch runs to completion before the next
    // one starts, and that is a correctness property rather than tidiness.
    //
    // This method awaits five times (registry removal, transport rebuild,
    // reconcile, …) and had no mutual exclusion, so two callers interleaved
    // freely — and the pair that actually happens is a switch racing a
    // teardown. `HyperliquidSession.stop()` calls `switchTo(null)` while a
    // `start()` may already be inside `switchTo(identity)`; when the start's
    // call resumed past its awaits it set store targets and reconciled the
    // account channels back onto a session that had already published `null`,
    // leaving seven live subscriptions — and, on the second path, a whole open
    // socket — belonging to an account the user had signed out of.
    //
    // The epoch checkpoints in `startInternal` cannot close this: they bracket
    // the call, and nothing inside it is cancellable. Queuing IS the fix here,
    // because the operations are short and their end state is what matters:
    // whichever switch the caller issued last is the one that wins, and it
    // observes a settled world rather than a half-torn-down one.
    const run = this.inFlight.then(
      () => this.switchToInternal(next),
      () => this.switchToInternal(next)
    );
    // The queue must survive a rejection, or one failed switch wedges the
    // session for good.
    this.inFlight = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** The queue every {@link switchTo} joins. Never rejects — see above. */
  private inFlight: Promise<unknown> = Promise.resolve();

  private async switchToInternal(next: HlIdentity | null): Promise<SubscriptionTarget[]> {
    const previous = this.current;
    if (previous && next && identityKey(previous) === identityKey(next)) {
      return accountTargetsFor(next, this.options.channels);
    }

    if (previous) {
      await this.options.registry.removeForIdentity(previous);
    }
    for (const bound of this.options.stores) bound.store.setTarget(null);
    if (previous) this.options.budget?.forget(previous);

    // Any frame still in flight on the old socket belongs to the old identity
    // and cannot be attributed once a second user is tracked on it.
    //
    // The generation bump comes FIRST and is not optional. `rebuildTransport`
    // destroys the socket, and a subscribe still in flight would otherwise pass
    // the registry's `isCurrent()` check on arrival and register its handle
    // against a connection that no longer exists — precisely the case the
    // generation token was written for, and the one path where it was never
    // armed. `closeAll()` bumps, but it only runs when switching to `null`.
    this.options.registry.invalidateInFlight();
    await this.options.rebuildTransport?.();

    // Enforced here rather than left to the server, which answers a 16th user
    // by closing the connection rather than refusing the subscribe. Checked
    // AFTER the previous identity's subscriptions are gone, so an ordinary
    // switch — which nets to zero new users — is never refused.
    //
    // It had no production caller at all until this: the cap was documented,
    // measured at 15 against the published 10, given an error message, and then
    // never consulted.
    if (next) this.assertCapacity();

    this.current = next;
    if (!next) {
      await this.options.registry.closeAll();
      logger.info("account.session_closed", {});
      return [];
    }

    const targets = accountTargetsFor(next, this.options.channels);
    for (const bound of this.options.stores) {
      // Its OWN channel's target, not the first one. A store whose target names
      // a different channel rejects every event it receives.
      const target = targets.find((candidate) => candidate.channel === bound.channel);
      if (!target) {
        throw new HlError(`No target for channel ${bound.channel}`, {
          code: "invalid_config",
          context: { channel: bound.channel },
        });
      }
      bound.store.setTarget(target);
    }
    // Scoped to the channels this session OWNS. A plain `reconcile` makes the
    // live set exactly `targets`, which tore down every market-data
    // subscription on the same registry — `l2Book`, `candle`, `trades` — with
    // nothing to re-add them. A chart on the same screen as the account
    // switcher froze permanently, with no error and no reset that reloads.
    //
    // Account data is account-scoped and must go. A price is not: BTC costs the
    // same whichever account is looking at it.
    const result = await this.options.registry.reconcileWithin(ACCOUNT_CHANNEL_SET, targets);

    // What actually OPENED, not what was asked for. A failed subscribe is
    // swallowed so one dead channel cannot fail an account switch — but logging
    // `targets.length` reported seven channels open when five were, and the only
    // other trace was a `subscribe.failed` warning nobody correlated.
    const opened = result && "opened" in result ? result.opened : targets.length;
    const failed = result && "failed" in result ? result.failed : [];
    logger[failed.length > 0 ? "warn" : "info"]("account.session_switched", {
      context: {
        user: effectiveAddress(next),
        requested: targets.length,
        opened,
        ...(failed.length > 0 && { failed }),
      },
    });
    return targets;
  }

  /**
   * Mark every account store stale, retaining its value.
   *
   * Called on resume from background, *before* the async resubscribe completes —
   * which is exactly why the stores flag rather than discard. A greyed-out
   * balance is honest; a blank one reads as "your money is gone".
   */
  /**
   * Rebuild every account subscription against the current identity.
   *
   * For a resume from background, where the socket has very likely been dropped
   * without anyone being told. `releaseAll()` genuinely unsubscribes: this used
   * to call `forgetAll()`, which dropped the handles on the theory that
   * unsubscribing over a dead socket would throw. It does not — and dropping
   * them left the SDK holding the old listener while the re-add attached a
   * second, once per resume, unbounded for the session.
   *
   * **But releasing is only safe when the socket can carry the re-add**, which
   * is why this takes a mode instead of always doing the same thing. The SDK
   * preserves its `_subscriptions` map across a non-terminal close so
   * `_handleOpen` can replay every channel with its original listener, and our
   * unsubscribe deletes from that very map. Releasing mid-reconnect therefore
   * erases the recovery AND cannot land its replacement — every account channel
   * ends up dead with nothing to re-drive it, while market feeds keep ticking
   * and hide the fact. `decideOnResume` returns `none` for that state, so this
   * is never called there; the branch below is the belt to that braces.
   *
   * Market-data subscriptions are rebuilt by their own surfaces, not here.
   */
  async resubscribe(mode: ResubscribeMode = "live"): Promise<void> {
    const identity = this.current;
    if (!identity) return;
    if (mode === "none") {
      logger.info("account.resubscribe_skipped", { context: { reason: "transport recovering" } });
      return;
    }

    await this.options.registry.releaseAll();
    // A terminated transport will not replay and cannot be re-subscribed on;
    // it has to be replaced first. Releasing before the rebuild is harmless —
    // the unsubscribes touch a dead manager's local state and send nothing.
    if (mode === "rebuild") await this.options.rebuildTransport?.();

    const targets = accountTargetsFor(identity, this.options.channels);
    const result = await this.options.registry.reconcileWithin(ACCOUNT_CHANNEL_SET, targets);
    const failed = result && "failed" in result ? result.failed : [];
    if (failed.length > 0) {
      // Counted and RAISED, not just logged. A partial reconcile leaves those
      // channels with no live subscription and no retry; the caller's catch is
      // what decides whether the surfaces stay stale.
      logger.warn("account.resubscribe_partial", {
        context: { channels: targets.length, failed },
      });
      throw new Error(`account resubscribe failed for ${failed.length} channel(s)`);
    }
    logger.info("account.resubscribed", { context: { channels: targets.length, mode } });
  }

  markAllStale(): void {
    for (const bound of this.options.stores) bound.store.markStale();
  }

  /**
   * Guard the per-connection user cap.
   *
   * One identity costs six subscriptions but only one distinct user, so the
   * ceiling is reached by tracking many accounts rather than many channels.
   */
  assertCapacity(additionalUsers = 1): void {
    const projected = this.options.registry.distinctUserCount() + additionalUsers;
    if (projected > MAX_USERS_PER_CONNECTION) {
      throw new HlError(
        `A websocket connection can track ${MAX_USERS_PER_CONNECTION} users; this would need ${projected}`,
        { code: "rate_limited", context: { projected, cap: MAX_USERS_PER_CONNECTION } }
      );
    }
  }
}
