/**
 * Asset resolution — symbol to the spec an order needs.
 *
 * Bridges `core/assetIds` (which resolves ids and size decimals against live
 * metadata) and `orders/build` (which needs `{ assetId, szDecimals, marketType }`).
 *
 * The mapping that matters is `marketType`, and it is **not** "is the id big".
 * Only genuine spot markets use the 8-decimal ceiling; builder-DEX perps
 * (100000+) and outcome markets (100000000+) are perps and use 6, despite both
 * being far above the spot range's 10000. Inferring from the id would silently
 * mis-price every HIP-3 and prediction market.
 *
 * **Outcome markets are handled explicitly here**, because the SDK's metadata is
 * wrong about them in two ways that are silent at every layer below:
 *
 * 1. `SymbolConverter` hard-codes `szDecimals = 5` ("absent from szDecimals
 *    metadata; they are all 5"). Measured live, sizes are whole shares and prices
 *    carry 5 decimals — so 5 is right for neither. `formatPrice("0.99283", 5,
 *    "perp")` returns `"0.9"`.
 * 2. The wire coin is `#<outcomeId * 10 + sideIndex>`, not the SDK's invented
 *    slug. `l2Book` answers literal `null` for the slug and every other form.
 */

import {
  classifyAssetId,
  outcomeAssetIdFromWireCoin,
  outcomeWireCoin,
  OUTCOME_PRICE_SZ_DECIMALS,
  OUTCOME_SIZE_DECIMALS,
  type AssetIndex,
} from "@/hyperliquid/core/assetIds";
import { UnknownAssetError } from "@/hyperliquid/core/errors";
import type { AssetSpec } from "@/hyperliquid/orders/build";
import type { AssetKind, MarketType } from "@/hyperliquid/types/domain";

/**
 * Decimal ceiling that applies to an asset kind.
 *
 * Spot alone gets the wider ceiling; every other range is priced as a perp.
 */
export function marketTypeFor(kind: AssetKind): MarketType {
  return kind === "spot" ? "spot" : "perp";
}

/**
 * Resolve a symbol to everything an order needs.
 *
 * Accepts the same forms as {@link AssetIndex}: `BTC`, `HYPE/USDC`,
 * `dexName:ASSET`, or an outcome-market slug — **and the wire spelling of any
 * of them**, because every UI call site has the wire coin and not the symbol.
 *
 * That last part is the fix for a real bug, not a convenience. A market row
 * carries `wireCoin`, which for spot is `@107`, and the SDK's index is keyed by
 * `BASE/QUOTE` — `@107` lives only in its pair-id map. So every spot order and
 * every spot cancel threw `Unknown Hyperliquid asset: "@107"` after the
 * blockers had passed and the hold button had armed. Normalising HERE rather
 * than at each call site is deliberate: `symbolFromWireCoin` existed and was
 * called from tests only, which is exactly how five call sites all got the
 * direction wrong.
 *
 * The conversion is total and safe in both directions: a symbol is never a key
 * in the pair-id map, so passing one through leaves it untouched, and an
 * outcome wire coin IS its own symbol.
 *
 * @throws {UnknownAssetError} if the symbol does not resolve — never returns a
 *   partial spec, since a missing `szDecimals` would silently mis-format a price.
 */
export function resolveAssetSpec(assets: AssetIndex, symbolOrWireCoin: string): AssetSpec {
  const symbol = symbolFromWireCoin(assets, symbolOrWireCoin);
  const assetId = assets.getAssetId(symbol);
  const kind = classifyAssetId(assetId);

  // Outcome markets take their precision from measurement, not metadata — no
  // metadata surface carries `szDecimals` for them at all, so the SDK's value is
  // a hard-coded guess and it is wrong in both directions at once.
  if (kind === "outcome") {
    return {
      assetId,
      szDecimals: OUTCOME_SIZE_DECIMALS,
      priceSzDecimals: OUTCOME_PRICE_SZ_DECIMALS,
      marketType: "perp",
    };
  }

  const szDecimals = assets.getSzDecimals(symbol);
  if (szDecimals === undefined) {
    throw new UnknownAssetError(symbol, { reason: "no size decimals in metadata" });
  }
  return { assetId, szDecimals, marketType: marketTypeFor(kind) };
}

/** Non-throwing variant, for display paths that tolerate an unknown symbol. */
export function tryResolveAssetSpec(assets: AssetIndex, symbol: string): AssetSpec | undefined {
  try {
    return resolveAssetSpec(assets, symbol);
  } catch {
    return undefined;
  }
}

/**
 * The coin string the wire expects.
 *
 * Perps use the plain name (`BTC`); **spot uses the pair id** (`@107`), not the
 * `BASE/QUOTE` display form. Info requests and websocket subscriptions both
 * take the wire form, so a spot subscription made with `HYPE/USDC` silently
 * matches nothing.
 *
 * A few spot pairs are exceptions where the pair id *is* the symbol; the SDK
 * handles those, which is why this defers to it rather than composing `@` + id.
 */
export function subscriptionCoin(assets: AssetIndex, symbol: string): string {
  const assetId = assets.getAssetId(symbol);
  const kind = classifyAssetId(assetId);

  // Outcome markets are addressed `#<outcomeId * 10 + sideIndex>`. Returning the
  // symbol here — which is what this did — subscribes to a coin the exchange does
  // not know: `l2Book` answers literal `null` at HTTP 200, so the book renders as
  // a permanent empty loading state with no error anywhere to explain it.
  if (kind === "outcome") return outcomeWireCoin(assetId);

  if (kind !== "spot") return symbol;
  const pairId = assets.getSpotPairId(symbol);
  if (!pairId) {
    throw new UnknownAssetError(symbol, { reason: "spot pair id not in metadata" });
  }
  return pairId;
}

/**
 * Inverse of {@link subscriptionCoin} — map a wire coin back to a symbol.
 *
 * Needed on the read side: events echo the wire coin, and matching it against a
 * displayed symbol requires this direction.
 */
export function symbolFromWireCoin(assets: AssetIndex, coin: string): string {
  // An outcome market's wire coin IS its symbol, and returning it unchanged is
  // the right answer rather than a missing case.
  //
  // The tempting alternative is to map it back to the SDK's slug, and that would
  // be worse than doing nothing. The slug is not an API field — the SDK invents
  // it as `slugify(question)-slugify(outcome)-slugify(side)` — and it is neither
  // injective nor covering: on live testnet 606 sides collapse to 200 distinct
  // slugs, the worst colliding 66 ways, and 406 sides have no slug at all. The
  // SDK also builds no reverse map for them, so `getSymbolBySpotPairId("#10090")`
  // is `undefined` and this would fall through anyway.
  if (outcomeAssetIdFromWireCoin(coin) !== undefined) return coin;
  return assets.getSymbolBySpotPairId(coin) ?? coin;
}
