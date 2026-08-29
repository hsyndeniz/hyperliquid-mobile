/**
 * Symbol ↔ asset-ID resolution. The single source of truth for asset IDs.
 *
 * **Nothing else in the codebase may do asset-ID arithmetic.** A signed order
 * carries `a: number`, not a symbol, so a wrong ID does not fail — it places an
 * order on a different market. Keeping the mapping in one tested module is the
 * mitigation.
 *
 * Hyperliquid uses four disjoint ranges:
 *
 * | Kind        | Formula                                    | Example                              |
 * | ----------- | ------------------------------------------ | ------------------------------------ |
 * | perp        | `index`                                    | `BTC` → 0                            |
 * | spot        | `10000 + index`                            | `HYPE/USDC` → 10107                  |
 * | builder DEX | `100000 + dexIndex * 10000 + index`        | `test:ABC` → 110000                  |
 * | outcome     | `100000000 + outcomeId * 10 + sideIndex`   | outcome 1009 side 0 → 100010090      |
 *
 * An outcome market is addressed **three different ways at once**, all measured
 * live and all in use simultaneously:
 *
 * | Spelling             | Where it appears                                     |
 * | -------------------- | ---------------------------------------------------- |
 * | `#<id − 1e8>`        | l2Book, trades, candles, allMids, fills, orders       |
 * | `+<id − 1e8>`        | the spot balance row, and `feeToken` on a buy fill    |
 * | `o<outcomeId>`       | the SETTLED share balance — outcome id, NOT the encoding |
 *
 * Only the first is accepted by `l2Book`: 13 candidate forms were tried across 16
 * live mainnet coins and every other one — the SDK's slug, the bare asset id
 * `100010090`, `@10090`, `10090`, the outcome name — returns literal `null` at
 * HTTP 200.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
 */

import { SymbolConverter } from "@nktkas/hyperliquid/utils";

import type { AssetKind } from "@/hyperliquid/types/domain";
import { UnknownAssetError } from "@/hyperliquid/core/errors";

import type { IRequestTransport } from "@nktkas/hyperliquid";

// ---------------------------------------------------------------------------
// Range boundaries
// ---------------------------------------------------------------------------

const SPOT_RANGE_START = 10_000;
const BUILDER_DEX_RANGE_START = 100_000;
const BUILDER_DEX_STRIDE = 10_000;
const OUTCOME_RANGE_START = 100_000_000;
const OUTCOME_SIDES_PER_MARKET = 10;

/**
 * An outcome market's size precision: **whole shares**.
 *
 * MEASURED, and absent from every metadata surface — `outcomeMeta` carries only
 * `{outcome, name, description, sideSpecs, quoteToken}`. Across 215 live mainnet
 * book levels the size decimal histogram is `{0: 215}`, and a wider census of
 * 3,288 size strings plus 338 live trades found no fractional size anywhere.
 *
 * The SDK hard-codes 5 here ("Outcome markets are absent from szDecimals
 * metadata; they are all 5"), which makes `formatSize("37.4")` return `37.4`
 * where the lot is one share.
 */
export const OUTCOME_SIZE_DECIMALS = 0;

/**
 * The szDecimals value that yields an outcome market's real PRICE cap.
 *
 * Prices are probabilities quoted to **5 decimal places** on a flat `1e-5` tick
 * across the whole (0,1) range — measured over 215 live levels, histogram
 * `{1:2, 2:20, 3:18, 4:6, 5:169}`, with zero levels off the grid and none at 6+.
 *
 * Hyperliquid's perp rule is `maxDecimals = 6 - szDecimals`, so 5 decimals means
 * **1** here. That is a different number from {@link OUTCOME_SIZE_DECIMALS}, and
 * that is the whole problem: **no single `szDecimals` describes an outcome
 * market.** Price needs 1, size needs 0, and the SDK's single hard-coded 5
 * satisfies neither — `formatPrice("0.85325", 5, "perp")` returns `"0.8"`, a 6.2%
 * error, and `"0.99283"` returns `"0.9"`, a 9.3% error. Both silent.
 */
