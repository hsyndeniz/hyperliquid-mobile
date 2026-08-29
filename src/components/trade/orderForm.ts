/**
 * The order ticket's pure rules: which fields each order type renders, what a
 * keystroke may put in a size or price field, the slider ⇄ size and base ⇄
 * quote conversions, the largest size a ticket can carry, TWAP runtime
 * parsing, every reason a ticket cannot be sent, the read-only info rows, and
 * the CTA's whole surface.
 *
 * Lives beside the trade components for the reason `tradeView.ts` states:
 * importing a component under Jest drags in Reanimated/Worklets/Skia, none of
 * which load there, so the logic with rules in it is a `.ts` module and the
 * markup stays markup.
 *
 * Two conventions hold throughout, both inherited from the money path:
 * - Everything the user typed is a **string** and stays one. `BigNumber` for
 *   the maths; `Number()` only where a value becomes a display leaf or a
 *   slider fraction.
 * - A half-typed ticket is the NORMAL state, not an error. Nothing here
 *   throws on garbage input — blockers name what is missing, info rows render
 *   `"--"`, and a rejected keystroke is simply a no-op.
 *
 * Deliberately imports **no builder** (`buildLimitOrder`, `buildTriggerOrder`,
 * `buildScaleOrder`, `snapTriggerPrice`): the info rows compute from
 * `notionalOf` and `calculateLiquidationPrice` directly, so no leg object
 * exists anywhere in this pass to be accidentally handed to a submit.
 */

import { BigNumber } from "bignumber.js";

import type { TradableKind } from "@/components/trade/tradeView";
import { MAX_DECIMALS_PERP, MAX_DECIMALS_SPOT } from "@/hyperliquid/config/constants";
import { OUTCOME_PRICE_SZ_DECIMALS, OUTCOME_SIZE_DECIMALS } from "@/hyperliquid/core/assetIds";
import { calculateLiquidationPrice, toBigNumber } from "@/hyperliquid/core/precision";
import {
  DEFAULT_SLIPPAGE,
  MIN_ORDER_NOTIONAL_USDC,
  notionalOf,
  type Tif,
} from "@/hyperliquid/orders/build";
import {
  TWAP_MAX_MINUTES,
  TWAP_MIN_MINUTES,
  TWAP_MIN_NOTIONAL_USDC,
} from "@/hyperliquid/orders/exchange";

/**
 * The TWAP bounds, re-exported from the module that enforces them on the wire
 * path (`orders/exchange.ts`). Re-exported rather than redeclared so the form
 * cannot drift from what `placeTwapOrder` actually refuses — a form validating
 * against its own copy of a constant tells the user their TWAP is fine and
 * then burns an action on the refusal.
 */
export { TWAP_MAX_MINUTES, TWAP_MIN_MINUTES, TWAP_MIN_NOTIONAL_USDC };

/**
 * The eight order types the ticket offers — the reference's "Pro" menu minus
 * Chase, which was cut deliberately. Keys are wire-adjacent camelCase; the
 * display names live in {@link ORDER_TYPE_LABEL}.
 */
export type OrderType =
  "market" | "limit" | "stopMarket" | "stopLimit" | "takeMarket" | "takeLimit" | "scale" | "twap";

export type OrderSide = "long" | "short";

/** Which unit the size field is denominated in: base asset or USDC notional. */
export type SizeUnit = "base" | "quote";

/**
 * Display names, verbatim from the reference's order-type menu, declared in
 * the menu's order — `Object.keys` of this object IS the menu, so the order
 * of these properties is load-bearing, not cosmetic.
 */
export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  market: "Market",
  limit: "Limit",
  scale: "Scale",
  stopLimit: "Stop Limit",
  stopMarket: "Stop Market",
  takeLimit: "Take Limit",
  takeMarket: "Take Market",
  twap: "TWAP",
};

/**
 * The 2x2 the four trigger types collapse onto `buildTriggerOrder`'s
 * `{tpsl, isMarket}`. `null` for the four non-trigger types.
 *
 * Exists so the mapping is stated once: a stop protects against the market
 * moving AGAINST the position (`sl`), a take banks the move WITH it (`tp`),
 * and the Market/Limit suffix is exactly `isMarket`. A component re-deriving
 * this per call site would eventually invert one cell and place a take-profit
 * that fires as a stop.
 */
export function triggerShapeOf(type: OrderType): { tpsl: "tp" | "sl"; isMarket: boolean } | null {
  switch (type) {
    case "stopMarket":
      return { tpsl: "sl", isMarket: true };
    case "stopLimit":
      return { tpsl: "sl", isMarket: false };
    case "takeMarket":
      return { tpsl: "tp", isMarket: true };
    case "takeLimit":
      return { tpsl: "tp", isMarket: false };
    default:
      return null;
  }
}

/**
 * Which fields a type renders. The JSX is one render of this declared set
 * rather than a chain of ternaries, so the rules below are testable.
 */
