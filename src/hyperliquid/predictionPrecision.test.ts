/**
 * The two Phase 10 defects, pinned as regressions.
 *
 * Both were silent — no throw, no wrong-looking value, just money leaving at a
 * price the user did not choose and a chart that never loaded. Each assertion
 * below carries the number that was measured live on 2026-08-06 against mainnet
 * outcome 1009 (`#10090`).
 */

import {
  classifyAssetId,
  decomposeAssetId,
  outcomeAssetIdFromWireCoin,
  outcomeBalanceCoin,
  outcomeWireCoin,
  settledOutcomeIdFromBalanceCoin,
  OUTCOME_PRICE_DECIMALS,
  OUTCOME_PRICE_SZ_DECIMALS,
  OUTCOME_SIZE_DECIMALS,
  type AssetIndex,
} from "@/hyperliquid/core/assetIds";
import { resolveAssetSpec, subscriptionCoin, symbolFromWireCoin } from "@/hyperliquid/assets";
import { buildLimitOrder, priceSzDecimalsOf } from "@/hyperliquid/orders/build";
import { formatPrice, formatSize } from "@/hyperliquid/core/precision";
import { UnknownAssetError } from "@/hyperliquid/core/errors";

/** Outcome 1009, side 0 — a real live mainnet market. */
const OUTCOME_ID = 1009;
const SIDE = 0;
const ASSET_ID = 100_000_000 + OUTCOME_ID * 10 + SIDE;
const WIRE = "#10090";
/** The slug the SDK invents. No API field carries it. */
const SLUG = "btc-above-64315-yes-aug-06-0600";

function indexStub(overrides: Partial<AssetIndex> = {}): AssetIndex {
  return {
    getAssetId: (symbol) => {
      if (symbol === SLUG) return ASSET_ID;
      if (symbol === "BTC") return 0;
      if (symbol === "HYPE/USDC") return 10_107;
      throw new UnknownAssetError(symbol);
    },
    tryGetAssetId: () => undefined,
    // What the SDK actually reports for an outcome market, and the defect.
    getSzDecimals: (symbol) => (symbol === SLUG ? 5 : 2),
    tryGetSzDecimals: () => undefined,
    getSpotPairId: (symbol) => (symbol === "HYPE/USDC" ? "@107" : undefined),
    getSymbolBySpotPairId: (pairId) => (pairId === "@107" ? "HYPE/USDC" : undefined),
    reload: async () => undefined,
    ...overrides,
  };
}

describe("defect 1: the SDK's szDecimals mis-prices every outcome order", () => {
  it("reproduces the exact damage the hard-coded 5 does", () => {
    // MEASURED against the live book. These are not hypotheticals: 169 of 215
    // live levels carry 5 decimals, and this is what the SDK's value does to them.
    expect(formatPrice("0.85325", 5, "perp")).toBe("0.8"); // 6.2% below
    expect(formatPrice("0.99283", 5, "perp")).toBe("0.9"); // 9.3% below

    // A buy submitted 6% under rests far from the market and never fills; a sell
    // submitted 6% under crosses the book and fills badly. Neither errors.
  });

  it("prices correctly once price and size precision are separated", () => {
    const spec = resolveAssetSpec(indexStub(), SLUG);

    expect(spec.szDecimals).toBe(OUTCOME_SIZE_DECIMALS);
    expect(spec.priceSzDecimals).toBe(OUTCOME_PRICE_SZ_DECIMALS);
    expect(formatPrice("0.85325", priceSzDecimalsOf(spec), spec.marketType)).toBe("0.85325");
    expect(formatPrice("0.99283", priceSzDecimalsOf(spec), spec.marketType)).toBe("0.99283");
  });

  it("takes precision from measurement, never from the metadata that lies", () => {
    // The stub reports 5, as the real SymbolConverter does. `resolveAssetSpec`
    // must ignore it for an outcome market — no metadata surface carries a real
    // szDecimals for them, so the SDK's number is a guess.
    const spec = resolveAssetSpec(indexStub({ getSzDecimals: () => 5 }), SLUG);
    expect(spec.szDecimals).toBe(0);
  });

  it("keeps sizes whole, because the lot is one share", () => {
    // MEASURED: 215 of 215 live levels had an integer size. The SDK's 5 permits
    // "37.4", which is not a tradeable quantity of a prediction share.
    const spec = resolveAssetSpec(indexStub(), SLUG);
    expect(formatSize("37.4", 5)).toBe("37.4");
    expect(formatSize("37.4", spec.szDecimals)).toBe("37");
  });

  it("carries both through a real built order", () => {
    // The end-to-end shape: a leg is what actually reaches the wire.
    const leg = buildLimitOrder({
      asset: resolveAssetSpec(indexStub(), SLUG),
      isBuy: true,
      price: "0.85325",
      size: "37.4",
      tif: "Gtc",
    });
    expect(leg.p).toBe("0.85325");
    expect(leg.s).toBe("37");
    expect(leg.a).toBe(ASSET_ID);
  });

  it("leaves every other market's precision exactly as it was", () => {
    // The change must be invisible outside the outcome range.
    const perp = resolveAssetSpec(indexStub(), "BTC");
    expect(perp).toEqual({ assetId: 0, szDecimals: 2, marketType: "perp" });
    expect(priceSzDecimalsOf(perp)).toBe(2);

    const spot = resolveAssetSpec(indexStub(), "HYPE/USDC");
    expect(spot.marketType).toBe("spot");
    expect(priceSzDecimalsOf(spot)).toBe(2);
  });

  it("states the price ceiling it measured", () => {
    // Histogram over 215 live levels: {1:2, 2:20, 3:18, 4:6, 5:169}, nothing at
    // 6+, and zero levels off the 1e-5 grid.
    expect(OUTCOME_PRICE_DECIMALS).toBe(5);
    // Hyperliquid's perp rule is maxDecimals = 6 - szDecimals.
    expect(6 - OUTCOME_PRICE_SZ_DECIMALS).toBe(OUTCOME_PRICE_DECIMALS);
  });
});