export const OUTCOME_PRICE_SZ_DECIMALS = 1;

/** Decimal places an outcome price may carry, for display and validation. */
export const OUTCOME_PRICE_DECIMALS = 5;

/**
 * Which range an asset ID falls in.
 *
 * Derived from the ID, not from the symbol's shape: name-based guesses (`:` for
 * a DEX, `/` for spot) are display heuristics and must never gate an order.
 */
export function classifyAssetId(assetId: number): AssetKind {
  if (!Number.isInteger(assetId) || assetId < 0) {
    throw new UnknownAssetError(String(assetId), {
      reason: "asset id must be a non-negative integer",
    });
  }
  if (assetId >= OUTCOME_RANGE_START) return "outcome";
  if (assetId >= BUILDER_DEX_RANGE_START) return "builderDex";
  if (assetId >= SPOT_RANGE_START) return "spot";
  return "perp";
}

/**
 * Invert the ID formulas. Diagnostic — use `AssetIndex` for real lookups, since
 * it resolves against live metadata rather than arithmetic alone.
 */
export function decomposeAssetId(
  assetId: number
):
  | { kind: "perp"; index: number }
  | { kind: "spot"; index: number }
  | { kind: "builderDex"; dexIndex: number; index: number }
  | { kind: "outcome"; outcomeId: number; sideIndex: number } {
  const kind = classifyAssetId(assetId);
  switch (kind) {
    case "perp":
      return { kind, index: assetId };
    case "spot":
      return { kind, index: assetId - SPOT_RANGE_START };
    case "builderDex": {
      const offset = assetId - BUILDER_DEX_RANGE_START;
      return {
        kind,
        dexIndex: Math.floor(offset / BUILDER_DEX_STRIDE),
        index: offset % BUILDER_DEX_STRIDE,
      };
    }
    case "outcome": {
      const offset = assetId - OUTCOME_RANGE_START;
      return {
        kind,
        outcomeId: Math.floor(offset / OUTCOME_SIDES_PER_MARKET),
        sideIndex: offset % OUTCOME_SIDES_PER_MARKET,
      };
    }
  }
}

/**
 * The wire coin for an outcome market: `#<outcomeId * 10 + sideIndex>`.
 *
 * The ONLY form `l2Book`, `trades`, `candleSnapshot` and `allMids` accept — every
 * other candidate returns literal `null` at HTTP 200, which is why a prediction
 * market rendered as a permanent empty book rather than an error.
 *
 * @throws {UnknownAssetError} if the id is not in the outcome range. Refusing is
 *   deliberate: silently returning a perp's name here would subscribe a chart to
 *   a completely different market.
 */
export function outcomeWireCoin(assetId: number): string {
  if (classifyAssetId(assetId) !== "outcome") {
    throw new UnknownAssetError(String(assetId), {
      reason: "not an outcome-market asset id",
    });
  }
  return `#${assetId - OUTCOME_RANGE_START}`;
}

/**
 * Inverse of {@link outcomeWireCoin}, for the read side.
 *
 * Events echo the wire coin, and every store in this codebase matches on echoed
 * identity — so without this a fill on a prediction market cannot be attributed
 * to the market the user was looking at.
 *
 * Returns `undefined` for anything that is not this shape, including the `+N`
 * spot-balance spelling and the `o<outcomeId>` settled-share spelling, which
 * encode different things and must not be confused with it.
 */
export function outcomeAssetIdFromWireCoin(coin: string): number | undefined {
  const match = /^#(\d+)$/.exec(coin);
  if (!match) return undefined;
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  return OUTCOME_RANGE_START + offset;
}

/**
 * The spot-balance coin for an outcome holding: `+<outcomeId * 10 + sideIndex>`.
 *
 * An outcome position does **not** appear in `clearinghouseState.assetPositions`
 * — measured on 4 of 4 live holders, which showed 0 perp rows and 5-20 spot rows.
 * It is a spot balance, so the account layer has to look somewhere else entirely.
 */
