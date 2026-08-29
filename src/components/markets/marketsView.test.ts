/**
 * The market list's formatting rules, pinned.
 *
 * Three of these are null-honesty pins: a null 24h change, probability, or
 * points-move renders as `"--"`, never as a zero the wire did not send —
 * 55/210 perp ctxs genuinely arrive without a mid, and a fresh listing has no
 * previous day.
 *
 * `decimalsOf` is pinned to the WIRE STRING's own shape (`"63645.0"` → 1):
 * deriving digits from the parsed number strips the trailing zero and makes
 * NumberFlow's digit count jump at round numbers.
 *
 * `flashDirection` is pinned to BigNumber comparison and to silence on first
 * render — a mount-time flash claims a move nobody saw, and a string compare
 * would flash on a re-spelling (`"1.0"` → `"1"`) of the same price.
 */

import {
  changeTrend,
  decimalsOf,
  flashDirection,
  formatChangePct,
  formatCompactUsd,
  formatProbabilityChangePts,
  kindOfWireCoin,
  probabilityPct,
  rowMetric,
  selectHighlights,
  summarizeMarkets,
} from "@/components/markets/marketsView";
import type { MarketRow } from "@/hyperliquid/markets/rows";

/** A perp-shaped row; each test overrides only the fields it is about. */
const marketRow = (overrides: Partial<MarketRow> & { symbol: string }): MarketRow => ({
  kind: "perp",
  wireCoin: overrides.symbol,
  px: "100",
  markPx: "100",
  midPx: "100",
  prevDayPx: "100",
  dayNtlVlm: "0.0",
  funding: null,
  openInterest: null,
  maxLeverage: null,
  szDecimals: 0,
  isDelisted: false,
  sideName: null,
  ...overrides,
});

describe("formatChangePct", () => {
  it("signs a gain explicitly and fixes two places", () => {
    expect(formatChangePct("2.33")).toBe("+2.33%");
    expect(formatChangePct("0.1")).toBe("+0.10%");
  });

  it("keeps the wire's own minus and fixes two places", () => {
    expect(formatChangePct("-1.5")).toBe("-1.50%");
  });

  it("renders a genuine zero unsigned — no direction to claim", () => {
    expect(formatChangePct("0")).toBe("0.00%");
  });

  it("renders null as dashes, never a fake flat", () => {
    expect(formatChangePct(null)).toBe("--");
  });

  it("renders malformed input as dashes, never a number", () => {
    expect(formatChangePct("abc")).toBe("--");
    expect(formatChangePct("")).toBe("--");
  });
});

describe("probabilityPct", () => {
  it("renders a share price as a one-decimal percent", () => {
    expect(probabilityPct("0.624")).toBe("62.4%");
    expect(probabilityPct("0.5")).toBe("50.0%");
  });

  it("rounds the wire's five decimals to one", () => {
    expect(probabilityPct("0.99283")).toBe("99.3%");
  });

  it("renders null as dashes — an unknown probability is not 0%", () => {
    expect(probabilityPct(null)).toBe("--");
  });

  it("renders malformed input as dashes", () => {
    expect(probabilityPct("abc")).toBe("--");
  });
});

describe("formatProbabilityChangePts", () => {
  it("states the move in points, signed", () => {
    expect(formatProbabilityChangePts("0.624", "0.55")).toBe("+7.4 pts");
    expect(formatProbabilityChangePts("0.55", "0.624")).toBe("-7.4 pts");
  });

  it("renders a genuine zero move unsigned", () => {
    expect(formatProbabilityChangePts("0.5", "0.5")).toBe("0.0 pts");
  });

  it("is dashes when either end is missing — no previous day is not a flat day", () => {
    expect(formatProbabilityChangePts(null, "0.55")).toBe("--");
    expect(formatProbabilityChangePts("0.624", null)).toBe("--");
    expect(formatProbabilityChangePts(null, null)).toBe("--");
  });

  it("is dashes when either end is malformed", () => {
    expect(formatProbabilityChangePts("abc", "0.55")).toBe("--");
    expect(formatProbabilityChangePts("0.624", "abc")).toBe("--");
  });
});

describe("decimalsOf", () => {
  it("counts the wire string's own fraction digits, trailing zeros included", () => {
    // The pin: a parsed-number derivation strips the ".0" and answers 0.
    expect(decimalsOf("63645.0")).toBe(1);
    expect(decimalsOf("0.624")).toBe(3);
    expect(decimalsOf("1.50")).toBe(2);
  });

  it("is 0 for an integer string", () => {
    expect(decimalsOf("12")).toBe(0);
    expect(decimalsOf("0")).toBe(0);
  });

  it("reads through a leading minus", () => {
    expect(decimalsOf("-1.50")).toBe(2);
  });

  it("is 0 for anything that is not a plain decimal", () => {
    expect(decimalsOf("")).toBe(0);
    expect(decimalsOf("abc")).toBe(0);
    expect(decimalsOf("1.")).toBe(0);
    expect(decimalsOf("1e5")).toBe(0);
  });
});

