/**
 * Ticket → wire. The ONE place the order form's strings meet the builders.
 *
 * `orderForm.ts` deliberately computes its info rows without ever building a
 * leg, so that during the read-only phase no leg object existed anywhere to
 * be handed to a submit by accident. This module is the other side of that
 * line, added when the money path was approved: it turns a VALID ticket
 * (`orderBlockers` returned empty — callers must check first) into exactly
 * what `placeOrders` / `placeTwapOrder` take.
 *
 * Rules encoded here, each the residue of a specific way to lose money:
 *
 * - A trigger's price is passed RAW — `buildTriggerOrder` snaps it in the
 *   direction that fires EARLIER (`snapTriggerPrice`), which depends on both
 *   side and tp/sl. Pre-rounding here with plain `formatPrice` truncates
 *   toward zero unconditionally and moves a long's stop-loss further away.
 * - TP/SL attach produces ONE parent plus up to two REVERSE-side trigger
 *   children under `grouping: "normalTpsl"` — the grouping is what ties the
 *   brackets to the parent on the exchange, and the children reduce-only so
 *   they can never open the opposite position.
 * - Which child is `tp` and which is `sl` depends on the SIDE: a long's take
 *   profit sells above, its stop sells below. Classifying by comparing the
 *   attached price to the entry would misfile a bracket the user typed on
 *   the wrong side of the price — the checkbox's own label is the intent.
 * - A TWAP is NOT legs. It has no cloid, no journal entry, and its own
 *   endpoint — `twapPayload` returns the input for `placeTwapOrder`, and an
 *   `unknown` outcome there must block retry until the next `twapStates`
 *   frame because nothing exists to reconcile by.
 */

import { BigNumber } from "bignumber.js";

import type { OrderSide, TicketState, TicketContext } from "@/components/trade/orderForm";
import { parseRuntimeMinutes, triggerShapeOf } from "@/components/trade/orderForm";
import { HlError } from "@/hyperliquid/core/errors";
import {
  buildLimitOrder,
  buildMarketOrder,
  buildTriggerOrder,
  type AssetSpec,
  type Grouping,
  type OrderLeg,
} from "@/hyperliquid/orders/build";
import { buildScaleOrder } from "@/hyperliquid/orders/scale";
import type { TwapOrderInput } from "@/hyperliquid/orders/exchange";

function isBuyOf(side: OrderSide): boolean {
  return side === "long";
}

/** The price a market-shaped leg slips from — mid first, mark as fallback. */
function referencePriceOf(ctx: TicketContext): string {
  const reference = ctx.midPx ?? ctx.markPx;
  if (reference === null) {
    throw new HlError("No live reference price to submit against", { code: "invalid_config" });
  }
  return reference;
}

export interface TicketLegs {
  legs: readonly OrderLeg[];
  grouping: Grouping;
}

/**
 * The legs a non-TWAP ticket submits. Throws (builder rules) rather than
 * returning null — callers gate on `orderBlockers` first, so a throw here is
 * a defect, not a user error, and must be loud.
 */
export function ticketToLegs(
  ticket: TicketState,
  ctx: TicketContext,
  asset: AssetSpec
): TicketLegs {
  const isBuy = isBuyOf(ticket.side);
  const trigger = triggerShapeOf(ticket.type);

  if (ticket.type === "twap") {
    throw new HlError("A TWAP is not legs — use twapPayload", { code: "invalid_config" });
  }

  if (ticket.type === "scale") {
    const plan = buildScaleOrder({
      asset,
      isBuy,
      startPrice: ticket.scaleStart,
      endPrice: ticket.scaleEnd,
      totalSize: ticket.size,
      legCount: Number(ticket.legCount),
      distribution: "flat",
      tif: "Gtc",
      reduceOnly: ticket.reduceOnly,
    });
    return { legs: plan.legs, grouping: "na" };
  }

  if (trigger !== null) {
    return {
      legs: [
        buildTriggerOrder({
          asset,
          isBuy,
          triggerPrice: ticket.triggerPrice,
          ...(trigger.isMarket ? {} : { limitPrice: ticket.price }),
          isMarket: trigger.isMarket,
          tpsl: trigger.tpsl,
          size: ticket.size,
          reduceOnly: ticket.reduceOnly,
        }),
      ],
      grouping: "na",
    };
  }

  const parent =
    ticket.type === "market"
      ? buildMarketOrder({
          asset,
          isBuy,
          size: ticket.size,
          referencePrice: referencePriceOf(ctx),
          reduceOnly: ticket.reduceOnly,
        })
      : buildLimitOrder({
          asset,
          isBuy,
          price: ticket.price,
          size: ticket.size,
          tif: ticket.tif,
          reduceOnly: ticket.reduceOnly,
        });

  const wantsBrackets = ticket.tpEnabled || ticket.slEnabled;
  if (!wantsBrackets) return { legs: [parent], grouping: "na" };

  // The brackets close the position the parent opens: REVERSE side, reduce
  // only, sized to the parent. Market execution on fire — a bracket that
  // rests as a limit can be gapped straight through.
  const children: OrderLeg[] = [];
  if (ticket.tpEnabled && ticket.tpPrice !== "") {
    children.push(
      buildTriggerOrder({
        asset,
        isBuy: !isBuy,
        triggerPrice: ticket.tpPrice,
        isMarket: true,
        tpsl: "tp",
        size: ticket.size,
        reduceOnly: true,
      })
    );
  }
  if (ticket.slEnabled && ticket.slPrice !== "") {
    children.push(
      buildTriggerOrder({
        asset,
        isBuy: !isBuy,
        triggerPrice: ticket.slPrice,
        isMarket: true,
        tpsl: "sl",
        size: ticket.size,
        reduceOnly: true,
      })
    );
  }
  if (children.length === 0) return { legs: [parent], grouping: "na" };
  return { legs: [parent, ...children], grouping: "normalTpsl" };
}

