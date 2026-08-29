import { createIdentity } from "@/hyperliquid/core/identity";
import {
  ActionBudget,
  cancelLimitFor,
  limitForVolume,
  openOrderLimitForVolume,
  wouldExceedOpenOrderLimit,
} from "@/hyperliquid/api/rateLimit";

const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const SUB = "0x1111111111111111111111111111111111111111";
const identity = createIdentity({ env: "testnet", accountId: "a", address: ADDRESS });

describe("limitForVolume", () => {
  it("gives a new address the documented initial buffer", () => {
    expect(limitForVolume(0)).toBe(10_000);
  });

  it("earns one request per USDC of lifetime volume", () => {
    expect(limitForVolume(5_000)).toBe(15_000);
  });

  it("floors partial volume rather than rounding up", () => {
    expect(limitForVolume("1000.9")).toBe(11_000);
  });

  it("handles volumes beyond safe float precision", () => {
    // 1e18 USDC would lose precision as a JS number mid-computation.
    expect(limitForVolume("1000000000000000000")).toBe(10_000 + 1e18);
  });

  it("treats negative or non-finite volume as new", () => {
    expect(limitForVolume(-5)).toBe(10_000);
    expect(limitForVolume(Number.NaN)).toBe(10_000);
  });
});

describe("cancelLimitFor", () => {
  it("uses limit*2 while that is the smaller of the two formulas", () => {
    // 10000*2 = 20000 vs 10000+100000 = 110000
    expect(cancelLimitFor(10_000)).toBe(20_000);
  });

  it("switches to limit+100000 for large limits", () => {
    // 200000*2 = 400000 vs 200000+100000 = 300000
    expect(cancelLimitFor(200_000)).toBe(300_000);
  });

  it("is always at least the base limit, so cancels are never scarcer", () => {
    for (const limit of [0, 1, 10_000, 100_000, 1_000_000]) {
      expect(cancelLimitFor(limit)).toBeGreaterThanOrEqual(limit);
    }
  });
});

describe("openOrderLimitForVolume", () => {
  it("starts at the base of 1000", () => {
    expect(openOrderLimitForVolume(0)).toBe(1_000);
  });

  it("earns one order per 5M USDC", () => {
    expect(openOrderLimitForVolume(5_000_000)).toBe(1_001);
    expect(openOrderLimitForVolume(50_000_000)).toBe(1_010);
  });

  it("caps at the documented hard limit", () => {
    expect(openOrderLimitForVolume("100000000000000")).toBe(5_000);
  });
});

describe("wouldExceedOpenOrderLimit", () => {
  it("permits fan-out within the limit", () => {
    expect(wouldExceedOpenOrderLimit({ currentOpenOrders: 10, additionalOrders: 20 })).toBe(false);
  });

  it("blocks a scale order that would cross the base limit", () => {
    // Past 1000 open orders, reduce-only and trigger orders are silently
    // rejected — which breaks TP/SL, so this must be caught before submit.
    expect(wouldExceedOpenOrderLimit({ currentOpenOrders: 990, additionalOrders: 20 })).toBe(true);
  });

  it("is exclusive at the boundary", () => {
    expect(wouldExceedOpenOrderLimit({ currentOpenOrders: 999, additionalOrders: 1 })).toBe(false);
    expect(wouldExceedOpenOrderLimit({ currentOpenOrders: 1_000, additionalOrders: 1 })).toBe(true);
  });

  it("accounts for a high-volume trader's larger allowance", () => {
    expect(
      wouldExceedOpenOrderLimit({
        currentOpenOrders: 1_000,
        additionalOrders: 1,
        cumulativeVolumeUsdc: 50_000_000,
      })
    ).toBe(false);
  });
});

