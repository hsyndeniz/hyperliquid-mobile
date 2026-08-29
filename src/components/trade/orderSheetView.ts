/**
 * Order-sheet logic — every number the `/order` modal derives, computed where
 * Jest can reach it.
 *
 * The sheet's model is **margin-first**: the user commits a margin (the
 * screenshot's "Margin (USDC) · 3"), and size is derived from it through
 * leverage and the reference price. The ticket itself still carries size in
 * BASE units always — `sizeUnit` never leaves `"base"` in this skin — because
 * the submit path uses `ticket.size` raw, and a quote-denominated string
 * reaching `ticketToLegs` would be a USDC notional wearing a size label.
 *
 * Conventions, restated at the edge:
 * - Strings in, strings out; BigNumber inside; `Number()` never touches money.
 * - `""` means "nothing usable" for editable values; `null` means it for
 *   derived readouts. Neither is ever rendered as a zero.
 * - Every produced price is snapped to the asset's grid — an unsnapped chip
 *   price would be rejected by the exchange as a tick error.
 */

import { sizeFromNotional } from "@/components/trade/orderForm";
import { snapPriceToGrid, toBigNumber } from "@/hyperliquid/core/precision";

import type { OrderSide, TicketContext, TicketState } from "@/components/trade/orderForm";

/**
 * The price-editor chips: two steps either side of the mid, mid itself in the
 * centre — the reference app's `-1% · -0.3% · Mid · +0.3% · +1%` row. Tight
 * steps on purpose: a resting limit lives near the touch, and a fat-finger
 * +10% market-crosses.
 */
export const PRICE_CHIP_STEPS: readonly { label: string; pct: number }[] = [
  { label: "-1%", pct: -0.01 },
  { label: "-0.3%", pct: -0.003 },
  { label: "Mid", pct: 0 },
  { label: "+0.3%", pct: 0.003 },
  { label: "+1%", pct: 0.01 },
];

/** The TP/SL preset magnitudes — the reference app's 5 / 10 / 25 / 50. */
export const TPSL_PRESET_PCTS: readonly number[] = [0.05, 0.1, 0.25, 0.5];

/**
 * A price `pct` away from `anchor`, snapped NEAREST to the asset's grid.
 *
 * Nearest, not directional: these chips are suggestions, not protective
 * levels, and the nearest grid point is the number the user meant. (Trigger
 * prices get their protective directional snap later, inside
 * `buildTriggerOrder` — snapping here too would be harmless but misleading.)
 * `""` when the anchor is unusable, so the caller renders the chip disabled
 * rather than a wrong number.
 */
export function chipPrice(
  anchor: string | null,
  pct: number,
  szDecimals: number | null,
  marketType: "perp" | "spot"
): string {
  if (anchor === null) return "";
  const base = toBigNumber(anchor);
  if (!base.isFinite() || base.lte(0)) return "";
  const snapped = snapPriceToGrid(base.times(1 + pct), "nearest", szDecimals ?? 1, marketType);
  return snapped === null ? "" : snapped.toFixed();
}

/**
 * Which side of entry a TP or SL belongs on.
 *
 * TP is the side where the position PROFITS (above entry for a long, below
 * for a short); SL is where it bleeds. This is intent, not validation — the
 * editor uses it to aim the preset chips, and a hand-typed price on the
 * "wrong" side is still accepted, because the exchange accepts it too.
 */
export function tpslDirection(kind: "tp" | "sl", side: OrderSide): "above" | "below" {
  const profitable = side === "long" ? "above" : "below";
  const losing = side === "long" ? "below" : "above";
  return kind === "tp" ? profitable : losing;
}

/** A preset chip's price: `pct` toward the kind's own side of entry. */
export function tpslPresetPrice(
  entry: string | null,
  pct: number,
  kind: "tp" | "sl",
  side: OrderSide,
  szDecimals: number | null,
  marketType: "perp" | "spot"
): string {
  const signed = tpslDirection(kind, side) === "above" ? pct : -pct;
  return chipPrice(entry, signed, szDecimals, marketType);
}

/**
 * How far `target` sits from `entry`, as a signed percent label — the
 * editor's "-1.90% below current price" line. `null` when either is unusable.
 */
export function offsetPctLabel(entry: string | null, target: string): string | null {
  if (entry === null) return null;
  const from = toBigNumber(entry);
  const to = toBigNumber(target);
  if (!from.isFinite() || from.lte(0) || !to.isFinite() || to.lte(0)) return null;
  const pct = to.div(from).minus(1).times(100);
  return `${pct.gte(0) ? "+" : ""}${pct.toFixed(2)}%`;
}

