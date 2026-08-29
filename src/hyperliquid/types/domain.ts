/**
 * Our own types — the ones that are not SDK response shapes.
 *
 * SDK shapes are aliased in `@/hyperliquid/types/sdk`. Keep the two separate: `sdk.ts` churns
 * with SDK releases, this file changes only when our own model does.
 */

/** 0x-prefixed hex string. */
import type { Cloid } from "@/hyperliquid/orders/cloid";

export type Hex = `0x${string}`;

export type HlEnv = "mainnet" | "testnet";

/**
 * The four disjoint asset-ID ranges Hyperliquid uses. Which range an asset
 * falls in determines the ID formula, so classification is a correctness
 * concern, not a display one.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
 */
export type AssetKind = "perp" | "spot" | "builderDex" | "outcome";

/**
 * Everything that scopes Hyperliquid state.
 *
 * All four fields are key dimensions, not metadata:
 * - `dex` — HIP-3 builder DEXs have their own universes, margin tables, and
 *   collateral; assets are namespaced `dexName:ASSET`.
 * - `subAccount` — Hyperliquid treats sub-accounts as **separate users**,
 *   including for rate limiting.
 * - `env` — asset ids differ between mainnet and testnet.
 *
 * Both are present from the start even though their features ship later,
 * because adding a key dimension afterwards means touching every cache key,
 * state key, and scoped selector in the app.
 */
export interface HlIdentity {
  /**
   * Network. A key dimension, not a setting: Hyperliquid assigns **different
   * asset ids per network** (HYPE is spot 107 on mainnet, 1035 on testnet), so
   * any cache or subscription key omitting it is cross-network contaminated.
   */
  env: HlEnv;
  /** Our local wallet/account identifier. */
  accountId: string;
  /** The on-chain address that owns the Hyperliquid account. */
  address: Hex;
  /** Builder DEX name; `null` is Hyperliquid's main perp DEX. */
  dex: string | null;
  /** Sub-account address; `null` is the main account. */
  subAccount: Hex | null;
}

/** Market type for price formatting — perps and spot have different decimal ceilings. */
export type MarketType = "perp" | "spot";

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Every websocket channel the SDK exposes.
 *
 * Taken verbatim from `node_modules/@nktkas/hyperliquid/esm/api/subscription/_methods/`
 * — widen it only against that directory. Note there is **no `webData2`** in
 * 0.33.3 (only `webData3`) and no `l2` channel (`l2Book` carries a `fast` flag
 * instead); both appear in the reference implementation and would fail here.
 */
export type SubscriptionChannel =
  | "activeAssetCtx"
  | "activeAssetData"
  | "activeSpotAssetCtx"
  | "allDexsAssetCtxs"
  | "allDexsClearinghouseState"
  | "allMids"
  | "assetCtxs"
  | "bbo"
  | "candle"
  | "clearinghouseState"
  | "fastAssetCtxs"
  | "l2Book"
  | "notification"
  | "openOrders"
  | "orderUpdates"
  | "outcomeMetaUpdates"
  | "spotAssetCtxs"
  | "spotState"
  | "trades"
  | "twapStates"
  | "userEvents"
  | "userFills"
  | "userFundings"
  | "userHistoricalOrders"
  | "userNonFundingLedgerUpdates"
  | "userTwapHistory"
  | "userTwapSliceFills"
  | "webData3";

/**
 * Order-book aggregation.
 *
 * Part of the subscription **identity**, not a display setting: the SDK
 * identifies a subscription by its serialised payload, so two l2Book
 * subscriptions differing only in aggregation are two distinct server
 * subscriptions. A key that omitted these would leave both live, with two
 * writers racing into one store slice at double the message rate.
 */
export interface L2Aggregation {
  nSigFigs: 2 | 3 | 4 | 5 | null;
  mantissa: 2 | 5 | null;
  fast: boolean;
}

