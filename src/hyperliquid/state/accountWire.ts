/**
 * The account-state boundary: runtime validation and wire→domain normalisation.
 *
 * Every sign convention, every rename and every string/number decision for
 * account state lives here and nowhere else. Stores consume domain types only.
 *
 * **Why validation is hand-written rather than trusted to the SDK.** The SDK
 * validates *requests*; responses are returned from the transport untouched.
 * TypeScript then asserts the old shape after a wire change and the app reads
 * `undefined`, which formats as `"NaN"` or `"$0.00"` on screen rather than
 * throwing. That is exactly how this project once had 500 green tests standing
 * on an invented order-book shape — the failure is silent by construction, so
 * the check has to be explicit.
 *
 * **Why nothing here is derived.** The server publishes `unrealizedPnl`,
 * `returnOnEquity`, `positionValue`, `marginUsed`, `liquidationPx` and
 * `withdrawable` from inputs this client does not have: a full-precision entry
 * price it never sends, a per-account maintenance rate, and spot collateral.
 * Recomputing any of them was measured wrong by up to 0.58% of notional, and in
 * one case by 64×. This module normalises and hands through.
 *
 * The one exception is `entryNotional`, which is computed — by subtraction
 * only, from two published fields, with no division and therefore no rounding.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { normalizeCloid } from "@/hyperliquid/orders/cloid";
import type {
  AccountSnapshot,
  AccountSummary,
  Fill,
  FillLiquidation,
  Hex,
  MarginBucket,
  MarginMode,
  OpenOrderRow,
  Position,
  PositionFunding,
  PositionSide,
  SpotBalance,
  SpotState,
} from "@/hyperliquid/types/domain";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A wire money/size string.
 *
 * Deliberately rejects exponential notation and `"-0.0"` — neither appeared in
 * 820 observed positions, so either one means the wire changed rather than that
 * an edge case was hit.
 */
const MONEY = /^-?[0-9]+(\.[0-9]+)?$/;

function fail(field: string, detail: string, value?: unknown): never {
  throw new HlError(`account wire: ${field} ${detail}`, {
    code: "validation_error",
    // The value is included because a shape change is only diagnosable with it,
    // and account state carries no secrets — no keys, no signatures.
    context: { field, received: typeof value === "object" ? JSON.stringify(value) : value },
  });
}

function obj(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(field, "is not an object", value);
  }
  return value as Record<string, unknown>;
}

function arr(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field, "is not an array", value);
  return value;
}

/** A required money string. */
function money(source: Record<string, unknown>, key: string, field: string): string {
  const value = source[key];
  if (typeof value !== "string") fail(field, "is not a string", value);
  if (!MONEY.test(value)) fail(field, "is not a plain decimal", value);
  return value;
}

/**
 * A money string that may be `null`.
 *
 * Distinct from an absent field on purpose: `liquidationPx` is legitimately
 * null on 410 of 1,044 mainnet positions, but a *number* there means the wire
 * changed and must not be silently coerced.
 */
function moneyOrNull(source: Record<string, unknown>, key: string, field: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(field, "is neither a string nor null", value);
  if (!MONEY.test(value)) fail(field, "is not a plain decimal", value);
  return value;
}

function int(source: Record<string, unknown>, key: string, field: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field, "is not a number", value);
  return value;
}

function str(source: Record<string, unknown>, key: string, field: string): string {
  const value = source[key];
  if (typeof value !== "string") fail(field, "is not a string", value);
  return value;
}

/** Numeric comparison. Every wire zero is spelled `"0.0"`, so `=== "0"` never fires. */
export function isZeroAmount(value: string): boolean {
  return new BigNumber(value).isZero();
}

function negate(value: string): string {
  return new BigNumber(value).negated().toFixed();
}

/**
 * Funding as the user *earned* it.
 *
 * `PositionFunding` is signed as funding **paid**; anything phrased as earned
 * has to flip it exactly once. Provided so no call site does it inline and
 * double-negates.
 */
