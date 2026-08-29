import {
  IP_WEIGHT_PER_MINUTE,
  SOFT_WEIGHT_PER_MINUTE,
  WeightBudget,
  weightBudget,
  weightOf,
} from "@/hyperliquid/api/weightBudget";

const NOW = 1_800_000_000_000;

describe("weightOf", () => {
  it("charges the documented weights", () => {
    expect(weightOf("orderStatus")).toBe(2);
    expect(weightOf("historicalOrders")).toBe(20);
  });

  it("adds a surcharge per page of results", () => {
    // Why reconciliation prefers orderStatus (2) over historicalOrders (20+).
    expect(weightOf("historicalOrders", 60)).toBe(23);
    expect(weightOf("historicalOrders", 19)).toBe(20);
  });
});

describe("WeightBudget", () => {
  it("starts with the full allowance", () => {
    expect(new WeightBudget().remaining(NOW)).toBe(IP_WEIGHT_PER_MINUTE);
  });

  it("tracks spend within the window", () => {
    const budget = new WeightBudget();
    budget.spend(100, NOW);
    budget.spend(50, NOW + 1000);
    expect(budget.used(NOW + 2000)).toBe(150);
  });

  it("slides — old spend ages out", () => {
    const budget = new WeightBudget();
    budget.spend(1000, NOW);
    expect(budget.used(NOW + 30_000)).toBe(1000);
    expect(budget.used(NOW + 61_000)).toBe(0);
  });

  it("is a sliding window, not fixed buckets", () => {
    // Fixed buckets would let a burst spend the whole budget twice across a
    // minute boundary — exactly the shape of a launch-time refresh sweep.
    const budget = new WeightBudget(1000, 60_000);
    budget.spend(1000, NOW + 59_000);
    expect(budget.canSpend(1000, NOW + 60_001)).toBe(false);
    expect(budget.canSpend(1000, NOW + 119_001)).toBe(true);
  });

  it("refuses a request that would exceed the limit", () => {
    const budget = new WeightBudget(100);
    budget.spend(95, NOW);
    expect(budget.canSpend(10, NOW)).toBe(false);
    expect(budget.canSpend(5, NOW)).toBe(true);
  });

  it("never reports negative remaining", () => {
    const budget = new WeightBudget(10);
    budget.spend(50, NOW);
    expect(budget.remaining(NOW)).toBe(0);
  });

  describe("retryAfterMs", () => {
    it("is zero when the request fits", () => {
      expect(new WeightBudget().retryAfterMs(10, NOW)).toBe(0);
    });

    it("waits exactly until enough weight ages out", () => {
      const budget = new WeightBudget(100, 60_000);
      budget.spend(60, NOW);
      budget.spend(40, NOW + 10_000);
      // Needs 60 to age out, which happens 60s after the first spend.
      expect(budget.retryAfterMs(60, NOW + 20_000)).toBe(40_000);
    });

    it("returns the full window for a request larger than the limit", () => {
      expect(new WeightBudget(100, 60_000).retryAfterMs(500, NOW)).toBe(60_000);
    });
  });

  describe("tryRun", () => {
    it("runs and charges when the budget allows", async () => {
      const budget = new WeightBudget();
      const result = await budget.tryRun("orderStatus", async () => "ok", { now: () => NOW });
      expect(result).toBe("ok");
      expect(budget.used(NOW)).toBe(2);
    });

    it("returns null without running when exhausted", async () => {
      const budget = new WeightBudget(1);
      let ran = false;
      const result = await budget.tryRun(
        "orderStatus",
        async () => {
          ran = true;
          return "ok";
        },
        { now: () => NOW }
      );
      expect(result).toBeNull();
      expect(ran).toBe(false);
    });

    it("does not wait — the caller decides how to handle pressure", async () => {
      const budget = new WeightBudget(1);
      const started = Date.now();
      await budget.tryRun("orderStatus", async () => "ok", { now: () => NOW });
      // Blocking here would hide the backpressure from the caller.
      expect(Date.now() - started).toBeLessThan(50);
    });

    it("charges the paging surcharge", async () => {
      const budget = new WeightBudget();
      await budget.tryRun("historicalOrders", async () => [], {
        now: () => NOW,
        resultCount: 40,
      });
      expect(budget.used(NOW)).toBe(22);
    });

    it("charges even when the operation throws — the request still went out", async () => {
      const budget = new WeightBudget();
      await expect(
        budget.tryRun(
          "orderStatus",
          async () => {
            throw new Error("boom");
          },
          { now: () => NOW }
        )
      ).rejects.toThrow("boom");
      expect(budget.used(NOW)).toBe(2);
    });
  });
});

