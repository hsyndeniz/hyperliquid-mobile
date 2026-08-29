import {
  PRICE_CHIP_STEPS,
  TPSL_PRESET_PCTS,
  chipPrice,
  liqDeltaPct,
  normalizeDecimalInput,
  offsetPctLabel,
  projectedPnl,
  roiOnMargin,
  sizeFromMargin,
  sizeLine,
  tpslDirection,
  tpslPresetPrice,
} from "@/components/trade/orderSheetView";

describe("chipPrice", () => {
  it("snaps the offset price to the asset's grid", () => {
    // BTC-like: szDecimals 5, perp → 1 decimal max, 5 sig figs → tick 1 at 77k.
    expect(chipPrice("77340", 0.01, 5, "perp")).toBe("78113");
    expect(chipPrice("77340", -0.01, 5, "perp")).toBe("76567");
  });

  it("returns the snapped anchor itself for the Mid chip", () => {
    expect(chipPrice("77340.4", 0, 5, "perp")).toBe("77340");
  });

  it("returns empty for an unusable anchor rather than a wrong number", () => {
    expect(chipPrice(null, 0.01, 5, "perp")).toBe("");
    expect(chipPrice("", 0.01, 5, "perp")).toBe("");
    expect(chipPrice("0", 0.01, 5, "perp")).toBe("");
    expect(chipPrice("-5", 0.01, 5, "perp")).toBe("");
  });

  it("ships the reference chip row: two steps each side of Mid", () => {
    expect(PRICE_CHIP_STEPS.map((c) => c.label)).toEqual(["-1%", "-0.3%", "Mid", "+0.3%", "+1%"]);
    const pcts = PRICE_CHIP_STEPS.map((c) => c.pct);
    expect(pcts).toEqual([-0.01, -0.003, 0, 0.003, 0.01]);
  });
});

describe("tpslDirection", () => {
  it("aims TP at profit and SL at loss, per side", () => {
    expect(tpslDirection("tp", "long")).toBe("above");
    expect(tpslDirection("tp", "short")).toBe("below");
    expect(tpslDirection("sl", "long")).toBe("below");
    expect(tpslDirection("sl", "short")).toBe("above");
  });
});

describe("tpslPresetPrice", () => {
  it("moves toward the kind's own side of entry", () => {
    // Long at 77348: TP +5% above, SL -5% below (the screenshot's numbers).
    expect(tpslPresetPrice("77348", 0.05, "tp", "long", 5, "perp")).toBe("81215");
    expect(tpslPresetPrice("77348", 0.05, "sl", "long", 5, "perp")).toBe("73481");
    // Short mirrors.
    expect(tpslPresetPrice("77348", 0.05, "tp", "short", 5, "perp")).toBe("73481");
    expect(tpslPresetPrice("77348", 0.05, "sl", "short", 5, "perp")).toBe("81215");
  });

  it("ships the reference presets", () => {
    expect(TPSL_PRESET_PCTS).toEqual([0.05, 0.1, 0.25, 0.5]);
  });
});

describe("offsetPctLabel", () => {
  it("signs the distance from entry", () => {
    expect(offsetPctLabel("100", "105")).toBe("+5.00%");
    expect(offsetPctLabel("100", "98.1")).toBe("-1.90%");
    expect(offsetPctLabel("100", "100")).toBe("+0.00%");
  });

  it("is null when either side is unusable", () => {
    expect(offsetPctLabel(null, "105")).toBeNull();
    expect(offsetPctLabel("100", "")).toBeNull();
    expect(offsetPctLabel("0", "105")).toBeNull();
    // orderInfo's unknown spelling must not become a percent.
    expect(offsetPctLabel("100", "--")).toBeNull();
  });
});