describe("defect 2: the slug is not a coin the exchange knows", () => {
  it("subscribes with #<outcomeId*10+sideIndex>, not the slug", () => {
    // MEASURED: `l2Book` with `#10090` returns 40 levels; with the slug it
    // returns literal `null` at HTTP 200 — so the chart shows a permanent empty
    // loading state and nothing anywhere reports an error.
    expect(subscriptionCoin(indexStub(), SLUG)).toBe(WIRE);
    expect(subscriptionCoin(indexStub(), SLUG)).not.toBe(SLUG);
  });

  it("still uses the pair id for spot and the bare name for a perp", () => {
    expect(subscriptionCoin(indexStub(), "HYPE/USDC")).toBe("@107");
    expect(subscriptionCoin(indexStub(), "BTC")).toBe("BTC");
  });

  it("round-trips the wire coin back to itself, which IS the identity", () => {
    // Deliberately not the slug. The SDK invents that string and it is neither
    // injective (606 testnet sides -> 200 slugs, worst collision 66-way) nor
    // covering (406 sides have none), so mapping back to it would be mapping to
    // a worse identity than the one we started with.
    expect(symbolFromWireCoin(indexStub(), WIRE)).toBe(WIRE);
    expect(symbolFromWireCoin(indexStub(), "@107")).toBe("HYPE/USDC");
  });
});

describe("the three wire spellings, which mean different things", () => {
  it("encodes the book coin and the balance coin from the same id", () => {
    expect(outcomeWireCoin(ASSET_ID)).toBe("#10090");
    expect(outcomeBalanceCoin(ASSET_ID)).toBe("+10090");
  });

  it("reads a settled-share row as an OUTCOME ID, not the encoding", () => {
    // `o482` is outcome 482 — `settledOutcome(482)` resolves it to "Argentina".
    // Decoding it as an encoding gives outcome 48 side 2, and side 2 does not
    // exist: every market has exactly two sides.
    expect(settledOutcomeIdFromBalanceCoin("o482")).toBe(482);
    expect(decomposeAssetId(100_000_000 + 482 * 10)).toEqual({
      kind: "outcome",
      outcomeId: 482,
      sideIndex: 0,
    });
  });

  it("keeps the three spellings from being confused for one another", () => {
    expect(outcomeAssetIdFromWireCoin("#10090")).toBe(ASSET_ID);
    // The balance and settled forms are NOT book coins.
    expect(outcomeAssetIdFromWireCoin("+10090")).toBeUndefined();
    expect(outcomeAssetIdFromWireCoin("o482")).toBeUndefined();
    expect(settledOutcomeIdFromBalanceCoin("#10090")).toBeUndefined();
    expect(outcomeAssetIdFromWireCoin("@107")).toBeUndefined();
    expect(outcomeAssetIdFromWireCoin("BTC")).toBeUndefined();
  });

  it("refuses to build a wire coin from a non-outcome id", () => {
    // Silently returning something here would subscribe a prediction-market
    // chart to a completely different market.
    expect(() => outcomeWireCoin(0)).toThrow(UnknownAssetError);
    expect(() => outcomeWireCoin(10_107)).toThrow(UnknownAssetError);
    expect(() => outcomeBalanceCoin(110_000)).toThrow(UnknownAssetError);
  });

  it("round-trips every side of a real market", () => {
    for (const sideIndex of [0, 1]) {
      const id = 100_000_000 + OUTCOME_ID * 10 + sideIndex;
      expect(classifyAssetId(id)).toBe("outcome");
      expect(outcomeAssetIdFromWireCoin(outcomeWireCoin(id))).toBe(id);
      expect(decomposeAssetId(id)).toEqual({
        kind: "outcome",
        outcomeId: OUTCOME_ID,
        sideIndex,
      });
    }
  });
});
