import { OUTCOME_PRICE_SZ_DECIMALS, OUTCOME_SIZE_DECIMALS } from "@/hyperliquid/core/assetIds";
import { HlError } from "@/hyperliquid/core/errors";
import {
  DEFAULT_SLIPPAGE,
  type AssetSpec,
  assertMinNotional,
  buildBuilderFee,
  buildLimitOrder,
  buildMarketOrder,
  buildTriggerOrder,
  marketLimitPrice,
  meetsMinNotional,
  snapTriggerPrice,
} from "@/hyperliquid/orders/build";

const BTC: AssetSpec = { assetId: 0, szDecimals: 5, marketType: "perp" };
const SPOT: AssetSpec = { assetId: 10_107, szDecimals: 2, marketType: "spot" };
const CLOID = "0xabcdef01234567890abcdef012345678" as const;

describe("buildLimitOrder", () => {
  it("emits the exact terse wire field names", () => {
    // Unknown keys are silently STRIPPED by the schema, so `reduceOnly` instead
    // of `r` would produce a valid order with reduce-only quietly off.
    const leg = buildLimitOrder({ asset: BTC, isBuy: true, price: "97000", size: "0.001" });
    expect(Object.keys(leg).sort()).toEqual(["a", "b", "p", "r", "s", "t"]);
  });

  it("defaults to Gtc and not reduce-only", () => {
    const leg = buildLimitOrder({ asset: BTC, isBuy: true, price: "97000", size: "0.001" });
    expect(leg.t).toEqual({ limit: { tif: "Gtc" } });
    expect(leg.r).toBe(false);
  });

  it("emits only the limit variant, never both branches of the union", () => {
    // A `t` carrying both `limit` and `trigger` is silently downgraded to one.
    const leg = buildLimitOrder({ asset: BTC, isBuy: true, price: "97000", size: "0.001" });
    expect("trigger" in leg.t).toBe(false);
  });

  it("includes the cloid under `c` when supplied, and omits it otherwise", () => {
    expect(
      buildLimitOrder({ asset: BTC, isBuy: true, price: "97000", size: "0.001", cloid: CLOID }).c
    ).toBe(CLOID);
    expect("c" in buildLimitOrder({ asset: BTC, isBuy: true, price: "97000", size: "0.001" })).toBe(
      false
    );
  });

  it("formats price and size to decimal strings, never exponential", () => {
    // `1e-7` is rejected outright by the wire schema.
    const leg = buildLimitOrder({ asset: SPOT, isBuy: true, price: "0.0001234", size: "1000" });
    expect(leg.p).not.toMatch(/e/i);
    expect(leg.s).not.toMatch(/e/i);
  });

  it("rejects a non-positive price", () => {
    expect(() => buildLimitOrder({ asset: BTC, isBuy: true, price: "0", size: "1" })).toThrow();
  });
});

describe("marketLimitPrice", () => {
  it("prices a buy above and a sell below the reference", () => {
    const buy = marketLimitPrice({ referencePrice: "1000", isBuy: true, asset: BTC });
    const sell = marketLimitPrice({ referencePrice: "1000", isBuy: false, asset: BTC });
    expect(Number(buy)).toBeGreaterThan(1000);
    expect(Number(sell)).toBeLessThan(1000);
  });

  it("applies the default slippage", () => {
    const buy = marketLimitPrice({ referencePrice: "1000", isBuy: true, asset: BTC });
    expect(Number(buy)).toBeCloseTo(1000 * (1 + DEFAULT_SLIPPAGE), 0);
  });

  it("honours an explicit slippage of zero rather than falling back", () => {
    // The reference uses `||` here, so 0 silently becomes 8%.
    const price = marketLimitPrice({
      referencePrice: "1000",
      isBuy: true,
      asset: BTC,
      slippage: 0,
    });
    expect(Number(price)).toBe(1000);
  });

  it("rejects negative slippage and a non-positive reference", () => {
    expect(() =>
      marketLimitPrice({ referencePrice: "1000", isBuy: true, asset: BTC, slippage: -0.1 })
    ).toThrow(HlError);
    expect(() => marketLimitPrice({ referencePrice: "0", isBuy: true, asset: BTC })).toThrow(
      HlError
    );
  });

  it("applies slippage BEFORE formatting, so the result stays on the tick grid", () => {
    const price = marketLimitPrice({ referencePrice: "97123.456", isBuy: true, asset: BTC });
    expect(price).not.toMatch(/e/i);
    expect(Number(price)).toBeGreaterThan(97123);
  });
});

