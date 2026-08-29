/**
 * The detail screen's decisions, pinned.
 *
 * The interval test is the load-bearing one: `CandleInterval` admits both
 * `1m` and `1M`, and the wrong case silently subscribes to a feed ~43,000×
 * slower than intended — only this constant and this test pin the spelling.
 *
 * The tile tests pin per-tile null honesty (a source that has not spoken is
 * `value: null`, and the label never vanishes), OI×mark in BigNumber (a
 * float product truncates a cent under `compactUsd`'s floor), and funding at
 * three significant figures (hourly funding lives in the 4th decimal of a percent — a
 * 2dp round prints `+0.00%` for every market on the exchange).
 *
 * The prediction rows pin the visible-sum rule: the wire guarantees the two
 * sides sum to exactly 1, and the display must never round its way out of
 * that invariant.
 */

import {
  DETAIL_INTERVALS,
  aboutRows,
  formingToCandlePoint,
  outcomeByWireCoin,
  perpStatTiles,
  predictionSideRows,
  predictionStatTiles,
  spotDetailFor,
  spotStatTiles,
  toCandlePoints,
  truncateAddress,
  toSparkPoints,
} from "@/components/markets/detailView";
import { toBigNumber } from "@/hyperliquid/core/precision";

import type { Candle } from "@/hyperliquid/types/domain";

describe("DETAIL_INTERVALS", () => {
  it("uses minute/day/week casing, never month casing", () => {
    expect(DETAIL_INTERVALS).toContain("1m");
    expect(DETAIL_INTERVALS).toContain("1d");
    expect(DETAIL_INTERVALS).not.toContain("1M");
    expect(DETAIL_INTERVALS).not.toContain("1D");
    expect(DETAIL_INTERVALS).not.toContain("1W");
  });

  it("offers exactly the seven segments, in order", () => {
    expect(DETAIL_INTERVALS).toEqual(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]);
  });
});

const HOUR_MS = 3_600_000;

function candle(overrides: Partial<Candle> = {}): Candle {
  const openTime = 1_700_000_060_000;
  return {
    openTime,
    closeTime: openTime + HOUR_MS - 1,
    interval: "1h",
    coin: "BTC",
    open: "100.5",
    high: "110.0",
    low: "99.25",
    close: "105.75",
    volume: "12.5",
    trades: 42,
    ...overrides,
  };
}

describe("toCandlePoints", () => {
  it("maps ms open times to SECONDS and OHLCV to numbers", () => {
    const [point] = toCandlePoints([candle()]);
    expect(point).toEqual({
      time: 1_700_000_060,
      open: 100.5,
      high: 110,
      low: 99.25,
      close: 105.75,
      volume: 12.5,
    });
  });

  it("keeps series order and length over well-formed rows", () => {
    const points = toCandlePoints([
      candle(),
      candle({ openTime: 1_700_000_060_000 + HOUR_MS, close: "106.0" }),
    ]);
    expect(points).toHaveLength(2);
    expect(points[1]!.time).toBe(1_700_003_660);
  });

  it("drops a row with a malformed price rather than drawing a wick to zero", () => {
    const points = toCandlePoints([candle({ low: "junk" }), candle({ openTime: 1 })]);
    expect(points).toHaveLength(1);
    expect(points[0]!.time).toBe(1 / 1000);
  });

  it("keeps a row whose volume alone is malformed, omitting the volume key", () => {
    const [point] = toCandlePoints([candle({ volume: "junk" })]);
    expect(point).toBeDefined();
    expect(point).not.toHaveProperty("volume");
  });
});

describe("formingToCandlePoint", () => {
  it("passes null through — a quiet market forms nothing", () => {
    expect(formingToCandlePoint(null)).toBeNull();
  });

  it("maps a forming candle like any other", () => {
    expect(formingToCandlePoint(candle())?.close).toBe(105.75);
  });

  it("is null for a malformed forming candle", () => {
    expect(formingToCandlePoint(candle({ close: "junk" }))).toBeNull();
  });
});

const PERP_CTX = {
  markPx: "63645.0",
  oraclePx: "63640.5",
  dayNtlVlm: "1234567.0",
  funding: "0.0000125",
  openInterest: "0.7",
};

