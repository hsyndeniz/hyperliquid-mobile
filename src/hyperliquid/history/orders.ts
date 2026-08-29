/**
 * Order history — `historicalOrders`.
 *
 * The single most misread endpoint in the API, and every misreading is measured
 * rather than theorised.
 *
 * ## A row is an EVENT, not an order
 *
 * The same `oid` appears on several rows — one per status transition. So:
 *
 * - Keying a list by `oid` renders duplicates.
 * - Counting rows to say "you have placed N orders" roughly doubles N.
 * - The 2,000-row cap is on **events**, so the real order depth is about half.
 *
 * ## `status: "open"` does not mean the order is open
 *
 * The SDK's own doc says *"Order active and waiting to be filled"*. It is not:
 * it means **"this order was accepted onto the book at this instant"** — a
 * placement event, historical by the time you read it. Taking it literally showed
 * **907 phantom live orders** on an account with 3. The live truth is
 * `openOrders`/`frontendOpenOrders`, which this project already reads through
 * `state/openOrders.ts`.
 *
 * ## The order object mutates across its own rows
 *
 * `origSz` is not immutable. A **trigger order re-enters the book under the same
 * `oid` with a rewritten identity** when it fires: `isTrigger` true → false,
 * `triggerCondition` → `"Triggered"`, `triggerPx` → `"0.0"`, `tif` null →
 * `"Gtc"` — on 161 of 161 measured groups. So `order.timestamp` is the *fire*
 * time, not the creation time, and a "placed at" column reads wrong for every
 * stop-loss and take-profit.
 *
 * **`cloid` is the only field safe to treat as a per-order constant**, which is
 * exactly what `orders/cloid.ts` assumes and this confirms.
 *
 * ## What it cannot tell you
 *
 * - **No pagination at all.** No cursor, no `startTime`, no limit; unknown fields
 *   are silently discarded (a bogus key still returns 200). Past 2,000 events the
 *   history is simply unreachable.
 * - **TWAPs and their child slices are absent entirely.** `twapHistory` and
 *   `userTwapSliceFills` are the only sources — the same gap `api/account.ts`
 *   already documents for fills.
 * - `statusTimestamp` is not a unique sort key: a placement row and its terminal
 *   row routinely share one, so sorting the flat array by it reorders an order's
 *   own lifecycle at random.
 */

import { log } from "@/hyperliquid/core/logger";
import { readCloid, type Cloid } from "@/hyperliquid/orders/cloid";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("history.orders");

/** Measured hard cap, on EVENTS rather than orders. There is no way past it. */
export const ORDER_HISTORY_CAP = 2_000;

/**
 * One status-transition event.
 *
 * Named `OrderEvent` rather than `HistoricalOrder` on purpose — the plural of
 * this type is not "orders", and a name that said so would invite every mistake
 * in the module note.
 */
export interface OrderEvent {
  oid: number;
  /** The only per-order constant. Null when the order carried none. */
  cloid: Cloid | null;
  coin: string;
  side: string;
  /** Status **at this instant**. `"open"` means "was accepted", not "is live". */
  status: string;
  statusTimestamp: number;
  /** Verbatim; fields mutate across an order's own events. */
  order: Readonly<Record<string, unknown>>;
}

/**
 * Terminal statuses — an order that reached one will produce no further events.
 *
 * **Enumerated from the SDK's declared union, not from what a test account
 * happened to produce.** An earlier version of this set listed 15 of the 30 and
 * was missing `iocCancelRejected` among others — which measured as 148 of 149
 * orders on a live account reporting `isTerminal: false`, i.e. a finished order
 * rendering as "no final status".
 *
 * The union is `open | triggered` plus these. `triggered` is deliberately NOT
 * here: a trigger order that fired becomes a live resting order and keeps
 * emitting. `open` means "was accepted", not "is live", but it is equally not
 * an ending.
 *
 * A status outside the union is treated as non-terminal, which reads as "the
 * history ends here" rather than as a claim the order finished — the honest
 * default for something this file has never seen.
 */
export const TERMINAL_STATUSES = new Set([
  "filled",
  "canceled",
  "rejected",
  // Cancels
  "marginCanceled",
  "liquidatedCanceled",
  "vaultWithdrawalCanceled",
  "openInterestCapCanceled",
  "selfTradeCanceled",
  "reduceOnlyCanceled",
  "siblingFilledCanceled",
  "delistedCanceled",
  "scheduledCancel",
  "internalCancel",
  "outcomeSettledCanceled",
  // Rejections
  "tickRejected",
  "minTradeNtlRejected",
  "perpMarginRejected",
  "badAloPxRejected",
  "badTriggerPxRejected",
  "insufficientSpotBalanceRejected",
  "iocCancelRejected",
  "marketOrderNoLiquidityRejected",
  "openInterestIncreaseRejected",
  "oracleRejected",
  "perpMaxPositionRejected",
  "positionFlipAtOpenInterestCapRejected",
  "positionIncreaseAtOpenInterestCapRejected",
  "reduceOnlyRejected",
  "tooAggressiveAtOpenInterestCapRejected",
  "tooManyOpenOrdersRejected",
]);

