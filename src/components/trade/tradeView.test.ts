/**
 * The trade screen's pure rules, pinned.
 *
 * The countdown is pinned on its boundary: exactly on the hour the answer is
 * a full period, never 0 — a lingering "00:00" reads as a stuck timer.
 *
 * `localSpread` is pinned to null on a crossed book and on a missing side —
 * transient wire nonsense and a one-sided book must not render as a spread —
 * while a locked book (bid = ask) genuinely measures `"0"`.
 *
 * `BOOK_GROUPINGS` is pinned to the wire's mantissa rule: a mantissa may only
 * ever ride on `nSigFigs: 5`. Every entry is `fast` — depth is measured from
 * the ladder's space and filled from both feeds by `mergeBookSide`, never
 * bought with refresh rate through the grouping menu.
 *
 * `mergeBookSide` is pinned on its seam: only deep levels strictly BEYOND the
 * last fast level survive, so an overlapping price appears once at the fast
 * feed's size — the deep snapshot can be five seconds old.
 */

import { BigNumber } from "bignumber.js";

import { getPriceTick } from "@/hyperliquid/core/precision";
import {
  pairTitle,
  BOOK_GROUPINGS,
  bookChromeHeight,
  bookColumnHeader,
  bookGroupingOptions,
  bookMid,
  bookRatio,
  BOOK_APPEARANCE,
  bookRowsPerSide,
  groupingTickLabel,
  fittedRowCount,
  resolveBookAppearance,
  canUseColumns,
  COLUMNS_MIN_WIDTH,
  countdownLabel,
  fundingPercentLabel,
  cumulativeDepth,
  FUNDING_PERIOD_MS,
  localSpread,
  mergeBookSide,
  msToNextHour,
  dayRange,
  shortClock,
  priceIsStale,
} from "@/components/trade/tradeView";

describe("msToNextHour", () => {
  // An arbitrary exact UTC hour: 2026-08-17T14:00:00.000Z.
  const onTheHour = Date.UTC(2026, 7, 17, 14, 0, 0, 0);

  it("counts down through the hour", () => {
    expect(msToNextHour(onTheHour + 15 * 60_000)).toBe(45 * 60_000);
    expect(msToNextHour(onTheHour + 1)).toBe(FUNDING_PERIOD_MS - 1);
  });

  it("is 1ms just before the boundary", () => {
    expect(msToNextHour(onTheHour - 1)).toBe(1);
  });

  it("is a full period exactly ON the boundary — never 0", () => {
    // The moment funding pays, the next payment is an hour away; a 0 here
    // renders a lingering "00:00" that reads as a stuck timer.
    expect(msToNextHour(onTheHour)).toBe(FUNDING_PERIOD_MS);
  });
});

describe("countdownLabel", () => {
  it("renders mm:ss, floored", () => {
    expect(countdownLabel(45 * 60_000)).toBe("45:00");
    expect(countdownLabel(59_999)).toBe("00:59");
    expect(countdownLabel(61_000)).toBe("01:01");
  });

  it("floors instead of rounding — a round would tick a second twice", () => {
    expect(countdownLabel(59_600)).toBe("00:59");
  });

  it("renders a full hour as 60:00 rather than growing an hours place", () => {
    expect(countdownLabel(FUNDING_PERIOD_MS)).toBe("60:00");
  });

  it("clamps at 00:00 — a countdown never goes negative", () => {
    expect(countdownLabel(0)).toBe("00:00");
    expect(countdownLabel(-1500)).toBe("00:00");
  });

  it("renders non-finite input as the clamp, not NaN:NaN", () => {
    expect(countdownLabel(Number.NaN)).toBe("00:00");
  });
});

describe("fundingPercentLabel", () => {
  // Both anchors are LIVE testnet readings (metaAndAssetCtxs, 2026-08-17):
  // BTC funds at 0.0000125/h and HYPE — thin book, huge premium — at 0.04/h.
  // One format cannot serve both, which is the whole reason for the rule.
  it("keeps four decimals for a major perp's tiny rate", () => {
    expect(fundingPercentLabel("0.0000125")).toBe("0.0013%");
  });

  it("drops to two decimals once the rate reaches a whole percent", () => {
    expect(fundingPercentLabel("0.04")).toBe("4.00%");
  });

  it("switches exactly at 1%", () => {
    expect(fundingPercentLabel("0.01")).toBe("1.00%");
    expect(fundingPercentLabel("0.0099")).toBe("0.9900%");
  });

  it("applies the magnitude rule to negative rates too", () => {
    expect(fundingPercentLabel("-0.04")).toBe("-4.00%");
    expect(fundingPercentLabel("-0.0000125")).toBe("-0.0013%");
  });

  it("renders zero as a measured zero, not as unknown", () => {
    expect(fundingPercentLabel("0")).toBe("0.0000%");
  });

  it("renders an absent or malformed rate as --", () => {
    expect(fundingPercentLabel(null)).toBe("--");
    expect(fundingPercentLabel("")).toBe("--");
    expect(fundingPercentLabel("abc")).toBe("--");
  });
});