describe("perpStatTiles", () => {
  it("renders all six tiles from a live ctx, in card order", () => {
    expect(perpStatTiles(PERP_CTX, { maxLeverage: 40 })).toEqual([
      { label: "Mark", value: "63645.0" },
      { label: "Oracle", value: "63640.5" },
      { label: "24h volume", value: "$1.2M" },
      // 0.7 × 63645.0 = 44551.5, floored to "$44.5K" by compactUsd.
      { label: "Open interest", value: "$44.5K" },
      { label: "Funding / hr", value: "+0.00125%", tone: "up" },
      { label: "Max leverage", value: "40x" },
    ]);
  });

  it("computes OI×mark in BigNumber — a float product loses a cent to the floor", () => {
    // 0.7 × 0.1 in doubles is 0.06999999999999999, which compactUsd's
    // ROUND_DOWN truncates to "$0.06". The true product is exactly 0.07.
    const tiles = perpStatTiles({ ...PERP_CTX, openInterest: "0.7", markPx: "0.1" }, null);
    expect(tiles[3]).toEqual({ label: "Open interest", value: "$0.07" });
  });

  it("keeps funding at three significant figures, signed, with a sign tone", () => {
    const down = perpStatTiles({ ...PERP_CTX, funding: "-0.0000125" }, null)[4];
    expect(down).toEqual({ label: "Funding / hr", value: "-0.00125%", tone: "down" });
    // The noisy mantissa the fixed-decimal form printed verbatim — the whole
    // reason this is significant figures now.
    const noisy = perpStatTiles({ ...PERP_CTX, funding: "0.0002533821" }, null)[4];
    expect(noisy).toEqual({ label: "Funding / hr", value: "+0.0253%", tone: "up" });
    const flat = perpStatTiles({ ...PERP_CTX, funding: "0.0" }, null)[4];
    expect(flat).toEqual({ label: "Funding / hr", value: "0%", tone: "neutral" });
  });

  it("nulls every live tile when the ctx is null — labels stay, values honest", () => {
    const tiles = perpStatTiles(null, { maxLeverage: 40 });
    expect(tiles.map((t) => t.label)).toEqual([
      "Mark",
      "Oracle",
      "24h volume",
      "Open interest",
      "Funding / hr",
      "Max leverage",
    ]);
    expect(tiles.slice(0, 5).every((t) => t.value === null)).toBe(true);
    // The universe row is a different source and answers for itself.
    expect(tiles[5]!.value).toBe("40x");
  });

  it("nulls max leverage alone when only the universe row is missing", () => {
    const tiles = perpStatTiles(PERP_CTX, null);
    expect(tiles[5]).toEqual({ label: "Max leverage", value: null });
    expect(tiles[0]!.value).toBe("63645.0");
  });

  it("nulls a tile whose own field is malformed instead of printing dashes-as-data", () => {
    const tiles = perpStatTiles({ ...PERP_CTX, oraclePx: "junk" }, null);
    expect(tiles[1]).toEqual({ label: "Oracle", value: null });
  });
});

describe("spotStatTiles", () => {
  const SPOT_CTX = { markPx: "44.13", dayNtlVlm: "5250000.0", circulatingSupply: "334400000" };

  it("renders mark, volume, and a token-suffixed compact supply", () => {
    expect(spotStatTiles({ name: "HYPE" }, SPOT_CTX)).toEqual([
      { label: "Mark", value: "44.13" },
      { label: "24h volume", value: "$5.2M" },
      { label: "Circulating supply", value: "334.4M HYPE" },
    ]);
  });

  it("leaves the supply bare when the token is unknown", () => {
    expect(spotStatTiles(null, SPOT_CTX)[2]!.value).toBe("334.4M");
  });

  it("nulls every value when the ctx has not loaded", () => {
    const tiles = spotStatTiles({ name: "HYPE" }, null);
    expect(tiles).toHaveLength(3);
    expect(tiles.every((t) => t.value === null)).toBe(true);
  });
});

describe("aboutRows", () => {
  const TOKEN = {
    fullName: "Hyperliquid",
    totalSupply: "999990000.0",
    evmContract: { address: "0x1baAe07Bff112233445566778899aabbccdd34d5" },
  };

  it("omits the all-zero contract address — it means no deployment, not one at 0x0", () => {
    const rows = aboutRows({
      ...TOKEN,
      evmContract: { address: "0x0000000000000000000000000000000000000000" },
    });
    expect(rows.some((row) => row.label === "Contract")).toBe(false);
  });

  it("renders name, compact supply, and a truncated contract", () => {
    expect(aboutRows(TOKEN)).toEqual([
      { label: "Full name", value: "Hyperliquid" },
      { label: "Total supply", value: "999.9M" },
      { label: "Contract", value: "0x1baA…34d5" },
    ]);
  });

  it("OMITS a null attribute rather than dashing it — absence is ordinary here", () => {
    expect(aboutRows({ ...TOKEN, fullName: null }).map((r) => r.label)).toEqual([
      "Total supply",
      "Contract",
    ]);
    expect(aboutRows({ ...TOKEN, evmContract: null }).map((r) => r.label)).toEqual([
      "Full name",
      "Total supply",
    ]);
    expect(aboutRows({ ...TOKEN, totalSupply: null }).map((r) => r.label)).toEqual([
      "Full name",
      "Contract",
    ]);
  });

  it("treats an empty-string name as absent, not as a blank row", () => {
    expect(aboutRows({ ...TOKEN, fullName: "" }).map((r) => r.label)).not.toContain("Full name");
  });

  it("is empty for a null token — the caller skips the card", () => {
    expect(aboutRows(null)).toEqual([]);
  });
});