export function parseOrderEvents(rows: unknown): OrderEvent[] {
  if (!Array.isArray(rows)) return [];
  const events: OrderEvent[] = [];
  let dropped = 0;

  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) {
      dropped += 1;
      continue;
    }
    const row = entry as { order?: unknown; status?: unknown; statusTimestamp?: unknown };
    const order = row.order;
    if (typeof order !== "object" || order === null) {
      dropped += 1;
      continue;
    }
    const o = order as Record<string, unknown>;
    if (typeof o.oid !== "number" || typeof row.status !== "string") {
      dropped += 1;
      continue;
    }

    events.push({
      oid: o.oid,
      cloid: readCloid(o),
      coin: typeof o.coin === "string" ? o.coin : "",
      side: typeof o.side === "string" ? o.side : "",
      status: row.status,
      statusTimestamp:
        typeof row.statusTimestamp === "number"
          ? row.statusTimestamp
          : (o.timestamp as number) || 0,
      order: o,
    });
  }

  if (dropped > 0) logger.warn("orders.rows_dropped", { context: { dropped } });
  return events;
}

/**
 * Group events into orders, newest order first.
 *
 * The grouping key is `oid`. Within a group the events are ordered by
 * `statusTimestamp` **with a terminal status last as a tiebreak** — because a
 * placement row and its terminal row routinely carry an identical timestamp, and
 * a plain sort would render "filled" above "placed" at random.
 */
export function groupByOrder(events: readonly OrderEvent[]): OrderLifecycle[] {
  const groups = new Map<number, OrderEvent[]>();
  for (const event of events) {
    const held = groups.get(event.oid);
    if (held) held.push(event);
    else groups.set(event.oid, [event]);
  }

  const lifecycles: OrderLifecycle[] = [];
  for (const [oid, rows] of groups) {
    const ordered = [...rows].sort((a, b) => {
      if (a.statusTimestamp !== b.statusTimestamp) return a.statusTimestamp - b.statusTimestamp;
      // Same millisecond: the terminal event is the later one, always.
      return Number(TERMINAL_STATUSES.has(a.status)) - Number(TERMINAL_STATUSES.has(b.status));
    });
    const last = ordered[ordered.length - 1];
    lifecycles.push({
      oid,
      // Constant across the whole lifecycle, unlike everything else on `order`.
      cloid: ordered.find((e) => e.cloid !== null)?.cloid ?? null,
      coin: last.coin,
      side: last.side,
      events: ordered,
      finalStatus: last.status,
      isTerminal: TERMINAL_STATUSES.has(last.status),
      placedAt: ordered[0].statusTimestamp,
      lastAt: last.statusTimestamp,
    });
  }

  return lifecycles.sort((a, b) => b.lastAt - a.lastAt);
}

export interface OrderLifecycle {
  oid: number;
  cloid: Cloid | null;
  coin: string;
  side: string;
  events: OrderEvent[];
  finalStatus: string;
  /** False means the history simply ends here — NOT that the order is live. */
  isTerminal: boolean;
  /**
   * First event's timestamp.
   *
   * Deliberately not `order.timestamp`: on a trigger order that fired, that field
   * holds the FIRE time, so it would report a stop-loss as placed at the moment
   * it triggered.
   */
  placedAt: number;
  lastAt: number;
}

export interface OrderHistoryProbe {
  historicalOrders(params: { user: Hex }): Promise<unknown>;
}

export interface OrderHistory {
  orders: OrderLifecycle[];
  events: OrderEvent[];
  /**
   * True when the event cap was hit, so older history is **unreachable** — there
   * is no cursor to page with. A UI must say "showing recent activity", never
   * "all orders".
   */
  truncated: boolean;
}

/** Read the order history. One call covers every dex: perp, builder, spot, predictions. */
export async function fetchOrderHistory(params: {
  probe: OrderHistoryProbe;
  user: Hex;
}): Promise<OrderHistory> {
  const raw = await params.probe.historicalOrders({ user: params.user });
  const events = parseOrderEvents(raw);
  const orders = groupByOrder(events);
  const truncated = events.length >= ORDER_HISTORY_CAP;

  logger.info("orders.history", {
    context: { events: events.length, orders: orders.length, truncated },
  });
  return { orders, events, truncated };
}