export function outcomeBalanceCoin(assetId: number): string {
  if (classifyAssetId(assetId) !== "outcome") {
    throw new UnknownAssetError(String(assetId), {
      reason: "not an outcome-market asset id",
    });
  }
  return `+${assetId - OUTCOME_RANGE_START}`;
}

/**
 * Match a settled-share balance row, `o<outcomeId>`.
 *
 * **The number is the outcome id, not the `outcomeId * 10 + sideIndex`
 * encoding** — `o482` is outcome 482, which `settledOutcome(482)` resolves to
 * "Argentina". Reading it as an encoding gives outcome 48, side 2, and side 2
 * does not exist.
 */
export function settledOutcomeIdFromBalanceCoin(coin: string): number | undefined {
  const match = /^o(\d+)$/.exec(coin);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

// ---------------------------------------------------------------------------
// Live index
// ---------------------------------------------------------------------------

/**
 * Symbol formats accepted by every lookup:
 * - perp: `BTC`
 * - spot: `HYPE/USDC`
 * - builder DEX: `dexName:ASSET`
 * - outcome: the URL slug, e.g. `btc-above-61720-yes-jun-08-0600`
 */
export interface AssetIndex {
  /** @throws {UnknownAssetError} if the symbol does not resolve. */
  getAssetId(symbol: string): number;
  /** Non-throwing variant, for display paths that tolerate a miss. */
  tryGetAssetId(symbol: string): number | undefined;
  /** @throws {UnknownAssetError} if the symbol does not resolve. */
  getSzDecimals(symbol: string): number;
  tryGetSzDecimals(symbol: string): number | undefined;
  /** Spot pair id (`@107`) used by `l2Book`/`trades`; some pairs are exceptions and return the symbol. */
  getSpotPairId(symbol: string): string | undefined;
  getSymbolBySpotPairId(pairId: string): string | undefined;
  /** Re-fetch metadata. Needed when new assets or DEXs are listed. */
  reload(): Promise<void>;
}

export interface CreateAssetIndexOptions {
  transport: IRequestTransport;
  /**
   * Which builder DEXs to index. Defaults to `true` (all): HIP-3 markets are in
   * scope, and an unindexed DEX means its symbols silently fail to resolve.
   */
  dexs?: string[] | boolean;
}

/**
 * Build an index over live metadata.
 *
 * Takes a transport rather than reaching for a shared client so it stays
 * testable and so network wiring lives in one place (`api/clients`).
 */
export async function createAssetIndex({
  transport,
  dexs = true,
}: CreateAssetIndexOptions): Promise<AssetIndex> {
  const converter = await SymbolConverter.create({ transport, dexs });
  return wrapSymbolConverter(converter);
}

/**
 * Adapt a `SymbolConverter` to `AssetIndex`.
 *
 * The adaptation that matters: the SDK returns `undefined` for unknown symbols,
 * which would flow into a signed payload unnoticed. The throwing variants are
 * the default so a typo fails at the call site instead of on-chain.
 *
 * Exported for tests, which substitute a stub rather than hitting the network.
 */
export function wrapSymbolConverter(
  converter: Pick<
    SymbolConverter,
    "getAssetId" | "getSzDecimals" | "getSpotPairId" | "getSymbolBySpotPairId" | "reload"
  >
): AssetIndex {
  return {
    getAssetId(symbol) {
      const id = converter.getAssetId(symbol);
      if (id === undefined) throw new UnknownAssetError(symbol);
      return id;
    },
    tryGetAssetId: (symbol) => converter.getAssetId(symbol),
    getSzDecimals(symbol) {
      const decimals = converter.getSzDecimals(symbol);
      if (decimals === undefined) throw new UnknownAssetError(symbol);
      return decimals;
    },
    tryGetSzDecimals: (symbol) => converter.getSzDecimals(symbol),
    getSpotPairId: (symbol) => converter.getSpotPairId(symbol),
    getSymbolBySpotPairId: (pairId) => converter.getSymbolBySpotPairId(pairId),
    reload: () => converter.reload(),
  };
}
