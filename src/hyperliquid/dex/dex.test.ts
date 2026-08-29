import {
  MAIN_DEX,
  parseCollateralToken,
  parseDexUniverse,
  parsePerpDexs,
  referencedMarginTableIds,
  tradeableAssets,
} from "@/hyperliquid/dex/catalog";
import {
  effectiveFeeRate,
  feeMultiplier,
  isBuilderDexCoin,
  splitCoin,
} from "@/hyperliquid/dex/fees";
import {
  FLAT_MARGIN_TABLE_MAX_ID,
  isFlatMarginTable,
  MarginTableCache,
  normaliseMarginTable,
  syntheticMarginTable,
} from "@/hyperliquid/dex/margin";
import {
  isAtOpenInterestCap,
  maxMarketOrderNotional,
  parseCappedCoins,
  parseDexLimits,
  parseMaxMarketOrderNtls,
} from "@/hyperliquid/dex/limits";

describe("parsePerpDexs", () => {
  /** Shaped from the live mainnet response. */
  const LIVE = [
    null,
    { name: "xyz", fullName: "XYZ", deployer: "0x88", deployerFeeScale: "1.0" },
    { name: "hyna", fullName: "HyENA", oracleUpdater: "0xaa", deployerFeeScale: "0.1111" },
  ];

  it("keeps index 0 as the main dex rather than dropping the null", () => {
    // The array index IS the dexIndex in `100000 + dexIndex*10000 + i`, verified
    // against 369 real asset ids. Compacting would shift every one of them.
    const dexes = parsePerpDexs(LIVE);
    expect(dexes[0].name).toBe("");
    expect(dexes[0].index).toBe(0);
    expect(dexes[1].index).toBe(1);
    expect(dexes[2].index).toBe(2);
  });

  it("reads fullName, not full_name", () => {
    // The snake_case spelling is undefined for every dex on both networks.
    expect(parsePerpDexs(LIVE)[1].fullName).toBe("XYZ");
    expect(parsePerpDexs([{ name: "x", full_name: "ignored" }])[0].fullName).toBeNull();
  });

  it("keeps deployerFeeScale per dex, since it is not a constant", () => {
    // 1.0 on xyz but 0.1111 on hyna. Hard-coding 2x overstates hyna by 80%.
    const dexes = parsePerpDexs(LIVE);
    expect(dexes[1].deployerFeeScale).toBe("1.0");
    expect(dexes[2].deployerFeeScale).toBe("0.1111");
    expect(MAIN_DEX.deployerFeeScale).toBeNull();
  });
});

describe("effectiveFeeRate", () => {
  it("applies the referral discount, which is NOT already in the rate", () => {
    expect(
      effectiveFeeRate({
        baseRate: "0.0004275",
        referralDiscount: "0.04",
        deployerFeeScale: null,
        growthMode: undefined,
      })
    ).toBe("0.0004104");
  });

  it("scales by the DEX's own deployerFeeScale, not a constant", () => {
    // xyz (1.0) doubles; hyna (0.1111) multiplies by 1.1111. A client using 2.0
    // everywhere overstates hyna's taker fee by 80%.
    const base = { baseRate: "0.0003", referralDiscount: "0", growthMode: undefined } as const;
    expect(effectiveFeeRate({ ...base, deployerFeeScale: "1.0" })).toBe("0.0006");
    expect(effectiveFeeRate({ ...base, deployerFeeScale: "0.1111" })).toBe("0.00033333");
  });

  it("charges a tenth on a growth-mode asset", () => {
    expect(
      effectiveFeeRate({
        baseRate: "0.0003",
        referralDiscount: "0",
        deployerFeeScale: "1.0",
        growthMode: "enabled",
      })
    ).toBe("0.00006");
  });

  it("gives a maker rebate the protocol multiplier ALONE", () => {
    // The deployer takes a cut of a fee; there is no fee to cut when the user is
    // being paid. Scaling a rebate would overstate it.
    const rebate = effectiveFeeRate({
      baseRate: "-0.00001",
      referralDiscount: "0",
      deployerFeeScale: "1.0",
      growthMode: undefined,
    });
    expect(rebate).toBe("-0.00001");
    expect(Number(rebate)).toBeLessThan(0);
  });

  it("leaves the main dex unscaled", () => {
    expect(
      effectiveFeeRate({
        baseRate: "0.00045",
        referralDiscount: "0",
        deployerFeeScale: null,
        growthMode: undefined,
      })
    ).toBe("0.00045");
  });

  it("exposes the multiplier separately, so a zero rate can still be explained", () => {
    expect(feeMultiplier({ deployerFeeScale: "1.0", growthMode: undefined })).toBe("2");
    expect(feeMultiplier({ deployerFeeScale: "0.1111", growthMode: undefined })).toBe("1.1111");
    expect(feeMultiplier({ deployerFeeScale: "1.0", growthMode: "enabled" })).toBe("0.2");
    expect(feeMultiplier({ deployerFeeScale: "1.0", growthMode: undefined, isRebate: true })).toBe(
      "1"
    );
  });
});

