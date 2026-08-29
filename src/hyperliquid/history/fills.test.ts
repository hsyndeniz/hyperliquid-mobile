/**
 * The walk's three rules, each of which fails silently if broken:
 *
 * - pages advance with `startTime = lastRowTime` and dedupe by `key`, because
 *   `+1` loses a same-millisecond fill at every boundary;
 * - a short page ends the walk as `complete: true` — the endpoint's only
 *   end-of-history signal;
 * - a refused page or a capped walk returns what was collected as
 *   `complete: false`, never as a full history.
 */

import { fetchFillHistory, type FillHistoryProbe } from "@/hyperliquid/history/fills";
import type { WeightBudget } from "@/hyperliquid/api/weightBudget";

/** A budget that admits everything — the walk under test, not the budget. */
const OPEN_BUDGET = {
  tryRun: async <T>(_request: string, fn: () => Promise<T>): Promise<T | null> => fn(),
} as unknown as WeightBudget;

/** A wire-shaped fill row; only the fields the parser requires. */
function wireFill(overrides: { oid: number; tid: number; time: number; coin?: string }): object {
  return {
    coin: overrides.coin ?? "BTC",
    px: "63645.0",
    sz: "0.00024",
    side: "B",
    time: overrides.time,
    startPosition: "0.0",
    dir: "Open Long",
    closedPnl: "0.0",
    hash: "0x2a267083e834eda12ba00426ce2a2a010100886983380c73cdef1bd6a738c78b",
    oid: overrides.oid,
    crossed: true,
    fee: "0.006873",
    tid: overrides.tid,
    feeToken: "USDC",
  };
}

/** A probe that serves pre-cut pages keyed by requested startTime. */
function pagedProbe(pages: Map<number, object[]>): FillHistoryProbe & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    userFillsByTime: async ({ startTime }) => {
      calls.push(startTime);
      return pages.get(startTime) ?? [];
    },
  };
}

describe("fetchFillHistory", () => {
  it("returns a single short page as the complete history", async () => {
    const probe = pagedProbe(
      new Map([
        [0, [wireFill({ oid: 1, tid: 10, time: 100 }), wireFill({ oid: 2, tid: 20, time: 200 })]],
      ])
    );
    const result = await fetchFillHistory({ probe, user: "0xabc", budget: OPEN_BUDGET });
    expect(result.complete).toBe(true);
    expect(result.fills.map((fill) => fill.tid)).toEqual([10, 20]);
    expect(probe.calls).toEqual([0]);
  });

  it("walks full pages from the LAST row's time and dedupes the boundary row", async () => {
    // A "full" page per the real cap is 2000 rows; build one whose last two
    // rows share a millisecond, so a naive `time + 1` advance would lose one.
    const fullPage = Array.from({ length: 1999 }, (_, i) =>
      wireFill({ oid: i, tid: i, time: 1000 + i })
    );
    fullPage.push(wireFill({ oid: 5000, tid: 5000, time: 2998 })); // same ms as row 1998
    const secondPage = [
      wireFill({ oid: 1998, tid: 1998, time: 2998 }), // boundary row, re-fetched
      wireFill({ oid: 5000, tid: 5000, time: 2998 }), // boundary row, re-fetched
      wireFill({ oid: 6000, tid: 6000, time: 3500 }),
    ];
    const probe = pagedProbe(
      new Map<number, object[]>([
        [0, fullPage],
        [2998, secondPage],
      ])
    );

    const result = await fetchFillHistory({ probe, user: "0xabc", budget: OPEN_BUDGET });
    expect(probe.calls).toEqual([0, 2998]);
    expect(result.complete).toBe(true);
    // 2000 distinct from page one + 1 new from page two; boundary rows once.
    expect(result.fills).toHaveLength(2001);
    expect(result.fills.filter((fill) => fill.tid === 5000)).toHaveLength(1);
    expect(result.fills.at(-1)?.tid).toBe(6000);
  });

  it("returns a disclosed partial when the budget refuses a page", async () => {
    const fullPage = Array.from({ length: 2000 }, (_, i) =>
      wireFill({ oid: i, tid: i, time: 1000 + i })
    );
    const probe = pagedProbe(new Map<number, object[]>([[0, fullPage]]));
    // Admit exactly one call, refuse the rest.
    let admitted = 0;
    const stingy = {
      tryRun: async <T>(_request: string, fn: () => Promise<T>): Promise<T | null> => {
        admitted += 1;
        return admitted === 1 ? fn() : null;
      },
    } as unknown as WeightBudget;

    const result = await fetchFillHistory({ probe, user: "0xabc", budget: stingy });
    expect(result.complete).toBe(false);
    expect(result.fills).toHaveLength(2000);
  });

  it("caps a runaway walk and says so", async () => {
    // Every page is full and advances by one ms — an endless history.
    const probe: FillHistoryProbe & { calls: number[] } = {
      calls: [],
      userFillsByTime: async ({ startTime }) => {
        probe.calls.push(startTime);
        return Array.from({ length: 2000 }, (_, i) =>
          wireFill({ oid: startTime + i + 1, tid: startTime + i + 1, time: startTime + i + 1 })
        );
      },
    };
    const result = await fetchFillHistory({ probe, user: "0xabc", budget: OPEN_BUDGET });
    expect(result.complete).toBe(false);
    expect(probe.calls).toHaveLength(20);
  });
});