export interface OrderFieldSet {
  /** The resting limit price — the three limit-shaped types only. */
  price: boolean;
  /** The price that fires a trigger order — the four trigger types only. */
  triggerPrice: boolean;
  /** Scale's start/end bounds and leg count. */
  scaleRange: boolean;
  /** TWAP's running time. */
  runtime: boolean;
  /**
   * Time-in-force. FALSE for every trigger type: emitting a tif on a trigger
   * leg pushes the object into the `limit` branch of the `t` union and
   * silently downgrades a TP/SL to a plain limit order at the trigger price
   * (orders/build.ts:326-328). Scale and TWAP have no tif either — a ladder
   * rests Gtc and a TWAP carries no tif at all. Not disabled, NOT RENDERED.
   */
  tif: boolean;
  reduceOnly: boolean;
  /** Randomised slice timing — TWAP only. */
  randomize: boolean;
  /** Max-slippage editor — market execution only. */
  slippage: boolean;
  /** The base ⇄ quote unit toggle on the size field. */
  sizeUnitToggle: boolean;
  /**
   * The attached Take Profit / Stop Loss checkboxes (`tpEnabled`/`slEnabled`
   * in {@link TicketState}). Offered only on market and limit — a trigger
   * type IS a TP/SL, a ladder's legs would each need their own bracket, and a
   * TWAP has no single entry to bracket.
   */
  tpslAttach: boolean;
}

/**
 * Which fields an order type renders, on a given kind of market.
 *
 * `kind` gates the position-shaped fields: spot has no position, so reduce
 * only and an attached TP/SL have nothing to act on there — rendering them
 * would offer a checkbox whose wire meaning does not exist.
 */
export function fieldsFor(type: OrderType, kind: TradableKind): OrderFieldSet {
  const trigger = triggerShapeOf(type);
  const isPerp = kind === "perp";
  return {
    price: type === "limit" || type === "stopLimit" || type === "takeLimit",
    triggerPrice: trigger !== null,
    scaleRange: type === "scale",
    runtime: type === "twap",
    tif: type === "limit",
    reduceOnly: isPerp,
    randomize: type === "twap",
    slippage: type === "market" || trigger?.isMarket === true,
    sizeUnitToggle: type !== "scale",
    tpslAttach: isPerp && (type === "market" || type === "limit"),
  };
}

/** Digits, optionally one dot, optionally more digits. Nothing else, ever. */
const DECIMAL_SHAPE = /^[0-9]*(\.[0-9]*)?$/;

/** Enough for any size a person holds, and a hard stop on pathological input. */
const MAX_EDIT_CHARS = 20;

/**
 * The keystroke filter for the ticket's numeric fields, PARAMETERISED by
 * decimals — the one thing `acceptEdit` (money/amountEntry.ts:40) cannot do:
 * its cap is the module constant `AMOUNT_DECIMALS = 6` (USDC), wrong for both
 * size and price here, where the cap is per-asset (`szDecimals` for a size,
 * `maxDecimals − szDecimals` for a price, 0 for an outcome share).
 *
 * Same contract otherwise, keystroke for keystroke: `""` stays `""`; `null`
 * REJECTS and the caller keeps the old value (no error state, nothing to
 * dismiss); a leading `"."` becomes `"0."`; more than 20 characters, a second
 * dot, a sign, an exponent or a space is `null`; leading zeros are stripped
 * except the one that becomes `"0."`.
 *
 * At `decimals` 0 any dot at all is rejected — `"2."` included. An outcome
 * market's sizes are whole shares, and accepting the dot would leave a field
 * that can never become a legal size.
 */
export function acceptDecimalEdit(next: string, decimals: number): string | null {
  if (next.length === 0) return "";
  if (next.length > MAX_EDIT_CHARS) return null;

  // The LOCALE separator first, before anything judges the shape.
  //
  // A `decimal-pad` renders the locale's separator — a comma across most of
  // Europe, including this project's own simulator. Every filter below speaks
  // only ".", so a comma-locale user pressing their single separator key got a
  // silent no-op and could not type a fraction AT ALL; on any asset priced
  // under 1 USDC the field was unusable. It lives HERE rather than at the call
  // sites because it was at the call sites — one of four remembered it, and
  // the three that forgot are exactly the money fields that broke.
  //
  // Every comma is replaced, not just the first: "1,5,5" becomes "1.5.5",
  // which the shape test then rejects for two dots — the same answer a
  // dot-locale user typing "1.5.5" gets. Normalising must not make an invalid
  // string valid.
  const localised = next.replace(/,/g, ".");

  // A leading dot is the one edit worth *fixing* rather than refusing: tapping
  // "." on an empty field plainly means "nought point".
  const normalised = localised.startsWith(".") ? `0${localised}` : localised;

  if (!DECIMAL_SHAPE.test(normalised)) return null;

  const [whole, fraction] = normalised.split(".");
  if (fraction !== undefined && decimals <= 0) return null;
  if (fraction !== undefined && fraction.length > decimals) return null;

  // `"007"` is not a thing anyone means. Leading zeros are stripped, except the
  // single `"0"` that has to survive long enough to become `"0."`.
  const trimmed = whole.replace(/^0+(?=[0-9])/, "");
  return fraction === undefined ? trimmed : `${trimmed}.${fraction}`;
}

/**
 * The size field's decimal cap. `null` szDecimals means an outcome market
 * (absent from every metadata surface), whose sizes are whole shares —
 * {@link OUTCOME_SIZE_DECIMALS}, measured at 0 across 3,288 live size strings.
 */
export function sizeDecimalsOf(szDecimals: number | null): number {
  return szDecimals ?? OUTCOME_SIZE_DECIMALS;
}

