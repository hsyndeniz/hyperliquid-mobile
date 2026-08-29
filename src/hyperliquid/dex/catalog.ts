/**
 * The builder-DEX catalogue.
 *
 * One place that knows which dexs exist, what they charge, what they settle in,
 * and which of their assets are actually tradeable. Everything here is verified
 * against both networks.
 *
 * Three facts drive the shape:
 *
 * 1. **`perpDexs()[0]` is literally `null`** and is the only null entry — that
 *    slot is the main dex. Its index still counts in the asset-id formula, so
 *    the array position is meaningful and must not be filtered away.
 * 2. **`collateralToken` is dex-specific and frequently is not USDC** — USDH,
 *    USDE and USDT0 on mainnet, and on testnet even non-stablecoins like `NQ`
 *    and `TZERO`. A client that assumes dollars will label balances wrongly.
 * 3. **Most builder-dex assets are delisted.** Only 4 of 9 mainnet dexs have any
 *    live asset at all; the rest return empty books and null mid prices while
 *    still appearing in `meta`. Listing them as tradeable produces a market
 *    screen that cannot be traded.
 */

import { log } from "@/hyperliquid/core/logger";

const logger = log.child("dex.catalog");

export interface DexInfo {
  /** Index into `perpDexs()`, which is the `dexIndex` in the asset-id formula. */
  index: number;
  /** `""` for the main dex. */
  name: string;
  /** Display name. The wire field is `fullName`, camelCase — `full_name` is always undefined. */
  fullName: string | null;
  deployer: string | null;
  oracleUpdater: string | null;
  feeRecipient: string | null;
  /** Multiplies the protocol fee. `null` for the main dex, which has no deployer. */
  deployerFeeScale: string | null;
}

/** The main dex, which `perpDexs()` represents as a literal `null` at index 0. */
export const MAIN_DEX: DexInfo = {
  index: 0,
  name: "",
  fullName: "Hyperliquid",
  deployer: null,
  oracleUpdater: null,
  feeRecipient: null,
  deployerFeeScale: null,
};

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Parse a `perpDexs()` response.
 *
 * The array index is preserved as `DexInfo.index` because it *is* the
 * `dexIndex` in `100000 + dexIndex × 10000 + i` — verified against 369 real
 * asset ids across 20 dexs with zero mismatches. Compacting the array would
 * silently shift every id.
 */
export function parsePerpDexs(raw: unknown): DexInfo[] {
  if (!Array.isArray(raw)) {
    logger.warn("catalog.perpDexs_not_array");
    return [MAIN_DEX];
  }

  return raw.map((entry, index) => {
    // Index 0 is null: that is the main dex, not a parse failure.
    if (entry === null || typeof entry !== "object") return { ...MAIN_DEX, index };
    const record = entry as Record<string, unknown>;
    return {
      index,
      name: str(record, "name") ?? "",
      // camelCase. The snake_case spelling reads undefined for every dex,
      // silently, and a fixture written the same way agrees with the bug.
      fullName: str(record, "fullName"),
      deployer: str(record, "deployer"),
      oracleUpdater: str(record, "oracleUpdater"),
      feeRecipient: str(record, "feeRecipient"),
      deployerFeeScale: str(record, "deployerFeeScale"),
    };
  });
}

export interface DexAsset {
  /** Fully qualified — `"hyna:BTC"`. Already qualified in `meta`; never bare. */
  coin: string;
  /** The bare asset name, for display. */
  symbol: string;
  /** `100000 + dexIndex × 10000 + indexInUniverse`. */
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  marginTableId: number;
  /** `"enabled"` or absent. A string, never a boolean. */
  growthMode: "enabled" | undefined;
  /** Common on builder dexs, rare on the main dex. A delisted asset cannot be traded. */
  isDelisted: boolean;
  /** `"strictIsolated"` / `"noCross"` on many builder assets. */
  marginMode: string | null;
}

/**
 * Parse a `meta({dex})` universe into assets.
 *
 * `dexIndex` must be the dex's position in `perpDexs()`, since that is what the
 * asset-id formula uses.
 */
export function parseDexUniverse(raw: unknown, dexIndex: number): DexAsset[] {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const universe = Array.isArray(record.universe) ? record.universe : [];

  return universe.flatMap((entry, i) => {
    if (typeof entry !== "object" || entry === null) return [];
    const asset = entry as Record<string, unknown>;
    const coin = typeof asset.name === "string" ? asset.name : null;
    if (!coin) return [];

    const separator = coin.indexOf(":");
    return [
      {
        coin,
        symbol: separator === -1 ? coin : coin.slice(separator + 1),
        // The main dex uses a bare index; a builder dex uses the offset formula.
        assetId: dexIndex === 0 ? i : 100_000 + dexIndex * 10_000 + i,
        szDecimals: typeof asset.szDecimals === "number" ? asset.szDecimals : 0,
        maxLeverage: typeof asset.maxLeverage === "number" ? asset.maxLeverage : 1,
        marginTableId: typeof asset.marginTableId === "number" ? asset.marginTableId : 0,
        // Compared against the string, because the wire never sends a boolean
        // here — a truthiness check would treat any future value as enabled.
        growthMode: asset.growthMode === "enabled" ? "enabled" : undefined,
        isDelisted: asset.isDelisted === true,
        marginMode: typeof asset.marginMode === "string" ? asset.marginMode : null,
      },
    ];
  });
}

/** The collateral token index a dex settles in. `0` is USDC. */
export function parseCollateralToken(raw: unknown): number {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return typeof record.collateralToken === "number" ? record.collateralToken : 0;
}

/**
 * Assets a user could actually trade.
 *
 * Filtering delisted assets is not cosmetic: on mainnet, five of nine builder
 * dexs are **entirely** delisted, and their assets return empty books with null
 * mid prices while still appearing in `meta`.
 */
export function tradeableAssets(assets: readonly DexAsset[]): DexAsset[] {
  return assets.filter((asset) => !asset.isDelisted);
}

/** Every distinct margin-table id a set of assets refers to. */
export function referencedMarginTableIds(assets: readonly DexAsset[]): number[] {
  return [...new Set(assets.map((asset) => asset.marginTableId))].sort((a, b) => a - b);
}
