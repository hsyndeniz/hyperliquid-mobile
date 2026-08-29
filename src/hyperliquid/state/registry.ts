/**
 * Subscription registry — the authority on what is subscribed.
 *
 * The reference's central rule:
 *
 * > The background subscription target is the source of truth. On a symbol
 * > switch, push the new target *before* slow UI cleanup. Create/destroy
 * > mutations must be serialised by key, and **a stale create must never
 * > overwrite an active map**.
 *
 * Three guards enforce that, and each closes a distinct hole:
 *
 * 1. **Serialised by key** — a create and a destroy for one target can never
 *    interleave, so the map cannot end up holding a handle for a subscription
 *    that was already torn down.
 * 2. **Desire check on completion** — after an async subscribe returns, the
 *    registry re-checks whether that target is still wanted. A user who
 *    switched away mid-flight gets it unsubscribed immediately rather than
 *    leaving a live feed writing into state.
 * 3. **Generation token** — a transport rebuild or identity switch invalidates
 *    everything in flight, so a subscribe issued against a dead socket cannot
 *    register itself against the new one.
 *
 * Handles are opaque: the registry never inspects them, so it is testable
 * without a websocket.
 */

import { log } from "@/hyperliquid/core/logger";
import { effectiveAddress, subscriptionKey } from "@/hyperliquid/core/identity";
import { Generation, PerKeyMutationQueue } from "@/hyperliquid/core/queues";
import type { HlIdentity, SubscriptionTarget } from "@/hyperliquid/types/domain";

const logger = log.child("ws.registry");

/** What the SDK hands back; only `unsubscribe` is ever used. */
/** What a scoped reconcile actually achieved. */
export interface ReconcileResult {
  requested: number;
  opened: number;
  /** Channels whose subscribe was rejected. Empty on a clean reconcile. */
  failed: string[];
}

export interface SubscriptionHandle {
  unsubscribe(): Promise<unknown>;
}

/** Opens a subscription for a target. Supplied by the caller so this stays transport-agnostic. */
export type SubscribeFn = (target: SubscriptionTarget) => Promise<SubscriptionHandle>;

interface Entry {
  target: SubscriptionTarget;
  handle: SubscriptionHandle;
  generation: number;
}

export class SubscriptionRegistry {
  private readonly active = new Map<string, Entry>();
  /** Targets the app *wants*, which may briefly differ from what is open. */
  private readonly desired = new Map<string, SubscriptionTarget>();
  private readonly mutations = new PerKeyMutationQueue();
  private readonly generation = new Generation();

  constructor(private readonly subscribe: SubscribeFn) {}

  /**
   * Ensure a target is subscribed.
   *
   * Idempotent: a target already open is a no-op, so callers may assert their
   * desired set freely without tracking what is already live.
   */
  async add(target: SubscriptionTarget): Promise<void> {
    const key = subscriptionKey(target);
    this.desired.set(key, target);
    const token = this.generation.current();

    await this.mutations.run(key, async () => {
      if (this.active.has(key)) return;
      // Re-checked inside the queue: a remove() may have landed while queued.
      if (!this.desired.has(key)) return;

      let handle: SubscriptionHandle;
      try {
        handle = await this.subscribe(target);
      } catch (error) {
        logger.warn("subscribe.failed", { context: { key }, error });
        throw error;
      }

      // The two post-await guards. Either means this handle is already
      // obsolete, and keeping it would leave a feed nobody reads.
      if (!this.generation.isCurrent(token)) {
        logger.info("subscribe.discarded_stale_generation", { context: { key } });
        await this.safeUnsubscribe(handle, key);
        return;
      }
      if (!this.desired.has(key)) {
        logger.info("subscribe.discarded_no_longer_desired", { context: { key } });
        await this.safeUnsubscribe(handle, key);
        return;
      }

      this.active.set(key, { target, handle, generation: token });
      logger.info("subscribe.opened", { context: { key } });
    });
  }

  /** Tear down a target. Idempotent. */
  async remove(target: SubscriptionTarget): Promise<void> {
    await this.removeByKey(subscriptionKey(target));
  }

  private async removeByKey(key: string): Promise<void> {
    this.desired.delete(key);
    await this.mutations.run(key, async () => {
      const entry = this.active.get(key);
      if (!entry) return;
      this.active.delete(key);
      await this.safeUnsubscribe(entry.handle, key);
      logger.info("subscribe.closed", { context: { key } });
    });
  }