describe("localSpread", () => {
  it("computes abs and pct against the mid", () => {
    // mid = 100, abs = 2, pct = 2/100 × 100 = 2.
    expect(localSpread("99", "101")).toEqual({ abs: "2", pct: "2" });
  });

  it("keeps a tick-sized spread exact and states pct in significant digits", () => {
    // BigNumber, not float: 63000.1 − 63000.0 is exactly 0.1, and the pct is
    // 0.000159% — fixed decimal places would print it as a zero that lies.
    expect(localSpread("63000.0", "63000.1")).toEqual({ abs: "0.1", pct: "0.000159" });
  });

  it("measures a locked book as zero — that one is a measurement", () => {
    expect(localSpread("100", "100")).toEqual({ abs: "0", pct: "0" });
  });

  it("is null when either side is missing — a one-sided book has no spread", () => {
    expect(localSpread(null, "101")).toBeNull();
    expect(localSpread("99", null)).toBeNull();
    expect(localSpread(null, null)).toBeNull();
  });

  it("is null on a crossed book — transient wire nonsense, not a negative spread", () => {
    expect(localSpread("101", "99")).toBeNull();
  });

  it("is null on a zero mid — a ratio against zero is undefined", () => {
    expect(localSpread("0", "0")).toBeNull();
  });

  it("is null when either side is malformed", () => {
    expect(localSpread("abc", "101")).toBeNull();
    expect(localSpread("99", "abc")).toBeNull();
  });
});

describe("bookRatio", () => {
  it("states the buy side's share of total visible size", () => {
    expect(bookRatio(["1", "2"], ["1"])).toEqual({ buyPct: 75 });
  });

  it("reaches the extremes when one side is empty", () => {
    expect(bookRatio(["3"], [])).toEqual({ buyPct: 100 });
    expect(bookRatio([], ["3"])).toEqual({ buyPct: 0 });
  });

  it("skips a size it cannot read instead of counting it as zero", () => {
    expect(bookRatio(["1", "abc"], ["1"])).toEqual({ buyPct: 50 });
  });

  it("is null when both sides sum to zero — an empty book has no ratio", () => {
    expect(bookRatio([], [])).toBeNull();
    expect(bookRatio(["0"], ["0"])).toBeNull();
  });
});

describe("cumulativeDepth", () => {
  it("emits running-total fractions of the final total", () => {
    expect(cumulativeDepth(["1", "2", "1"])).toEqual([0.25, 0.75, 1]);
  });

  it("gives a single level the full bar", () => {
    expect(cumulativeDepth(["5"])).toEqual([1]);
  });

  it("is empty for empty input", () => {
    expect(cumulativeDepth([])).toEqual([]);
  });

  it("renders an all-zero side at zero width rather than dividing by zero", () => {
    expect(cumulativeDepth(["0", "0"])).toEqual([0, 0]);
  });

  it("keeps one bar slot per level even when a size will not parse", () => {
    // The bars sit behind rows; dropping a slot would shift every bar below
    // the bad level onto the wrong row.
    expect(cumulativeDepth(["1", "abc", "1"])).toEqual([0.5, 0.5, 1]);
  });
});