describe("predictionSideRows", () => {
  const OUTCOME = {
    sides: [
      { name: "Yes", wireCoin: "#1021700" },
      { name: "No", wireCoin: "#1021701" },
    ],
  };

  it("prices both sides from their own book", () => {
    const rows = predictionSideRows(
      OUTCOME,
      new Map([
        ["#1021700", { markPx: "0.624" }],
        ["#1021701", { markPx: "0.376" }],
      ])
    );
    expect(rows).toEqual([
      { name: "Yes", wireCoin: "#1021700", probability: "62.4%" },
      { name: "No", wireCoin: "#1021701", probability: "37.6%" },
    ]);
  });

  it("VISIBLY sums to 100% even when both sides sit on the rounding boundary", () => {
    // 62.45 and 37.55 both round up independently: 62.5 + 37.6 = 100.1. The
    // second side must display as the complement of the first.
    const rows = predictionSideRows(
      OUTCOME,
      new Map([
        ["#1021700", { markPx: "0.6245" }],
        ["#1021701", { markPx: "0.3755" }],
      ])
    );
    expect(rows[0]!.probability).toBe("62.5%");
    expect(rows[1]!.probability).toBe("37.5%");
    const sum = rows.reduce(
      (total, row) => total.plus(toBigNumber(row.probability!.replace("%", ""))),
      toBigNumber("0")
    );
    expect(sum.toFixed(1)).toBe("100.0");
  });

  it("leaves an unpriced side null and does not derive it from the other", () => {
    const rows = predictionSideRows(OUTCOME, new Map([["#1021700", { markPx: "0.624" }]]));
    expect(rows[0]!.probability).toBe("62.4%");
    expect(rows[1]!.probability).toBeNull();
  });

  it("is null on both sides before any ctx arrives", () => {
    const rows = predictionSideRows(OUTCOME, new Map());
    expect(rows.map((r) => r.probability)).toEqual([null, null]);
  });

  it("nulls a malformed side and lets the other stand on its own price", () => {
    const rows = predictionSideRows(
      OUTCOME,
      new Map([
        ["#1021700", { markPx: "junk" }],
        ["#1021701", { markPx: "0.376" }],
      ])
    );
    expect(rows[0]!.probability).toBeNull();
    expect(rows[1]!.probability).toBe("37.6%");
  });

  it("prices three or more sides independently — no pairwise complement exists", () => {
    const rows = predictionSideRows(
      { sides: ["a", "b", "c"].map((name, i) => ({ name, wireCoin: `#${i}` })) },
      new Map([
        ["#0", { markPx: "0.5" }],
        ["#1", { markPx: "0.3" }],
        ["#2", { markPx: "0.2" }],
      ])
    );
    expect(rows.map((r) => r.probability)).toEqual(["50.0%", "30.0%", "20.0%"]);
  });
});

describe("truncateAddress", () => {
  it("keeps the first six and last four around one ellipsis", () => {
    expect(truncateAddress("0x1baAe07Bff112233445566778899aabbccdd34d5")).toBe("0x1baA…34d5");
  });

  it("passes short strings through unchanged", () => {
    expect(truncateAddress("0x1234567")).toBe("0x1234567");
    expect(truncateAddress("")).toBe("");
  });
});

