/**
 * Channel wiring — turning a {@link SubscriptionTarget} into a live SDK subscription.
 *
 * The single place where a target becomes a real subscribe call, so two rules
 * hold for every channel without each one re-implementing them:
 *
 * 1. **Every event is scoped at the boundary.** The listener wraps the payload
 *    with the target it arrived for and a receive timestamp before anything
 *    downstream sees it. A surface therefore cannot forget to stamp, and "is
 *    this current?" is answerable everywhere.
 * 2. **Errors are reported, not swallowed.** The SDK's `onError` fires at most
 *    once and only *after* a subscription is confirmed; failures before
 *    confirmation reject the subscribe promise instead. Both paths are routed
 *    to the same handler, or a silently-dead feed looks identical to a quiet
 *    market.
 */

import { log } from "@/hyperliquid/core/logger";
import { scope } from "@/hyperliquid/core/freshness";
import { effectiveAddress } from "@/hyperliquid/core/identity";
import type { Scoped, SubscriptionChannel, SubscriptionTarget } from "@/hyperliquid/types/domain";
import type { SubscriptionHandle } from "@/hyperliquid/state/registry";
import { HlError } from "@/hyperliquid/core/errors";

const logger = log.child("ws.channels");

/** Receives every scoped event. One sink, so ordering across channels is preserved. */
export type EventSink = (event: Scoped<unknown>) => void;

/** Called when a confirmed subscription later fails. */
export type ChannelErrorHandler = (target: SubscriptionTarget, error: unknown) => void;

/**
 * The subset of `SubscriptionClient` used here.
 *
 * Structural rather than the concrete class so the wiring is testable without a
 * websocket — the registry's tests already prove the lifecycle; these prove the
 * per-channel parameter mapping.
 */