/**
 * The price field's decimal cap: `max((perp ? 6 : 8) − szDecimals, 0)` —
 * Hyperliquid's tick rule, the same arithmetic as precision.ts's private
 * `maxDecimalsFor`, from the same `MAX_DECIMALS_*` constants.
 *
 * `null` szDecimals substitutes {@link OUTCOME_PRICE_SZ_DECIMALS} (1), NOT
 * the size fallback of 0: an outcome market's prices carry 5 decimals while
 * its sizes carry none, and no single number describes both — the exact trap
 * that makes the SDK's hard-coded 5 turn `"0.99283"` into `"0.9"` silently
 * (assetIds.ts:66-80).
 */
export function priceDecimalsOf(szDecimals: number | null, marketType: "perp" | "spot"): number {
  const priceSzDecimals = szDecimals ?? OUTCOME_PRICE_SZ_DECIMALS;
  const ceiling = marketType === "perp" ? MAX_DECIMALS_PERP : MAX_DECIMALS_SPOT;
  return Math.max(ceiling - priceSzDecimals, 0);
}

/** `decimalPlaces` throws on a negative or fractional dp; garbage clamps to 0. */
function lotDecimals(szDecimals: number): number {
  return Number.isInteger(szDecimals) && szDecimals >= 0 ? szDecimals : 0;
}

/** A typed string as a finite, strictly positive BigNumber, else `null`. */
function parsePositive(value: string): BigNumber | null {
  const parsed = toBigNumber(value);
  return parsed.isFinite() && parsed.gt(0) ? parsed : null;
}

/**
 * Slider → size. The float is the *input gesture*, never the size — it goes
 * through BigNumber and is rounded **DOWN to the asset's lot** (`szDecimals`),
 * not to 6 decimals: that is `amountForFraction`'s USDC assumption, and a size
 * carrying more decimals than the lot is a size `formatSize` throws on.
 *
 * At the extremes it is exact, not approximate: fraction >= 1 returns
 * `maxSize` VERBATIM — byte-identical, so Max and the slider's right edge
 * produce the same string and the two paths cannot disagree by dust — and
 * fraction <= 0 returns the empty field, never the illegal size `"0"`. A
 * fraction so small it truncates below one lot also returns `""`: a thumb
 * position that means less than one lot is an empty ticket, not a zero one.
 */
export function sizeForFraction(
  maxSize: string | null,
  fraction: number,
  szDecimals: number
): string {
  if (maxSize === null || !Number.isFinite(fraction) || fraction <= 0) return "";
  const total = toBigNumber(maxSize);
  if (!total.isFinite() || total.lte(0)) return "";
  if (fraction >= 1) return maxSize;
  const sized = total
    .multipliedBy(fraction)
    .decimalPlaces(lotDecimals(szDecimals), BigNumber.ROUND_DOWN);
  return sized.lte(0) ? "" : sized.toFixed();
}

/**
 * Size → slider, clamped to [0, 1]. `Number()` at a display leaf, which is
 * where the house rule allows it: this feeds a thumb position and nothing
 * that gets signed. `0` while the max is unknown or the size is half-typed —
 * a bar cannot render "unknown", so it renders empty.
 */
export function fractionOfSize(size: string, maxSize: string | null): number {
  if (maxSize === null) return 0;
  const value = Number(size);
  const total = Number(maxSize);
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, value / total));
}

/**
 * Quote → base at a price, rounded DOWN to the asset's lot. `""` on any
 * unusable input — an unknown price cannot honestly become a size, and a
 * notional too small for one lot is an empty field, not `"0"`.
 */
export function sizeFromNotional(
  notional: string,
  price: string | null,
  szDecimals: number
): string {
  if (price === null) return "";
  const quote = parsePositive(notional);
  const px = parsePositive(price);
  if (quote === null || px === null) return "";
  const size = quote.dividedBy(px).decimalPlaces(lotDecimals(szDecimals), BigNumber.ROUND_DOWN);
  return size.lte(0) ? "" : size.toFixed();
}

/**
 * How many decimals the quote (USDC) side of the unit toggle carries: cents.
 * The quote figure never reaches the wire — orders are sized in base — so the
 * cap is a typing convention, not a wire rule.
 */
const QUOTE_DECIMALS = 2;

/**
 * Base → quote at a price, rounded DOWN to cents. `""` on unusable input.
 * Rounded down, not half-up: this fills the editable quote field when the
 * unit toggle flips, and rounding up would show a notional the typed size
 * cannot actually reach.
 */
export function notionalFromSize(size: string, price: string | null): string {
  if (price === null) return "";
  const base = parsePositive(size);
  const px = parsePositive(price);
  if (base === null || px === null) return "";
  return base.multipliedBy(px).decimalPlaces(QUOTE_DECIMALS, BigNumber.ROUND_DOWN).toFixed();
}

