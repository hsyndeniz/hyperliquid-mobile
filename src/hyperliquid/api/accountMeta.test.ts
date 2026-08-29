import {
  fetchMarginTable,
  fetchPerpDexes,
  fetchPortfolio,
  fetchUserFees,
  fetchUserFunding,
  fetchUserRateLimit,
  isKnownDex,
  parseFundingRow,
  fetchDelegatorSummary,
  parseVipTiers,
  stakingIsEmpty,
  sumDailyUserVolume,
  totalFeesPaid,
  type MetaProbe,
} from "@/hyperliquid/api/accountMeta";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";

const NOW = 1_800_000_000_000;
const USER = "0xabcdef0123456789abcdef0123456789abcdef01";

function probeOf(overrides: Partial<MetaProbe>): MetaProbe {
  const reject = async () => {
    throw new Error("not stubbed");
  };
  return {
    userFees: reject,
    userFunding: reject,
    portfolio: reject,
    userRateLimit: reject,
    perpDexs: reject,
    marginTable: reject,
    ...overrides,
  } as MetaProbe;
}

const base = { user: USER, budget: new WeightBudget(), now: () => NOW };

describe("fetchUserFees", () => {
  it("applies the referral discount the published rate omits", async () => {
    // Measured on two referred mainnet accounts: userCrossRate 4.5e-4 published
    // against 4.32e-4 actually charged — a 4.17% overstatement that only affects
    // referred users, so it survives spot-checking on an unreferred account.
    const probe = probeOf({
      userFees: async () => ({
        userCrossRate: "0.00045",
        userAddRate: "0.00015",
        activeReferralDiscount: "0.04",
        activeStakingDiscount: { discount: "0.0", bpsOfMaxSupply: "0.0" },
      }),
    });

    const { value } = await fetchUserFees({ probe, ...base });

    expect(value?.crossRate).toBe("0.00045");
    expect(value?.effectiveTakerRate).toBe("0.000432");
  });

  it("does not apply the staking discount, which is already baked in", async () => {
    // An account with a 0.1 staking discount was charged exactly its published
    // rate; applying it again would understate the fee by 10%.
    const probe = probeOf({
      userFees: async () => ({
        userCrossRate: "0.00036",
        userAddRate: "0.0001",
        activeReferralDiscount: "0",
        activeStakingDiscount: { discount: "0.1" },
      }),
    });

    const { value } = await fetchUserFees({ probe, ...base });

    expect(value?.effectiveTakerRate).toBe("0.00036");
    expect(value?.stakingDiscount).toBe("0.1");
  });

  it("reads activeStakingDiscount unconditionally, since it is always an object", async () => {
    // Present even on never-funded accounts, so a null check never takes the
    // zero path via null.
    const probe = probeOf({
      userFees: async () => ({ userCrossRate: "0.00045", activeStakingDiscount: {} }),
    });
    const { value } = await fetchUserFees({ probe, ...base });
    expect(value?.stakingDiscount).toBe("0");
  });

  describe("on a sub-account", () => {
    const referred = probeOf({
      userFees: async () => ({
        userCrossRate: "0.00045",
        userAddRate: "0.00015",
        activeReferralDiscount: "0.04",
        activeStakingDiscount: { discount: "0.0" },
      }),
    });

    it("does not apply the referral discount", async () => {
      // Hyperliquid's docs: sub-accounts share the master's fee TIER but
      // "referral discounts do not apply to sub-accounts". Applying it would
      // quote a fee 4% below what is charged, on every sub-account trade.
      const { value } = await fetchUserFees({ probe: referred, ...base, isSubAccount: true });

      expect(value?.effectiveTakerRate).toBe("0.00045");
      expect(value?.referralApplies).toBe(false);
    });

    it("still reports the discount, so a fee sheet can say why it is not applied", async () => {
      // Zeroing the field instead would make "no referral" and "referral that
      // does not apply here" indistinguishable.
      const { value } = await fetchUserFees({ probe: referred, ...base, isSubAccount: true });
      expect(value?.referralDiscount).toBe("0.04");
    });

    it("leaves the master's rate alone", async () => {
      const { value } = await fetchUserFees({ probe: referred, ...base });
      expect(value?.effectiveTakerRate).toBe("0.000432");
      expect(value?.referralApplies).toBe(true);
    });
  });

  it("defers when the weight budget is exhausted", async () => {
    const budget = new WeightBudget();
    budget.spend(1_200, NOW);
    let called = false;
    const probe = probeOf({
      userFees: async () => {
        called = true;
        return {};
      },
    });

    const result = await fetchUserFees({ probe, user: USER, budget, now: () => NOW });

    expect(result.deferred).toBe(true);
    expect(called).toBe(false);
  });
});