export interface SubscriptionApi {
  l2Book(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  bbo(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  allMids(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  trades(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  candle(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  activeAssetCtx(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  activeAssetData(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  webData3(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  orderUpdates(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  userEvents(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  userFills(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  notification(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  clearinghouseState(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  openOrders(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  spotState(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  userTwapSliceFills(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  outcomeMetaUpdates(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  twapStates(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  userFundings(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  userNonFundingLedgerUpdates(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
  userHistoricalOrders(
    params: unknown,
    listener: (data: unknown) => void,
    options?: unknown
  ): Promise<SubscriptionHandle>;
}

export interface ChannelWiringOptions {
  api: SubscriptionApi;
  sink: EventSink;
  onError?: ChannelErrorHandler;
  now?: () => number;
}

/**
 * Fill aggregation, pinned off everywhere.
 *
 * Every `userFills` call — websocket and REST alike — must use this one value.
 * Rows from the two modes are indistinguishable once received, and an aggregated
 * row reuses a constituent's `tid` with a summed size, so a store fed both
 * double-counts fills.
 */
export const FILL_AGGREGATION = false as const;

/** Channels that need a coin; asserted rather than silently subscribing to nothing. */
const COIN_REQUIRED = new Set([
  "l2Book",
  "bbo",
  "trades",
  "candle",
  "activeAssetCtx",
  "activeAssetData",
]);

/** Read a number at a nested path, or `null` if it is not there. */
function numberAt(data: unknown, path: readonly string[]): number | null {
  let node: unknown = data;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "number" ? node : null;
}

/**
 * The server's own timestamp, when the event carries one.
 *
 * Per channel, because the field is not in the same place — and for the account
 * channels it is not there at all. A single top-level `data.time` read silently
 * returns null for every account channel, and freshness then falls back to the
 * device clock, so a feed that died server-side while still delivering
 * heartbeats reads as perfectly fresh and no stale warning ever fires.
 *
 * The channels returning `null` genuinely carry no emission time. A fill's
 * `time` is a *trade* time; mapping it in would make an idle feed read as
 * arbitrarily stale or fresh depending on when the account last traded. A
 * candle's `t`/`T` are bucket bounds, and `T` is in the future for the forming
 * bar, which would make a dead feed read as permanently fresh.
 */
function readServerTime(channel: SubscriptionChannel, data: unknown): number | null {
  switch (channel) {
    case "clearinghouseState":
      return numberAt(data, ["clearinghouseState", "time"]);
    case "webData3":
      return numberAt(data, ["userState", "serverTime"]);
    case "openOrders":
    case "spotState":
    case "userFills":
    case "userTwapSliceFills":
    case "orderUpdates":
    case "userEvents":
    case "candle":
      return null;
    default:
      return numberAt(data, ["time"]);
  }
}

function requireCoin(target: SubscriptionTarget): string {
  if (!target.coin) {
    throw new HlError(`Channel ${target.channel} requires a coin`, {
      code: "invalid_config",
      context: { channel: target.channel },
    });
  }
  return target.coin;
}

/**
 * Build the registry's `SubscribeFn`.
 *
 * Every channel produces `Scoped` values through the same path, so a handler
 * downstream can treat them uniformly.
 */
export function createSubscribeFn(options: ChannelWiringOptions) {
  const { api, sink, now } = options;

  return async function subscribe(target: SubscriptionTarget): Promise<SubscriptionHandle> {
    if (COIN_REQUIRED.has(target.channel) && !target.coin) requireCoin(target);

    const user = effectiveAddress(target.identity);
    const dex = target.identity.dex ?? "";
    const listener = (data: unknown) => {
      // Several channels stamp their own `time`. Preferring it over our receive
      // time is the whole reason `Scoped.serverTime` exists — a mobile clock can
      // be badly wrong, and freshness decisions must not inherit that error.
      sink(
        scope(target, data, {
          now,
          serverTime: readServerTime(target.channel, data),
          // The fills channel replays its snapshot on every reconnect, and the
          // SDK resubscribes automatically. Without this flag a store cannot
          // tell a backfill from a live append. Tested `=== true` because the
          // field is ABSENT on deltas, not false.
          isSnapshot: (data as { isSnapshot?: unknown })?.isSnapshot === true,
        })
      );
    };
    // Fires only after the subscription is confirmed; pre-confirmation failures
    // reject the promise below instead.
    const subOptions = {
      onError: (error: unknown) => {
        logger.warn("channel.error", { context: { channel: target.channel }, error });
        options.onError?.(target, error);
      },
    };

    switch (target.channel) {
      case "l2Book":
        return api.l2Book(
          {
            coin: requireCoin(target),
            // Aggregation is part of the subscription's identity, so it must be
            // sent exactly as the key describes it.
            ...(target.aggregation?.nSigFigs != null
              ? { nSigFigs: target.aggregation.nSigFigs }
              : {}),
            ...(target.aggregation?.mantissa != null
              ? { mantissa: target.aggregation.mantissa }
              : {}),
            ...(target.aggregation?.fast ? { fast: true } : {}),
          },
          listener,
          subOptions
        );
      case "bbo":
        return api.bbo({ coin: requireCoin(target) }, listener, subOptions);
      case "trades":
        return api.trades({ coin: requireCoin(target) }, listener, subOptions);
      case "candle":
        // Read from the TARGET, not from wiring: one subscribe function must be
        // able to serve every interval, and the interval is part of the key.
        if (!target.interval) {
          throw new HlError("candle subscription requires an interval on the target", {
            code: "invalid_config",
          });
        }
        return api.candle(
          { coin: requireCoin(target), interval: target.interval },
          listener,
          subOptions
        );
      case "activeAssetCtx":
        return api.activeAssetCtx({ coin: requireCoin(target) }, listener, subOptions);
      case "activeAssetData":
        return api.activeAssetData({ coin: requireCoin(target), user }, listener, subOptions);
      case "allMids":
        // `dex` scopes mids to a builder DEX; omitted means the main one.
        return api.allMids(dex ? { dex } : {}, listener, subOptions);
      case "webData3":
        return api.webData3({ user }, listener, subOptions);
      case "orderUpdates":
        return api.orderUpdates({ user }, listener, subOptions);
      case "userEvents":
        return api.userEvents({ user }, listener, subOptions);
      case "userFills":
        // Pinned aggregation. An aggregated row REUSES one constituent fill's
        // `tid` with a summed size, and both modes land on the same channel with
        // no distinguishing marker — mixing them double-counts and no dedup key
        // repairs it. The aggregate `px` is also a VWAP with tick-violating
        // precision.
        return api.userFills({ user, aggregateByTime: FILL_AGGREGATION }, listener, subOptions);
      case "userTwapSliceFills":
        // TWAP executions appear in NO other feed: 0 of 1,159 slices overlapped
        // `userFillsByTime` on a matched window. Without this a user running a
        // TWAP watches the position move with no fills and a PnL that does not
        // reconcile.
        return api.userTwapSliceFills({ user }, listener, subOptions);
      case "clearinghouseState":
        // `dex` is part of the request, not just of our key. A real-but-wrong
        // dex answers 200 with a well-formed empty account.
        return api.clearinghouseState({ user, dex }, listener, subOptions);
      case "openOrders":
        return api.openOrders({ user, dex }, listener, subOptions);
      case "spotState":
        // Deliberately no `dex`: spot is not dex-scoped and the request type has
        // no such parameter.
        return api.spotState({ user }, listener, subOptions);
      case "notification":
        return api.notification({ user }, listener, subOptions);
      case "twapStates":
        // DEX-SCOPED, and a wrong dex answers with an empty array rather than an
        // error — the same trap `clearinghouseState` carries below. Measured: the
        // same account in the same window returned 0 TWAPs for `{user}` and the 2
        // that were actually running for `{user, dex:"xyz"}`.
        return api.twapStates({ user, dex }, listener, subOptions);
      case "userFundings":
        return api.userFundings({ user }, listener, subOptions);
      case "userNonFundingLedgerUpdates":
        // The snapshot is capped at the most recent 100 rows — a DIFFERENT window
        // from `history/ledger.ts`'s REST seed, and not mergeable with it into a
        // complete history. Use this to stay current, never to seed.
        return api.userNonFundingLedgerUpdates({ user }, listener, subOptions);
      case "userHistoricalOrders":
        // Snapshot capped at 30 rows, which on an active account covered FIVE
        // SECONDS. Also a firehose — up to 9 events/second measured. A store fed
        // from this must not re-render per event.
        return api.userHistoricalOrders({ user }, listener, subOptions);
      case "fastAssetCtxs":
        // NOT WIRED, DELIBERATELY. The SDK decodes this channel with
        // `new DecompressionStream("deflate-raw")`, which does not exist in
        // Hermes/React Native (nor in Bun). The subscribe SUCCEEDS and then an
        // uncaught ReferenceError is thrown from inside the SDK's listener
        // seconds later — it does not reject the promise and does not reach
        // `onError`, so it takes the app down with it. Measured directly.
        throw new HlError("fastAssetCtxs cannot be used on this runtime", {
          code: "invalid_config",
          context: { channel: target.channel, reason: "DecompressionStream unavailable" },
        });
      case "outcomeMetaUpdates":
        // No user, no coin, no dex — it is the exchange's own catalog, not an
        // account's. Passing `{ user }` here would be harmless on the wire and
        // misleading in the code: this feed is identical for everyone, so one
        // subscription serves the whole app rather than being torn down on an
        // identity switch.
        return api.outcomeMetaUpdates({}, listener, subOptions);
      default:
        throw new HlError(`Channel ${target.channel} is not wired yet`, {
          code: "invalid_config",
          context: { channel: target.channel },
        });
    }
  };
}