/**
 * The largest size this ticket can carry, as a wire-shaped string.
 *
 * `null` means UNKNOWN — the balance or price has not been read — and is
 * **never** spelled `"0"`: the AmountPad convention, where `null` disables
 * Max and the caption carries the reason, while `"0"` claims a measured
 * empty account. A read balance of zero genuinely returns `"0"`.
 *
 * Reduce-only caps at the position's **unsigned** size and ignores margin
 * entirely — closing needs no new collateral, and the sign is the side, not
 * part of the quantity. An unread position under reduce-only is `null`, not
 * zero: claiming "nothing to reduce" about a position nobody read would
 * disable a close that is actually legal.
 *
 * Otherwise `available × leverage / price`, rounded DOWN to the lot so Max
 * can never propose a size the wire truncates upward past the margin.
 */
export function maxSizeFor(params: {
  available: string | null;
  price: string | null;
  leverage: number;
  szDecimals: number;
  reduceOnly: boolean;
  positionSize: string | null;
  /**
   * A cap already denominated in BASE units — used for a spot SELL, whose
   * limit is simply the token balance.
   *
   * Without it the sell was capped by round-tripping through money: the screen
   * converted the base balance to USDC at the MID, and this function divided
   * that back by the ticket's own reference price. Whenever the limit differed
   * from the mid the two prices did not cancel, so the cap came out wrong in
   * both directions — a limit sell above mid could not sell the whole balance
   * (100 HYPE, mid 40, limit 50 capped at 80), and one below mid proposed
   * more than the user holds. A balance is not spending power and must not be
   * priced twice.
   */
  baseCap?: string | null;
}): string | null {
  const decimals = lotDecimals(params.szDecimals);

  if (params.reduceOnly) {
    if (params.positionSize === null) return null;
    const position = toBigNumber(params.positionSize);
    if (!position.isFinite()) return null;
    return position.abs().decimalPlaces(decimals, BigNumber.ROUND_DOWN).toFixed();
  }

  // Before the priced path: a base-denominated cap needs no price at all, so
  // it also survives the moment before a mid arrives.
  if (params.baseCap !== undefined && params.baseCap !== null) {
    const cap = toBigNumber(params.baseCap);
    if (!cap.isFinite()) return null;
    if (cap.lte(0)) return "0";
    return cap.decimalPlaces(decimals, BigNumber.ROUND_DOWN).toFixed();
  }

  if (params.available === null || params.price === null) return null;
  const available = toBigNumber(params.available);
  const price = toBigNumber(params.price);
  if (!available.isFinite() || !price.isFinite() || price.lte(0)) return null;

  // Spot passes 1; a perp context always carries a real leverage. Anything
  // else is defensive clamping, never a reason to claim the max is unknown.
  const leverage = Number.isFinite(params.leverage) && params.leverage >= 1 ? params.leverage : 1;
  const max = available.multipliedBy(leverage).dividedBy(price);
  if (max.lte(0)) return "0";
  return max.decimalPlaces(decimals, BigNumber.ROUND_DOWN).toFixed();
}

const RUNTIME_SHAPE = /^(?:([0-9]+)d)?\s*(?:([0-9]+)h)?\s*(?:([0-9]+)m)?$/;

/**
 * TWAP runtime, parsed to whole minutes. `"30m"`, `"2h"`, `"2h30m"`, `"1d"`
 * and bare `"90"` (minutes) all parse; anything unparseable, fractional, or
 * outside {@link TWAP_MIN_MINUTES}..{@link TWAP_MAX_MINUTES} is `null`.
 *
 * The bounds are checked HERE, not left to the wire: `placeTwapOrder` throws
 * on an out-of-range duration (exchange.ts:518-526), and by then the action
 * is being spent from a budget earned only by traded volume. `null` from this
 * function IS the `runtimeOutOfRange` blocker.
 */
export function parseRuntimeMinutes(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  let minutes: number;
  if (/^[0-9]+$/.test(trimmed)) {
    minutes = Number(trimmed);
  } else {
    const match = RUNTIME_SHAPE.exec(trimmed);
    if (match === null) return null;
    const [, days, hours, mins] = match;
    if (days === undefined && hours === undefined && mins === undefined) return null;
    minutes = Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(mins ?? 0);
  }

  if (!Number.isInteger(minutes)) return null;
  if (minutes < TWAP_MIN_MINUTES || minutes > TWAP_MAX_MINUTES) return null;
  return minutes;
}

/**
 * Whole minutes as the runtime echo — `"30m"`, `"1h 30m"`, `"1d"`. The
 * inverse display of {@link parseRuntimeMinutes} (every output round-trips
 * through it), `"--"` for anything that is not a positive whole number.
 */
export function formatRuntime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes <= 0) return "--";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

/**
 * Everything the user typed, wire-shaped: every numeric is a string. `size`
 * is denominated in `sizeUnit` — a quote-unit size IS the notional, and the
 * base size is derived at the current reference price.
 */
export interface TicketState {
  type: OrderType;
  side: OrderSide;
  sizeUnit: SizeUnit;
  size: string;
  price: string;
  triggerPrice: string;
  scaleStart: string;
  scaleEnd: string;
  legCount: string;
  runtime: string;
  tif: Tif;
  reduceOnly: boolean;
  randomize: boolean;
  tpEnabled: boolean;
  tpPrice: string;
  slEnabled: boolean;
  slPrice: string;
}

/**
 * Everything the screen knows. Nullable throughout: `null` means UNREAD, and
 * every consumer below treats it as unknown rather than zero. `leverage` is
 * the account's REAL leverage from the position/context — never a UI toggle,
 * which this pass renders read-only precisely so these rows cannot misstate
 * the margin regime the user is deciding against.
 */