describe("coin qualification", () => {
  it("splits a builder-dex coin", () => {
    expect(splitCoin("hyna:BTC")).toEqual({ dex: "hyna", asset: "BTC" });
    expect(splitCoin("BTC")).toEqual({ dex: null, asset: "BTC" });
    expect(isBuilderDexCoin("hyna:BTC")).toBe(true);
    expect(isBuilderDexCoin("BTC")).toBe(false);
  });
});

describe("parseDexUniverse", () => {
  const UNIVERSE = {
    collateralToken: 235,
    universe: [
      {
        name: "hyna:BTC",
        szDecimals: 5,
        maxLeverage: 40,
        marginTableId: 10,
        growthMode: "enabled",
      },
      { name: "hyna:ETH", szDecimals: 4, maxLeverage: 25, marginTableId: 51, isDelisted: true },
      {
        name: "hyna:SOL",
        szDecimals: 2,
        maxLeverage: 20,
        marginTableId: 20,
        marginMode: "noCross",
      },
    ],
  };

  it("computes asset ids by the verified formula", () => {
    // 100000 + dexIndex*10000 + i, matched against 369 real ids with 0 misses.
    const assets = parseDexUniverse(UNIVERSE, 4);
    expect(assets[0].assetId).toBe(140_000);
    expect(assets[2].assetId).toBe(140_002);
  });

  it("uses a bare index for the main dex", () => {
    expect(parseDexUniverse({ universe: [{ name: "BTC" }] }, 0)[0].assetId).toBe(0);
  });

  it("keeps the coin qualified and exposes the bare symbol", () => {
    const assets = parseDexUniverse(UNIVERSE, 4);
    expect(assets[0].coin).toBe("hyna:BTC");
    expect(assets[0].symbol).toBe("BTC");
  });

  it("treats growthMode as a STRING, never a boolean", () => {
    // The wire sends "enabled" or omits the key. A truthiness check would
    // accept any future value as enabled.
    const assets = parseDexUniverse(UNIVERSE, 4);
    expect(assets[0].growthMode).toBe("enabled");
    expect(assets[1].growthMode).toBeUndefined();
    expect(
      parseDexUniverse({ universe: [{ name: "a:B", growthMode: true }] }, 1)[0].growthMode
    ).toBeUndefined();
  });

  it("filters delisted assets, which are the norm on builder dexs", () => {
    // Five of nine mainnet builder dexs are ENTIRELY delisted, and their assets
    // return empty books while still appearing in meta.
    expect(tradeableAssets(parseDexUniverse(UNIVERSE, 4))).toHaveLength(2);
  });

  it("reads the dex's own collateral token, which is often not USDC", () => {
    // USDH, USDE and USDT0 on mainnet; non-stablecoins on testnet.
    expect(parseCollateralToken(UNIVERSE)).toBe(235);
    expect(parseCollateralToken({})).toBe(0);
  });

  it("collects the margin-table ids the universe refers to", () => {
    expect(referencedMarginTableIds(parseDexUniverse(UNIVERSE, 4))).toEqual([10, 20, 51]);
  });
});