describe("flashDirection", () => {
  it("is null on first render — no direction from nowhere", () => {
    expect(flashDirection(null, "5")).toBeNull();
  });

  it("is null when the value did not move", () => {
    expect(flashDirection("5", "5")).toBeNull();
  });

  it("compares as numbers, not strings — a re-spelling is not a move", () => {
    expect(flashDirection("1.0", "1")).toBeNull();
    expect(flashDirection("1.10", "1.1")).toBeNull();
  });

  it("points up on a rise and down on a fall", () => {
    expect(flashDirection("5", "6")).toBe("up");
    expect(flashDirection("6", "5")).toBe("down");
    // Numeric, not lexicographic: "9" < "10" as numbers, > as strings.
    expect(flashDirection("9", "10")).toBe("up");
  });

  it("is null when either side is malformed — a flash is an assertion", () => {
    expect(flashDirection("abc", "5")).toBeNull();
    expect(flashDirection("5", "abc")).toBeNull();
  });
});

describe("changeTrend", () => {
  it("points up on a day-over-day rise and down on a fall", () => {
    expect(changeTrend("6", "5")).toBe("up");
    expect(changeTrend("5", "6")).toBe("down");
    // Numeric, not lexicographic: "10" > "9" as numbers, < as strings.
    expect(changeTrend("10", "9")).toBe("up");
  });

  it("returns neutral for an equal re-spelling — a flat day is a real claim", () => {
    expect(changeTrend("5", "5")).toBe("neutral");
    expect(changeTrend("1.0", "1")).toBe("neutral");
  });

  it("makes no claim when either end is missing", () => {
    expect(changeTrend(null, "5")).toBeNull();
    expect(changeTrend("5", null)).toBeNull();
    expect(changeTrend(null, null)).toBeNull();
  });

  it("makes no claim when either end is malformed", () => {
    expect(changeTrend("abc", "5")).toBeNull();
    expect(changeTrend("5", "abc")).toBeNull();
  });
});

describe("formatCompactUsd", () => {
  it("scales to B/M/K with two decimals", () => {
    expect(formatCompactUsd("2140000000")).toBe("$2.14B");
    expect(formatCompactUsd("288129.86073")).toBe("$288.12K");
    expect(formatCompactUsd("4200.5")).toBe("$4.2K");
  });

  it("rounds DOWN so a total is never overstated", () => {
    // $4.999M is "$4.99M": calling it "$5M" claims volume that did not trade.
    expect(formatCompactUsd("4999999")).toBe("$4.99M");
  });

  it("trims trailing zeros rather than padding to two places", () => {
    expect(formatCompactUsd("1500000")).toBe("$1.5M");
    expect(formatCompactUsd("0.0")).toBe("$0");
  });

  it("leaves sub-thousand figures unscaled", () => {
    expect(formatCompactUsd("12.349")).toBe("$12.34");
  });

  it("renders malformed input as dashes — an unreadable volume is not $0", () => {
    expect(formatCompactUsd("abc")).toBe("--");
    expect(formatCompactUsd("")).toBe("--");
  });
});

describe("rowMetric", () => {
  it("states volume under the volume sort", () => {
    expect(rowMetric(marketRow({ symbol: "BTC", dayNtlVlm: "1000000" }), "volume")).toBe("$1M vol");
  });

  it("states the 24h percent under gainers and losers — the sort KEY", () => {
    // Percent for every kind, predictions included: `orderRows` ranks on
    // `change24hPct`, and printing a prediction's points here would show a
    // list whose numbers do not descend.
    const row = marketRow({ symbol: "UP", px: "110", prevDayPx: "100" });

    expect(rowMetric(row, "gainers")).toBe("+10.00% 24h");
    expect(rowMetric(row, "losers")).toBe("+10.00% 24h");
  });

  it("states dashes, never a fake flat, when the change is unknowable", () => {
    const fresh = marketRow({ symbol: "FRESH", px: "100", prevDayPx: "0.0" });

    expect(rowMetric(fresh, "gainers")).toBe("-- 24h");
  });

  it("states open interest as notional USD", () => {
    const row = marketRow({ symbol: "BTC", openInterest: "10", markPx: "60000" });

    expect(rowMetric(row, "oi")).toBe("$600K OI");
  });

  it("states dashes for a row with no open interest — null is not $0", () => {
    expect(rowMetric(marketRow({ symbol: "HYPE", kind: "spot" }), "oi")).toBe("-- OI");
  });
});

