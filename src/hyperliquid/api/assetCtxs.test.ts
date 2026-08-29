import {
  fetchPerpCtxs,
  fetchSpotCtxs,
  parsePerpCtxs,
  parseSpotCtxs,
  type PerpCtxsProbe,
  type SpotCtxsProbe,
} from "@/hyperliquid/api/assetCtxs";
import { WeightBudget, REQUEST_WEIGHTS } from "@/hyperliquid/api/weightBudget";
import { HlError } from "@/hyperliquid/core/errors";

const NOW = 1_800_000_000_000;

/** A perp ctx with only the fields downstream consumes populated meaningfully. */
function perpCtx(markPx: string) {
  return {
    markPx,
    midPx: null,
    prevDayPx: "1",
    dayNtlVlm: "0.0",
    funding: "0.0000125",
    openInterest: "10",
    premium: null,
    oraclePx: markPx,
    impactPxs: null,
    dayBaseVlm: "0.0",
  };
}

function perpTuple(universeNames: string[], ctxCount: number): unknown {
  return [
    {
      universe: universeNames.map((name) => ({ name, szDecimals: 3, maxLeverage: 40 })),
      marginTables: [],
    },
    Array.from({ length: ctxCount }, (_, i) => perpCtx(String(100 + i))),
  ];
}

function spotCtx(coin: string) {
  return {
    coin,
    markPx: "1.5",
    midPx: null,
    prevDayPx: "1.4",
    dayNtlVlm: "12.0",
    circulatingSupply: "1000",
    totalSupply: "1000",
    dayBaseVlm: "8.0",
  };
}

/**
 * The measured spot reality in miniature: 1 universe row, 3 ctxs — a pair, a
 * `#N` prediction side, and a ctx for a pair beyond the universe slice.
 */
function spotTuple(): unknown {
  return [
    {
      universe: [{ name: "@1", tokens: [1, 0], index: 1, isCanonical: false }],
      tokens: [
        { name: "USDC", index: 0, szDecimals: 8 },
        { name: "PURR", index: 1, szDecimals: 0 },
      ],
    },
    [spotCtx("@1"), spotCtx("#102380"), spotCtx("@999")],
  ];
}

function perpProbe(raw: unknown): { probe: PerpCtxsProbe; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    probe: {
      metaAndAssetCtxs: async () => {
        calls += 1;
        return raw;
      },
    },
  };
}

function spotProbe(raw: unknown): { probe: SpotCtxsProbe; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    probe: {
      spotMetaAndAssetCtxs: async () => {
        calls += 1;
        return raw;
      },
    },
  };
}

/** A budget stub that records which request key each call charged. */
function recordingBudget(): { budget: WeightBudget; charged: string[] } {
  const charged: string[] = [];
  const budget = {
    tryRun: async <T>(request: string, operation: () => Promise<T>): Promise<T | null> => {
      charged.push(request);
      return operation();
    },
  } as unknown as WeightBudget;
  return { budget, charged };
}