/** What a subscription is *for*. The unit Phase 4 serialises mutations on. */
export interface SubscriptionTarget {
  identity: HlIdentity;
  channel: SubscriptionChannel;
  /** The **wire** coin (`@107` for spot), not the display symbol. Null for user-wide channels. */
  coin: string | null;
  aggregation: L2Aggregation | null;
  /**
   * Candle interval. Part of the subscription's **identity**, not a setting:
   * BTC/1m and BTC/1h are two distinct server subscriptions, and a key omitting
   * this would treat them as one — the second subscribe would be skipped as a
   * duplicate and the chart would silently show the wrong timeframe.
   */
  interval: CandleInterval | null;
}

/**
 * A value tagged with the target it arrived for and when.
 *
 * The envelope that lets each surface prove its own freshness. Without it, data
 * from a previous coin or account cannot be distinguished from current data —
 * the "stale book after a symbol switch" class of bug.
 */
export interface Scoped<T> {
  target: SubscriptionTarget;
  value: T;
  /** Server timestamp where the channel provides one; null otherwise. */
  serverTime: number | null;
  /** Stamped once, at the listener boundary. */
  receivedAt: number;
  isSnapshot: boolean;
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

/**
 * Valid candle intervals, taken from the SDK's schema picklist.
 *
 * `1M` is one **month** and `1m` is one minute — the casing is the only thing
 * distinguishing them, and getting it wrong silently subscribes to a feed
 * ~43,000× slower than intended.
 */
export type CandleInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";

/**
 * One candle, in our own naming.
 *
 * The wire uses single letters (`t`,`T`,`s`,`i`,`o`,`c`,`h`,`l`,`v`,`n`), which
 * are unreadable at call sites and easy to transpose — `o` and `c` differ by one
 * character and swapping them inverts every candle on the chart. Normalised
 * once, at the boundary.
 *
 * Prices stay **strings**: the same rule as everywhere else in this module.
 */
export interface Candle {
  /** Open time, ms since epoch. Identifies the candle. */
  openTime: number;
  /** Close time, ms since epoch. */
  closeTime: number;
  interval: CandleInterval;
  coin: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Volume in base currency. */
  volume: string;
  /** Number of trades. */
  trades: number;
}

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

/**
 * One margin bucket.
 *
 * The wire ships two of these — `marginSummary` and `crossMarginSummary` — with
 * **identical field names and different numbers**. Observed on one account in
 * one frame: 9,448.62 against 5,077.08. They are near-identical on a cross-only
 * account, so picking the wrong one passes every test until the first user with
 * an isolated position. Renamed here so the choice has to be deliberate.
 */
export interface MarginBucket {
  /** wire `accountValue`. Unsigned. */
  accountValue: string;
  /** wire `totalNtlPos`. Unsigned. */
  totalNotional: string;
  /** wire `totalRawUsd`. **Signed** — the only signed field in the summary. */
  totalRawUsd: string;
  /** wire `totalMarginUsed`. Unsigned. Can exceed `accountValue`. */
  totalMarginUsed: string;
}

export interface AccountSummary {
  /** All positions, cross and isolated. wire `marginSummary`. */
  total: MarginBucket;
  /** Cross positions only. wire `crossMarginSummary`. */
  cross: MarginBucket;
  /** Cross only; an isolated position contributes nothing here. */
  crossMaintenanceMarginUsed: string;
  /**
   * The server's own figure.
   *
   * Never derived: `accountValue - totalMarginUsed` gave $67,004 where the API
   * said $12.75, because resting-order margin reservations are not in either
   * term. It also swings ~10% within seconds while `accountValue` moves <0.05%.
   */
  withdrawable: string;
  /** wire `time`, nested inside `clearinghouseState`. Milliseconds. */
  serverTime: number;
  /** Echoed by the event; `""` is the main dex. Checked against `dexParam`. */
  dex: string;
}

export type PositionSide = "long" | "short";
export type MarginMode = "cross" | "isolated";

/**
 * Funding, from the position's point of view.
 *
 * **Positive means funding the user PAID.** Verified by exact reconciliation
 * against the `userFunding` ledger, which signs it the opposite way — inverted
 * in 4 of 4 checks, same-sign in 0. Rendering this with a PnL convention shows
 * a cost as a gain.
 */
export interface PositionFunding {
  allTime: string;
  sinceOpen: string;
  sinceChange: string;
}

export interface Position {
  /** Wire coin. May be `@107` (spot) or `xyz:BTC` (builder dex) — not a ticker. */
  coin: string;
  /** Derived from `sign(szi)`. There is **no** side field on the wire. */
  side: PositionSide;
  /** `|szi|`. What a size column and an order form want. */
  size: string;
  /** `szi` verbatim, signed. The only field arithmetic may take direction from. */
  signedSize: string;
  marginMode: MarginMode;
  /** Integer, and not always a slider stop — 27 has been observed. */
  leverage: number;
  /** wire `leverage.rawUsd`, signed. `null` for cross, which never carries it. */
  isolatedRawUsd: string | null;
  /**
   * wire `entryPx` — **display only**.
   *
   * The published value is the internal entry price truncated toward zero to
   * `6 - szDecimals` decimals (5,004 of 5,004 positions). Truncation is
   * directional, so recomputing PnL from it overstates every long and
   * understates every short — worst observed single position $11,252.50. Use
   * `entryNotional`.
   */
  entryPxDisplay: string;
  /** wire `positionValue` = `|szi| × markPx`. A **mark** notional, not a cost. */
  notionalValue: string;
  /**
   * Exact cost basis: `notionalValue - sign(szi) × unrealizedPnl`.
   *
   * Subtraction only — no division, so no rounding loss. This is the quantity
   * `entryPxDisplay` approximates, and the one to divide by for a true entry.
   */
  entryNotional: string;
  /** Signed. Server-computed; never recomputed here — see `entryPxDisplay`. */
  unrealizedPnl: string;
  /** Signed **fraction** (0.204 = 20.4%), not a percentage. */
  returnOnEquity: string;
  /**
   * `null` means the position cannot be liquidated by price at current equity —
   * the common case, 410 of 1,044 mainnet positions. Coercing it to 0 renders
   * "liquidation at $0.00", which reads as imminent on a long.
   */
  liquidationPx: string | null;
  /**
   * Different quantities per mode: cross is `notionalValue / leverage`; isolated
   * is `isolatedRawUsd + szi × markPx`, which moves with PnL. Summing across
   * modes mixes them.
   */
  marginUsed: string;
  /**
   * The margin-**tier** cap at this position's current notional, which shrinks
   * as the position grows — BTC reported 40 on a small position and 10 on a
   * $93k one at the same instant. The asset ceiling is `meta.universe[].maxLeverage`.
   */
  tierMaxLeverage: number;
  fundingPaid: PositionFunding;
}

export interface AccountSnapshot {
  summary: AccountSummary;
  /**
   * Replaced wholesale, never merged by coin: a flat position is **removed**
   * from the array rather than reported with `szi: "0.0"`, so a merging store
   * keeps a closed position on screen forever.
   */
  positions: readonly Position[];
}

// ---------------------------------------------------------------------------
// Open orders
// ---------------------------------------------------------------------------

export interface OpenOrderRow {
  /**
   * Primary key.
   *
   * **Not `cloid`** — a real trader reused cloid `0xa1c759b8…` across oid
   * 57378687005 (filled) and oid 57378791975 (open) one second apart on the same
   * account. A cloid-keyed map loses one of them.
   */
  oid: number;
  /** Correlation tag for orders this client submitted. Not unique, not a key. */
  cloid: Cloid | null;
  coin: string;
  /** wire `"B"` / `"A"`. */
  side: "buy" | "sell";
  limitPx: string;
  /**
   * wire `sz` — the size **remaining** on a partially-filled resting order.
   *
   * Renamed because a 10 BTC order that filled 7 reports `sz: "3"`, and a
   * cancel-and-replace built on that column re-places the wrong quantity.
   */
  remainingSz: string;
  /** wire `origSz` — the size at placement, which is what the user recognises. */
  originalSz: string;
  /** wire `timestamp`. */
  placedAt: number;
  isTrigger: boolean;
  /** `null` when not a trigger. The wire sends `"0.0"`, which reads as a real trigger at zero. */
  triggerPx: string | null;
  /** Display string ("N/A", "Price above 63314"). Never parsed. */
  triggerCondition: string;
  /** Verbatim: the value set is open in practice. */
  orderType: string;
  tif: string | null;
  /** wire `reduceOnly?: true` — **absence** means false, so a plain boolean read mislabels. */
  reduceOnly: boolean;
  isPositionTpsl: boolean;
  children: OpenOrderRow[];
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export interface FillLiquidation {
  /**
   * Optional on the wire, so a missing value must not fall through to "you were
   * liquidated": the block is attached to **both** counterparties of the trade,
   * meaning every market maker who absorbed someone else's liquidation would
   * otherwise get the alert.
   */
  liquidatedUser: Hex | null;
  markPx: string;
  method: string;
}

export interface Fill {
  /**
   * Dedup key, `${oid}:${tid}`.
   *
   * Measured across 113,984 rows on both networks: zero collisions. The
   * alternatives silently drop rows — `hash` 31.2%, `oid` 26.4%, `hash|oid`
   * 21.1% — and bare `tid` collapses every Spot Dust Conversion an account has
   * ever had, since they all carry `tid: 0`.
   */
  key: string;
  /** `0` is a real sentinel value, not a missing one. */
  tid: number;
  oid: number;
  coin: string;
  side: "buy" | "sell";
  px: string;
  /** Always unsigned. */
  sz: string;
  /** Server clock — can lead the device clock by seconds. */
  time: number;
  /** Signed. With `side`, the reliable direction signal; `dir` is not. */
  startPosition: string;
  /**
   * Display string, rendered verbatim.
   *
   * An open set — 13+ values observed, including spot ones ("Buy", "Spot Dust
   * Conversion", "Settlement") that fall through every long/short branch. A
   * liquidated position can also report the ordinary `"Close Short"`.
   */
  dir: string;
  /** Signed, **gross of fees**, and per-fill rather than cumulative. */
  closedPnl: string;
  /** Signed: negative is a maker rebate (433 of 4,000 fills). */
  fee: string;
  /** 15 distinct tokens observed. **Not always USDC** — summing blind adds BTC to dollars. */
  feeToken: string;
  builderFee: string | null;
  /** True means taker. */
  crossed: boolean;
  /** Not unique — 5.6% of mainnet fills carry the all-zero hash. */
  hash: Hex;
  twapId: number | null;
  liquidation: FillLiquidation | null;
  source: "fill" | "twapSlice";
}

// ---------------------------------------------------------------------------
// Spot
// ---------------------------------------------------------------------------

export interface SpotBalance {
  coin: string;
  /** Absent on outcome-market rows (`"+9930"`), so this is nullable by necessity. */
  token: number | null;
  kind: "token" | "outcome";
  total: string;
  /** A portion **of** `total`, not additional to it. */
  hold: string;
  /** `total - hold`, via BigNumber. */
  available: string;
  /**
   * wire `entryNtl` — the **total** cost basis in USD for the holding, not a
   * current value, and `"0.0"` for USDC. Rendering it as value shows $0.00 for
   * the largest position on most accounts.
   */
  costBasisNtl: string;
}

export interface SpotState {
  balances: readonly SpotBalance[];
  /**
   * `null` means portfolio margin does not apply to this account.
   *
   * The fields are **absent** on an ordinary account rather than false or zero,
   * so defaulting the ratio to `"0"` renders a PM health bar at 0% for everyone.
   */
  portfolioMargin: { enabled: boolean; ratio: string | null } | null;
  /** wire `tokenToAvailableAfterMaintenance`. `null` when absent. */
  availableAfterMaintenance: ReadonlyMap<number, string> | null;
}
