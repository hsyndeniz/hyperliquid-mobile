import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import type { AssetSpec } from "@/hyperliquid/orders/build";
import { buildScaleOrder } from "@/hyperliquid/orders/scale";

const BTC: AssetSpec = { assetId: 0, szDecimals: 5, marketType: "perp" };

describe("buildScaleOrder", () => {
  it("spreads legs inclusively between the bounds", () => {
    const { legs } = buildScaleOrder({
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.3",
      legCount: 3,
    });
    expect(legs.map((l) => l.p)).toEqual(["90000", "92500", "95000"]);
  });

  it("places a single leg at the start price", () => {
    const { legs } = buildScaleOrder({
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.01",
      legCount: 1,
    });
    expect(legs).toHaveLength(1);
    expect(legs[0].p).toBe("90000");
  });

  it("works downward as well as upward", () => {
    const { legs } = buildScaleOrder({
      asset: BTC,
      isBuy: false,
      startPrice: "95000",
      endPrice: "90000",
      totalSize: "0.3",
      legCount: 3,
    });
    expect(legs.map((l) => l.p)).toEqual(["95000", "92500", "90000"]);
  });

  it("divides size evenly by default", () => {
    const { legs } = buildScaleOrder({
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.3",
      legCount: 3,
    });
    expect(legs.map((l) => l.s)).toEqual(["0.1", "0.1", "0.1"]);
  });

  it("weights ascending and descending distributions in opposite directions", () => {
    const base = {
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.6",
      legCount: 3,
    } as const;

    const asc = buildScaleOrder({ ...base, distribution: "ascending" }).legs.map((l) =>
      Number(l.s)
    );
    const desc = buildScaleOrder({ ...base, distribution: "descending" }).legs.map((l) =>
      Number(l.s)
    );

    expect(asc[0]).toBeLessThan(asc[2]);
    expect(desc[0]).toBeGreaterThan(desc[2]);
    expect(asc).toEqual([...desc].reverse());
  });

  it("reports the remainder left by lot-size truncation instead of under-delivering silently", () => {
    // 1/3 of a size that does not divide evenly truncates on every leg.
    const { legs, remainder } = buildScaleOrder({
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.1",
      legCount: 3,
    });
    const placed = legs.reduce((sum, l) => sum.plus(l.s), new BigNumber(0));
    expect(placed.plus(remainder).toFixed()).toBe("0.1");
    expect(new BigNumber(remainder).gte(0)).toBe(true);
  });

  it("reports a zero remainder when the size divides cleanly", () => {
    const { remainder } = buildScaleOrder({
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.3",
      legCount: 3,
    });
    expect(new BigNumber(remainder).isZero()).toBe(true);
  });

  it("rejects a ladder whose legs fall below the minimum notional, before sending", () => {
    // The total clears $10 but the individual legs do not — the exchange would
    // reject them one by one, leaving a partially-filled ladder to unwind.
    expect(() =>
      buildScaleOrder({
        asset: BTC,
        isBuy: true,
        startPrice: "90000",
        endPrice: "95000",
        totalSize: "0.0005", // ~$45 total, ~$4.50 per leg
        legCount: 10,
      })
    ).toThrow(/minimum/);
  });

  it("names which leg failed", () => {
    expect(() =>
      buildScaleOrder({
        asset: BTC,
        isBuy: true,
        startPrice: "90000",
        endPrice: "95000",
        totalSize: "0.0005",
        legCount: 10,
      })
    ).toThrow(/leg 1 of 10/i);
  });

  it("rejects invalid leg counts and non-positive inputs", () => {
    const base = {
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.3",
    } as const;
    expect(() => buildScaleOrder({ ...base, legCount: 0 })).toThrow(HlError);
    expect(() => buildScaleOrder({ ...base, legCount: 1.5 })).toThrow(HlError);
    expect(() => buildScaleOrder({ ...base, legCount: 3, totalSize: "0" })).toThrow(HlError);
    expect(() => buildScaleOrder({ ...base, legCount: 3, startPrice: "0" })).toThrow(HlError);
  });

  it("emits plain limit legs, so the ordinary batch path applies", () => {
    const { legs } = buildScaleOrder({
      asset: BTC,
      isBuy: true,
      startPrice: "90000",
      endPrice: "95000",
      totalSize: "0.3",
      legCount: 3,
      tif: "Alo",
      reduceOnly: true,
    });
    for (const leg of legs) {
      expect(leg.t).toEqual({ limit: { tif: "Alo" } });
      expect(leg.r).toBe(true);
      // No cloid yet — placeOrders mints one per leg.
      expect(leg.c).toBeUndefined();
    }
  });
});