describe("totalFeesPaid", () => {
  it("separates the builder fee from the protocol fee", async () => {
    // builderFee is an absolute amount in feeToken units, not a rate, and it is
    // not a protocol fee — counting it as one reads 3.3x too high on the fills a
    // mobile client actually generates.
    const totals = totalFeesPaid([
      { fee: "0.001432", feeToken: "USDC", builderFee: "0.001" },
      { fee: "0.000432", feeToken: "USDC", builderFee: null },
    ]);

    expect(totals.usdcProtocolFees).toBe("0.000864");
    expect(totals.usdcBuilderFees).toBe("0.001");
  });

  it("never adds a non-USDC fee into the dollar total", async () => {
    // 15 distinct fee tokens observed; a blind sum adds token quantities to
    // dollars.
    const totals = totalFeesPaid([
      { fee: "1.0", feeToken: "USDC", builderFee: null },
      { fee: "500.0", feeToken: "PURR", builderFee: null },
    ]);

    expect(totals.usdcProtocolFees).toBe("1");
    expect(totals.byToken.get("PURR")).toBe("500");
  });

  it("keeps a maker rebate negative", async () => {
    const totals = totalFeesPaid([{ fee: "-0.00001", feeToken: "USDC", builderFee: null }]);
    expect(totals.usdcProtocolFees).toBe("-0.00001");
  });
});

describe("perp dex validation", () => {
  it("reads the main dex as a null entry", async () => {
    // perpDexs()[0] is literally null on both networks.
    const probe = probeOf({
      // `fullName` is the real wire spelling on both networks. A fixture using
      // `full_name` passes against a parser that reads `full_name` and hides that
      // every dex comes back with a null name in production.
      perpDexs: async () => [null, { name: "xyz", fullName: "XYZ Dex" }],
    });

    const { value } = await fetchPerpDexes({ probe, budget: new WeightBudget(), now: () => NOW });

    expect(value?.[0]).toEqual({ name: null, fullName: null });
    expect(value?.[1]).toEqual({ name: "xyz", fullName: "XYZ Dex" });
  });

  it("treats the main dex as always valid", () => {
    const dexes = [{ name: null, fullName: null }];
    expect(isKnownDex("", dexes)).toBe(true);
    expect(isKnownDex(null, dexes)).toBe(true);
    expect(isKnownDex(undefined, dexes)).toBe(true);
  });

  it("rejects a dex this network does not serve", () => {
    // A real-but-wrong dex returns 200 with an empty account; only an allow-list
    // distinguishes it from a genuinely empty one.
    const dexes = [
      { name: null, fullName: null },
      { name: "xyz", fullName: "XYZ" },
    ];
    expect(isKnownDex("xyz", dexes)).toBe(true);
    expect(isKnownDex("test", dexes)).toBe(false);
  });
});