describe("buildMarketOrder", () => {
  it("expresses a market order as an IOC limit", () => {
    const leg = buildMarketOrder({
      asset: BTC,
      isBuy: true,
      size: "0.01",
      referencePrice: "97000",
    });
    expect(leg.t).toEqual({ limit: { tif: "Ioc" } });
  });

  it("never emits the internal FrontendMarket tif", () => {
    const leg = buildMarketOrder({
      asset: BTC,
      isBuy: true,
      size: "0.01",
      referencePrice: "97000",
    });
    expect(JSON.stringify(leg)).not.toContain("FrontendMarket");
  });
});

describe("buildTriggerOrder", () => {
  it("emits only the trigger variant, with no tif", () => {
    const leg = buildTriggerOrder({
      asset: BTC,
      isBuy: false,
      triggerPrice: "90000",
      limitPrice: "89900",
      isMarket: false,
      tpsl: "sl",
      size: "0.01",
    });
    expect("limit" in leg.t).toBe(false);
    expect(leg.t).toMatchObject({ trigger: { isMarket: false, tpsl: "sl" } });
    expect(JSON.stringify(leg.t)).not.toContain("tif");
  });

  it("keeps triggerPx and the resting price independent", () => {
    const leg = buildTriggerOrder({
      asset: BTC,
      isBuy: false,
      triggerPrice: "90000",
      limitPrice: "89000",
      isMarket: false,
      tpsl: "sl",
      size: "0.01",
    });
    expect(leg.p).toBe("89000");
    expect("trigger" in leg.t && leg.t.trigger.triggerPx).toBe("90000");
  });

  it("allows size zero for a position-scaled TP/SL", () => {
    // Legal on the wire, but formatSize would reject it — the zero path must
    // bypass formatting entirely.
    const leg = buildTriggerOrder({
      asset: BTC,
      isBuy: false,
      triggerPrice: "90000",
      isMarket: true,
      tpsl: "sl",
      size: "0",
    });
    expect(leg.s).toBe("0");
  });

  it("derives a slipped resting price when the trigger is a market order", () => {
    const leg = buildTriggerOrder({
      asset: BTC,
      isBuy: false,
      triggerPrice: "90000",
      isMarket: true,
      tpsl: "sl",
      size: "0.01",
    });
    // Selling on the stop: the resting price sits below the trigger.
    expect(Number(leg.p)).toBeLessThan(90_000);
  });
});

