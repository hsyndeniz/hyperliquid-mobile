import { BigNumber } from "bignumber.js";

import { PrecisionError } from "@/hyperliquid/core/errors";
import {
  calculateLiquidationPrice,
  findMarginTier,
  formatPrice,
  maintenanceMarginRate,
  formatSize,
  getNextPrice,
  getPriceTick,
  snapPriceToGrid,
  tryFormatPrice,
} from "@/hyperliquid/core/precision";

/**
 * The formatPrice/formatSize cases are **conformance tests**: they assert the
 * SDK still implements Hyperliquid's documented tick and lot rules, so an SDK
 * bump that changes behaviour fails here rather than in production.
 */
describe("formatPrice (conformance with HL tick rules)", () => {
  // The two caps — 5 significant figures and (6|8) - szDecimals decimals —
  // apply together; whichever is stricter for a given value wins. These cases
  // pin down which one binds where, because it is not obvious by inspection.
  it("caps at 5 significant figures when that is the stricter rule", () => {
    expect(formatPrice("1.23456789", 5)).toBe("1.2");
    // 0.12345 is 5 sig figs at 5 decimals — sig figs bind before the 6-decimal cap.
    expect(formatPrice("0.123456789", 0)).toBe("0.12345");
  });

  it("caps decimals at 6 - szDecimals when that is the stricter rule", () => {
    // 0.0012345 would be 5 sig figs but needs 7 decimals, so the 6-decimal cap binds.
    expect(formatPrice("0.0012345678", 0)).toBe("0.001234");
    // szDecimals=4 leaves only 2 decimal places.
    expect(formatPrice("0.123456789", 4)).toBe("0.12");
  });

  it("allows integer prices regardless of significant figures", () => {
    expect(formatPrice("97123.456789", 0)).toBe("97123");
    expect(formatPrice("123456", 0)).toBe("123456");
  });

  it("uses the 8-decimal ceiling for spot", () => {
    expect(formatPrice("0.0000123456789", 0, "spot")).toBe("0.00001234");
  });

  it("throws rather than returning an empty string when a value truncates to zero", () => {
    // The reference returned '' here, which callers could ignore.
    expect(() => formatPrice("0.0000000001", 5)).toThrow(PrecisionError);
    expect(() => formatPrice("not a number", 0)).toThrow(PrecisionError);
  });

  it("names the input in the error for diagnosis", () => {
    expect(() => formatPrice("nonsense", 2)).toThrow(/nonsense/);
  });

  it("offers a non-throwing variant for live input fields", () => {
    expect(tryFormatPrice("nonsense", 2)).toBeUndefined();
    expect(tryFormatPrice("97123.456789", 0)).toBe("97123");
  });
});

describe("formatSize (conformance with HL lot rules)", () => {
  it("truncates to szDecimals rather than rounding up", () => {
    expect(formatSize("0.00123456789", 5)).toBe("0.00123");
    expect(formatSize("1.999", 0)).toBe("1");
  });

  it("throws when a size truncates to zero", () => {
    expect(() => formatSize("0.0001", 2)).toThrow(PrecisionError);
  });
});

describe("getPriceTick", () => {
  it("widens the tick as price grows, per the significant-figure rule", () => {
    // At 5 sig figs, a 5-digit price can only move in whole units.
    expect(getPriceTick("97123", 0)?.toFixed()).toBe("1");
    expect(getPriceTick("9712.3", 0)?.toFixed()).toBe("0.1");
  });

  it("is bounded below by the decimal ceiling", () => {
    // szDecimals=5 on a perp leaves 1 decimal place, so the tick cannot go finer.
    expect(getPriceTick("1.23", 5)?.toFixed()).toBe("0.1");
  });

  it("uses the wider spot decimal ceiling", () => {
    expect(getPriceTick("0.001", 0, "spot")?.toFixed()).toBe("0.0000001");
  });

  it("returns null for prices with no meaningful tick", () => {
    expect(getPriceTick("0", 0)).toBeNull();
    expect(getPriceTick("-5", 0)).toBeNull();
    expect(getPriceTick("abc", 0)).toBeNull();
    expect(getPriceTick("100", 1.5)).toBeNull();
  });
});