describe("margin tables", () => {
  it("answers low ids locally, with id === maxLeverage", () => {
    // Verified for ids 1,3,5,10,12,20,25,30,40,50 — each one tier, lowerBound
    // "0.0", empty description. Fetching them is a wasted request per asset.
    expect(isFlatMarginTable(10)).toBe(true);
    expect(isFlatMarginTable(FLAT_MARGIN_TABLE_MAX_ID)).toBe(true);
    expect(isFlatMarginTable(51)).toBe(false);

    const table = syntheticMarginTable(20);
    expect(table.tiers).toEqual([{ lowerBound: "0.0", maxLeverage: 20 }]);
    expect(table.synthetic).toBe(true);
  });

  it("sorts a fetched table defensively", () => {
    // findMarginTier does a reverse scan and does NOT sort; the docs never
    // promise the ordering, so a violation would silently pick the wrong tier.
    const table = normaliseMarginTable(51, {
      description: "tiered 10x",
      marginTiers: [
        { lowerBound: "3000000.0", maxLeverage: 5 },
        { lowerBound: "0.0", maxLeverage: 10 },
      ],
    });
    expect(table.tiers.map((t) => t.lowerBound)).toEqual(["0.0", "3000000.0"]);
    expect(table.synthetic).toBe(false);
  });

  it("drops malformed tiers rather than fabricating them", () => {
    const table = normaliseMarginTable(51, {
      marginTiers: [{ lowerBound: "0.0", maxLeverage: 10 }, { lowerBound: 5 }, null],
    });
    expect(table.tiers).toHaveLength(1);
  });

  describe("MarginTableCache", () => {
    it("resolves flat ids without a fetch and remembers fetched ones", () => {
      const cache = new MarginTableCache();
      expect(cache.get(10)?.tiers[0].maxLeverage).toBe(10);
      expect(cache.get(51)).toBeNull();

      cache.set(
        normaliseMarginTable(51, { marginTiers: [{ lowerBound: "0.0", maxLeverage: 10 }] })
      );
      expect(cache.get(51)?.tiers).toHaveLength(1);
    });

    it("reports only the ids that genuinely need a request", () => {
      // A builder dex's universe references ids its own marginTables array does
      // not carry, so without this every asset row triggers a fetch.
      const cache = new MarginTableCache();
      expect(cache.missing([3, 10, 20, 51, 55])).toEqual([51, 55]);
    });
  });
});

describe("dex limits", () => {
  it("returns null for the main dex, as the endpoint does", () => {
    expect(parseDexLimits(null)).toBeNull();
  });

  it("keys OI caps by the fully-qualified coin", () => {
    const limits = parseDexLimits({
      totalOiCap: "10000000000.0",
      oiSzCapPerPerp: "20000000000.0",
      maxTransferNtl: "3000000000.0",
      coinToOiCap: [["xyz:AAPL", "150000000.0"]],
    });
    expect(limits?.coinToOiCap.get("xyz:AAPL")).toBe("150000000.0");
    expect(limits?.totalOiCap).toBe("10000000000.0");
  });

  it("treats the capped-coin list as the real order-rejecting signal", () => {
    // perpDexStatus returns only totalNetDeposit and gates nothing; this is the
    // only live indicator that an order would be refused for capacity.
    const capped = parseCappedCoins(["hyna:BTC"]);
    expect(isAtOpenInterestCap(capped, "hyna:BTC")).toBe(true);
    expect(isAtOpenInterestCap(capped, "hyna:ETH")).toBe(false);
    expect(parseCappedCoins([]).size).toBe(0);
  });
});

describe("maxMarketOrderNotional", () => {
  // Live mainnet shape: global, keyed by maxLeverage, only a few entries.
  const TABLE = parseMaxMarketOrderNtls([
    [25, "30000000.0"],
    [20, "5000000.0"],
    [10, "2000000.0"],
    [5, "1000000.0"],
  ]);

  it("returns an exact match when the leverage is tabulated", () => {
    expect(maxMarketOrderNotional(TABLE, 20)).toEqual({ notional: "5000000.0", exact: true });
  });

  it("falls back to the next LOWER tier for an untabulated leverage", () => {
    // Builder-dex assets carry leverage up to 50, which has no entry. Returning
    // null would invite a caller to read "unknown" as "unlimited".
    expect(maxMarketOrderNotional(TABLE, 50)).toEqual({ notional: "30000000.0", exact: false });
    expect(maxMarketOrderNotional(TABLE, 12)).toEqual({ notional: "2000000.0", exact: false });
  });

  it("takes the smallest tier when every entry is above the asset's leverage", () => {
    expect(maxMarketOrderNotional(TABLE, 3)).toEqual({ notional: "1000000.0", exact: false });
  });

  it("returns null only for an empty table", () => {
    expect(maxMarketOrderNotional([], 10)).toBeNull();
  });
});