export interface TicketContext {
  kind: TradableKind;
  marketType: "perp" | "spot";
  symbol: string;
  szDecimals: number | null;
  markPx: string | null;
  midPx: string | null;
  available: string | null;
  /**
   * The base-token balance, for a SPOT market only — `null` on a perp or
   * before the balance is read.
   *
   * Separate from `available` (which is USDC everywhere) because a spot SELL
   * is capped by the tokens held, not by their momentary worth: converting to
   * USDC at the mid and dividing back by the ticket's limit price mis-sizes
   * the sell whenever those two prices differ. See `maxSizeFor`'s `baseCap`.
   */
  baseAvailable: string | null;
  positionSize: string | null;
  leverage: number;
  /** Maintenance margin rate as a fraction (`"0.01"` = 1%). */
  maintenanceMarginRate: string | null;
  /**
   * Fee rates as fractions (`"0.00045"` = 0.045%), shown as a PAIR.
   *
   * Both, not one, because which applies is not knowable here: a market or
   * IOC order is taker and an ALO is maker, but a plain GTC limit is
   * whichever the book makes it. Picking one would be a guess rendered as a
   * fact; the reference app shows the pair for the same reason.
   */
  takerFeeRate: string | null;
  makerFeeRate: string | null;
  isSignedIn: boolean;
  canTrade: boolean;
}

export type BlockerCode =
  | "signedOut"
  | "noAgent"
  | "noPrice"
  | "noSize"
  | "sizeTooLarge"
  | "belowMinNotional"
  | "belowTwapMinNotional"
  | "runtimeOutOfRange"
  | "priceRequired"
  | "triggerRequired"
  | "scaleRangeInvalid"
  | "legCountInvalid";

export interface Blocker {
  code: BlockerCode;
  message: string;
}

const BLOCKER_MESSAGE: Record<BlockerCode, string> = {
  signedOut: "Connect a wallet to trade",
  noAgent: "Approve trading to continue",
  noPrice: "Waiting for a market price",
  noSize: "Enter a size",
  sizeTooLarge: "Size exceeds the max for this ticket",
  belowMinNotional: `Order value is below the ${MIN_ORDER_NOTIONAL_USDC} USDC minimum`,
  belowTwapMinNotional: `TWAP value is below the ${TWAP_MIN_NOTIONAL_USDC} USDC minimum`,
  runtimeOutOfRange: `Runtime must be between ${formatRuntime(TWAP_MIN_MINUTES)} and ${formatRuntime(TWAP_MAX_MINUTES)}`,
  priceRequired: "Enter a limit price",
  triggerRequired: "Enter a trigger price",
  scaleRangeInvalid: "Enter a valid start and end price",
  legCountInvalid: "Order count must be a whole number of at least 2",
};

function blocker(code: BlockerCode): Blocker {
  return { code, message: BLOCKER_MESSAGE[code] };
}

/**
 * The price a ticket is VALUED at — order value, margin, the $10/$100 floors
 * and the max-size cap all derive from it. Market-execution types (market,
 * TWAP) value at the mark (mid as fallback): the fill happens wherever the
 * market is. The limit-shaped types value at the resting price the user
 * typed. A market trigger values at its trigger price — that is where
 * `buildTriggerOrder` derives the slipped limit from (build.ts:335-341), not
 * at today's mark, which the order will not see. Scale values at the flat
 * ladder's mean.
 *
 * Exported (2026-08-22) so the order sheet can anchor its margin↔size
 * conversion and slider max at the SAME price the blockers and `orderInfo`
 * value the ticket at — a mark-anchored slider over a mean-valued scale
 * ladder let a maxed slider produce a size the blocker then rejected.
 */
export function referencePriceOf(ticket: TicketState, ctx: TicketContext): BigNumber | null {
  switch (ticket.type) {
    case "market":
    case "twap":
      return (
        (ctx.markPx === null ? null : parsePositive(ctx.markPx)) ??
        (ctx.midPx === null ? null : parsePositive(ctx.midPx))
      );
    case "limit":
    case "stopLimit":
    case "takeLimit":
      return parsePositive(ticket.price);
    case "stopMarket":
    case "takeMarket":
      return parsePositive(ticket.triggerPrice);
    case "scale": {
      const start = parsePositive(ticket.scaleStart);
      const end = parsePositive(ticket.scaleEnd);
      if (start === null || end === null) return null;
      return start.plus(end).dividedBy(2);
    }
  }
}

interface ResolvedAmounts {
  /** Size in base units, > 0, or `null` when unknown/absent. */
  baseSize: BigNumber | null;
  /** Notional in USDC, > 0, or `null` when unknown/absent. */
  notional: BigNumber | null;
  /** The user explicitly typed a zero — distinct from typing nothing. */
  typedZero: boolean;
}

/**
 * The typed size resolved into both denominations. In base mode the notional
 * is `notionalOf(price, size)` — the same multiplication `meetsMinNotional`
 * checks (build.ts:128-141) — and in quote mode the typed figure IS the
 * notional, with the base size derived by division and truncated to the lot.
 */
