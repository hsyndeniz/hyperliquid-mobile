import {
  marketTypeFor,
  resolveAssetSpec,
  subscriptionCoin,
  symbolFromWireCoin,
  tryResolveAssetSpec,
} from "@/hyperliquid/assets";
import { wrapSymbolConverter } from "@/hyperliquid/core/assetIds";
import { UnknownAssetError } from "@/hyperliquid/core/errors";

/** Stub index covering one asset from each of the four ranges. */
const ASSETS: Record<string, { id: number; sz: number }> = {
  BTC: { id: 0, sz: 5 },
  "HYPE/USDC": { id: 10_107, sz: 2 },
  "test:ABC": { id: 110_000, sz: 0 },
  "btc-above-61720-yes": { id: 100_002_200, sz: 5 },
};

const index = wrapSymbolConverter({
  getAssetId: (name: string) => ASSETS[name]?.id,
  getSzDecimals: (name: string) => ASSETS[name]?.sz,
  getSpotPairId: () => undefined,
  getSymbolBySpotPairId: () => undefined,
  reload: async () => {},
} as never);

/**
 * The same index, but with the spot pair-id map the real SDK builds: spot is
 * keyed by `BASE/QUOTE`, and `@107` exists ONLY as a pair id.
 */
const spotWireIndex = wrapSymbolConverter({
  getAssetId: (name: string) => ASSETS[name]?.id,
  getSzDecimals: (name: string) => ASSETS[name]?.sz,
  getSpotPairId: (symbol: string) => (symbol === "HYPE/USDC" ? "@107" : undefined),
  getSymbolBySpotPairId: (coin: string) => (coin === "@107" ? "HYPE/USDC" : undefined),
  reload: async () => {},
} as never);

describe("marketTypeFor", () => {
  it("gives the wider decimal ceiling to spot alone", () => {
    expect(marketTypeFor("spot")).toBe("spot");
  });

  it("treats builder-DEX and outcome markets as PERPS, not spot", () => {
    // Their ids are far above the spot range's 10000, so an id-magnitude test
    // would misclassify both and mis-price every HIP-3 and prediction market.
    expect(marketTypeFor("builderDex")).toBe("perp");
    expect(marketTypeFor("outcome")).toBe("perp");
    expect(marketTypeFor("perp")).toBe("perp");
  });
});

describe("resolveAssetSpec", () => {
  // Every UI call site holds a market row's `wireCoin`, which for spot is
  // `@107`. Passing that straight in threw `Unknown Hyperliquid asset` after
  // the blockers had passed and the hold button had armed — so every spot
  // order and every spot cancel failed at the last step.
  it("accepts a spot WIRE coin, not just the symbol", () => {
    expect(resolveAssetSpec(spotWireIndex, "@107")).toEqual({
      assetId: 10_107,
      szDecimals: 2,
      marketType: "spot",
    });
  });

  it("still accepts the symbol form, unchanged", () => {
    expect(resolveAssetSpec(spotWireIndex, "HYPE/USDC")).toEqual({
      assetId: 10_107,
      szDecimals: 2,
      marketType: "spot",
    });
  });

  it("leaves a perp symbol alone even when a pair-id map exists", () => {
    // A symbol is never a key in the pair-id map, so normalisation is a no-op
    // for perps — the property that makes converting unconditionally safe.
    expect(resolveAssetSpec(spotWireIndex, "BTC").assetId).toBe(0);
  });

  it("resolves a perp", () => {
    expect(resolveAssetSpec(index, "BTC")).toEqual({
      assetId: 0,
      szDecimals: 5,
      marketType: "perp",
    });
  });

  it("resolves a spot pair to the spot ceiling", () => {
    expect(resolveAssetSpec(index, "HYPE/USDC")).toEqual({
      assetId: 10_107,
      szDecimals: 2,
      marketType: "spot",
    });
  });

  it("resolves a builder-DEX asset as a perp despite its large id", () => {
    expect(resolveAssetSpec(index, "test:ABC")).toEqual({
      assetId: 110_000,
      szDecimals: 0,
      marketType: "perp",
    });
  });

  it("resolves an outcome market as a perp", () => {
    expect(resolveAssetSpec(index, "btc-above-61720-yes")).toMatchObject({
      assetId: 100_002_200,
      marketType: "perp",
    });
  });

  it("throws on an unknown symbol rather than returning a partial spec", () => {
    // A missing szDecimals would silently mis-format every price.
    expect(() => resolveAssetSpec(index, "NOPE")).toThrow(UnknownAssetError);
  });

  it("offers a non-throwing variant for display paths", () => {
    expect(tryResolveAssetSpec(index, "NOPE")).toBeUndefined();
    expect(tryResolveAssetSpec(index, "BTC")).toMatchObject({ assetId: 0 });
  });
});

describe("wire coin conversion", () => {
  const spotIndex = wrapSymbolConverter({
    getAssetId: (name: string) => ASSETS[name]?.id,
    getSzDecimals: (name: string) => ASSETS[name]?.sz,
    getSpotPairId: (name: string) => (name === "HYPE/USDC" ? "@107" : undefined),
    getSymbolBySpotPairId: (id: string) => (id === "@107" ? "HYPE/USDC" : undefined),
    reload: async () => {},
  } as never);

  it("leaves a perp symbol alone", () => {
    expect(subscriptionCoin(spotIndex, "BTC")).toBe("BTC");
  });

  it("converts a spot pair to its pair id — the display form matches nothing", () => {
    expect(subscriptionCoin(spotIndex, "HYPE/USDC")).toBe("@107");
  });

  it("leaves a builder-DEX symbol in its namespaced form", () => {
    expect(subscriptionCoin(spotIndex, "test:ABC")).toBe("test:ABC");
  });

  it("throws rather than composing a wrong coin when the pair id is missing", () => {
    const broken = wrapSymbolConverter({
      getAssetId: () => 10_107,
      getSzDecimals: () => 2,
      getSpotPairId: () => undefined,
      getSymbolBySpotPairId: () => undefined,
      reload: async () => {},
    } as never);
    expect(() => subscriptionCoin(broken, "HYPE/USDC")).toThrow(UnknownAssetError);
  });

  it("round-trips a spot symbol", () => {
    expect(symbolFromWireCoin(spotIndex, subscriptionCoin(spotIndex, "HYPE/USDC"))).toBe(
      "HYPE/USDC"
    );
  });

  it("passes a perp coin through unchanged on the way back", () => {
    expect(symbolFromWireCoin(spotIndex, "BTC")).toBe("BTC");
  });
});