/**
 * TP/SL for a position that ALREADY EXISTS — no parent, size zero.
 *
 * Three differences from the ticket's bracket path above, all load-bearing:
 *
 * - **`grouping: "positionTpsl"`**, not `normalTpsl`. The SDK's own wording:
 *   `normalTpsl` is "fixed size that doesn't adjust with position changes",
 *   `positionTpsl` "adjusts proportionally with the position size". A bracket
 *   attached to a live position must be the second, or it strands at the old
 *   size the moment the position is added to or partly closed.
 * - **`size: "0"`**, the legal encoding of "track the whole position"
 *   (`buildTriggerOrder` documents it and bypasses `formatSize` for it). It
 *   is what makes `positionTpsl` mean anything.
 * - **No parent leg.** The position is the parent; these legs stand alone.
 *
 * Everything else is the ticket's rules verbatim: reverse side so the bracket
 * CLOSES the position, reduce-only so it can never open the opposite one,
 * market execution so a gap cannot jump a resting limit, the tp/sl label
 * taken from the user's intent rather than inferred from the price, and the
 * trigger price passed RAW for directional snapping.
 *
 * Returns an empty leg list when neither price is set — the caller cancels
 * existing brackets rather than submitting nothing.
 */
export function positionTpslLegs(params: {
  asset: AssetSpec;
  /** The OPEN position's side. The legs come out on the opposite one. */
  side: OrderSide;
  /** Empty string means "not set" — the same convention the ticket uses. */
  takeProfitPrice: string;
  stopLossPrice: string;
}): { legs: OrderLeg[]; grouping: Grouping } {
  // A long position is closed by a SELL, so the brackets are buys only when
  // the position is short.
  const isBuy = params.side === "short";
  const legs: OrderLeg[] = [];
  if (params.takeProfitPrice !== "") {
    legs.push(
      buildTriggerOrder({
        asset: params.asset,
        isBuy,
        triggerPrice: params.takeProfitPrice,
        isMarket: true,
        tpsl: "tp",
        size: "0",
        reduceOnly: true,
      })
    );
  }
  if (params.stopLossPrice !== "") {
    legs.push(
      buildTriggerOrder({
        asset: params.asset,
        isBuy,
        triggerPrice: params.stopLossPrice,
        isMarket: true,
        tpsl: "sl",
        size: "0",
        reduceOnly: true,
      })
    );
  }
  return { legs, grouping: legs.length === 0 ? "na" : "positionTpsl" };
}

/** The TWAP endpoint's input. Throws on a non-TWAP ticket. */
export function twapPayload(
  ticket: TicketState,
  ctx: TicketContext,
  asset: AssetSpec
): TwapOrderInput {
  if (ticket.type !== "twap") {
    throw new HlError("Not a TWAP ticket", { code: "invalid_config" });
  }
  const minutes = parseRuntimeMinutes(ticket.runtime);
  if (minutes === null) {
    throw new HlError("TWAP runtime is not valid", { code: "invalid_config" });
  }
  return {
    assetId: asset.assetId,
    isBuy: isBuyOf(ticket.side),
    size: new BigNumber(ticket.size).toFixed(),
    durationMinutes: minutes,
    randomize: ticket.randomize,
    reduceOnly: ticket.reduceOnly,
    referencePrice: ctx.midPx ?? ctx.markPx ?? undefined,
  };
}