export function fundingEarned(funding: PositionFunding): PositionFunding {
  return {
    allTime: negate(funding.allTime),
    sinceOpen: negate(funding.sinceOpen),
    sinceChange: negate(funding.sinceChange),
  };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Direction lives only in the sign of `szi`. Verified across 820 open positions. */
export function positionSideOf(signedSize: string): PositionSide {
  return new BigNumber(signedSize).isNegative() ? "short" : "long";
}

function parseMarginBucket(raw: unknown, field: string): MarginBucket {
  const source = obj(raw, field);
  return {
    accountValue: money(source, "accountValue", `${field}.accountValue`),
    totalNotional: money(source, "totalNtlPos", `${field}.totalNtlPos`),
    totalRawUsd: money(source, "totalRawUsd", `${field}.totalRawUsd`),
    totalMarginUsed: money(source, "totalMarginUsed", `${field}.totalMarginUsed`),
  };
}

function parseFunding(raw: unknown, field: string): PositionFunding {
  const source = obj(raw, field);
  return {
    allTime: money(source, "allTime", `${field}.allTime`),
    sinceOpen: money(source, "sinceOpen", `${field}.sinceOpen`),
    sinceChange: money(source, "sinceChange", `${field}.sinceChange`),
  };
}

export function parsePosition(raw: unknown, index: number): Position {
  const field = `assetPositions[${index}].position`;
  const entry = obj(raw, `assetPositions[${index}]`);
  const source = obj(entry.position, field);

  const signedSize = money(source, "szi", `${field}.szi`);
  if (isZeroAmount(signedSize)) {
    // A flat position is removed from the array, never reported as zero. Seeing
    // one means the invariant the store's whole-replace design rests on broke.
    fail(`${field}.szi`, "is zero — a flat position should not be reported", signedSize);
  }

  const leverageSource = obj(source.leverage, `${field}.leverage`);
  const marginMode = str(leverageSource, "type", `${field}.leverage.type`);
  if (marginMode !== "cross" && marginMode !== "isolated") {
    fail(`${field}.leverage.type`, "is neither cross nor isolated", marginMode);
  }

  const notionalValue = money(source, "positionValue", `${field}.positionValue`);
  const unrealizedPnl = money(source, "unrealizedPnl", `${field}.unrealizedPnl`);
  const side = positionSideOf(signedSize);

  // Exact cost basis. `notionalValue` is a MARK notional (|szi| × markPx), so
  // removing the unrealised gain leaves what was actually paid. Signed by side
  // because a short profits as the mark falls below entry.
  const entryNotional = new BigNumber(notionalValue)
    .minus(new BigNumber(unrealizedPnl).multipliedBy(side === "short" ? -1 : 1))
    .toFixed();

  return {
    coin: str(source, "coin", `${field}.coin`),
    side,
    size: new BigNumber(signedSize).abs().toFixed(),
    signedSize,
    marginMode: marginMode as MarginMode,
    leverage: int(leverageSource, "value", `${field}.leverage.value`),
    // Cross never carries rawUsd — 0 of 1,469 observed. Its presence is the
    // structural marker of an isolated position.
    isolatedRawUsd:
      marginMode === "isolated"
        ? money(leverageSource, "rawUsd", `${field}.leverage.rawUsd`)
        : null,
    entryPxDisplay: money(source, "entryPx", `${field}.entryPx`),
    notionalValue,
    entryNotional,
    unrealizedPnl,
    returnOnEquity: money(source, "returnOnEquity", `${field}.returnOnEquity`),
    liquidationPx: moneyOrNull(source, "liquidationPx", `${field}.liquidationPx`),
    marginUsed: money(source, "marginUsed", `${field}.marginUsed`),
    tierMaxLeverage: int(source, "maxLeverage", `${field}.maxLeverage`),
    fundingPaid: parseFunding(source.cumFunding, `${field}.cumFunding`),
  };
}

/** The six keys observed on every one of ~90 accounts across both networks. */
const CLEARINGHOUSE_KEYS = [
  "assetPositions",
  "crossMaintenanceMarginUsed",
  "crossMarginSummary",
  "marginSummary",
  "time",
  "withdrawable",
] as const;

export interface ClearinghouseParseOptions {
  /** Echoed by the websocket event; absent on the REST response. */
  dex?: string;
  /** Reports an unrecognised top-level key. A warning, never a rejection. */
  onUnknownKeys?: (keys: string[]) => void;
}

/**
 * Parse `clearinghouseState`, from REST or from the websocket event's payload.
 *
 * A missing known key is a rejection — the domain type reads it, so proceeding
 * puts `undefined` on screen. An *extra* key is only a warning: the API adds
 * fields, and refusing to parse would take the whole portfolio offline over an
 * addition this client does not read.
 */
export function parseClearinghouseState(
  raw: unknown,
  options: ClearinghouseParseOptions = {}
): AccountSnapshot {
  const source = obj(raw, "clearinghouseState");

  const present = new Set(Object.keys(source));
  const missing = CLEARINGHOUSE_KEYS.filter((key) => !present.has(key));
  if (missing.length > 0) fail("clearinghouseState", `is missing ${missing.join(", ")}`);

  const unknown = [...present].filter(
    (key) => !(CLEARINGHOUSE_KEYS as readonly string[]).includes(key)
  );
  if (unknown.length > 0) options.onUnknownKeys?.(unknown);

  const summary: AccountSummary = {
    total: parseMarginBucket(source.marginSummary, "marginSummary"),
    cross: parseMarginBucket(source.crossMarginSummary, "crossMarginSummary"),
    crossMaintenanceMarginUsed: money(
      source,
      "crossMaintenanceMarginUsed",
      "crossMaintenanceMarginUsed"
    ),
    withdrawable: money(source, "withdrawable", "withdrawable"),
    serverTime: int(source, "time", "time"),
    dex: options.dex ?? "",
  };

  return {
    summary,
    positions: arr(source.assetPositions, "assetPositions").map(parsePosition),
  };
}

// ---------------------------------------------------------------------------
// Open orders
// ---------------------------------------------------------------------------

function parseSide(raw: string, field: string): "buy" | "sell" {
  if (raw === "B") return "buy";
  if (raw === "A") return "sell";
  return fail(field, "is neither B nor A", raw);
}

export function parseOpenOrder(raw: unknown, index = 0): OpenOrderRow {
  const field = `openOrders[${index}]`;
  const source = obj(raw, field);

  const isTrigger = source.isTrigger === true;
  const rawCloid = source.cloid;
  if (rawCloid !== undefined && rawCloid !== null && typeof rawCloid !== "string") {
    fail(`${field}.cloid`, "is neither a string nor null", rawCloid);
  }

  return {
    oid: int(source, "oid", `${field}.oid`),
    cloid: typeof rawCloid === "string" ? normalizeCloid(rawCloid) : null,
    coin: str(source, "coin", `${field}.coin`),
    side: parseSide(str(source, "side", `${field}.side`), `${field}.side`),
    limitPx: money(source, "limitPx", `${field}.limitPx`),
    remainingSz: money(source, "sz", `${field}.sz`),
    // `origSz` is absent on the plain `openOrders` shape; the remaining size is
    // the only thing known there, and claiming it as the original would be worse
    // than repeating it.
    originalSz:
      typeof source.origSz === "string"
        ? money(source, "origSz", `${field}.origSz`)
        : money(source, "sz", `${field}.sz`),
    placedAt: int(source, "timestamp", `${field}.timestamp`),
    isTrigger,
    // The wire sends "0.0" on a non-trigger order, which renders as a real
    // trigger at zero on any row that shows the field when present.
    triggerPx: isTrigger ? moneyOrNull(source, "triggerPx", `${field}.triggerPx`) : null,
    triggerCondition: typeof source.triggerCondition === "string" ? source.triggerCondition : "N/A",
    orderType: typeof source.orderType === "string" ? source.orderType : "Limit",
    tif: typeof source.tif === "string" ? source.tif : null,
    // Present-or-absent on the wire, never `false`.
    reduceOnly: source.reduceOnly === true,
    isPositionTpsl: source.isPositionTpsl === true,
    children: Array.isArray(source.children)
      ? source.children.map((child, i) => parseOpenOrder(child, i))
      : [],
  };
}

export function parseOpenOrders(raw: unknown): OpenOrderRow[] {
  return arr(raw, "openOrders").map(parseOpenOrder);
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/**
 * The dedup key.
 *
 * Zero collisions across 113,984 rows on both networks, where `hash` would drop
 * 31.2% of rows, `oid` 26.4% and bare `tid` every Spot Dust Conversion the
 * account has ever had.
 */
export function fillKey(oid: number, tid: number): string {
  return `${oid}:${tid}`;
}

function parseLiquidation(raw: unknown, field: string): FillLiquidation | null {
  if (raw === null || raw === undefined) return null;
  const source = obj(raw, field);
  const user = source.liquidatedUser;
  return {
    // Optional on the wire. Left null rather than defaulted, so a missing value
    // cannot pass an "is this me?" check by accident.
    liquidatedUser: typeof user === "string" ? (user.toLowerCase() as Hex) : null,
    markPx: money(source, "markPx", `${field}.markPx`),
    method: str(source, "method", `${field}.method`),
  };
}

export function parseFill(raw: unknown, index = 0, source: "fill" | "twapSlice" = "fill"): Fill {
  const field = `fills[${index}]`;
  const row = obj(raw, field);

  const oid = int(row, "oid", `${field}.oid`);
  const tid = int(row, "tid", `${field}.tid`);

  return {
    key: fillKey(oid, tid),
    tid,
    oid,
    coin: str(row, "coin", `${field}.coin`),
    side: parseSide(str(row, "side", `${field}.side`), `${field}.side`),
    px: money(row, "px", `${field}.px`),
    sz: money(row, "sz", `${field}.sz`),
    time: int(row, "time", `${field}.time`),
    startPosition: money(row, "startPosition", `${field}.startPosition`),
    dir: str(row, "dir", `${field}.dir`),
    closedPnl: money(row, "closedPnl", `${field}.closedPnl`),
    fee: money(row, "fee", `${field}.fee`),
    feeToken: str(row, "feeToken", `${field}.feeToken`),
    builderFee: moneyOrNull(row, "builderFee", `${field}.builderFee`),
    crossed: row.crossed === true,
    hash: str(row, "hash", `${field}.hash`) as Hex,
    twapId: typeof row.twapId === "number" ? row.twapId : null,
    liquidation: parseLiquidation(row.liquidation, `${field}.liquidation`),
    source,
  };
}

export function parseFills(raw: unknown): Fill[] {
  return arr(raw, "fills").map((row, i) => parseFill(row, i));
}

/**
 * Unwrap a TWAP slice.
 *
 * The slice nests the fill and carries `twapId` on the **outer** object; the
 * inner `fill.twapId` is always null. Reading the inner one loses the only link
 * back to the TWAP, and these rows appear in no other feed — 0 of 1,159 slices
 * overlapped `userFillsByTime` on a matched window, so a user running a TWAP
 * otherwise watches the position move with no fills at all.
 */
export function parseTwapSliceFills(raw: unknown): Fill[] {
  return arr(raw, "twapSliceFills").map((entry, i) => {
    const source = obj(entry, `twapSliceFills[${i}]`);
    const fill = parseFill(source.fill, i, "twapSlice");
    return { ...fill, twapId: int(source, "twapId", `twapSliceFills[${i}].twapId`) };
  });
}

// ---------------------------------------------------------------------------
// Spot
// ---------------------------------------------------------------------------

export function parseSpotBalance(raw: unknown, index = 0): SpotBalance {
  const field = `balances[${index}]`;
  const source = obj(raw, field);

  const total = money(source, "total", `${field}.total`);
  const hold = money(source, "hold", `${field}.hold`);
  // Outcome-market rows omit `token` entirely, so keying a map by it collides
  // every such row under one `undefined` key and throws on `.toString()`.
  const hasToken = typeof source.token === "number";

  return {
    coin: str(source, "coin", `${field}.coin`),
    token: hasToken ? (source.token as number) : null,
    kind: hasToken ? "token" : "outcome",
    total,
    hold,
    available: new BigNumber(total).minus(hold).toFixed(),
    costBasisNtl: money(source, "entryNtl", `${field}.entryNtl`),
  };
}

export function parseSpotState(raw: unknown): SpotState {
  const source = obj(raw, "spotState");

  // An array of [token, amount] PAIRS on the wire, not an object map. Verified
  // against a live account: `[[0,"6473640.48"],[1204,"92508.11"],…]`. Reading it
  // with `Object.entries` yields numeric indices as keys and every amount as an
  // array, which then formats as garbage rather than throwing.
  const available = source.tokenToAvailableAfterMaintenance;
  let availableAfterMaintenance: Map<number, string> | null = null;
  if (available !== null && available !== undefined) {
    availableAfterMaintenance = new Map();
    arr(available, "tokenToAvailableAfterMaintenance").forEach((pair, i) => {
      const entry = arr(pair, `tokenToAvailableAfterMaintenance[${i}]`);
      const [token, amount] = entry;
      if (typeof token !== "number" || typeof amount !== "string") {
        fail(`tokenToAvailableAfterMaintenance[${i}]`, "is not a [number, string] pair", entry);
      }
      availableAfterMaintenance!.set(token, amount);
    });
  }

  // Absent, not false — defaulting the ratio to "0" renders a portfolio-margin
  // health bar at 0% for every ordinary account.
  const pmEnabled = source.portfolioMarginEnabled;
  const pmRatio = source.portfolioMarginRatio;
  const portfolioMargin =
    pmEnabled === undefined && pmRatio === undefined
      ? null
      : {
          enabled: pmEnabled === true,
          ratio: typeof pmRatio === "string" ? pmRatio : null,
        };

  return {
    balances: arr(source.balances, "balances").map((row, i) => parseSpotBalance(row, i)),
    portfolioMargin,
    availableAfterMaintenance,
  };
}