describe("snapTriggerPrice", () => {
  // formatPrice truncates toward zero unconditionally, which for a long's
  // stop-loss moves the stop further away — it fires later, at a worse price.
  const COARSE: AssetSpec = { assetId: 0, szDecimals: 5, marketType: "perp" };

  it("rounds a sell trigger UP so a long's stop fires no later than asked", () => {
    const snapped = snapTriggerPrice("1.2345678", false, COARSE, "sl");
    expect(Number(snapped)).toBeGreaterThanOrEqual(1.2345678);
  });

  it("rounds a buy trigger DOWN so a short's stop fires no later than asked", () => {
    const snapped = snapTriggerPrice("1.2345678", true, COARSE, "sl");
    expect(Number(snapped)).toBeLessThanOrEqual(1.2345678);
  });

  it("is idempotent — formatting a snapped price must not move it again", () => {
    for (const isBuy of [true, false]) {
      for (const tpsl of ["tp", "sl"] as const) {
        const once = snapTriggerPrice("1.2345678", isBuy, COARSE, tpsl);
        expect(snapTriggerPrice(once, isBuy, COARSE, tpsl)).toBe(once);
      }
    }
  });

  it("keeps its direction on an OUTCOME spec, where price and size precision differ", () => {
    // The only spec that sets `priceSzDecimals`. Size is 0 (one share is the
    // lot) and price is 1 (a flat 1e-5 tick across the whole 0–1 probability
    // range) — measured, not metadata; see `core/assetIds.ts`.
    //
    // The snap grid used to be built from the raw `szDecimals`, which for a
    // perp means `6 - 0` = SIX decimals, while `formatPrice` ran at the
    // accessor's `6 - 1` = five. Two different grids, and the docstring's
    // promise that the format step is "a no-op rather than a second,
    // undirected truncation" was false: the snap moved 0.000333667 UP to
    // 0.000334, then the format truncated toward zero to 0.00033 — BELOW the
    // requested price, so a long's stop fires later than asked. Exactly the
    // failure the directional snap exists to prevent.
    //
    // The two grids coincide above ~0.01, where the five-significant-figure
    // rule binds first, which is why every existing case here passed.
    const OUTCOME: AssetSpec = {
      assetId: 10_171,
      szDecimals: OUTCOME_SIZE_DECIMALS,
      priceSzDecimals: OUTCOME_PRICE_SZ_DECIMALS,
      marketType: "perp",
    };
    const asked = "0.000333667";
    const sellStop = snapTriggerPrice(asked, false, OUTCOME, "sl");
    expect(Number(sellStop)).toBeGreaterThanOrEqual(Number(asked));

    const buyStop = snapTriggerPrice(asked, true, OUTCOME, "sl");
    expect(Number(buyStop)).toBeLessThanOrEqual(Number(asked));

    // And the format step really is a no-op now — one grid, not two.
    expect(snapTriggerPrice(sellStop, false, OUTCOME, "sl")).toBe(sellStop);
  });

  it("prices a trigger leg's RESTING price at the price precision too", () => {
    // The sibling read, at the other end of `buildTriggerOrder`. Same rule:
    // `AssetSpec.priceSzDecimals` carries "read it through `priceSzDecimalsOf`,
    // never directly, so a new call site cannot forget the fallback", and
    // `marketLimitPrice`, `buildLimitOrder` and the isMarket branch all honour
    // it. These two reads did not, which made it internal inconsistency rather
    // than a documented exception.
    const OUTCOME: AssetSpec = {
      assetId: 10_171,
      szDecimals: OUTCOME_SIZE_DECIMALS,
      priceSzDecimals: OUTCOME_PRICE_SZ_DECIMALS,
      marketType: "perp",
    };
    const leg = buildTriggerOrder({
      asset: OUTCOME,
      isBuy: false,
      size: "10",
      triggerPrice: "0.00034",
      // Below 0.01, where the raw `szDecimals` (6 - 0 = SIX decimals) and the
      // accessor's (6 - 1 = five) diverge. Above it the five-significant-figure
      // rule binds first and the two agree, which is why this went unnoticed.
      limitPrice: "0.000333667",
      isMarket: false,
      tpsl: "sl",
    });
    // Five decimals — the measured outcome tick, `{1:2, 2:20, 3:18, 4:6, 5:169}`
    // across 215 live levels with NONE at 6+. A sixth decimal is off-grid and
    // comes back `tickRejected`.
    expect((String(leg.p).split(".")[1] ?? "").length).toBeLessThanOrEqual(5);
  });

  it("leaves an already-valid price untouched", () => {
    expect(snapTriggerPrice("90000", false, COARSE, "sl")).toBe("90000");
  });

  it("inverts the direction for a take-profit, which sits WITH the position", () => {
    // A long's TP is a sell trigger ABOVE the mark: the price travels up to
    // reach it, so rounding must go DOWN to fire no later than asked. Using the
    // stop-loss direction here would push every take-profit further away.
    const tpLong = snapTriggerPrice("1.2345678", false, COARSE, "tp");
    expect(Number(tpLong)).toBeLessThanOrEqual(1.2345678);

    const tpShort = snapTriggerPrice("1.2345678", true, COARSE, "tp");
    expect(Number(tpShort)).toBeGreaterThanOrEqual(1.2345678);
  });

  it("rounds stops and take-profits in opposite directions at the same side", () => {
    const sl = snapTriggerPrice("1.2345678", false, COARSE, "sl");
    const tp = snapTriggerPrice("1.2345678", false, COARSE, "tp");
    expect(Number(sl)).toBeGreaterThanOrEqual(Number(tp));
  });
});