describe("bookMid", () => {
  it("halves the touch", () => {
    expect(bookMid("99", "101")).toBe("100");
  });

  it("carries the extra decimal two adjacent ticks produce", () => {
    // The mid of consecutive ticks needs one more place than either side —
    // this is exactly what FlashPrice's digit pinning has to accommodate.
    expect(bookMid("63645", "63646")).toBe("63645.5");
  });

  it("shows a mid on a CROSSED book, unlike localSpread", () => {
    // A crossed book is a transient wire artefact. The spread is meaningless
    // there, but the ladder's anchor price still is not — blanking it would
    // empty the row the whole column is read against.
    expect(localSpread("101", "99")).toBeNull();
    expect(bookMid("101", "99")).toBe("100");
  });

  it("is null when a side is missing — a mid needs both", () => {
    expect(bookMid(null, "101")).toBeNull();
    expect(bookMid("99", null)).toBeNull();
  });

  it("is null on a non-positive or unreadable mid", () => {
    expect(bookMid("0", "0")).toBeNull();
    expect(bookMid("abc", "101")).toBeNull();
  });

  it("does not go exponential on a small spot price", () => {
    // toString() emits "1e-8" below 1e-7; a tick label is not a place for
    // scientific notation.
    expect(bookMid("0.00000001", "0.00000003")).toBe("0.00000002");
  });
});

describe("groupingTickLabel", () => {
  const fast = (nSigFigs: 2 | 3 | 4 | 5 | null, mantissa: 2 | 5 | null = null) => ({
    nSigFigs,
    mantissa,
    fast: true as const,
  });

  it("turns significant figures into the tick they actually quote", () => {
    // 58.907 has exponent 1; 5 sig figs fixes the last at 10^(1−5+1) = 0.001,
    // which is exactly the label the official web app shows.
    expect(groupingTickLabel(fast(5), "58.907", 2, "perp")).toBe("0.001");
    expect(groupingTickLabel(fast(4), "58.907", 2, "perp")).toBe("0.01");
    expect(groupingTickLabel(fast(3), "58.907", 2, "perp")).toBe("0.1");
    expect(groupingTickLabel(fast(2), "58.907", 2, "perp")).toBe("1");
  });

  it("applies the mantissa on the fifth significant figure", () => {
    expect(groupingTickLabel(fast(5, 2), "58.907", 2, "perp")).toBe("0.002");
    expect(groupingTickLabel(fast(5, 5), "58.907", 2, "perp")).toBe("0.005");
  });

  it("gives Finest the asset's own tick", () => {
    expect(groupingTickLabel(fast(null), "58.907", 2, "perp")).toBe(
      getPriceTick("58.907", 2, "perp")!.toFixed()
    );
  });

  it("clamps UP to the native tick — no label may promise a finer grid", () => {
    // szDecimals 4 on a perp caps decimals at 6−4 = 2, so a 5-sig-fig
    // grouping on a sub-1 price cannot really quote 0.00001.
    const label = groupingTickLabel(fast(5), "0.5", 4, "perp");
    expect(label).toBe("0.01");
  });

  it("produces a tick every real price sits on", () => {
    for (const px of ["58.907", "64213.5", "1.2795", "0.0015185"]) {
      const label = groupingTickLabel(fast(4), px, 2, "perp");
      expect(label).not.toBeNull();
      // The grid is only a grid if the tick divides its own power of ten.
      expect(new BigNumber(label!).isFinite()).toBe(true);
      expect(label).not.toContain("e");
    }
  });

  it("is null when there is no anchor to derive from", () => {
    expect(groupingTickLabel(fast(5), null, 2, "perp")).toBeNull();
    expect(groupingTickLabel(fast(5), "0", 2, "perp")).toBeNull();
    expect(groupingTickLabel(fast(5), "abc", 2, "perp")).toBeNull();
  });

  it("falls back to the outcome price decimals when szDecimals is unknown", () => {
    expect(groupingTickLabel(fast(null), "0.5", null, "spot")).not.toBeNull();
  });
});

