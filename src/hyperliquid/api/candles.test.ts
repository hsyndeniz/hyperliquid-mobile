import {
  MAX_CANDLES_PER_REQUEST,
  fetchCandles,
  mergeCandles,
  previousPageEnd,
  toCandle,
  type CandleProbe,
} from "@/hyperliquid/api/candles";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";
import type { Candle } from "@/hyperliquid/types/domain";
import type { ICandle } from "@/hyperliquid/types/sdk";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

/** A wire row, in the single letters the API actually sends. */
function row(t: number, overrides: Partial<ICandle> = {}): ICandle {
  return {
    t,
    T: t + MINUTE - 1,
    s: "BTC",
    i: "1m",
    o: "100",
    c: "105",
    h: "110",
    l: "90",
    v: "1.5",
    n: 42,
    ...overrides,
  } as ICandle;
}

function probeReturning(rows: ICandle[]): { probe: CandleProbe; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    probe: {
      candleSnapshot: async (params) => {
        calls.push(params);
        return rows;
      },
    },
  };
}

describe("toCandle", () => {
  it("maps every wire letter to its named field", () => {
    // `o` and `c` differ by one character and swapping them inverts every
    // candle on the chart, which is the whole reason this mapping is central.
    expect(toCandle(row(0))).toEqual({
      openTime: 0,
      closeTime: MINUTE - 1,
      interval: "1m",
      coin: "BTC",
      open: "100",
      high: "110",
      low: "90",
      close: "105",
      volume: "1.5",
      trades: 42,
    } satisfies Candle);
  });

  it("keeps prices as strings", () => {
    const candle = toCandle(row(0, { o: "0.000012345" }));
    expect(candle.open).toBe("0.000012345");
    expect(typeof candle.open).toBe("string");
  });

  it("takes the interval from the row, not from the request", () => {
    expect(toCandle(row(0, { i: "1h" })).interval).toBe("1h");
  });
});

describe("fetchCandles", () => {
  it("anchors startTime on the bucket grid so the response is not short by one", async () => {
    const { probe, calls } = probeReturning([row(0)]);

    await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      count: 10,
      endTime: NOW,
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(calls[0]).toEqual({
      coin: "BTC",
      interval: "1m",
      // Ten full widths below the current bucket's open. Measuring from `endTime`
      // itself yields nine rows, not ten: the range covers a partial bucket at
      // each end, and the top one is the forming bar, which the API never returns.
      startTime: NOW - 10 * MINUTE,
      endTime: NOW,
    });
  });

  it("returns candles ascending even if the API does not", async () => {
    const { probe } = probeReturning([row(2 * MINUTE), row(0), row(MINUTE)]);

    const history = await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(history.candles.map((c) => c.openTime)).toEqual([0, MINUTE, 2 * MINUTE]);
  });

  // The live API returns closed buckets only — verified with an `endTime` an hour
  // in the future. This guard exists so a change to that behaviour is detected.
  it("would flag a last row whose close time has not passed", async () => {
    const openNow = NOW - 30_000;
    const { probe } = probeReturning([row(openNow - MINUTE), row(openNow)]);

    const history = await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(history.hasFormingBar).toBe(true);
  });

  it("does not flag a forming bar when the range ends on a closed bucket", async () => {
    const { probe } = probeReturning([row(NOW - 10 * MINUTE)]);

    const history = await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      endTime: NOW - 9 * MINUTE,
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(history.hasFormingBar).toBe(false);
  });

  it("reports no forming bar for a snapshot of closed buckets — the normal case", async () => {
    const { probe } = probeReturning([row(NOW - 3 * MINUTE), row(NOW - 2 * MINUTE)]);

    const history = await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(history.hasFormingBar).toBe(false);
    expect(history.candles).toHaveLength(2);
  });

  it("handles an empty response without claiming a forming bar", async () => {
    const { probe } = probeReturning([]);

    const history = await fetchCandles({
      probe,
      coin: "NEWCOIN",
      interval: "1m",
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(history).toEqual({ candles: [], hasFormingBar: false, deferred: false });
  });

  it("clamps count to the per-request cap the API silently enforces", async () => {
    const { probe, calls } = probeReturning([row(0)]);

    await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      count: 50_000,
      endTime: NOW,
      budget: new WeightBudget(),
      now: () => NOW,
    });

    const { startTime } = calls[0] as { startTime: number };
    expect((NOW - startTime) / MINUTE).toBe(MAX_CANDLES_PER_REQUEST);
  });

  it("defers instead of firing when the per-IP weight budget is exhausted", async () => {
    // A phone behind carrier NAT shares the budget with strangers, so refusing
    // is a real outcome — and the caller, not this module, decides what to do.
    const budget = new WeightBudget();
    budget.spend(1_200, NOW);
    let called = false;
    const probe: CandleProbe = {
      candleSnapshot: async () => {
        called = true;
        return [];
      },
    };

    const history = await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      budget,
      now: () => NOW,
    });

    expect(history.deferred).toBe(true);
    expect(history.candles).toEqual([]);
    expect(called).toBe(false);
  });

  it("charges the budget for a request that goes through", async () => {
    const budget = new WeightBudget();
    const { probe } = probeReturning([row(0)]);

    await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      count: 500,
      budget,
      now: () => NOW,
    });

    expect(budget.used(NOW)).toBeGreaterThan(0);
  });

  it("rejects an interval it has no width for", async () => {
    const { probe } = probeReturning([]);

    await expect(
      fetchCandles({
        probe,
        coin: "BTC",
        // Only reachable via a cast, which is exactly when a silent NaN range hurts.
        interval: "2w" as never,
        budget: new WeightBudget(),
        now: () => NOW,
      })
    ).rejects.toThrow(/Unknown candle interval/);
  });
});

