/**
 * The one formatting rule the fee card owns: rates render at full precision.
 * Tested via `fetchedView` — importing the component itself pulls Reanimated
 * into Jest, which is the documented reason pure logic lives in `.ts` files.
 */

import {
  compactUsd,
  nextFeeTier,
  progressPercent,
  rateAsPercent,
} from "@/components/portfolio/fetchedView";

describe("rateAsPercent", () => {
  it("keeps the precision fee tiers actually differ by", () => {
    // Two adjacent VIP tiers are 0.045% and 0.04% — a 2dp round shows both as
    // 0.04% or 0.05% and the card stops carrying information.
    expect(rateAsPercent("0.00045")).toBe("0.045%");
    expect(rateAsPercent("0.0004")).toBe("0.04%");
    expect(rateAsPercent("0.00015")).toBe("0.015%");
  });

  it("keeps a maker rebate negative", () => {
    expect(rateAsPercent("-0.00001")).toBe("-0.001%");
  });

  it("renders the unknown as --, never as 0%", () => {
    expect(rateAsPercent("")).toBe("--");
    expect(rateAsPercent("abc")).toBe("--");
  });
});

/** The live testnet ladder, as `feeSchedule.tiers.vip` published it. */
const TIERS = [
  { ntlCutoff: "5000000.0", cross: "0.0004" },
  { ntlCutoff: "25000000.0", cross: "0.00035" },
  { ntlCutoff: "100000000.0", cross: "0.0003" },
];

describe("nextFeeTier", () => {
  it("picks the lowest cutoff the volume has not reached", () => {
    const next = nextFeeTier("15.27", TIERS);
    expect(next?.cutoff).toBe("5000000.0");
    expect(next?.cross).toBe("0.0004");
  });

  it("skips tiers already earned and targets the one above", () => {
    const next = nextFeeTier("5000000.0", TIERS);
    // Exactly AT the cutoff means the tier is held; the next rung is 25M.
    expect(next?.cutoff).toBe("25000000.0");
  });

  it("is null at or beyond the top tier — no bar to a level that does not exist", () => {
    expect(nextFeeTier("100000000.0", TIERS)).toBeNull();
    expect(nextFeeTier("999999999999", TIERS)).toBeNull();
  });

  it("is null when no tiers are published", () => {
    expect(nextFeeTier("15.27", [])).toBeNull();
  });

  it("computes progress as an exact BigNumber fraction", () => {
    expect(nextFeeTier("2500000", TIERS)?.progress).toBe("0.5000");
    expect(nextFeeTier("15.27", TIERS)?.progress).toBe("0.0000");
  });

  it("orders tiers itself rather than trusting wire order", () => {
    const shuffled = [TIERS[2]!, TIERS[0]!, TIERS[1]!];
    expect(nextFeeTier("15.27", shuffled)?.cutoff).toBe("5000000.0");
  });
});

describe("compactUsd", () => {
  it("renders the ladder's cutoffs the way the ladder states them", () => {
    expect(compactUsd("5000000.0")).toBe("$5M");
    expect(compactUsd("25000000.0")).toBe("$25M");
    expect(compactUsd("500000000.0")).toBe("$500M");
    expect(compactUsd("2000000000.0")).toBe("$2B");
  });

  it("rounds DOWN so a threshold is never understated", () => {
    expect(compactUsd("4970000")).toBe("$4.9M");
  });

  it("handles small figures without a suffix", () => {
    expect(compactUsd("15.27")).toBe("$15.27");
    expect(compactUsd("1500")).toBe("$1.5K");
  });
});

describe("progressPercent", () => {
  it("renders a fraction as a whole percent — the 0.5%-for-half-done bug", () => {
    expect(progressPercent("0.5")).toBe("50%");
    expect(progressPercent("1")).toBe("100%");
    expect(progressPercent("0")).toBe("0%");
  });

  it("renders a malformed fraction as dashes", () => {
    expect(progressPercent("abc")).toBe("--");
  });
});