describe("bookGroupingOptions", () => {
  it("labels every option by tick when a price is known", () => {
    const options = bookGroupingOptions("58.907", 2, "perp");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.label).toMatch(/^[0-9.]+$/);
    }
  });

  it("keeps the English labels when there is no price yet", () => {
    expect(bookGroupingOptions(null, 2, "perp").map((o) => o.label)).toEqual(
      BOOK_GROUPINGS.map((g) => g.label)
    );
  });

  it("preserves the key the appearance names as its default grouping", () => {
    const options = bookGroupingOptions("58.907", 2, "perp");
    expect(options.some((o) => o.id === BOOK_APPEARANCE.defaultGrouping)).toBe(true);
  });

  it("collapses adjacent duplicates the clamp creates", () => {
    // At szDecimals 4 on a sub-1 perp the finest groupings all clamp to the
    // same native tick; two menu rows reading "0.01" are a choice with no
    // difference.
    const options = bookGroupingOptions("0.5", 4, "perp");
    const labels = options.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never emits a duplicate id", () => {
    const ids = bookGroupingOptions("58.907", 2, "perp").map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("bookColumnHeader", () => {
  it("reads price-then-size in the stacked ladder", () => {
    expect(bookColumnHeader("stacked", "both", "HYPE")).toEqual({
      left: "Price",
      right: "Size (HYPE)",
    });
  });

  it("MIRRORS over the bid column, because the bid rows are mirrored", () => {
    // Bids read size-outward so the two sides' prices meet in the middle; a
    // single "Price | Size" header would sit over the wrong cells.
    expect(bookColumnHeader("columns", "bid", "HYPE")).toEqual({
      left: "Size (HYPE)",
      right: "Price",
    });
    expect(bookColumnHeader("columns", "ask", "HYPE")).toEqual({
      left: "Price",
      right: "Size (HYPE)",
    });
  });

  it("does not mirror a bid side in the stacked layout", () => {
    expect(bookColumnHeader("stacked", "bid", "HYPE")).toEqual({
      left: "Price",
      right: "Size (HYPE)",
    });
  });
});

describe("mergeBookSide", () => {
  const level = (px: string, sz = "1") => ({ px, sz });

  it("appends only deep levels beyond the fast edge — bids descend", () => {
    const fast = [level("100"), level("99"), level("98")];
    const deep = [level("100"), level("99"), level("98"), level("97"), level("96")];
    expect(mergeBookSide(fast, deep, "bids").map((l) => l.px)).toEqual([
      "100",
      "99",
      "98",
      "97",
      "96",
    ]);
  });

  it("appends only deep levels beyond the fast edge — asks ascend", () => {
    const fast = [level("100"), level("101")];
    const deep = [level("100"), level("101"), level("102"), level("103")];
    expect(mergeBookSide(fast, deep, "asks").map((l) => l.px)).toEqual([
      "100",
      "101",
      "102",
      "103",
    ]);
  });

  it("prefers the fast size where both feeds carry a price", () => {
    // The deep snapshot can be five seconds old, so an overlapping level is
    // the fast feed's to state. A duplicate row at two sizes is the bug this
    // guards.
    const merged = mergeBookSide(
      [level("100", "7")],
      [level("100", "3"), level("99", "2")],
      "bids"
    );
    expect(merged).toEqual([
      { px: "100", sz: "7" },
      { px: "99", sz: "2" },
    ]);
  });

  it("takes nothing from a deep feed that does not reach past the fast edge", () => {
    const fast = [level("100"), level("99"), level("98")];
    const deep = [level("100"), level("99")];
    expect(mergeBookSide(fast, deep, "bids").map((l) => l.px)).toEqual(["100", "99", "98"]);
  });

  it("is the fast side alone when the deep feed is empty or stale", () => {
    const fast = [level("100"), level("99")];
    expect(mergeBookSide(fast, [], "bids")).toEqual(fast);
  });

  it("falls back to the deep side when the fast feed has nothing yet", () => {
    const deep = [level("100"), level("99")];
    expect(mergeBookSide([], deep, "bids")).toEqual(deep);
  });

  it("compares prices numerically, not as strings", () => {
    // "9" > "100" lexicographically; a string compare would drop the 9 from
    // the bid tail and keep nothing.
    const merged = mergeBookSide([level("100")], [level("9")], "bids");
    expect(merged.map((l) => l.px)).toEqual(["100", "9"]);
  });

  it("drops an unparseable deep level rather than placing it", () => {
    const merged = mergeBookSide([level("100")], [level("junk"), level("98")], "bids");
    expect(merged.map((l) => l.px)).toEqual(["100", "98"]);
  });

  it("keeps the fast side whole when its own edge is unparseable", () => {
    const fast = [level("100"), level("junk")];
    expect(mergeBookSide(fast, [level("98")], "bids")).toEqual(fast);
  });

  it("does not mutate either input", () => {
    const fast = [level("100")];
    const deep = [level("99")];
    mergeBookSide(fast, deep, "bids");
    expect(fast).toHaveLength(1);
    expect(deep).toHaveLength(1);
  });
});

describe("BOOK_GROUPINGS", () => {
  it("leads with the fast finest book — the default the screen opens on", () => {
    expect(BOOK_GROUPINGS[0]).toEqual({
      key: "default",
      label: "Finest",
      aggregation: { nSigFigs: null, mantissa: null, fast: true },
    });
  });

  it("walks the sig-fig ladder in order", () => {
    expect(BOOK_GROUPINGS.map((option) => option.aggregation.nSigFigs)).toEqual([
      null,
      5,
      5,
      5,
      4,
      3,
      2,
    ]);
  });

  it("is entirely fast — depth is measured space, not a menu choice", () => {
    for (const option of BOOK_GROUPINGS) {
      expect(option.aggregation.fast).toBe(true);
    }
  });

  it("only ever pairs a mantissa with nSigFigs 5 — the wire rejects anything else", () => {
    for (const option of BOOK_GROUPINGS) {
      if (option.aggregation.mantissa !== null) {
        expect(option.aggregation.nSigFigs).toBe(5);
      }
    }
    expect(BOOK_GROUPINGS.filter((option) => option.aggregation.mantissa !== null)).toHaveLength(2);
  });

  it("keys every option uniquely — the menu persists the key", () => {
    const keys = BOOK_GROUPINGS.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("shortClock", () => {
  it("renders a fixed-width 24-hour clock in local time", () => {
    // Local-time constructor, so the expectation holds in any zone Jest runs
    // in — the convention under test is "device-local", following shortTime.
    expect(shortClock(new Date(2026, 7, 17, 14, 3, 27).getTime())).toBe("14:03:27");
  });

  it("pads every part — the tape is a column and width must not wander", () => {
    expect(shortClock(new Date(2026, 7, 17, 9, 7, 3).getTime())).toBe("09:07:03");
  });

  it("renders unusable input as dashes, following shortTime's guard", () => {
    expect(shortClock(0)).toBe("--");
    expect(shortClock(-5)).toBe("--");
    expect(shortClock(Number.NaN)).toBe("--");
  });
});

describe("book sides", () => {
  it("splits the fitted rows between both sides when stacked", () => {
    expect(bookRowsPerSide("both", "stacked", 12)).toBe(6);
  });

  it("gives a single side ALL of them — the switch reveals depth", () => {
    expect(bookRowsPerSide("asks", "stacked", 12)).toBe(12);
    expect(bookRowsPerSide("bids", "stacked", 12)).toBe(12);
  });

  it("gives BOTH sides all of them in columns — the layout's payoff", () => {
    // Side by side, the sides no longer compete for rows: twice the depth in
    // the same height. That is why the layout exists.
    expect(bookRowsPerSide("both", "columns", 12)).toBe(12);
    expect(bookRowsPerSide("asks", "columns", 12)).toBe(12);
  });

  it("leaves an odd row unused rather than favouring one side", () => {
    // Giving it to one side would push the spread off-centre.
    expect(bookRowsPerSide("both", "stacked", 13)).toBe(6);
  });

  it("is zero before anything has been measured", () => {
    expect(bookRowsPerSide("both", "stacked", 0)).toBe(0);
    expect(bookRowsPerSide("asks", "columns", 0)).toBe(0);
  });
});

describe("resolveBookAppearance", () => {
  it("is the house book when nothing is overridden", () => {
    expect(resolveBookAppearance()).toEqual(BOOK_APPEARANCE);
    expect(resolveBookAppearance({})).toEqual(BOOK_APPEARANCE);
  });

  it("separates rows by a hairline rather than butting them together", () => {
    // Small on purpose: enough to part the rows, not enough to break the
    // depth column into stripes.
    expect(BOOK_APPEARANCE.rowGap).toBeGreaterThan(0);
    expect(BOOK_APPEARANCE.rowGap).toBeLessThan(4);
  });

  it("keeps every unset field at its default", () => {
    const dense = resolveBookAppearance({ rowGap: 0, rowHeight: 18 });
    expect(dense.rowGap).toBe(0);
    expect(dense.rowHeight).toBe(18);
    expect(dense.showDepth).toBe(BOOK_APPEARANCE.showDepth);
    expect(dense.defaultSides).toBe(BOOK_APPEARANCE.defaultSides);
  });

  it("carries a chrome-free preset for an embedded book", () => {
    const bare = resolveBookAppearance({
      showTape: false,
      showControls: false,
      showRatio: false,
      maxRows: 4,
    });
    expect(bare).toMatchObject({
      showTape: false,
      showControls: false,
      showRatio: false,
      maxRows: 4,
    });
    // Still a book: rows, depth and the spread reference survive.
    expect(bare.showDepth).toBe(true);
    expect(bare.showSpread).toBe(true);
  });

  it("does not mutate the shared default", () => {
    resolveBookAppearance({ rowGap: 9 });
    expect(BOOK_APPEARANCE.rowGap).not.toBe(9);
  });
});

describe("bookChromeHeight", () => {
  it("charges the touch row, the ratio bar and the column header", () => {
    expect(bookChromeHeight(BOOK_APPEARANCE)).toBe(26 + 24);
  });

  it("stops charging for chrome that is genuinely unmounted", () => {
    // A book that opts the ratio bar back IN pays its height; dropping the
    // column header spends those points on levels instead.
    expect(bookChromeHeight(resolveBookAppearance({ showRatio: true }))).toBe(26 + 26 + 24);
    expect(bookChromeHeight(resolveBookAppearance({ showColumnHeader: false }))).toBe(26);
  });

  it("STILL charges the touch row when the spread is hidden", () => {
    // It renders an empty view of the same height on purpose: hiding the
    // spread must not reflow the ladder by a row and move the sides under
    // the reader's eye.
    expect(bookChromeHeight(resolveBookAppearance({ showSpread: false }))).toBe(
      bookChromeHeight(BOOK_APPEARANCE)
    );
  });

  it("counts every element inside the measured box — the defect this exists for", () => {
    // The ladder box holds the ratio bar too. Charging only the touch row let
    // the ladder claim 26pt it did not have — one full row pitch — and the
    // stacked layout's centring hid it by clipping symmetrically.
    expect(bookChromeHeight(BOOK_APPEARANCE)).toBeGreaterThan(BOOK_APPEARANCE.spreadHeight);
  });
});

describe("fittedRowCount", () => {
  it("fills the measured space, fixed chrome first", () => {
    // 300 tall − 26 chrome = 274 for rows; at 24pt each that is 11.
    expect(fittedRowCount(300, 24, 26)).toBe(11);
  });

  it("loses a row to chrome the caller previously forgot to charge", () => {
    // The regression: 26pt of ratio bar is one 25pt pitch. Same box, honest
    // chrome, one row fewer — and that row now exists on screen.
    expect(fittedRowCount(441, 24, 40, 1)).toBe(16);
    expect(fittedRowCount(441, 24, 40 + 26 + 16, 1)).toBe(14);
  });

  it("charges each row its gap, so a gapped ladder fits fewer", () => {
    // 274 for rows at a 25pt pitch (24 + 1) is 10, not 11.
    expect(fittedRowCount(300, 24, 26, 1)).toBe(10);
    expect(fittedRowCount(300, 24, 26, 6)).toBe(9);
  });

  it("over-reserves by one gap — the safe direction", () => {
    // n rows really need n×h + (n−1)×gap; charging the gap to every row can
    // only leave space over, never overflow the measured box.
    const rows = fittedRowCount(300, 24, 26, 1);
    expect(rows * 24 + (rows - 1) * 1 + 26).toBeLessThanOrEqual(300);
  });

  it("treats a negative gap as no gap rather than inflating the count", () => {
    expect(fittedRowCount(300, 24, 26, -10)).toBe(fittedRowCount(300, 24, 26, 0));
  });

  it("gives a taller screen a deeper book — the whole point of measuring", () => {
    expect(fittedRowCount(500, 24, 26)).toBeGreaterThan(fittedRowCount(300, 24, 26));
  });

  it("floors — a partial row is not drawn", () => {
    // 26 + 24×5 = 146 exactly; one more point must not add a sixth row.
    expect(fittedRowCount(146, 24, 26)).toBe(5);
    expect(fittedRowCount(147, 24, 26)).toBe(5);
    expect(fittedRowCount(170, 24, 26)).toBe(6);
  });

  it("is zero when the space cannot hold the spread plus one row", () => {
    expect(fittedRowCount(40, 24, 26)).toBe(0);
    expect(fittedRowCount(26, 24, 26)).toBe(0);
  });

  it("is zero before the first layout pass", () => {
    // Callers render the skeleton at 0 rather than guessing and reflowing.
    expect(fittedRowCount(0, 24, 26)).toBe(0);
    expect(fittedRowCount(-10, 24, 26)).toBe(0);
    expect(fittedRowCount(Number.NaN, 24, 26)).toBe(0);
  });
});

describe("dayRange", () => {
  const H = 60 * 60 * 1000;
  const now = 1_000_000 * H; // an arbitrary fixed instant
  const bar = (hoursAgoClose: number, high: string, low: string) => ({
    closeTime: now - hoursAgoClose * H,
    high,
    low,
  });

  it("folds high and low over the window, keeping wire strings", () => {
    const range = dayRange([bar(20, "101.5", "99.1"), bar(10, "103.2", "100.0")], null, now);
    expect(range).toEqual({ high: "103.2", low: "99.1" });
  });

  it("drops bars that closed before the window", () => {
    // The 30h-old bar printed the extremes — outside the day, they must not
    // survive into it.
    const range = dayRange([bar(30, "999", "1"), bar(5, "103", "100")], null, now);
    expect(range).toEqual({ high: "103", low: "100" });
  });

  it("keeps a bar that OPENED outside the window but closed inside it", () => {
    // Its extreme may have printed 23h ago; closeTime is the honest test.
    const range = dayRange([bar(1, "104", "98")], null, now);
    expect(range).toEqual({ high: "104", low: "98" });
  });

  it("lets the forming bucket set the extreme — the high is often NOW", () => {
    const range = dayRange([bar(5, "103", "100")], bar(0, "105.5", "99"), now);
    expect(range).toEqual({ high: "105.5", low: "99" });
  });

  it("is null with no candles and null when nothing overlaps", () => {
    expect(dayRange([], null, now)).toBeNull();
    expect(dayRange([bar(30, "999", "1")], null, now)).toBeNull();
  });

  it("skips a bar it cannot read rather than poisoning the fold", () => {
    const range = dayRange([bar(5, "abc", "xyz"), bar(3, "103", "100")], null, now);
    expect(range).toEqual({ high: "103", low: "100" });
  });
});

describe("canUseColumns", () => {
  it("refuses a panel too narrow for two price+size columns", () => {
    // A layout control that produces an unreadable layout is not a choice.
    expect(canUseColumns(COLUMNS_MIN_WIDTH - 1)).toBe(false);
    expect(canUseColumns(180)).toBe(false);
  });

  it("allows it exactly at the threshold and above", () => {
    expect(canUseColumns(COLUMNS_MIN_WIDTH)).toBe(true);
    expect(canUseColumns(768)).toBe(true);
  });

  it("treats an unmeasured panel (0) as too narrow", () => {
    // onLayout has not fired yet — default to the layout that always fits.
    expect(canUseColumns(0)).toBe(false);
  });
});

describe("pairTitle", () => {
  it("spells the official mobile header pair", () => {
    expect(pairTitle("BTC")).toBe("BTC-USDC");
    expect(pairTitle("HYPE")).toBe("HYPE-USDC");
  });
});

describe("priceIsStale", () => {
  // The screen resolves `mid ?? ctx.midPx ?? ctx.markPx ?? row.px`, so a flag
  // that tracks one channel describes a value that may not be on screen. Both
  // directions were wrong before this; the second one is the expensive one.
  it("reports the MID's age when the mid is what is shown", () => {
    expect(priceIsStale({ mid: "100", ctxPrice: "101", midsStale: false, ctxStale: true })).toBe(
      false
    );
  });

  it("calls a stalled mid stale even while the ctx channel is live", () => {
    // The dangerous direction. Reporting the ctx channel here would present a
    // minutes-old mid as fact on the one screen that commits money against it —
    // the size slider's cap and the liquidation estimate both derive from it.
    expect(priceIsStale({ mid: "100", ctxPrice: "101", midsStale: true, ctxStale: false })).toBe(
      true
    );
  });

  it("falls through to the CTX's age only once the mid is absent", () => {
    expect(priceIsStale({ mid: null, ctxPrice: "101", midsStale: false, ctxStale: true })).toBe(
      true
    );
    expect(priceIsStale({ mid: null, ctxPrice: "101", midsStale: true, ctxStale: false })).toBe(
      false
    );
  });

  it("does not flag the market-row snapshot before the first poll has run", () => {
    // `row.px` is a REST snapshot with no age. It only applies during initial
    // load, where `midsAge === null` yields `midsStale === false` — correctly
    // "just fetched" rather than a stale chip on every cold open.
    expect(priceIsStale({ mid: null, ctxPrice: null, midsStale: false, ctxStale: true })).toBe(
      false
    );
  });

  it("does flag the snapshot once the mids poll is itself behind", () => {
    expect(priceIsStale({ mid: null, ctxPrice: null, midsStale: true, ctxStale: false })).toBe(
      true
    );
  });
});