describe("spotDetailFor", () => {
  // Token array deliberately OUT of index order: position 0 holds index 2.
  // The join must go through the `index` FIELD; array position is not aligned
  // on the wire and a positional lookup returns the wrong token silently.
  const META = {
    universe: [
      { name: "@107", tokens: [2, 0] as const },
      { name: "PURR/USDC", tokens: [1, 0] as const },
    ],
    tokens: [
      {
        name: "HYPE",
        index: 2,
        fullName: "Hyperliquid",
        evmContract: { address: "0x1baAe07Bff112233445566778899aabbccdd34d5" },
      },
      { name: "USDC", index: 0, fullName: null, evmContract: null },
      { name: "PURR", index: 1, fullName: null, evmContract: null },
    ],
  };
  const CTXS = [
    {
      coin: "@107",
      markPx: "44.5",
      prevDayPx: "43.0",
      dayNtlVlm: "1000000.0",
      circulatingSupply: "334000000.0",
      totalSupply: "1000000000.0",
    },
    {
      coin: "PURR/USDC",
      markPx: "0.17",
      prevDayPx: "0.18",
      dayNtlVlm: "5000.0",
      circulatingSupply: "600000000.0",
      totalSupply: "1000000000.0",
    },
  ];

  it("joins the base token by its index FIELD, never by array position", () => {
    const detail = spotDetailFor(META, CTXS, "@107");
    expect(detail.token).toEqual({ name: "HYPE" });
    expect(detail.about?.fullName).toBe("Hyperliquid");
  });

  it("joins the ctx by coin and splits totalSupply (ctx) from fullName/contract (token)", () => {
    const detail = spotDetailFor(META, CTXS, "@107");
    expect(detail.ctx).toEqual({
      markPx: "44.5",
      dayNtlVlm: "1000000.0",
      circulatingSupply: "334000000.0",
    });
    expect(detail.about).toEqual({
      fullName: "Hyperliquid",
      totalSupply: "1000000000.0",
      evmContract: { address: "0x1baAe07Bff112233445566778899aabbccdd34d5" },
    });
    expect(detail.prevDayPx).toBe("43.0");
    expect(detail.markPx).toBe("44.5");
  });

  it("resolves a canonical pair by its literal name — no @ prefix assumed", () => {
    const detail = spotDetailFor(META, CTXS, "PURR/USDC");
    expect(detail.token).toEqual({ name: "PURR" });
    expect(detail.ctx?.markPx).toBe("0.17");
  });

  it("keeps the token when only the ctx is missing — the tiles dash independently", () => {
    const detail = spotDetailFor(META, [], "@107");
    expect(detail.token).toEqual({ name: "HYPE" });
    expect(detail.ctx).toBeNull();
    // About survives on token attributes; the ctx-borne totalSupply stays null.
    expect(detail.about).toEqual({
      fullName: "Hyperliquid",
      totalSupply: null,
      evmContract: { address: "0x1baAe07Bff112233445566778899aabbccdd34d5" },
    });
    expect(detail.prevDayPx).toBeNull();
  });

  it("is all-null for an unknown pair — absence, not an invented market", () => {
    const detail = spotDetailFor(META, CTXS, "@999");
    expect(detail).toEqual({ token: null, ctx: null, about: null, prevDayPx: null, markPx: null });
  });
});

describe("outcomeByWireCoin", () => {
  const OUTCOMES = [
    {
      name: "one",
      sides: [{ wireCoin: "#1021700" }, { wireCoin: "#1021701" }],
    },
    {
      name: "two",
      sides: [{ wireCoin: "#1021800" }, { wireCoin: "#1021801" }],
    },
  ];

  it("finds the outcome owning the yes side", () => {
    expect(outcomeByWireCoin(OUTCOMES, "#1021800")?.name).toBe("two");
  });

  it("finds the outcome owning the NO side too — either spelling resolves", () => {
    expect(outcomeByWireCoin(OUTCOMES, "#1021701")?.name).toBe("one");
  });

  it("is null for an unknown coin and for an unresolved catalog", () => {
    expect(outcomeByWireCoin(OUTCOMES, "#999")).toBeNull();
    expect(outcomeByWireCoin(null, "#1021700")).toBeNull();
  });
});

describe("predictionStatTiles", () => {
  it("renders volume compact and quote verbatim", () => {
    const tiles = predictionStatTiles({
      dayNtlVlm: "1250000.0",
      quoteToken: "USDC",
      venue: "kalshi",
    });
    expect(tiles).toEqual([
      { label: "24h volume", value: "$1.2M" },
      { label: "Quote", value: "USDC" },
      { label: "Venue", value: "kalshi" },
    ]);
  });

  it("OMITS the venue tile when venue is null — absent metadata, not a load failure", () => {
    const tiles = predictionStatTiles({ dayNtlVlm: "0.0", quoteToken: "USDC", venue: null });
    expect(tiles.map((tile) => tile.label)).toEqual(["24h volume", "Quote"]);
  });

  it("dashes volume and quote via null while their sources are unloaded", () => {
    const tiles = predictionStatTiles({ dayNtlVlm: null, quoteToken: null, venue: null });
    expect(tiles).toEqual([
      { label: "24h volume", value: null },
      { label: "Quote", value: null },
    ]);
  });

  it("nulls a malformed volume rather than printing dashes-as-data", () => {
    const tiles = predictionStatTiles({ dayNtlVlm: "junk", quoteToken: "USDC", venue: null });
    expect(tiles[0]).toEqual({ label: "24h volume", value: null });
  });
});

describe("toSparkPoints", () => {
  it("converts ms to seconds with the close as a display-leaf number", () => {
    expect(
      toSparkPoints([
        [1786600000000, "63645.0"],
        [1786603600000, "63700.5"],
      ])
    ).toEqual([
      { time: 1786600000, value: 63645 },
      { time: 1786603600, value: 63700.5 },
    ]);
  });

  it("drops a non-finite close — a hole beats a spike to zero", () => {
    expect(toSparkPoints([[1786600000000, "abc"]])).toEqual([]);
  });
});