/**
 * The PnL a fill at `target` would realise against `entry`, in quote units.
 *
 * Signed: a stop below entry on a long comes out negative, which is the whole
 * message of the readout. `null` when any input is unusable or the size is
 * not positive — a projection over nothing is not zero.
 */
export function projectedPnl(
  entry: string | null,
  target: string,
  baseSize: string,
  side: OrderSide
): string | null {
  if (entry === null) return null;
  const from = toBigNumber(entry);
  const to = toBigNumber(target);
  const size = toBigNumber(baseSize);
  if (!from.isFinite() || from.lte(0) || !to.isFinite() || to.lte(0)) return null;
  if (!size.isFinite() || size.lte(0)) return null;
  const move = side === "long" ? to.minus(from) : from.minus(to);
  return move.times(size).toFixed(2);
}

/**
 * A PnL as a percent of the margin behind it — the editor's "You Gain (ROI)".
 * `null` when the margin is unusable or non-positive (ROI on zero margin is
 * not a number, and rendering one would claim infinite leverage).
 */
export function roiOnMargin(margin: string | null, pnl: string | null): string | null {
  if (margin === null || pnl === null) return null;
  const base = toBigNumber(margin);
  const gain = toBigNumber(pnl);
  if (!base.isFinite() || base.lte(0) || !gain.isFinite()) return null;
  const pct = gain.div(base).times(100);
  return `${pct.gte(0) ? "+" : ""}${pct.toFixed(2)}%`;
}

/**
 * Margin → base size, through leverage and the reference price.
 *
 * The inverse of `orderInfo`'s `marginRequired = notional / leverage`:
 * notional = margin × leverage, then quote→base via {@link sizeFromNotional}
 * (which truncates DOWN to the lot grid — a margin that buys 1.4 lots buys
 * 1). Leverage is clamped to ≥ 1 the same way `maxSizeFor` clamps it, so a
 * spot caller passing its constant 1 and a perp caller passing an unread 0
 * both stay sane.
 */
export function sizeFromMargin(
  margin: string,
  leverage: number,
  price: string | null,
  szDecimals: number
): string {
  const committed = toBigNumber(margin);
  if (!committed.isFinite() || committed.lte(0)) return "";
  const lever = Number.isFinite(leverage) && leverage >= 1 ? leverage : 1;
  return sizeFromNotional(committed.times(lever).toFixed(), price, szDecimals);
}

/**
 * How far the estimated liquidation sits from the current price, as a signed
 * percent label — the "-3.80% from current price" line under the estimate.
 * Reuses the offset math; `"--"` liq strings (orderInfo's unknown) map to
 * `null` because `toBigNumber("--")` is NaN.
 */
export function liqDeltaPct(liq: string, current: string | null): string | null {
  return offsetPctLabel(current, liq);
}

/**
 * The size row's two spellings — "$119.88 = 0.00155 BTC".
 *
 * Derived from the ticket's base size and the ticket context's own reference
 * (mid, falling back to mark), NOT from `orderInfo.orderValue`: orderValue
 * values limit tickets at their typed price, while this row answers "what
 * does the margin I committed buy right now", which is a spot question.
 */
export function sizeLine(
  ticket: Pick<TicketState, "size">,
  ctx: Pick<TicketContext, "midPx" | "markPx" | "symbol">
): { notional: string; base: string } | null {
  const size = toBigNumber(ticket.size);
  if (!size.isFinite() || size.lte(0)) return null;
  const price = toBigNumber(ctx.midPx ?? ctx.markPx ?? NaN);
  if (!price.isFinite() || price.lte(0)) return null;
  return {
    notional: size.times(price).toFixed(2),
    base: `${size.toFixed()} ${ctx.symbol}`,
  };
}

/**
 * Normalise a locale decimal separator to the wire one.
 *
 * A `decimal-pad` keyboard renders the LOCALE's separator — a comma across
 * most of Europe, and on this project's own simulator, where prices already
 * read `78.658,5`. `acceptDecimalEdit` only speaks `"."`, so without this a
 * user in a comma locale cannot type a fraction at all: the only separator
 * key on their keyboard is rejected on every press.
 *
 * Every comma is replaced, not just the first: `"1,5,5"` becomes `"1.5.5"`,
 * which `acceptDecimalEdit` then rejects for having two dots — the same
 * answer it would give a dot-locale user typing `"1.5.5"`. Normalising must
 * not make an invalid string valid.
 */
export function normalizeDecimalInput(text: string): string {
  return text.replace(/,/g, ".");
}