  /**
   * Make the live set exactly `targets`.
   *
   * Removals are issued before additions so a switch frees its slot first —
   * Hyperliquid caps how many user-scoped subscriptions may be open, and
   * adding before removing can trip that ceiling during a rapid switch.
   */
  /**
   * Reconcile **within one channel set**, leaving everything else untouched.
   *
   * `reconcile` makes the live set exactly `targets`, which is right only for a
   * caller that owns every subscription. `AccountSession` does not: it shares
   * this registry with charts and books, and a plain reconcile tore those down
   * on every identity switch with nothing to restore them.
   */
  async reconcileWithin(
    channels: ReadonlySet<string>,
    targets: readonly SubscriptionTarget[]
  ): Promise<ReconcileResult> {
    const wanted = new Map(targets.map((t) => [subscriptionKey(t), t]));
    const removals = [...this.desired.entries()]
      .filter(([key, target]) => channels.has(target.channel) && !wanted.has(key))
      .map(([key]) => key);

    await Promise.allSettled(removals.map((key) => this.removeByKey(key)));
    const results = await Promise.allSettled(
      [...wanted.values()].map((target) => this.add(target))
    );

    // Counted, not assumed. A failed subscribe is swallowed here on purpose —
    // one dead channel must not fail a whole account switch — but a caller that
    // logs `targets.length` then reports six channels open when five are. The
    // failures are named so the log can say which.
    const failed = results.flatMap((result, index) =>
      result.status === "rejected" ? [[...wanted.values()][index].channel] : []
    );
    return { requested: wanted.size, opened: wanted.size - failed.length, failed };
  }

  async reconcile(targets: readonly SubscriptionTarget[]): Promise<void> {
    const wanted = new Map(targets.map((t) => [subscriptionKey(t), t]));

    const removals = [...this.desired.keys()].filter((key) => !wanted.has(key));
    await Promise.allSettled(removals.map((key) => this.removeByKey(key)));
    await Promise.allSettled([...wanted.values()].map((target) => this.add(target)));
  }

  /**
   * Drop every subscription belonging to an identity.
   *
   * The account-switch path: nothing from the previous account may keep
   * writing into state while the new one loads.
   */
  async removeForIdentity(identity: HlIdentity): Promise<void> {
    // BOTH maps, not just `desired`. `removeByKey` deletes from `desired`
    // synchronously and unsubscribes inside the mutation queue, so between those
    // two steps a target is active-but-not-desired — invisible to a scan of
    // `desired` alone, and therefore still writing into state under a docstring
    // that promises it is not. Keyed and de-duplicated, since the same target is
    // normally in both.
    const targets = new Map<string, SubscriptionTarget>();
    for (const target of [...this.desired.values(), ...this.activeTargets()]) {
      if (target.identity === identity || sameIdentityKey(target, identity)) {
        targets.set(subscriptionKey(target), target);
      }
    }
    await Promise.allSettled([...targets.values()].map((target) => this.remove(target)));
  }

  /**
   * Invalidate everything in flight, without tearing anything down.
   *
   * For the case the generation token was written for and was **not** armed on:
   * the transport is being rebuilt underneath us. `closeAll()` bumps, but it
   * only runs on logout — an account-to-account switch rebuilds the socket via
   * `rebuildTransport` and left the generation untouched, so a subscribe still
   * in flight passed `isCurrent()` and registered a handle against a socket that
   * no longer existed.
   */
  invalidateInFlight(): void {
    this.generation.bump();
  }

  /**
   * Invalidate everything and tear it down — a transport rebuild.
   *
   * The generation bump comes **first**, so any subscribe already in flight
   * discards itself on arrival instead of registering against the new socket.
   */
  async closeAll(): Promise<void> {
    this.desired.clear();
    await this.releaseAll();
  }

