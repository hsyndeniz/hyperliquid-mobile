/**
 * Market-data subscription owner — candles, books, trades, asset contexts.
 *
 * A separate registry from the session's, deliberately. The session's registry
 * is private and its lifecycle is an *account's*: `switchTo` reconciles the
 * account channel set and `removeForIdentity` tears down by identity. Market
 * feeds belong to no account — a BTC candle chart must survive an account
 * switch untouched — so they get their own registry over the SAME websocket
 * (both subscribe paths resolve `getSubscriptionClient()`, which is a
 * singleton per config).
 *
 * ## The synthetic identity
 *
 * Registry keys require an identity, but none of the channels here sends one:
 * every {@link MarketChannel} puts only `{ coin }` (plus interval) on the wire
 * — verified in `channels.ts`, precedent in `__e2e__/market-data.e2e.ts`. So
 * targets are scoped under a fixed synthetic identity, `market-data-<env>` at
 * an arbitrary address. The address never reaches the server, which means the
 * server's 15-tracked-users cap is untouched no matter how many market feeds
 * are open.
 *
 * ## Ref-counting
 *
 * Several surfaces may want one feed (list row + detail hero on the same
 * coin). `open()` counts listeners per `subscriptionKey`: the first listener
 * opens the underlying subscription, the last `close()` tears it down, and
 * fanout routes each event to exactly the listeners of its key.
 *
 * ## `rebuild()` — the transport-rebuild rule
 *
 * After the websocket is rebuilt (an account switch calls `closeClients()`),
 * every handle this registry holds points at a socket that is gone. Rebuild is
 * `releaseAll()` — unsubscribe each one, bump the generation so in-flight
 * subscribes discard themselves — then re-add every key that still has
 * listeners. The re-add lands on the CURRENT client because the subscribe
 * lambda re-evaluates `getSubscriptionClient()` per call (the `session.ts`
 * pattern); caching the client once would pin every re-add to the corpse.
 * Clearing the ACTIVE entries is what makes the re-add do anything at all — a
 * stale one makes `add()` a no-op.
 *
 * This was `forgetAll()`, which skipped the unsubscribe on the theory that it
 * "would at best throw and at worst detach nothing". Neither holds: the SDK
 * sends an unsubscribe frame only on an OPEN socket and otherwise just detaches
 * locally, and detaching locally is precisely what has to happen, because it
 * keys listener registrations by function identity and `createSubscribeFn`
 * mints a fresh closure per call. Skipping it left the old closure attached and
 * unreachable, parsing every frame forever. See `registry.releaseAll`.
 *
 * Constructing the singleton opens NO socket: the client getter runs on the
 * first actual subscribe, never at module scope — `WebSocketTransport`
 * connects eagerly in its constructor, so module-scope resolution would open
 * a socket before any screen mounts.
 */

import { log } from "@/hyperliquid/core/logger";
import { createIdentity, subscriptionKey } from "@/hyperliquid/core/identity";
import { SubscriptionRegistry } from "@/hyperliquid/state/registry";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import { getSubscriptionClient } from "@/hyperliquid/api/clients";
import type {
  CandleInterval,
  HlEnv,
  HlIdentity,
  L2Aggregation,
  Scoped,
  SubscriptionTarget,
} from "@/hyperliquid/types/domain";

const logger = log.child("ws.marketFeed");

/**
 * Arbitrary but fixed. Only the *shape* matters: registry keys need an
 * address, the wire never sees it.
 */
const MARKET_DATA_ADDRESS = "0x0000000000000000000000000000000000000001";

const identities = new Map<HlEnv, HlIdentity>();

/**
 * The synthetic identity every market target is scoped under.
 *
 * Cached per env for referential stability — one object per env means
 * `target.identity === marketIdentity(env)` holds and React deps stay quiet.
 */
export function marketIdentity(env: HlEnv): HlIdentity {
  let identity = identities.get(env);
  if (!identity) {
    identity = createIdentity({
      env,
      accountId: `market-data-${env}`,
      address: MARKET_DATA_ADDRESS,
    });
    identities.set(env, identity);
  }
  return identity;
}

/**
 * The coin-scoped channels that carry no user.
 *
 * Exclusions are deliberate: `activeAssetData` sends `{ user }` and would both
 * put the synthetic address on the wire and burn a tracked-user slot;
 * `allMids` is polled over REST for the list, never subscribed (plan rule);
 * `outcomeMetaUpdates` is the exchange-wide catalog, not a per-coin feed.
 */
export type MarketChannel = "l2Book" | "bbo" | "trades" | "candle" | "activeAssetCtx";

/**
 * `interval` is required exactly when the channel is `candle` — BTC/1m and
 * BTC/1h are two distinct server subscriptions, and the runtime authority for
 * the rule stays `channels.ts`. This type just refuses to compile the miss.
 *
 * `aggregation` is accepted exactly when the channel is `l2Book`, for the
 * mirror-image reason: only the l2Book payload carries `nSigFigs`/`mantissa`/
 * `fast` on the wire (`channels.ts` spreads them into the subscribe call), yet
 * aggregation is part of {@link subscriptionKey} for EVERY channel. Allowing it
 * on, say, `trades` would mint two distinct keys — two live server
 * subscriptions — over byte-identical wire data. Omitted means `null`, so every
 * pre-existing call site keeps the exact key it always produced.
 */