describe("minimum notional", () => {
  it("accepts an order at or above $10", () => {
    expect(meetsMinNotional("97000", "0.001")).toBe(true); // $97
    expect(meetsMinNotional("10", "1")).toBe(true);
  });

  it("rejects an order below $10 — enforced server-side only", () => {
    expect(meetsMinNotional("1", "1")).toBe(false);
    expect(() => assertMinNotional("1", "1")).toThrow(HlError);
  });

  it("exempts a zero-size position TP/SL, which carries no notional", () => {
    expect(meetsMinNotional("90000", "0")).toBe(true);
  });
});

describe("buildBuilderFee", () => {
  const address = "0x9b12e858da780a96876e3018780cf0d83359b0bb";

  it("returns undefined — never null — when no builder is configured", () => {
    // `builder: null` is a hard validation error; the field must be absent.
    expect(buildBuilderFee({ builderAddress: null, maxBuilderFee: 50 }, "perp")).toBeUndefined();
  });

  it("emits the wire shape when configured", () => {
    expect(buildBuilderFee({ builderAddress: address, maxBuilderFee: 50 }, "perp")).toEqual({
      b: address,
      f: 50,
    });
  });

  it("enforces the perp ceiling of 100, which the schema does not", () => {
    // The schema caps at 1000 (the spot ceiling), so perps must be checked here.
    expect(() => buildBuilderFee({ builderAddress: address, maxBuilderFee: 101 }, "perp")).toThrow(
      /ceiling of 100/
    );
  });

  it("allows up to 1000 on spot", () => {
    expect(buildBuilderFee({ builderAddress: address, maxBuilderFee: 1000 }, "spot")).toMatchObject(
      {
        f: 1000,
      }
    );
    expect(() =>
      buildBuilderFee({ builderAddress: address, maxBuilderFee: 1001 }, "spot")
    ).toThrow();
  });

  it("rejects a non-integer fee", () => {
    expect(() => buildBuilderFee({ builderAddress: address, maxBuilderFee: 1.5 }, "perp")).toThrow(
      HlError
    );
  });
});

describe("slippage is exact decimal, not float", () => {
  it("computes 7% off 100 as exactly 93", () => {
    // `1 - 0.07` is 0.9299999999999999 in IEEE-754. Multiplying a reference
    // price by that float put the order one tick below where the user asked —
    // silently, at a price that then rests on the book.
    expect(
      marketLimitPrice({
        referencePrice: "100",
        isBuy: false,
        asset: { assetId: 0, szDecimals: 5, marketType: "perp" },
        slippage: 0.07,
      })
    ).toBe("93");
  });

  it("computes the buy side exactly too", () => {
    expect(
      marketLimitPrice({
        referencePrice: "100",
        isBuy: true,
        asset: { assetId: 0, szDecimals: 5, marketType: "perp" },
        slippage: 0.07,
      })
    ).toBe("107");
  });

  it("holds at a coarser size precision", () => {
    expect(
      marketLimitPrice({
        referencePrice: "100",
        isBuy: false,
        asset: { assetId: 0, szDecimals: 2, marketType: "perp" },
        slippage: 0.07,
      })
    ).toBe("93");
  });
});