describe("snapPriceToGrid", () => {
  it("rounds down, up and to nearest", () => {
    expect(snapPriceToGrid("9712.34", "down", 0)?.toFixed()).toBe("9712.3");
    expect(snapPriceToGrid("9712.34", "up", 0)?.toFixed()).toBe("9712.4");
    expect(snapPriceToGrid("9712.36", "nearest", 0)?.toFixed()).toBe("9712.4");
  });

  it("leaves an already-valid price untouched", () => {
    expect(snapPriceToGrid("9712.3", "nearest", 0)?.toFixed()).toBe("9712.3");
  });

  it("returns null when snapping would reach zero or below", () => {
    expect(snapPriceToGrid("0", "down", 0)).toBeNull();
  });
});

describe("getNextPrice", () => {
  it("always moves the price", () => {
    const up = getNextPrice("9712.3", "up", 0);
    const down = getNextPrice("9712.3", "down", 0);
    expect(up?.gt(new BigNumber("9712.3"))).toBe(true);
    expect(down?.lt(new BigNumber("9712.3"))).toBe(true);
  });

  it("steps onto the grid, not by a raw decimal", () => {
    expect(getNextPrice("9712.3", "up", 0)?.toFixed()).toBe("9712.4");
  });

  it("refuses to step below zero", () => {
    expect(getNextPrice("0.000001", "down", 0)).toBeNull();
  });
});

describe("findMarginTier", () => {
  const tiers = [
    { lowerBound: "0", maxLeverage: 50 },
    { lowerBound: "10000", maxLeverage: 25 },
    { lowerBound: "100000", maxLeverage: 10 },
  ];

  it("picks the highest tier the notional clears", () => {
    expect(findMarginTier("500", tiers)?.maxLeverage).toBe(50);
    expect(findMarginTier("10000", tiers)?.maxLeverage).toBe(25);
    expect(findMarginTier("250000", tiers)?.maxLeverage).toBe(10);
  });

  it("is inclusive at a tier boundary", () => {
    expect(findMarginTier("100000", tiers)?.maxLeverage).toBe(10);
    expect(findMarginTier("99999.99", tiers)?.maxLeverage).toBe(25);
  });

  it("returns null with no tiers", () => {
    expect(findMarginTier("1000", [])).toBeNull();
  });

  it("does not mutate the caller's array", () => {
    const original = [...tiers];
    findMarginTier("500", tiers);
    expect(tiers).toEqual(original);
  });
});

describe("calculateLiquidationPrice", () => {
  it("puts a long's liquidation below entry", () => {
    const result = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "1",
      mmr: "0.01",
      side: "long",
    });
    expect(result?.lt(new BigNumber("100"))).toBe(true);
  });

  it("puts a short's liquidation above entry", () => {
    const result = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "1",
      mmr: "0.01",
      side: "short",
    });
    expect(result?.gt(new BigNumber("100"))).toBe(true);
  });

  it("matches the documented formula exactly", () => {
    // 100 - 1 * 10 / 1 / (1 - 0.01 * 1) = 100 - 10.101010... = 89.8989...
    const result = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "1",
      mmr: "0.01",
      side: "long",
    });
    expect(result?.toFixed(4)).toBe("89.8990");
  });

  it("moves liquidation closer to entry as margin shrinks", () => {
    const base = { entryPrice: "100", positionSize: "1", mmr: "0.01", side: "long" as const };
    const wellMargined = calculateLiquidationPrice({ ...base, marginAvailable: "50" });
    const thin = calculateLiquidationPrice({ ...base, marginAvailable: "5" });
    expect(thin?.gt(wellMargined!)).toBe(true);
  });

  it("returns null for a zero-size position rather than dividing by zero", () => {
    const result = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "0",
      mmr: "0.01",
      side: "long",
    });
    expect(result).toBeNull();
  });
});