export type MarketTargetParams =
  | {
      env: HlEnv;
      channel: "candle";
      coin: string;
      interval: CandleInterval;
      aggregation?: undefined;
    }
  | {
      env: HlEnv;
      channel: "l2Book";
      coin: string;
      interval?: undefined;
      aggregation?: L2Aggregation | null;
    }
  | {
      env: HlEnv;
      channel: Exclude<MarketChannel, "candle" | "l2Book">;
      coin: string;
      interval?: undefined;
      aggregation?: undefined;
    };

/** Build a market-data {@link SubscriptionTarget}. The one way to make one. */
export function marketTarget(params: MarketTargetParams): SubscriptionTarget {
  return {
    identity: marketIdentity(params.env),
    channel: params.channel,
    coin: params.coin,
    aggregation: params.aggregation ?? null,
    interval: params.interval ?? null,
  };
}

/** Receives every scoped event for the key it was opened on. */
export type MarketListener = (event: Scoped<unknown>) => void;

export interface MarketFeedOptions {
  /**
   * Client override for tests. Resolved PER SUBSCRIBE, never cached — the
   * whole point of `rebuild()` is that a re-add reaches the client that
   * exists *now*, not the one that existed at construction.
   */
  api?: () => SubscriptionApi;
  now?: () => number;
}

interface KeyEntry {
  target: SubscriptionTarget;
  listeners: Set<MarketListener>;
}

export class MarketFeed {
  private readonly registry: SubscriptionRegistry;
  /** One entry per subscription key; an entry exists iff it has listeners. */
  private readonly byKey = new Map<string, KeyEntry>();

  constructor(options: MarketFeedOptions = {}) {
    const api = options.api ?? (() => getSubscriptionClient() as unknown as SubscriptionApi);
    this.registry = new SubscriptionRegistry((target) =>
      createSubscribeFn({
        api: api(),
        sink: (event) => this.fanout(event),
        onError: (failed, error) => {
          logger.warn("marketFeed.channel_error", {
            context: { channel: failed.channel, coin: failed.coin },
            error,
          });
          // Evict so the key is re-openable. A book that the SDK has torn down
          // otherwise stays "active" forever and the ladder silently freezes.
          this.registry.onFailed(failed);
        },
        now: options.now,
      })(target)
    );
  }

  /**
   * Attach a listener; returns its close.
   *
   * The first listener on a key opens the subscription, later ones share it.
   * Synchronous by design — the subscribe proceeds in the background and a
   * failure is logged, not thrown: the caller holds a valid close either way,
   * and `rebuild()` retries every keyed target, so a transient failure heals
   * on the next transport rebuild instead of wedging the key.
   *
   * A listener instance registers once per key (Set semantics); the returned
   * close is idempotent.
   */
  open(target: SubscriptionTarget, listener: MarketListener): () => void {
    const key = subscriptionKey(target);
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { target, listeners: new Set() };
      this.byKey.set(key, entry);
    }
    entry.listeners.add(listener);
    if (entry.listeners.size === 1) {
      void this.registry.add(target).catch((error) => {
        logger.warn("marketFeed.subscribe_failed", { context: { key }, error });
      });
    }

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const current = this.byKey.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      this.byKey.delete(key);
      // Safe after a transport rebuild: `releaseAll()` already unsubscribed
      // and cleared the stale entry, so this remove finds either the re-added
      // live handle or nothing — never a handle from the previous transport.
      void this.registry.remove(target).catch((error) => {
        logger.warn("marketFeed.unsubscribe_failed", { context: { key }, error });
      });
    };
  }

  /**
   * Recover from a transport rebuild. See the module header for why this is
   * forget-then-re-add and never unsubscribe-then-resubscribe.
   */
  async rebuild(): Promise<void> {
    await this.registry.releaseAll();
    const entries = [...this.byKey.entries()];
    const results = await Promise.allSettled(
      entries.map(([, entry]) => this.registry.add(entry.target))
    );
    // Counted, not assumed — the same rule as `reconcileWithin`: one dead
    // channel must not fail the whole rebuild, but the log must say which.
    const failed = results.flatMap((result, index) =>
      result.status === "rejected" ? [entries[index][0]] : []
    );
    if (failed.length > 0) {
      logger.warn("marketFeed.rebuild_partial", { context: { failed } });
    }
    logger.info("marketFeed.rebuilt", {
      context: { requested: entries.length, opened: entries.length - failed.length },
    });
  }

  /** Live server subscriptions — what is actually open, not what is wanted. */
  activeCount(): number {
    return this.registry.activeCount;
  }

  /**
   * Events for a key nobody holds are dropped silently — expected during the
   * window between the last close and the unsubscribe landing.
   */
  private fanout(event: Scoped<unknown>): void {
    const entry = this.byKey.get(subscriptionKey(event.target));
    if (!entry) return;
    for (const listener of entry.listeners) listener(event);
  }
}

/** The app's one market feed. Constructing it opens no socket — see header. */
export const marketFeed = new MarketFeed();