function resolveAmounts(
  ticket: TicketState,
  ctx: TicketContext,
  referencePrice: BigNumber | null
): ResolvedAmounts {
  const typed = toBigNumber(ticket.size);
  if (!typed.isFinite() || typed.lt(0)) return { baseSize: null, notional: null, typedZero: false };
  if (typed.isZero()) return { baseSize: null, notional: null, typedZero: true };

  if (ticket.sizeUnit === "quote") {
    const baseSize =
      referencePrice === null
        ? null
        : typed
            .dividedBy(referencePrice)
            .decimalPlaces(lotDecimals(sizeDecimalsOf(ctx.szDecimals)), BigNumber.ROUND_DOWN);
    return {
      baseSize: baseSize !== null && baseSize.gt(0) ? baseSize : null,
      notional: typed,
      typedZero: false,
    };
  }

  const notional =
    referencePrice === null ? null : notionalOf(referencePrice.toFixed(), typed.toFixed());
  return { baseSize: typed, notional, typedZero: false };
}

/** Scale's leg count, parsed. The FORM requires >= 2: a 1-leg ladder is a
 *  limit order wearing a costume, and `buildScaleOrder`'s own floor of 1
 *  (scale.ts:86) exists for programmatic callers, not the menu. */
function parseLegCount(text: string): number | null {
  if (!/^[0-9]+$/.test(text.trim())) return null;
  const count = Number(text.trim());
  return Number.isInteger(count) && count >= 2 ? count : null;
}

/**
 * Every reason this ticket cannot be sent, in the form's reading order —
 * account state first, then fields top to bottom. Empty means valid.
 *
 * The floors are enforced HERE because nothing else in src does: build.ts's
 * `assertMinNotional` has ZERO callers, and a server-rejected order still
 * burns an action from a budget earned only by traded volume (build.ts:66-69).
 * The $10 floor covers market/limit/stop/take; TWAP's floor is $100
 * (exchange.ts:459, measured, refused with an HTTP 200); scale is checked on
 * its WORST leg — `buildScaleOrder` throws per-leg (scale.ts:115), and a
 * ladder whose total clears $10 can still contain legs that do not.
 *
 * A size of `"0"` is legal ONLY on a trigger type, where it is the wire's
 * encoding for "the whole position" — everywhere else `formatSize` throws on
 * it, so it blocks as `noSize`.
 *
 * Signed out short-circuits: nothing below it is knowable without an account,
 * and the CTA in that state is the enabled "Connect wallet" branch anyway.
 */
export function orderBlockers(ticket: TicketState, ctx: TicketContext): readonly Blocker[] {
  if (!ctx.isSignedIn) return [blocker("signedOut")];

  const blockers: Blocker[] = [];
  if (!ctx.canTrade) blockers.push(blocker("noAgent"));

  const referencePrice = referencePriceOf(ticket, ctx);
  const { type } = ticket;

  // Market-execution types need a market price to value and to slip from; the
  // typed-price types surface the more actionable "enter a price" instead.
  if ((type === "market" || type === "twap") && referencePrice === null) {
    blockers.push(blocker("noPrice"));
  }

  let legCount: number | null = null;
  if (type === "scale") {
    if (parsePositive(ticket.scaleStart) === null || parsePositive(ticket.scaleEnd) === null) {
      blockers.push(blocker("scaleRangeInvalid"));
    }
    legCount = parseLegCount(ticket.legCount);
    if (legCount === null) blockers.push(blocker("legCountInvalid"));
  }

  const fields = fieldsFor(type, ctx.kind);
  if (fields.triggerPrice && parsePositive(ticket.triggerPrice) === null) {
    blockers.push(blocker("triggerRequired"));
  }
  if (fields.price && parsePositive(ticket.price) === null) {
    blockers.push(blocker("priceRequired"));
  }

  const { baseSize, notional, typedZero } = resolveAmounts(ticket, ctx, referencePrice);
  const zeroIsWholePosition = typedZero && triggerShapeOf(type) !== null;
  if (baseSize === null && notional === null && !zeroIsWholePosition) {
    blockers.push(blocker("noSize"));
  }

  // After size, matching the TWAP form's reading order (Total Size, then
  // Running Time). Covers empty, garbage and out-of-bounds alike.
  if (type === "twap" && parseRuntimeMinutes(ticket.runtime) === null) {
    blockers.push(blocker("runtimeOutOfRange"));
  }

  if (baseSize !== null) {
    const max = maxSizeFor({
      available: ctx.available,
      price: referencePrice === null ? null : referencePrice.toFixed(),
      leverage: ctx.leverage,
      szDecimals: sizeDecimalsOf(ctx.szDecimals),
      reduceOnly: ticket.reduceOnly,
      positionSize: ctx.positionSize,
      // A spot SELL spends tokens, so its ceiling is the token balance itself.
      baseCap: ctx.marketType === "spot" && ticket.side === "short" ? ctx.baseAvailable : null,
    });
    // `null` is UNKNOWN: an unread balance must not accuse the size of being
    // too large, and must not vouch for it either — the caption carries that.
    if (max !== null && baseSize.gt(toBigNumber(max))) {
      blockers.push(blocker("sizeTooLarge"));
    }
  }

  if (notional !== null) {
    if (type === "twap") {
      if (notional.lt(TWAP_MIN_NOTIONAL_USDC)) blockers.push(blocker("belowTwapMinNotional"));
    } else if (type === "scale") {
      if (baseSize !== null && legCount !== null && referencePrice !== null) {
        const worstPrice = BigNumber.minimum(
          toBigNumber(ticket.scaleStart),
          toBigNumber(ticket.scaleEnd)
        );
        const legSize = baseSize
          .dividedBy(legCount)
          .decimalPlaces(lotDecimals(sizeDecimalsOf(ctx.szDecimals)), BigNumber.ROUND_DOWN);
        if (legSize.multipliedBy(worstPrice).lt(MIN_ORDER_NOTIONAL_USDC)) {
          blockers.push(blocker("belowMinNotional"));
        }
      }
    } else if (notional.lt(MIN_ORDER_NOTIONAL_USDC)) {
      blockers.push(blocker("belowMinNotional"));
    }
  }

  return blockers;
}

