import {
  classifyAssetId,
  decomposeAssetId,
  wrapSymbolConverter,
} from "@/hyperliquid/core/assetIds";
import { UnknownAssetError } from "@/hyperliquid/core/errors";

/**
 * These cover the arithmetic and the undefined→throw adaptation offline.
 * Resolution against live metadata is proven by the testnet smoke check,
 * since it depends on what Hyperliquid has actually listed.
 */
describe("classifyAssetId", () => {
  it("classifies perps from the bottom of the range", () => {
    expect(classifyAssetId(0)).toBe("perp"); // BTC
    expect(classifyAssetId(9_999)).toBe("perp");
  });

  it("classifies spot", () => {
    expect(classifyAssetId(10_000)).toBe("spot");
    expect(classifyAssetId(10_107)).toBe("spot"); // HYPE/USDC
    expect(classifyAssetId(99_999)).toBe("spot");
  });

  it("classifies builder DEX assets", () => {
    expect(classifyAssetId(100_000)).toBe("builderDex");
    expect(classifyAssetId(110_000)).toBe("builderDex"); // first asset of dexIndex 1
    expect(classifyAssetId(99_999_999)).toBe("builderDex");
  });

  it("classifies outcome markets", () => {
    expect(classifyAssetId(100_000_000)).toBe("outcome");
    expect(classifyAssetId(100_002_200)).toBe("outcome");
  });

  it("rejects non-integer and negative ids rather than guessing a range", () => {
    expect(() => classifyAssetId(-1)).toThrow(UnknownAssetError);
    expect(() => classifyAssetId(1.5)).toThrow(UnknownAssetError);
    expect(() => classifyAssetId(Number.NaN)).toThrow(UnknownAssetError);
  });
});

describe("decomposeAssetId", () => {
  it("inverts the perp formula", () => {
    expect(decomposeAssetId(0)).toEqual({ kind: "perp", index: 0 });
  });

  it("inverts the spot formula", () => {
    expect(decomposeAssetId(10_107)).toEqual({ kind: "spot", index: 107 });
  });

  it("inverts the builder-DEX formula for the documented example", () => {
    // test:ABC → 110000 == 100000 + 1 * 10000 + 0
    expect(decomposeAssetId(110_000)).toEqual({ kind: "builderDex", dexIndex: 1, index: 0 });
  });

  it("handles builder DEXs beyond the second, which the reference hardcoded", () => {
    expect(decomposeAssetId(130_042)).toEqual({ kind: "builderDex", dexIndex: 3, index: 42 });
  });

  it("inverts the outcome formula", () => {
    // 100002200 == 100000000 + 220 * 10 + 0
    expect(decomposeAssetId(100_002_200)).toEqual({
      kind: "outcome",
      outcomeId: 220,
      sideIndex: 0,
    });
    expect(decomposeAssetId(100_002_201)).toEqual({
      kind: "outcome",
      outcomeId: 220,
      sideIndex: 1,
    });
  });

  it("round-trips against the documented formulas", () => {
    const cases = [
      { id: 7, kind: "perp" },
      { id: 10_000 + 3, kind: "spot" },
      { id: 100_000 + 2 * 10_000 + 5, kind: "builderDex" },
      { id: 100_000_000 + 31 * 10 + 1, kind: "outcome" },
    ] as const;
    for (const { id, kind } of cases) {
      expect(decomposeAssetId(id).kind).toBe(kind);
      expect(classifyAssetId(id)).toBe(kind);
    }
  });
});

describe("wrapSymbolConverter", () => {
  function stub(overrides: Partial<Record<string, unknown>> = {}) {
    return wrapSymbolConverter({
      getAssetId: (name: string) => (name === "BTC" ? 0 : undefined),
      getSzDecimals: (name: string) => (name === "BTC" ? 5 : undefined),
      getSpotPairId: (name: string) => (name === "HYPE/USDC" ? "@107" : undefined),
      getSymbolBySpotPairId: (id: string) => (id === "@107" ? "HYPE/USDC" : undefined),
      reload: async () => {},
      ...overrides,
    } as never);
  }

  it("resolves known symbols", () => {
    expect(stub().getAssetId("BTC")).toBe(0);
    expect(stub().getSzDecimals("BTC")).toBe(5);
  });

  it("throws on an unknown symbol so a typo cannot reach a signed order", () => {
    expect(() => stub().getAssetId("BTCC")).toThrow(UnknownAssetError);
    expect(() => stub().getSzDecimals("BTCC")).toThrow(UnknownAssetError);
  });

  it("names the offending symbol in the error", () => {
    expect(() => stub().getAssetId("NOPE")).toThrow(/NOPE/);
  });

  it("does not throw asset id 0 away — BTC is falsy-valued", () => {
    // Guards against an `if (!id)` style check silently rejecting BTC.
    expect(stub().getAssetId("BTC")).toBe(0);
    expect(stub().tryGetAssetId("BTC")).toBe(0);
  });

  it("offers non-throwing variants for display paths", () => {
    expect(stub().tryGetAssetId("BTCC")).toBeUndefined();
    expect(stub().tryGetSzDecimals("BTCC")).toBeUndefined();
  });

  it("passes spot pair lookups through", () => {
    expect(stub().getSpotPairId("HYPE/USDC")).toBe("@107");
    expect(stub().getSymbolBySpotPairId("@107")).toBe("HYPE/USDC");
  });
});
