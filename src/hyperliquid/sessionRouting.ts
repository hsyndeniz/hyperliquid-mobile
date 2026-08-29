/**
 * Wire shapes to stores.
 *
 * Split out of `session.ts` so that file stays about lifecycle and this one
 * stays about payloads — they change for entirely different reasons, and the
 * payload side is where the wire's surprises live.
 *
 * Every parse goes through `state/accountWire`, which validates before it
 * normalises. A rejected event leaves the previous value in place and is
 * counted, so a shape change degrades into "the numbers stopped updating"
 * rather than into `NaN` on screen — the failure mode this project has been
 * built around since a hand-written `BookSnapshot` passed 500 tests and was
 * wrong.
 */

import { log } from "@/hyperliquid/core/logger";
import {
  parseClearinghouseState,
  parseFills,
  parseOpenOrders,
  parseSpotState,
  parseTwapSliceFills,
} from "@/hyperliquid/state/accountWire";
import type { AccountStore } from "@/hyperliquid/state/account";
import type { FillsStore } from "@/hyperliquid/state/fills";
import type { OpenOrdersStore } from "@/hyperliquid/state/openOrders";
import type { NotificationStore } from "@/hyperliquid/state/notifications";
import type { SpotBalanceStore } from "@/hyperliquid/state/spot";
import { readCloid } from "@/hyperliquid/orders/cloid";
import { resolvePending } from "@/hyperliquid/orders/pending";
import type { Scoped } from "@/hyperliquid/types/domain";

const logger = log.child("session.routing");

export interface RoutingTargets {
  account: AccountStore;
  openOrders: OpenOrdersStore;
  fills: FillsStore;
  spot: SpotBalanceStore;
  notifications: NotificationStore;
}

/** Counts rejections per channel so a shape change is visible without per-tick logging. */
export interface RoutingCounters {
  rejected: Map<string, number>;
}

function record(counters: RoutingCounters, channel: string, error: unknown): void {
  const seen = counters.rejected.get(channel) ?? 0;
  counters.rejected.set(channel, seen + 1);
  // Once per channel. A malformed feed at 5s intervals would otherwise fill the
  // log with the same line forever.
  if (seen === 0) logger.warn("routing.rejected", { context: { channel }, error });
}

/**
 * Build the dispatcher.
 *
 * `orderUpdates` deliberately writes **no order row**: the `openOrders` feed is
 * the sole authority, and `orderUpdates` carries the plain shape with no
 * `triggerPx`, `orderType` or `tif` — a stop-loss read from it renders as a
 * resting limit order at its trigger price. It is used only to resolve the
 * journal and evict the unconfirmed overlay.
 */
export function createDispatcher(
  targets: RoutingTargets,
  counters: RoutingCounters = { rejected: new Map() }
): (event: Scoped<unknown>) => void {
  return function dispatch(event: Scoped<unknown>): void {
    const channel = event.target.channel;

    try {
      switch (channel) {
        case "clearinghouseState": {
          const payload = event.value as {
            clearinghouseState: unknown;
            dex?: string;
            user?: string;
          };
          const snapshot = parseClearinghouseState(payload.clearinghouseState, {
            dex: payload.dex ?? "",
            onUnknownKeys: (keys) =>
              logger.warn("routing.unknown_keys", { context: { channel, keys } }),
          });
          targets.account.apply(
            { ...event, value: snapshot },
            {
              dex: payload.dex ?? "",
              user: payload.user ?? "",
            }
          );
          return;
        }

        case "openOrders": {
          // The event's array field is `orders`, not `openOrders` — verified on
          // the live wire.
          //
          // Deliberately **no `?? []` default.** This store does a whole-snapshot
          // replace, so a synthesised empty array is not a degraded read, it is a
          // wipe: a renamed or missing field would parse cleanly to zero rows and
          // show "no open orders" to someone holding live resting stop-losses,
          // with no rejection counted, nothing logged, and `lastSnapshotAt`
          // refreshed so it does not even read as stale. Passing the raw value
          // lets the parser reject it, which keeps the previous rows on screen
          // and increments the counter — the behaviour this module's header
          // promises for every other channel.
          const payload = event.value as { orders?: unknown; dex?: string };
          targets.openOrders.apply(
            { ...event, value: parseOpenOrders(payload.orders) },
            payload.dex ?? ""
          );
          return;
        }

        case "spotState": {
          const payload = event.value as { spotState?: unknown };
          targets.spot.apply({ ...event, value: parseSpotState(payload.spotState ?? payload) });
          return;
        }

        case "userFills": {
          const payload = event.value as { fills?: unknown };
          targets.fills.apply({ ...event, value: parseFills(payload.fills ?? []) });
          return;
        }

        case "userTwapSliceFills": {
          // TWAP executions appear in no other feed — 0 of 1,159 slices overlapped
          // `userFillsByTime` on a matched window — so without this a user running
          // a TWAP sees the position move with no fills.
          const payload = event.value as { twapSliceFills?: unknown };
          targets.fills.apply({
            ...event,
            value: parseTwapSliceFills(payload.twapSliceFills ?? []),
          });
          return;
        }

        case "notification": {
          // The store owns the parse, because it also owns the `dropped`
          // counter — routing it here and passing a maybe-undefined string on
          // would put an empty toast on screen instead of counting a bad frame.
          targets.notifications.apply(event);
          return;
        }

        case "orderUpdates": {
          // No row is written here. See the function note.
          const updates = Array.isArray(event.value) ? event.value : [];
          const cloids = updates
            .map((update) => readCloid((update as { order?: { cloid?: string } }).order ?? {}))
            .filter((cloid): cloid is NonNullable<typeof cloid> => cloid !== null);

          if (cloids.length > 0) {
            resolvePending(cloids);
            for (const cloid of cloids) targets.openOrders.removeUnconfirmed(cloid);
          }
          return;
        }

        default:
          // Market-data channels are routed by their own surfaces; an account
          // session simply does not own them.
          return;
      }
    } catch (error) {
      record(counters, channel, error);
    }
  };
}