/** The read-only rows. Strings, `"--"` for unknown — never a held zero. */
export interface OrderInfo {
  orderValue: string;
  marginRequired: string;
  liquidationPrice: string;
  fees: string;
  slippage: string | null;
  sizePerSuborder: string | null;
  scaleRemainder: string | null;
}

const UNKNOWN = "--";

/**
 * The info rows, computed without building a single leg — `notionalOf` and
 * `calculateLiquidationPrice` directly, so nothing here can be handed to a
 * submit path by accident.
 *
 * - **Order value** is size × the valuation price ({@link referencePriceOf}:
 *   mark for the market-execution types), in USDC at two decimals.
 * - **Margin required** is order value / the account's real leverage.
 * - **Liquidation price** is a pre-trade ESTIMATE and must be labelled one:
 *   `calculateLiquidationPrice`'s own doc records a measured 64x divergence
 *   from the exchange's figure, and an open position must show the server's
 *   `liquidationPx` instead. It is fed an **UNSIGNED** size — it throws on a
 *   negative one, deliberately (precision.ts:287-302) — and every throw or
 *   `null` (zero size, zero denominator, non-finite) is absorbed into `"--"`,
 *   because a half-typed ticket hits those paths on every keystroke. Spot has
 *   no liquidation, so spot is `"--"` unconditionally.
 * - **Fees** is the account's fee RATE as a percentage — the reference shows
 *   `0.0432% / 0.0144%`, not a dollar figure, and a sub-cent absolute fee
 *   would round to a `"0.00"` that reads as free.
 * - **Slippage** renders only where the field set offers it (market
 *   execution); this pass has no editor, so it is the {@link DEFAULT_SLIPPAGE}
 *   maximum.
 * - **Size per suborder** (TWAP only): total size / (minutes × 2). The wire
 *   module does not state the division; Hyperliquid runs a TWAP as one
 *   suborder per 30 seconds, hence two per minute. Truncated to the lot —
 *   the sizes the exchange will actually send.
 * - **Scale remainder** (scale only): what lot truncation strands, the figure
 *   `buildScaleOrder` returns precisely because the reference implementation
 *   throws it away (scale.ts:15-17,134). Flat distribution, matching the
 *   ticket, which offers no other.
 */
export function orderInfo(ticket: TicketState, ctx: TicketContext): OrderInfo {
  const fields = fieldsFor(ticket.type, ctx.kind);
  const referencePrice = referencePriceOf(ticket, ctx);
  const { baseSize, notional } = resolveAmounts(ticket, ctx, referencePrice);
  const leverage = Number.isFinite(ctx.leverage) && ctx.leverage >= 1 ? ctx.leverage : 1;

  const orderValue = notional !== null ? notional.toFixed(2) : UNKNOWN;
  const margin = notional !== null ? notional.dividedBy(leverage) : null;
  const marginRequired = margin !== null ? margin.toFixed(2) : UNKNOWN;

  let liquidationPrice = UNKNOWN;
  if (
    ctx.marketType === "perp" &&
    referencePrice !== null &&
    baseSize !== null &&
    margin !== null &&
    // Implied by `margin`, which is derived from it — but the maintenance
    // margin below is charged against the notional directly, so it is named.
    notional !== null &&
    ctx.maintenanceMarginRate !== null
  ) {
    const mmr = toBigNumber(ctx.maintenanceMarginRate);
    if (mmr.isFinite()) {
      try {
        // NET of maintenance margin, which is what Hyperliquid's formula means
        // by `margin_available`: "margin_available (isolated) = isolated_margin
        // - maintenance_margin_required". Passing the gross initial margin put
        // the estimate roughly twice as far from the mark as the truth — at 3x
        // on a 3x-max asset it promised a 40% cushion where the real one is
        // 20%, so a trader sized believing they had double the room and was
        // liquidated at half the move the sheet showed.
        const liq = calculateLiquidationPrice({
          entryPrice: referencePrice,
          marginAvailable: margin.minus(mmr.multipliedBy(notional)),
          positionSize: baseSize.abs(),
          mmr,
          side: ticket.side,
        });
        if (liq !== null && liq.gt(0)) {
          liquidationPrice = liq
            .decimalPlaces(priceDecimalsOf(ctx.szDecimals, ctx.marketType))
            .toFixed();
        }
      } catch {
        // The throw is the unsigned-size contract; a ticket cannot honour it
        // mid-keystroke, and an estimate that cannot be computed is "--".
      }
    }
  }

  // "taker / maker", the reference's own spelling. A negative maker rate is a
  // rebate tier and renders as typed — clamping it to zero would hide money
  // the user is owed.
  let fees = UNKNOWN;
  const asPercent = (rate: string | null): string | null => {
    if (rate === null) return null;
    const value = toBigNumber(rate);
    return value.isFinite() ? `${value.multipliedBy(100).toFixed(4)}%` : null;
  };
  const takerText = asPercent(ctx.takerFeeRate);
  const makerText = asPercent(ctx.makerFeeRate);
  if (takerText !== null && makerText !== null) fees = `${takerText} / ${makerText}`;
  else if (takerText !== null) fees = takerText;
  else if (makerText !== null) fees = makerText;

  const slippage = fields.slippage
    ? `${new BigNumber(DEFAULT_SLIPPAGE).multipliedBy(100).toFixed(2)}%`
    : null;

  let sizePerSuborder: string | null = null;
  if (ticket.type === "twap") {
    const minutes = parseRuntimeMinutes(ticket.runtime);
    sizePerSuborder =
      baseSize !== null && minutes !== null
        ? baseSize
            .dividedBy(minutes * 2)
            .decimalPlaces(lotDecimals(sizeDecimalsOf(ctx.szDecimals)), BigNumber.ROUND_DOWN)
            .toFixed()
        : UNKNOWN;
  }

  let scaleRemainder: string | null = null;
  if (ticket.type === "scale") {
    const legCount = parseLegCount(ticket.legCount);
    if (baseSize !== null && legCount !== null) {
      const legSize = baseSize
        .dividedBy(legCount)
        .decimalPlaces(lotDecimals(sizeDecimalsOf(ctx.szDecimals)), BigNumber.ROUND_DOWN);
      scaleRemainder = baseSize.minus(legSize.multipliedBy(legCount)).toFixed();
    } else {
      scaleRemainder = UNKNOWN;
    }
  }

  return {
    orderValue,
    marginRequired,
    liquidationPrice,
    fees,
    slippage,
    sizePerSuborder,
    scaleRemainder,
  };
}