describe("projectedPnl", () => {
  it("signs by side: a long profits above entry, a short below", () => {
    expect(projectedPnl("100", "110", "2", "long")).toBe("20.00");
    expect(projectedPnl("100", "90", "2", "long")).toBe("-20.00");
    expect(projectedPnl("100", "90", "2", "short")).toBe("20.00");
    expect(projectedPnl("100", "110", "2", "short")).toBe("-20.00");
  });

  it("refuses a projection over nothing", () => {
    expect(projectedPnl(null, "110", "2", "long")).toBeNull();
    expect(projectedPnl("100", "110", "", "long")).toBeNull();
    expect(projectedPnl("100", "110", "0", "long")).toBeNull();
    expect(projectedPnl("100", "", "2", "long")).toBeNull();
  });
});

describe("roiOnMargin", () => {
  it("reads the PnL against the committed margin", () => {
    expect(roiOnMargin("3.08", "0.15")).toBe("+4.87%");
    expect(roiOnMargin("3.08", "-0.15")).toBe("-4.87%");
  });

  it("is null on zero or unknown margin — never an infinite ROI", () => {
    expect(roiOnMargin("0", "0.15")).toBeNull();
    expect(roiOnMargin(null, "0.15")).toBeNull();
    expect(roiOnMargin("3.08", null)).toBeNull();
  });
});

describe("sizeFromMargin", () => {
  it("levers the margin into notional and truncates to the lot grid", () => {
    // 3 USDC × 40x = 120 notional; at 77340 → 0.00155159… → lot 5dp truncates.
    expect(sizeFromMargin("3", 40, "77340", 5)).toBe("0.00155");
  });

  it("clamps leverage below 1 to 1, matching maxSizeFor", () => {
    expect(sizeFromMargin("100", 0, "50", 2)).toBe("2");
    expect(sizeFromMargin("100", 1, "50", 2)).toBe("2");
  });

  it("returns empty for unusable inputs rather than a zero", () => {
    expect(sizeFromMargin("", 10, "77340", 5)).toBe("");
    expect(sizeFromMargin("0", 10, "77340", 5)).toBe("");
    expect(sizeFromMargin("3", 10, null, 5)).toBe("");
  });
});

describe("liqDeltaPct", () => {
  it("reports the estimate's distance from current price", () => {
    expect(liqDeltaPct("74420", "77358")).toBe("-3.80%");
  });

  it("maps orderInfo's unknown spelling to null", () => {
    expect(liqDeltaPct("--", "77358")).toBeNull();
    expect(liqDeltaPct("74420", null)).toBeNull();
  });
});

describe("sizeLine", () => {
  it("prices the base size at mid, falling back to mark", () => {
    expect(sizeLine({ size: "0.00155" }, { midPx: "77340", markPx: null, symbol: "BTC" })).toEqual({
      notional: "119.88",
      base: "0.00155 BTC",
    });
    expect(sizeLine({ size: "0.00155" }, { midPx: null, markPx: "77340", symbol: "BTC" })).toEqual({
      notional: "119.88",
      base: "0.00155 BTC",
    });
  });

  it("is null with no size or no price", () => {
    expect(sizeLine({ size: "" }, { midPx: "77340", markPx: null, symbol: "BTC" })).toBeNull();
    expect(sizeLine({ size: "0.00155" }, { midPx: null, markPx: null, symbol: "BTC" })).toBeNull();
  });
});

describe("normalizeDecimalInput", () => {
  it("accepts the comma a European decimal-pad actually renders", () => {
    expect(normalizeDecimalInput("1,5")).toBe("1.5");
    expect(normalizeDecimalInput("0,00155")).toBe("0.00155");
  });

  it("leaves a dot-locale string alone", () => {
    expect(normalizeDecimalInput("1.5")).toBe("1.5");
    expect(normalizeDecimalInput("")).toBe("");
    expect(normalizeDecimalInput("77345")).toBe("77345");
  });

  it("does not turn an invalid string into a valid one", () => {
    // Two separators must still read as two separators, so the filter
    // downstream rejects them the same way it would for a dot locale.
    expect(normalizeDecimalInput("1,5,5")).toBe("1.5.5");
  });
});