  /**
   * Unsubscribe everything active, keeping the desired set for a re-add.
   *
   * This replaced a `forgetAll()` that dropped the handles WITHOUT
   * unsubscribing, on the stated theory that "the handles are meaningless and
   * unsubscribing over a dead connection would only throw". Both halves are
   * false for the installed SDK, and the combination leaked a listener on
   * every rebuild:
   *
   * - `unsubscribe` sends a frame only `if (readyState === OPEN)`; over a dead
   *   socket it just detaches locally and returns. It cannot throw — and
   *   `safeUnsubscribe` catches regardless.
   * - The handle is not meaningless, because the SDK keys its listener
   *   registrations by **listener identity** and `createSubscribeFn` mints a
   *   fresh closure per call. Dropping the handle without unsubscribing left
   *   the old closure attached to the same subscription id; the re-add then
   *   registered a SECOND one beside it. The first became unreachable forever
   *   — its only handle had been discarded — so it kept parsing every frame,
   *   and because the SDK sends `unsubscribe` only when a subscription's
   *   listener count reaches zero, it also pinned the server stream open.
   *
   * The stores neutralise the duplicate CONTENT (unchanged-signature emits are
   * suppressed, fills dedupe by `oid:tid`, trades by `tid`), so this never
   * showed as double renders. What grew without ceiling was parse plus
   * `JSON.stringify` signature work per extra listener on every frame — and
   * `NotificationStore`, which mints `seq` locally with no wire dedup key, DID
   * surface it: after k resumes a liquidation warning toasted k+1 times.
   *
   * Does NOT touch `desired`: the caller is rebuilding, not tearing down.
   */
  async releaseAll(): Promise<void> {
    this.generation.bump();
    const keys = [...this.active.keys()];
    await Promise.allSettled(
      keys.map((key) =>
        this.mutations.run(key, async () => {
          const entry = this.active.get(key);
          if (!entry) return;
          this.active.delete(key);
          await this.safeUnsubscribe(entry.handle, key);
          logger.info("subscribe.released", { context: { key } });
        })
      )
    );
    this.active.clear();
  }

  /**
   * The SDK has torn down a CONFIRMED subscription; forget our handle for it.
   *
   * `_failSubscription` removes the entry from the SDK's own map, detaches the
   * listener, and then calls `onError` once — after which no further events or
   * errors arrive on that channel. Until this existed, both consumers only
   * logged, so `active` kept a key the SDK had already destroyed: `add()`
   * returns early on `active.has(key)`, so every later reconcile treated the
   * dead channel as live and nothing ever re-opened it. The user sees a screen
   * that has simply stopped updating, with no staleness marker, because the
   * store is never told either.
   *
   * `desired` is deliberately left intact — the target is still WANTED, it is
   * merely no longer live, which is exactly the state a reconcile can repair.
   * Unsubscribing is pointless here (the SDK already dropped it) and the handle
   * is discarded rather than released for that reason.
   */
  onFailed(target: SubscriptionTarget): void {
    const key = subscriptionKey(target);
    void this.mutations.run(key, async () => {
      if (!this.active.delete(key)) return;
      logger.warn("subscribe.failed_after_confirm", { context: { key } });
    });
  }

  isActive(target: SubscriptionTarget): boolean {
    return this.active.has(subscriptionKey(target));
  }

  isDesired(target: SubscriptionTarget): boolean {
    return this.desired.has(subscriptionKey(target));
  }

  get activeCount(): number {
    return this.active.size;
  }

  activeTargets(): SubscriptionTarget[] {
    return [...this.active.values()].map((entry) => entry.target);
  }

  /**
   * Distinct user addresses across live subscriptions.
   *
   * The server enforces **15**, not the 10 the public rate-limit page states:
   * exceeding it returns `{"channel":"error","data":"Cannot track more than 15
   * total users."}`, matching the SDK's own `MAX_UNIQUE_USERS`. Treat the
   * published page as unreliable generally — it was wrong about this.
   */
  distinctUserCount(): number {
    return new Set(this.activeTargets().map((target) => effectiveAddress(target.identity))).size;
  }

  private async safeUnsubscribe(handle: SubscriptionHandle, key: string): Promise<void> {
    try {
      await handle.unsubscribe();
    } catch (error) {
      // A failed unsubscribe on a dead socket is expected and must not stop
      // the rest of a teardown.
      logger.warn("unsubscribe.failed", { context: { key }, error });
    }
  }
}

function sameIdentityKey(target: SubscriptionTarget, identity: HlIdentity): boolean {
  const a = target.identity;
  return (
    a.env === identity.env &&
    a.accountId === identity.accountId &&
    a.address === identity.address &&
    a.dex === identity.dex &&
    a.subAccount === identity.subAccount
  );
}