describe("facts verified against live testnet", () => {
  it("accepts a zero-trade bucket as real data, not a defect", async () => {
    // Measured: 21-40 rows in a 200-500 bar window had n === 0. Such a bar
    // carries the previous close on all four prices; dropping it would put a
    // hole in the series and shift every index-based bar after it.
    const { probe } = probeReturning([
      row(NOW - 3 * MINUTE, { n: 0, o: "100", h: "100", l: "100", c: "100", v: "0" }),
      row(NOW - 2 * MINUTE),
    ]);

    const history = await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(history.candles).toHaveLength(2);
    expect(history.candles[0]).toMatchObject({ trades: 0, open: "100", close: "100" });
  });

  it("does not assume the tail is contiguous", async () => {
    // A bucket with no trades gets no candle until it is backfilled, so a hole
    // near the tail is normal. Nothing here may renumber or fill it.
    const { probe } = probeReturning([
      row(NOW - 4 * MINUTE),
      // NOW - 3m is missing: quiet bucket, not yet backfilled.
      row(NOW - 2 * MINUTE),
    ]);

    const history = await fetchCandles({
      probe,
      coin: "BTC",
      interval: "1m",
      budget: new WeightBudget(),
      now: () => NOW,
    });

    expect(history.candles.map((c) => c.openTime)).toEqual([NOW - 4 * MINUTE, NOW - 2 * MINUTE]);
  });

  it("upserts a bucket that a later fetch fills in", async () => {
    // The direct consequence of the hole above: a refetch must be merged, since
    // a bucket absent from the first response can exist in the second.
    const first = [row(NOW - 4 * MINUTE), row(NOW - 2 * MINUTE)].map(toCandle);
    const backfilled = [
      row(NOW - 4 * MINUTE),
      row(NOW - 3 * MINUTE, { n: 0 }),
      row(NOW - 2 * MINUTE),
    ].map(toCandle);

    const merged = mergeCandles(first, backfilled);

    expect(merged.map((c) => c.openTime)).toEqual([
      NOW - 4 * MINUTE,
      NOW - 3 * MINUTE,
      NOW - 2 * MINUTE,
    ]);
  });
});

describe("paging backwards", () => {
  it("ends the previous page one millisecond before the oldest bucket opens", () => {
    // Passing `openTime` itself re-returns that bucket — the range is inclusive
    // at both ends — so a pager using it either loops or duplicates a bar.
    expect(previousPageEnd(toCandle(row(5 * MINUTE)))).toBe(5 * MINUTE - 1);
  });

  it("merges pages without duplicating the overlap", () => {
    const older = [row(0), row(MINUTE)].map(toCandle);
    const newer = [row(MINUTE), row(2 * MINUTE)].map(toCandle);

    const merged = mergeCandles(older, newer);

    expect(merged.map((c) => c.openTime)).toEqual([0, MINUTE, 2 * MINUTE]);
  });

  it("lets the later fetch win, since it is the more complete view of that bucket", () => {
    const held = [toCandle(row(0, { c: "100", v: "1" }))];
    const incoming = [toCandle(row(0, { c: "150", v: "9" }))];

    expect(mergeCandles(held, incoming)[0]).toMatchObject({ close: "150", volume: "9" });
  });

  it("keeps ascending order when an older page is merged in", () => {
    const held = [row(10 * MINUTE), row(11 * MINUTE)].map(toCandle);
    const olderPage = [row(0), row(MINUTE)].map(toCandle);

    expect(mergeCandles(held, olderPage).map((c) => c.openTime)).toEqual([
      0,
      MINUTE,
      10 * MINUTE,
      11 * MINUTE,
    ]);
  });

  it("returns the incoming page verbatim when nothing is held", () => {
    const page = [row(0)].map(toCandle);
    expect(mergeCandles([], page)).toEqual(page);
  });
});