describe("fetchMarginTable", () => {
  it("returns tiers ascending by lower bound", async () => {
    // findMarginTier scans in reverse and does NOT sort, so an unsorted table
    // would silently select the wrong tier and show a wrong maximum leverage.
    const probe = probeOf({
      marginTable: async () => ({
        marginTiers: [
          { lowerBound: "10000", maxLeverage: 20 },
          { lowerBound: "0", maxLeverage: 40 },
          { lowerBound: "100000", maxLeverage: 10 },
        ],
      }),
    });

    const { value } = await fetchMarginTable({
      probe,
      id: 1,
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(value?.map((t) => t.lowerBound)).toEqual(["0", "10000", "100000"]);
  });

  it("leaves an already-sorted table untouched", async () => {
    // 21 live tables across both networks were sorted; this is the normal path.
    const probe = probeOf({
      marginTable: async () => ({
        marginTiers: [
          { lowerBound: "0", maxLeverage: 40 },
          { lowerBound: "10000", maxLeverage: 20 },
        ],
      }),
    });

    const { value } = await fetchMarginTable({
      probe,
      id: 1,
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(value).toEqual([
      { lowerBound: "0", maxLeverage: 40 },
      { lowerBound: "10000", maxLeverage: 20 },
    ]);
  });
});

describe("fetchUserRateLimit", () => {
  it("reads the four fields the server reports", async () => {
    const probe = probeOf({
      userRateLimit: async () => ({
        cumVlm: "29894185.2699999996",
        nRequestsUsed: 43503,
        nRequestsCap: 29904185,
        nRequestsSurplus: 0,
      }),
    });

    const { value } = await fetchUserRateLimit({ probe, ...base });

    // Kept as a string: 18 significant digits do not survive a double.
    expect(value?.cumVlm).toBe("29894185.2699999996");
    expect(value?.nRequestsUsed).toBe(43503);
  });
});

describe("sumDailyUserVolume", () => {
  it("sums the USER's columns with BigNumber exactness", () => {
    // 0.1 + 0.2 twice — a float sum would carry dust into the display.
    const total = sumDailyUserVolume([
      { date: "2026-08-01", userCross: "0.1", userAdd: "0.2", exchange: "5082890.17" },
      { date: "2026-08-02", userCross: "0.1", userAdd: "0.2", exchange: "4900000.00" },
    ]);

    expect(total).toBe("0.6");
  });

  it("NEVER sums the exchange column — that is everyone's volume", () => {
    // Live measurement: ~5M/day of exchange volume against a user volume of 0.
    // Summing it in is off by six orders of magnitude and looks plausible.
    const total = sumDailyUserVolume([
      { date: "2026-08-01", userCross: "0", userAdd: "0", exchange: "5082890.1799999997" },
    ]);

    expect(total).toBe("0");
  });

  it("treats a missing or malformed window as zero volume, not NaN", () => {
    expect(sumDailyUserVolume(undefined)).toBe("0");
    expect(sumDailyUserVolume([])).toBe("0");
    expect(sumDailyUserVolume([{ userCross: "abc" }, null])).toBe("0");
  });
});

describe("parseFundingRow", () => {
  it("reads the REST shape, which nests the row under delta", () => {
    const row = parseFundingRow({
      time: 1_700_000_000_000,
      hash: "0xabc",
      delta: { type: "funding", coin: "BTC", usdc: "-1.5", szi: "0.1", fundingRate: "0.0000125" },
    });

    expect(row).toEqual({
      time: 1_700_000_000_000,
      coin: "BTC",
      usdc: "-1.5",
      szi: "0.1",
      fundingRate: "0.0000125",
    });
  });

  it("passes both signs through unmodified — the sign IS the paid/received label", () => {
    // Verified live by exact reconciliation: cumFunding.allTime = 0.005326,
    // Σ ledger usdc = -0.005326. Negative usdc is PAID, positive RECEIVED, and
    // the parser must never normalise it.
    const paid = parseFundingRow({ time: 1, delta: { coin: "BTC", usdc: "-0.000191" } });
    const received = parseFundingRow({ time: 2, delta: { coin: "BTC", usdc: "0.000343" } });

    expect(paid.usdc).toBe("-0.000191");
    expect(received.usdc).toBe("0.000343");
  });

  it("reads the flat websocket shape with the same parser", () => {
    // One parser for both, so neither path silently reads undefined.
    const row = parseFundingRow({
      time: 1_700_000_000_000,
      coin: "BTC",
      usdc: "-1.5",
      szi: "0.1",
      fundingRate: "0.0000125",
      nSamples: 3,
    });

    expect(row.coin).toBe("BTC");
    expect(row.usdc).toBe("-1.5");
  });

  it("preserves the sign exactly, without relabelling it", () => {
    // The ledger's sign convention relative to a position's cumFunding was not
    // independently verified, so nothing here names it paid or earned.
    expect(parseFundingRow({ delta: { usdc: "2.5" } }).usdc).toBe("2.5");
    expect(parseFundingRow({ delta: { usdc: "-2.5" } }).usdc).toBe("-2.5");
  });
});

describe("fetchUserFunding", () => {
  it("passes the window through and parses every row", async () => {
    const calls: unknown[] = [];
    const probe = probeOf({
      userFunding: async (params) => {
        calls.push(params);
        return [{ time: 1, delta: { coin: "BTC", usdc: "-1.0", szi: "1", fundingRate: "0.0001" } }];
      },
    });

    const { value } = await fetchUserFunding({ probe, startTime: 1_000, ...base });

    expect(calls[0]).toEqual({ user: USER, startTime: 1_000 });
    expect(value).toHaveLength(1);
    expect(value?.[0].coin).toBe("BTC");
  });
});

describe("fetchPortfolio", () => {
  it("exposes both series rather than choosing one", async () => {
    // accountValueHistory deltas attribute a deposit to trading performance;
    // pnlHistory is the deposit-adjusted series. Which is right depends on the
    // surface, so the choice is not made here.
    const probe = probeOf({
      portfolio: async () => [
        [
          "day",
          {
            accountValueHistory: [
              [1, "100.0"],
              [2, "150.0"],
            ],
            pnlHistory: [
              [1, "0.0"],
              [2, "5.0"],
            ],
          },
        ],
      ],
    });

    const { value } = await fetchPortfolio({ probe, ...base });

    expect(value?.get("day")?.accountValueHistory).toEqual([
      [1, "100.0"],
      [2, "150.0"],
    ]);
    expect(value?.get("day")?.pnlHistory).toEqual([
      [1, "0.0"],
      [2, "5.0"],
    ]);
  });

  it("tolerates a period whose series are missing", async () => {
    const probe = probeOf({ portfolio: async () => [["week", {}]] });
    const { value } = await fetchPortfolio({ probe, ...base });
    expect(value?.get("week")).toEqual({ accountValueHistory: [], pnlHistory: [] });
  });
});

describe("perpDexs field spelling", () => {
  it("ignores the snake_case spelling, which the wire does not use", async () => {
    // Guards the regression directly: reading `full_name` yields null for every
    // dex on both networks, silently, and a fixture written in the same
    // spelling agrees with it.
    const { value } = await fetchPerpDexes({
      probe: {
        perpDexs: async () => [{ name: "xyz", full_name: "should be ignored" }],
      } as unknown as Parameters<typeof fetchPerpDexes>[0]["probe"],
    });

    expect(value?.[0]).toEqual({ name: "xyz", fullName: null });
  });
});

describe("parseVipTiers", () => {
  const LIVE_SHAPE = {
    tiers: {
      vip: [
        {
          ntlCutoff: "25000000.0",
          cross: "0.00035",
          add: "0.00008",
          spotCross: "0.0005",
          spotAdd: "0.0002",
        },
        {
          ntlCutoff: "5000000.0",
          cross: "0.0004",
          add: "0.00012",
          spotCross: "0.0006",
          spotAdd: "0.0003",
        },
      ],
      mm: [{ makerFractionCutoff: "0.005", add: "-0.00001" }],
    },
  };

  it("parses the vip ladder and sorts by cutoff ascending", () => {
    const tiers = parseVipTiers(LIVE_SHAPE);
    expect(tiers.map((tier) => tier.ntlCutoff)).toEqual(["5000000.0", "25000000.0"]);
    expect(tiers[0]).toEqual({
      ntlCutoff: "5000000.0",
      cross: "0.0004",
      add: "0.00012",
      spotCross: "0.0006",
      spotAdd: "0.0003",
    });
  });

  it("returns [] when the schedule or ladder is missing", () => {
    expect(parseVipTiers(undefined)).toEqual([]);
    expect(parseVipTiers({})).toEqual([]);
    expect(parseVipTiers({ tiers: {} })).toEqual([]);
  });

  it("drops a row whose cutoff is missing or unparseable — it cannot be placed", () => {
    const tiers = parseVipTiers({
      tiers: {
        vip: [{ cross: "0.0004" }, { ntlCutoff: "abc", cross: "0.0004" }, LIVE_SHAPE.tiers.vip[1]],
      },
    });
    expect(tiers.map((tier) => tier.ntlCutoff)).toEqual(["5000000.0"]);
  });
});

describe("delegator summary", () => {
  const OPEN_BUDGET = {
    tryRun: async (_r: string, fn: () => Promise<unknown>) => fn(),
  } as never;

  it("parses the live wire shape and renames totalPendingWithdrawal", async () => {
    const probe = {
      delegatorSummary: async () => ({
        delegated: "12.5",
        undelegated: "0.5",
        totalPendingWithdrawal: "1.0",
        nPendingWithdrawals: 2,
      }),
    } as never;
    const result = await fetchDelegatorSummary({ probe, user: "0xabc", budget: OPEN_BUDGET });
    expect(result.value).toEqual({
      delegated: "12.5",
      undelegated: "0.5",
      pendingWithdrawal: "1.0",
      pendingWithdrawalCount: 2,
    });
  });

  it("treats the never-staked account's genuine zeros as empty", () => {
    expect(
      stakingIsEmpty({
        delegated: "0.0",
        undelegated: "0.0",
        pendingWithdrawal: "0.0",
        pendingWithdrawalCount: 0,
      })
    ).toBe(true);
  });

  it("is not empty when ANY field is non-zero — including a bare pending count", () => {
    const zeros = {
      delegated: "0.0",
      undelegated: "0.0",
      pendingWithdrawal: "0.0",
      pendingWithdrawalCount: 0,
    };
    expect(stakingIsEmpty({ ...zeros, delegated: "0.1" })).toBe(false);
    expect(stakingIsEmpty({ ...zeros, undelegated: "5" })).toBe(false);
    expect(stakingIsEmpty({ ...zeros, pendingWithdrawalCount: 1 })).toBe(false);
  });
});