describe("parsePerpCtxs", () => {
  it("accepts an index-aligned tuple and returns it untouched", () => {
    const raw = perpTuple(["BTC", "ETH"], 2);
    // Same reference out: the response is large and must not be copied per parse.
    expect(parsePerpCtxs(raw)).toBe(raw);
  });

  it("throws HlError validation_error on a universe/ctxs length mismatch", () => {
    // With no key on the ctx side, a zip-short join would dress every market
    // after the gap in its neighbour's prices — the response must be refused.
    expect(() => parsePerpCtxs(perpTuple(["BTC", "ETH", "SOL"], 2))).toThrow(HlError);
    try {
      parsePerpCtxs(perpTuple(["BTC", "ETH", "SOL"], 2));
      throw new Error("did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HlError);
      expect((error as HlError).code).toBe("validation_error");
    }
  });

  it("throws validation_error when the response is not a tuple", () => {
    for (const raw of [null, undefined, 42, "nope", {}, [1]]) {
      try {
        parsePerpCtxs(raw);
        throw new Error(`did not throw for ${String(raw)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(HlError);
        expect((error as HlError).code).toBe("validation_error");
      }
    }
  });

  it("throws validation_error when meta has no universe array", () => {
    try {
      parsePerpCtxs([{ marginTables: [] }, []]);
      throw new Error("did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HlError);
      expect((error as HlError).code).toBe("validation_error");
    }
  });
});

describe("parseSpotCtxs", () => {
  it("accepts unequal universe/ctxs lengths — the measured live shape", () => {
    // 1,309 universe rows vs 2,492 ctxs on testnet: equality would reject
    // every valid response the endpoint has ever produced.
    const raw = spotTuple();
    expect(parseSpotCtxs(raw)).toBe(raw);
  });

  it("passes the ctxs through raw, prediction sides included", () => {
    const parsed = parseSpotCtxs(spotTuple());
    const coins = parsed[1].map((ctx) => (ctx as { coin: string }).coin);
    expect(coins).toEqual(["@1", "#102380", "@999"]);
  });

  it("throws validation_error when meta is missing universe or tokens", () => {
    for (const meta of [{ tokens: [] }, { universe: [] }, {}]) {
      try {
        parseSpotCtxs([meta, []]);
        throw new Error("did not throw");
      } catch (error) {
        expect(error).toBeInstanceOf(HlError);
        expect((error as HlError).code).toBe("validation_error");
      }
    }
  });
});

describe("fetchPerpCtxs", () => {
  it("returns the validated tuple with deferred false", async () => {
    const raw = perpTuple(["BTC"], 1);
    const { probe } = perpProbe(raw);
    const result = await fetchPerpCtxs({ probe, budget: new WeightBudget(), now: () => NOW });
    expect(result.deferred).toBe(false);
    expect(result.value).toBe(raw);
  });

  it("charges the metaAndAssetCtxs key — not a cheaper neighbour", async () => {
    // The exact bug candles.ts shipped with: charging l2Book's 2 for a
    // 20-weight request undercounts 10× and the budget stops guarding.
    const { probe } = perpProbe(perpTuple(["BTC"], 1));
    const { budget, charged } = recordingBudget();
    await fetchPerpCtxs({ probe, budget });
    expect(charged).toEqual(["metaAndAssetCtxs"]);
  });

  it("spends the documented 20 weight against a real budget", async () => {
    const { probe } = perpProbe(perpTuple(["BTC"], 1));
    const budget = new WeightBudget();
    await fetchPerpCtxs({ probe, budget, now: () => NOW });
    expect(budget.used(NOW)).toBe(REQUEST_WEIGHTS.metaAndAssetCtxs);
  });

  it("defers without calling the probe when the budget refuses", async () => {
    const { probe, calls } = perpProbe(perpTuple(["BTC"], 1));
    const budget = new WeightBudget(10); // smaller than the request's 20
    const result = await fetchPerpCtxs({ probe, budget, now: () => NOW });
    // `deferred: true` with a null value — NOT an empty market list.
    expect(result).toEqual({ value: null, deferred: true });
    expect(calls()).toBe(0);
  });

  it("propagates the length-mismatch throw instead of returning partial data", async () => {
    const { probe } = perpProbe(perpTuple(["BTC", "ETH"], 1));
    await expect(
      fetchPerpCtxs({ probe, budget: new WeightBudget(), now: () => NOW })
    ).rejects.toThrow(HlError);
  });
});

describe("fetchSpotCtxs", () => {
  it("returns the tuple with deferred false, unequal lengths and all", async () => {
    const raw = spotTuple();
    const { probe } = spotProbe(raw);
    const result = await fetchSpotCtxs({ probe, budget: new WeightBudget(), now: () => NOW });
    expect(result.deferred).toBe(false);
    expect(result.value).toBe(raw);
  });

  it("charges the spotMetaAndAssetCtxs key", async () => {
    const { probe } = spotProbe(spotTuple());
    const { budget, charged } = recordingBudget();
    await fetchSpotCtxs({ probe, budget });
    expect(charged).toEqual(["spotMetaAndAssetCtxs"]);
  });

  it("defers without calling the probe when the budget refuses", async () => {
    const { probe, calls } = spotProbe(spotTuple());
    const budget = new WeightBudget(10);
    const result = await fetchSpotCtxs({ probe, budget, now: () => NOW });
    expect(result).toEqual({ value: null, deferred: true });
    expect(calls()).toBe(0);
  });
});