describe("negative-value rejection", () => {
  // The SDK's formatters pass negatives through — formatPrice(-5, 0) returns
  // "-5" — but the wire schema is UnsignedDecimal and rejects them. Caught here
  // so a sign error fails at the call site, not as an opaque submit failure.
  it("rejects a negative price", () => {
    expect(() => formatPrice(-5, 0)).toThrow(PrecisionError);
    expect(() => formatPrice("-1.23", 2)).toThrow(PrecisionError);
  });

  it("rejects a negative size", () => {
    expect(() => formatSize(-1, 0)).toThrow(PrecisionError);
    expect(() => formatSize("-0.5", 2)).toThrow(PrecisionError);
  });

  it("still accepts positives and zero-ish values normally", () => {
    expect(formatPrice("5", 0)).toBe("5");
    expect(() => formatSize("0", 2)).toThrow(PrecisionError); // truncates to zero
  });

  it("names the offending value", () => {
    expect(() => formatPrice(-5, 0)).toThrow(/must not be negative/);
  });
});

describe("calculateLiquidationPrice sign guard", () => {
  it("throws when handed a signed position size", () => {
    // `sideMultiplier` is -1 for a short AND `positionSize` would be negative:
    // the negations cancel and the result lands BELOW entry instead of above.
    // Worked: entry 100, margin 10, szi "-1", mmr 0.01 gives 90.10, not 109.90.
    expect(() =>
      calculateLiquidationPrice({
        entryPrice: "100",
        marginAvailable: "10",
        positionSize: "-1",
        mmr: "0.01",
        side: "short",
      })
    ).toThrow(/unsigned position size/);
  });

  it("puts a short's liquidation price above entry when given |szi|", () => {
    const price = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "1",
      mmr: "0.01",
      side: "short",
    });
    expect(price).not.toBeNull();
    expect(price!.isGreaterThan(100)).toBe(true);
  });

  it("puts a long's liquidation price below entry", () => {
    const price = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "1",
      mmr: "0.01",
      side: "long",
    });
    expect(price!.isLessThan(100)).toBe(true);
  });
});

describe("calculateLiquidationPrice honours its null contract", () => {
  it.each([
    ["a half-typed entry price", { entryPrice: "", marginAvailable: "10", mmr: "0.01" }],
    ["a non-numeric margin", { entryPrice: "100", marginAvailable: "abc", mmr: "0.01" }],
    ["a non-numeric mmr", { entryPrice: "100", marginAvailable: "10", mmr: "" }],
  ])("returns null for %s", (_label, params) => {
    // An order form feeds this half-typed values on every keystroke. Returning
    // a NaN BigNumber breaks the documented contract and renders as "NaN".
    expect(calculateLiquidationPrice({ ...params, positionSize: "1", side: "long" })).toBeNull();
  });

  it("still computes a real one", () => {
    const price = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "1",
      mmr: "0.01",
      side: "long",
    });
    expect(price).not.toBeNull();
    expect(price!.isFinite()).toBe(true);
  });
});

describe("maintenanceMarginRate", () => {
  it("is half the initial margin at max leverage — the exchange's published rule", () => {
    // Hyperliquid's own worked example: "at 20x max leverage,
    // maintenance_margin_rate = 2.5%".
    expect(maintenanceMarginRate(20)).toBe("0.025");
    // BTC on testnet caps at 40x.
    expect(maintenanceMarginRate(40)).toBe("0.0125");
    expect(maintenanceMarginRate(3)).toBe("0.16666666666666666667");
  });

  it("feeds calculateLiquidationPrice as its `mmr` term", () => {
    // The docs' formula uses l = 1 / MAINTENANCE_LEVERAGE, and maintenance
    // leverage is twice the max — so the rate this returns IS that l.
    const liq = calculateLiquidationPrice({
      entryPrice: "100",
      marginAvailable: "10",
      positionSize: "1",
      mmr: maintenanceMarginRate(20)!,
      side: "long",
    });
    // 100 - 10/1/(1 - 0.025) = 100 - 10.2564… = 89.743…
    expect(liq?.toFixed(4)).toBe("89.7436");
  });

  it("returns null rather than fabricating a rate for an unknown cap", () => {
    expect(maintenanceMarginRate(null)).toBeNull();
    expect(maintenanceMarginRate(0)).toBeNull();
    expect(maintenanceMarginRate(-5)).toBeNull();
    expect(maintenanceMarginRate(Number.NaN)).toBeNull();
  });
});