describe("capacity()", () => {
  // The gauge reads this. It used to read the documented 1200 while the live
  // budget enforced 1000, so the arc saturated at 83% and could never turn red.
  it("reports the limit the instance actually enforces", () => {
    expect(new WeightBudget(1000).capacity()).toBe(1000);
    expect(weightBudget.capacity()).toBe(SOFT_WEIGHT_PER_MINUTE);
  });

  it("never lets `used` exceed it", () => {
    const budget = new WeightBudget(100);
    for (let i = 0; i < 50; i += 1) {
      if (budget.canSpend(20, NOW)) budget.spend(20, NOW);
    }
    expect(budget.used(NOW)).toBeLessThanOrEqual(budget.capacity());
  });
});

describe("extraWeight", () => {
  // A `tryRun` whose operation fires two endpoints spends one endpoint's
  // weight while the server charges for both. `fetchOpenOrders` did exactly
  // that, and its only caller multiplies it by a family fan-out.
  it("charges for the companion request too", async () => {
    const budget = new WeightBudget(1000);
    await budget.tryRun("frontendOpenOrders", async () => "ok", {
      now: () => NOW,
      extraWeight: weightOf("openOrders"),
    });
    expect(budget.used(NOW)).toBe(weightOf("frontendOpenOrders") + weightOf("openOrders"));
  });

  it("still charges the base weight when omitted", async () => {
    const budget = new WeightBudget(1000);
    await budget.tryRun("frontendOpenOrders", async () => "ok", { now: () => NOW });
    expect(budget.used(NOW)).toBe(weightOf("frontendOpenOrders"));
  });

  it("declines when only the base weight would have fit", async () => {
    // The gate must consider the TOTAL, or the budget is overspent silently.
    const budget = new WeightBudget(30);
    const ran = await budget.tryRun("frontendOpenOrders", async () => "ok", {
      now: () => NOW,
      extraWeight: weightOf("openOrders"),
    });
    expect(ran).toBeNull();
    expect(budget.used(NOW)).toBe(0);
  });
});

/**
 * The weight table against the published rate limits, because the whole budget
 * is worthless if it disagrees with the server it is modelling — and it did.
 *
 * Docs (rate-limits-and-user-limits, read 2026-08-29): weight 2 for exactly
 * `l2Book, allMids, clearinghouseState, orderStatus, spotClearinghouseState,
 * exchangeStatus`; weight 60 for `userRole`; **20 for every other documented
 * info request**. Sixteen entries here were keyed at 2, so a session start plus
 * one Markets sweep was charged about 12 locally against roughly 160 for real:
 * the tracker stayed green while the actual per-IP budget emptied, turning the
 * quiet local deferrals this module exists to produce into hard 429s.
 */
describe("REQUEST_WEIGHTS against the published rate limits", () => {
  it("charges 2 for exactly the six documented cheap reads", () => {
    for (const request of [
      "l2Book",
      "allMids",
      "clearinghouseState",
      "orderStatus",
      "spotClearinghouseState",
    ] as const) {
      expect(weightOf(request)).toBe(2);
    }
  });

  it("charges 60 for userRole", () => {
    expect(weightOf("userRole")).toBe(60);
  });

  it("charges 20 for everything else, including the unlisted default", () => {
    // The sixteen that were wrong, plus the fallback an unknown request takes.
    for (const request of [
      "meta",
      "spotMeta",
      "perpDexs",
      "perpDexLimits",
      "perpDexStatus",
      "perpsAtOpenInterestCap",
      "userAbstraction",
      "preTransferCheck",
      "usdcRouting",
      "activeAssetData",
      "marginTable",
      "maxMarketOrderNtls",
      "userRateLimit",
      "settledOutcome",
      "outcomeTemplates",
      "default",
    ] as const) {
      expect(weightOf(request)).toBe(20);
    }
  });

  it("applies the per-page surcharge only to the endpoints that charge one", () => {
    // 2,000 rows of fills is 100 pages of 20 on top of the base 20.
    expect(weightOf("userFillsByTime", 2_000)).toBe(20 + 100);
    expect(weightOf("historicalOrders", 100)).toBe(20 + 5);
    // A read with no surcharge is unaffected however many rows it returns —
    // charging one everywhere would defer cheap reads for nothing.
    expect(weightOf("clearinghouseState", 5_000)).toBe(2);
    expect(weightOf("meta", 5_000)).toBe(20);
  });

  it("counts candle pages in 60s, not 20s", () => {
    // The one endpoint the docs give a different page size, and it was being
    // charged threefold.
    expect(weightOf("candleSnapshot", 300)).toBe(20 + 5);
  });
});