describe("ActionBudget", () => {
  let budget: ActionBudget;

  beforeEach(() => {
    budget = new ActionBudget();
  });

  it("assumes a new-account budget for an unseeded identity rather than unlimited", () => {
    const snapshot = budget.snapshot(identity);
    expect(snapshot.limit).toBe(10_000);
    expect(snapshot.isThrottled).toBe(false);
  });

  it("seeds from the server's accounting", () => {
    budget.seed(identity, { limit: 12_000, used: 11_500 });
    expect(budget.snapshot(identity)).toMatchObject({
      limit: 12_000,
      used: 11_500,
      remaining: 500,
      isThrottled: false,
    });
  });

  it("seeds from volume when userRateLimit is unavailable", () => {
    budget.seedFromVolume(identity, 5_000);
    expect(budget.snapshot(identity).limit).toBe(15_000);
  });

  it("reports throttled once the allowance is spent", () => {
    budget.seed(identity, { limit: 10, used: 10 });
    const snapshot = budget.snapshot(identity);
    expect(snapshot.remaining).toBe(0);
    expect(snapshot.isThrottled).toBe(true);
    expect(budget.canSpend(identity, "other")).toBe(false);
  });

  it("never reports negative remaining", () => {
    budget.seed(identity, { limit: 5, used: 50 });
    expect(budget.snapshot(identity).remaining).toBe(0);
  });

  it("still allows cancels when the placement budget is exhausted", () => {
    // The whole point of Hyperliquid's larger cancel allowance: a user must
    // always be able to close a position.
    budget.seed(identity, { limit: 10, used: 10 });
    expect(budget.canSpend(identity, "other")).toBe(false);
    expect(budget.canSpend(identity, "cancel")).toBe(true);
  });

  it("does not let placements draw down the cancel allowance", () => {
    budget.seed(identity, { limit: 100, used: 0 });
    const before = budget.snapshot(identity).cancelRemaining;
    budget.spend(identity, "other", 50);
    expect(budget.snapshot(identity).cancelRemaining).toBe(before);
  });

  it("counts spending against the right bucket", () => {
    budget.seed(identity, { limit: 100, used: 0 });
    budget.spend(identity, "other", 3);
    budget.spend(identity, "cancel", 2);
    const snapshot = budget.snapshot(identity);
    expect(snapshot.used).toBe(3);
    expect(snapshot.cancelRemaining).toBe(cancelLimitFor(100) - 2);
  });

  it("keeps sub-account budgets separate — Hyperliquid bills them as distinct users", () => {
    const withSub = createIdentity({
      env: "testnet",
      accountId: "a",
      address: ADDRESS,
      subAccount: SUB,
    });
    budget.seed(identity, { limit: 10, used: 10 });
    budget.seed(withSub, { limit: 10_000, used: 0 });

    expect(budget.canSpend(identity, "other")).toBe(false);
    expect(budget.canSpend(withSub, "other")).toBe(true);
  });

  it("keeps DEX budgets separate too", () => {
    const onDex = createIdentity({ env: "testnet", accountId: "a", address: ADDRESS, dex: "xyz" });
    budget.seed(identity, { limit: 1, used: 1 });
    expect(budget.canSpend(onDex, "other")).toBe(true);
  });

  it("checks multi-action spends as a whole, not one at a time", () => {
    budget.seed(identity, { limit: 10, used: 8 });
    expect(budget.canSpend(identity, "other", 2)).toBe(true);
    expect(budget.canSpend(identity, "other", 3)).toBe(false);
  });

  it("advises the documented throttle interval once exhausted", () => {
    budget.seed(identity, { limit: 1, used: 1 });
    expect(budget.retryDelayMs(identity, "other")).toBe(10_000);
    expect(budget.retryDelayMs(identity, "cancel")).toBe(0);
  });

  it("advises no delay while budget remains", () => {
    budget.seed(identity, { limit: 100, used: 0 });
    expect(budget.retryDelayMs(identity, "other")).toBe(0);
  });

  it("forgets an identity on sign-out", () => {
    budget.seed(identity, { limit: 1, used: 1 });
    budget.forget(identity);
    expect(budget.snapshot(identity).limit).toBe(10_000);
  });
});
