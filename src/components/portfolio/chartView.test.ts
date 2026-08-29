/**
 * The chart's pure decisions.
 *
 * `periodKey` is pinned to all eight wire spellings because the perp keys are
 * camel-cased (`perpAllTime`) — a naive concatenation produces `perpallTime`,
 * a key the endpoint never returns, and the chart would render "not enough
 * history" for an account with months of it.
 *
 * `maxDrawdown` is pinned on the null-vs-zero boundary: null means "not
 * computable" (one point, all-zero series) and `"0"` means "measured, and it
 * never fell" — collapsing the two would show 0% for charts nobody measured.
 */

import {
  drawdownPercent,
  maxDrawdown,
  periodKey,
  pnlStats,
  seriesBounds,
} from "@/components/portfolio/chartView";

describe("periodKey", () => {
  it("maps every scope+period pair to its exact wire key", () => {
    expect(periodKey("all", "day")).toBe("day");
    expect(periodKey("all", "week")).toBe("week");
    expect(periodKey("all", "month")).toBe("month");
    expect(periodKey("all", "allTime")).toBe("allTime");
    expect(periodKey("perp", "day")).toBe("perpDay");
    expect(periodKey("perp", "week")).toBe("perpWeek");
    expect(periodKey("perp", "month")).toBe("perpMonth");
    expect(periodKey("perp", "allTime")).toBe("perpAllTime");
  });
});

describe("maxDrawdown", () => {
  it("is null for an empty series", () => {
    expect(maxDrawdown([])).toBeNull();
  });

  it("is null for a single point — one number has no drawdown", () => {
    expect(maxDrawdown([[1, "100"]])).toBeNull();
  });

  it("is null when no positive peak exists — a zero peak has no ratio", () => {
    expect(
      maxDrawdown([
        [1, "0"],
        [2, "0"],
        [3, "0"],
      ])
    ).toBeNull();
  });

  it("is the string zero for a monotonic rise — measured, never fell", () => {
    expect(
      maxDrawdown([
        [1, "100"],
        [2, "150"],
        [3, "200"],
      ])
    ).toBe("0");
  });

  it("finds the deepest peak-to-trough decline, not the last one", () => {
    // Peak 120 → trough 60 is 50%; the later 110 → 90 dip is shallower and
    // must not overwrite it.
    expect(
      maxDrawdown([
        [1, "100"],
        [2, "120"],
        [3, "60"],
        [4, "110"],
        [5, "90"],
      ])
    ).toBe("0.5");
  });

  it("measures each decline against the highest peak so far", () => {
    // After the 200 peak, a fall to 150 is 25% even though 150 is above every
    // earlier value.
    expect(
      maxDrawdown([
        [1, "100"],
        [2, "200"],
        [3, "150"],
      ])
    ).toBe("0.25");
  });

  it("stays exact where floats would leave dust", () => {
    // (0.3 − 0.1) / 0.3 in doubles is 0.66666666666666674…; BigNumber's
    // 20-place division is the exact repeating decimal, rounded once.
    expect(
      maxDrawdown([
        [1, "0.3"],
        [2, "0.1"],
      ])
    ).toBe("0.66666666666666666667");
  });

  it("skips malformed values instead of poisoning the walk", () => {
    expect(
      maxDrawdown([
        [1, "100"],
        [2, "not-a-number"],
        [3, "50"],
      ])
    ).toBe("0.5");
  });
});

describe("drawdownPercent", () => {
  it("renders a fraction as a signed two-place percent", () => {
    expect(drawdownPercent("0.1816")).toBe("-18.16%");
    expect(drawdownPercent("0.5")).toBe("-50.00%");
  });

  it("renders a genuine zero unsigned", () => {
    expect(drawdownPercent("0")).toBe("0.00%");
  });

  it("renders a malformed fraction as dashes, never a number", () => {
    expect(drawdownPercent("abc")).toBe("--");
  });
});

describe("pnlStats", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("is null under two finite points — nothing to measure", () => {
    expect(pnlStats([])).toBeNull();
    expect(pnlStats([[0, "1"]])).toBeNull();
    expect(
      pnlStats([
        [0, "abc"],
        [1, "junk"],
      ])
    ).toBeNull();
  });

  it("reports the window change as last minus first", () => {
    const stats = pnlStats([
      [0, "1.00"],
      [1000, "0.25"],
    ]);
    expect(stats?.change).toBe("-0.75");
  });

  it("has no best/worst day inside a single UTC day — one day has no day-over-day delta", () => {
    const stats = pnlStats([
      [0, "0"],
      [1000, "5"],
    ]);
    expect(stats?.bestDay).toBeNull();
    expect(stats?.worstDay).toBeNull();
  });

  it("measures day deltas close-to-close, keeping the best and worst apart", () => {
    const stats = pnlStats([
      [0, "0"], // day 0 close: 0
      [DAY, "3"], // day 1 close: 3  (+3, best)
      [2 * DAY, "1"], // day 2 close: 1  (-2, worst)
      [2 * DAY + 1, "1.5"], // still day 2; close moves to 1.5 (-1.5, worst)
    ]);
    expect(stats?.change).toBe("1.50");
    expect(stats?.bestDay).toBe("3.00");
    expect(stats?.worstDay).toBe("-1.50");
  });
});

describe("seriesBounds", () => {
  it("finds the extremes and the ends independently", () => {
    // `first`/`last` are positional and `high`/`low` are ordinal — a window
    // that ends below where it started must still report the peak it reached.
    expect(
      seriesBounds([
        [0, "100"],
        [1, "140"],
        [2, "90"],
        [3, "120"],
      ])
    ).toEqual({ high: "140", low: "90", first: "100", last: "120" });
  });

  it("returns the ORIGINAL strings, not a re-rendered number", () => {
    // The trailing zero survives: the caller's formatter decides the digits,
    // and restating "63000.10" as "63000.1" here is the clipping bug that
    // already cost FlashPrice a fix.
    const bounds = seriesBounds([
      [0, "63000.10"],
      [1, "63000.20"],
    ]);
    expect(bounds?.low).toBe("63000.10");
    expect(bounds?.high).toBe("63000.20");
  });

  it("compares as numbers, not lexically", () => {
    // "9" > "100" as strings; the whole point of BigNumber comparison here.
    expect(
      seriesBounds([
        [0, "9"],
        [1, "100"],
      ])
    ).toEqual({ high: "100", low: "9", first: "9", last: "100" });
  });

  it("is null under two readings — one reading is not a range", () => {
    expect(seriesBounds([])).toBeNull();
    expect(seriesBounds([[0, "5"]])).toBeNull();
    // Two entries but only one usable: the survivor twice would read as a
    // measured range and is not one.
    expect(
      seriesBounds([
        [0, "5"],
        [1, "oops"],
      ])
    ).toBeNull();
  });

  it("skips a bad reading but keeps the window when enough survive", () => {
    // Unlike a sparkline's shape, these are four independent readings — the
    // survivors are each still true.
    expect(
      seriesBounds([
        [0, "10"],
        [1, "not-a-number"],
        [2, "30"],
      ])
    ).toEqual({ high: "30", low: "10", first: "10", last: "30" });
  });

  it("handles a negative P&L window", () => {
    expect(
      seriesBounds([
        [0, "-5"],
        [1, "-20"],
        [2, "-1"],
      ])
    ).toEqual({ high: "-1", low: "-20", first: "-5", last: "-1" });
  });
});