describe("summarizeMarkets", () => {
  const section = [
    marketRow({ symbol: "BTC", dayNtlVlm: "1000000000" }),
    marketRow({ symbol: "ETH", dayNtlVlm: "1140000000" }),
    marketRow({ symbol: "SOL", dayNtlVlm: "0.0" }),
    marketRow({ symbol: "APT", dayNtlVlm: "0.0" }),
  ];

  it("states the section count and its summed 24h volume when idle", () => {
    expect(summarizeMarkets({ all: section, shown: 4, unranked: 0, query: "" })).toBe(
      "4 markets · $2.14B 24h volume"
    );
  });

  it("counts a single market in the singular", () => {
    expect(summarizeMarkets({ all: section.slice(0, 1), shown: 1, unranked: 0, query: "" })).toBe(
      "1 market · $1B 24h volume"
    );
  });

  it("skips a volume it cannot read instead of poisoning the total", () => {
    const withGarbage = [...section, marketRow({ symbol: "ODD", dayNtlVlm: "abc" })];

    expect(summarizeMarkets({ all: withGarbage, shown: 5, unranked: 0, query: "" })).toBe(
      "5 markets · $2.14B 24h volume"
    );
  });

  it("states matches against the section total while searching", () => {
    expect(summarizeMarkets({ all: section, shown: 1, unranked: 0, query: "sol" })).toBe(
      "1 of 4 markets"
    );
  });

  it("treats a whitespace-only query as no search at all", () => {
    expect(summarizeMarkets({ all: section, shown: 4, unranked: 0, query: "   " })).toBe(
      "4 markets · $2.14B 24h volume"
    );
  });

  it("announces the shortfall when a sort could not rank every row", () => {
    // A list shorter than its section must say so — an unexplained gap reads
    // as data loss.
    expect(summarizeMarkets({ all: section, shown: 3, unranked: 1, query: "" })).toBe(
      "3 of 4 ranked"
    );
  });

  it("prefers the search count over the ranked count when both apply", () => {
    expect(summarizeMarkets({ all: section, shown: 2, unranked: 1, query: "b" })).toBe(
      "2 of 4 markets"
    );
  });

  it("says nothing at all for an empty section — the empty state owns that", () => {
    expect(summarizeMarkets({ all: [], shown: 0, unranked: 0, query: "" })).toBeNull();
  });
});

describe("kindOfWireCoin", () => {
  it("routes # spellings to prediction and @ spellings to spot", () => {
    expect(kindOfWireCoin("#102170")).toBe("prediction");
    expect(kindOfWireCoin("@107")).toBe("spot");
  });

  it("routes a canonical pair name to spot — no @ prefix to lean on", () => {
    // Smoke-measured: testnet's canonical pair uses the literal pair name as
    // its wire coin, and a bare-ticker heuristic would call it a perp.
    expect(kindOfWireCoin("PURR/USDC")).toBe("spot");
  });

  it("routes a bare ticker to perp", () => {
    expect(kindOfWireCoin("BTC")).toBe("perp");
    expect(kindOfWireCoin("kPEPE")).toBe("perp");
  });
});

describe("selectHighlights", () => {
  const row = (overrides: Partial<MarketRow> & { wireCoin: string }): MarketRow =>
    ({
      kind: "perp",
      symbol: overrides.wireCoin,
      px: null,
      markPx: "100",
      midPx: null,
      prevDayPx: "100",
      dayNtlVlm: "0.0",
      funding: null,
      openInterest: null,
      maxLeverage: null,
      szDecimals: 0,
      isDelisted: false,
      sideName: null,
      ...overrides,
    }) as MarketRow;

  it("picks volume leader, top riser, top faller in that order", () => {
    const picks = selectHighlights([
      row({ wireCoin: "BTC", dayNtlVlm: "1000000", markPx: "100", prevDayPx: "100" }),
      row({ wireCoin: "UP", dayNtlVlm: "10", markPx: "110", prevDayPx: "100" }),
      row({ wireCoin: "DOWN", dayNtlVlm: "10", markPx: "80", prevDayPx: "100" }),
      row({ wireCoin: "MEH", dayNtlVlm: "10", markPx: "101", prevDayPx: "100" }),
    ]);
    expect(picks.map((pick) => [pick.row.wireCoin, pick.role])).toEqual([
      ["BTC", "Top volume"],
      ["UP", "Top gainer"],
      ["DOWN", "Top loser"],
    ]);
  });

  it("dedupes without promoting the runner-up", () => {
    // BTC is both the volume leader AND the top riser: it appears once, and
    // the lesser riser MEH is not promoted into the gainer slot.
    const picks = selectHighlights([
      row({ wireCoin: "BTC", dayNtlVlm: "1000000", markPx: "150", prevDayPx: "100" }),
      row({ wireCoin: "MEH", dayNtlVlm: "10", markPx: "101", prevDayPx: "100" }),
      row({ wireCoin: "DOWN", dayNtlVlm: "10", markPx: "90", prevDayPx: "100" }),
    ]);
    expect(picks.map((pick) => pick.row.wireCoin)).toEqual(["BTC", "DOWN"]);
  });

  it("never casts an unknowable change as a riser or faller", () => {
    const picks = selectHighlights([
      row({ wireCoin: "FRESH", dayNtlVlm: "50", markPx: "100", prevDayPx: "0.0" }),
    ]);
    expect(picks.map((pick) => [pick.row.wireCoin, pick.role])).toEqual([["FRESH", "Top volume"]]);
  });

  it("is empty for no rows", () => {
    expect(selectHighlights([])).toEqual([]);
  });
});