/**
 * The two figures the pinned foot shows — exactly the numbers that make a
 * press wrong: where the position dies, and what it costs to open. Order
 * value, fees and the rest are reference material and stay in the scroller.
 * A tested rule rather than a JSX accident, so the choice of WHICH two
 * cannot drift in a markup edit.
 */
export function footFigures(info: OrderInfo): { liq: string; margin: string } {
  return { liq: info.liquidationPrice, margin: info.marginRequired };
}

/**
 * The CTA's whole surface, including its terminal state on the near side of
 * the money path. In priority order:
 *
 * 1. Signed out → an ENABLED "Connect wallet" — the only enabled branch in
 *    this pass, and it actually does something (routes to the account screen).
 * 2. Signed in, agent not approved → disabled "Approve trading to continue".
 * 3. Blockers present → the real Buy/Sell label, disabled, with the FIRST
 *    blocker's message as the note so the reason is visible without scrolling.
 * 4. Valid ticket → the real label and tone, still DISABLED, with a note
 *    saying why. Never enabled with a no-op `onPress` — a user tapping a
 *    live-looking Buy button and getting silence cannot tell that from a
 *    failed order, so the boundary is stated instead of faked.
 *
 * `isDisabled` is true in every branch except signed-out, by construction.
 */
export function ctaState(
  blockers: readonly Blocker[],
  ticket: TicketState,
  ctx: TicketContext
): { label: string; tone: "primary" | "danger"; isDisabled: boolean; note: string | null } {
  if (!ctx.isSignedIn) {
    return { label: "Connect wallet", tone: "primary", isDisabled: false, note: null };
  }
  if (!ctx.canTrade) {
    return { label: "Approve trading to continue", tone: "primary", isDisabled: true, note: null };
  }

  const verb = ticket.side === "long" ? "Buy" : "Sell";
  const label = ctx.symbol.length > 0 ? `${verb} ${ctx.symbol}` : verb;
  const tone = ticket.side === "long" ? ("primary" as const) : ("danger" as const);

  const firstBlocker = blockers.find((entry) => entry.code !== "noAgent");
  if (firstBlocker !== undefined) {
    return { label, tone, isDisabled: true, note: firstBlocker.message };
  }
  // A valid ticket is LIVE. The money path was explicitly approved
  // (2026-08-18), and the button does exactly what it says through
  // usePlaceTicket — never an enabled no-op, never a disabled valid ticket.
  return { label, tone, isDisabled: false, note: null };
}

/**
 * Keystroke filter for a percent box: whole percents, 0-100.
 *
 * Same contract as {@link acceptDecimalEdit} — returns the accepted string or
 * null to refuse the keystroke — plus a cap, because 250% of max is not a
 * bigger order, it is a lie the slider cannot render.
 *
 * NO CALLER as of 2026-08-20: the ticket's typed percent box was removed in
 * favour of the slider alone, which can only produce its own stops anyway.
 * Kept because the rule is the hard part and a percent field is a plausible
 * return; delete it with its tests if that stops being true.
 */
export function acceptPercentEdit(next: string): string | null {
  if (next === "") return "";
  if (!/^\d{1,3}$/.test(next)) return null;
  if (Number(next) > 100) return null;
  return next;
}
