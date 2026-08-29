/**
 * The three joins, and every place a row could quietly lie.
 *
 * Fixtures are real testnet slices (2026-08-15): SOL/APT liquid, MATIC
 * delisted with `midPx`/`premium`/`impactPxs` co-null, POLYX live at zero
 * volume; PURR/USDC plus a thin `@1` (null mid) and a liquid `@1035` (HYPE);
 * prediction sides `#102380`/`#102381` ("Brazil", marks 0.7175 + 0.2825 = 1)
 * and `#70020`/`#70021` ("Other", flat at 0.5). The spot fixture's ctxs are
 * deliberately NOT in universe order — as on the live wire, where 1,305 of
 * 1,309 same-index pairs disagree.
 */

import {
  buildPerpRows,
  buildPredictionRows,
  buildSpotRows,
  change24hPct,
  filterRows,
  orderRows,
  overlayMids,
  sortRows,
  type MarketRow,
  type PerpCtxsInput,
  type SpotCtxsInput,
} from "@/hyperliquid/markets/rows";
import { HlError } from "@/hyperliquid/core/errors";
import { toBigNumber } from "@/hyperliquid/core/precision";
import type { PredictionOutcome } from "@/hyperliquid/predictions/types";

import perpJson from "@/hyperliquid/markets/__fixtures__/meta-ctxs-testnet-slice.json";
import spotJson from "@/hyperliquid/markets/__fixtures__/spot-ctxs-testnet-slice.json";

// A JSON import widens the wire tuple to a plain array (and literal `true` to
// `boolean`), so each fixture gets its one cast here, at the unpack.
const PERP_FIXTURE = perpJson as unknown as PerpCtxsInput;
const SPOT_FIXTURE = spotJson as unknown as SpotCtxsInput;

/** Real testnet outcome 10238, as `predictions/catalog.ts` would parse it. */
const BRAZIL: PredictionOutcome = {
  outcomeId: 10238,
  name: "Brazil",
  description: "This outcome resolves to Yes if Brazil wins the 2026 HYPURR World Cup.",
  attributes: null,
  quoteToken: "USDC",
  venue: null,
  sides: [
    { sideIndex: 0, name: "Yes", assetId: 100102380, wireCoin: "#102380", balanceCoin: "+102380" },
    { sideIndex: 1, name: "No", assetId: 100102381, wireCoin: "#102381", balanceCoin: "+102381" },
  ],
};

/** Outcome 7002 with its name blanked — "listed but unnameable". */
const UNNAMED_OTHER: PredictionOutcome = {
  outcomeId: 7002,
  name: "",
  description: "N/A",
  attributes: null,
  quoteToken: "USDH",
  venue: null,
  sides: [
    { sideIndex: 0, name: "Yes", assetId: 100070020, wireCoin: "#70020", balanceCoin: "+70020" },
    { sideIndex: 1, name: "No", assetId: 100070021, wireCoin: "#70021", balanceCoin: "+70021" },
  ],
};

describe("buildPerpRows", () => {
  it("throws HlError on a universe/ctx length mismatch instead of zipping short", () => {
    // The ctx side carries no key — the index IS the join. Zipping a short
    // response would dress every market after the gap in its neighbour's
    // prices, so no output should survive a mismatch.
    const [meta, ctxs] = PERP_FIXTURE;
    expect(() => buildPerpRows([meta, ctxs.slice(0, 3)])).toThrow(HlError);
    try {
      buildPerpRows([meta, ctxs.slice(0, 3)]);
    } catch (error) {
      expect((error as HlError).code).toBe("validation_error");
    }
  });

  it("drops delisted markets by default", () => {
    const rows = buildPerpRows(PERP_FIXTURE);

    expect(rows.map((row) => row.symbol)).toEqual(["SOL", "APT", "POLYX"]);
    expect(rows.some((row) => row.symbol === "MATIC")).toBe(false);
  });

  it("keeps delisted markets behind the flag, still marked on the row", () => {
    const rows = buildPerpRows(PERP_FIXTURE, { includeDelisted: true });
    const matic = rows.find((row) => row.symbol === "MATIC");

    expect(rows).toHaveLength(4);
    expect(matic?.isDelisted).toBe(true);
    // Delisted means bookless: mid is null, so the row prices at the mark.
    expect(matic?.midPx).toBeNull();
    expect(matic?.px).toBe("0.37035");
  });

  it("joins ctx to universe by index and prefers the mid as px", () => {
    const [sol] = buildPerpRows(PERP_FIXTURE);

    expect(sol).toMatchObject({
      kind: "perp",
      symbol: "SOL",
      wireCoin: "SOL",
      px: "75.3765",
      markPx: "75.377",
      midPx: "75.3765",
      prevDayPx: "75.563",
      dayNtlVlm: "288129.86073",
      funding: "0.0000125",
      openInterest: "7055.74",
      maxLeverage: 10,
      szDecimals: 2,
      isDelisted: false,
      sideName: null,
    });
  });

  it('keeps a real "0.0" volume as-is rather than nulling it', () => {
    // 63 of 210 live perps report exactly "0.0" — a measured zero, not a gap.
    const polyx = buildPerpRows(PERP_FIXTURE).find((row) => row.symbol === "POLYX");

    expect(polyx?.dayNtlVlm).toBe("0.0");
  });
});

describe("buildSpotRows", () => {
  it("joins by ctx.coin, so the misordered ctxs still land on their own pairs", () => {
    // The fixture's ctx[0] is prediction `#102380` while universe[0] is
    // PURR/USDC — an index join would price PURR at 0.7175. Live it is worse:
    // 1,305 of 1,309 same-index pairs disagree.
    const { spot } = buildSpotRows(SPOT_FIXTURE);
    const purr = spot.find((row) => row.wireCoin === "PURR/USDC");

    expect(purr?.markPx).toBe("4.6252");
    expect(purr?.px).toBe("4.60235");
  });

  it("names an @N pair by its BASE token, never by the pair id", () => {
    const { spot } = buildSpotRows(SPOT_FIXTURE);
    const hype = spot.find((row) => row.wireCoin === "@1035");

    expect(hype?.symbol).toBe("HYPE");
    expect(hype?.szDecimals).toBe(2);
    expect(hype?.px).toBe("41.043");
  });

  it("falls back to the mark — never to zero — on a thin pair with a null mid", () => {
    // 1,523 of 2,492 live spot ctxs have midPx null. The mark is the honest
    // price for them; the null stays on the row so a view can tell.
    const { spot } = buildSpotRows(SPOT_FIXTURE);
    const thin = spot.find((row) => row.wireCoin === "@1");

    expect(thin?.midPx).toBeNull();
    expect(thin?.px).toBe("1.0936");
  });

  it("routes #N ctxs into the prediction map, not into spot rows", () => {
    const { spot, predictionCtxs } = buildSpotRows(SPOT_FIXTURE);

    expect(spot).toHaveLength(3);
    expect(spot.some((row) => row.wireCoin.startsWith("#"))).toBe(false);
    expect([...predictionCtxs.keys()].sort()).toEqual(["#102380", "#102381", "#70020", "#70021"]);
  });

  it("gives a spot row no perp concepts — null, not zero", () => {
    const { spot } = buildSpotRows(SPOT_FIXTURE);

    for (const row of spot) {
      expect(row.kind).toBe("spot");
      expect(row.funding).toBeNull();
      expect(row.openInterest).toBeNull();
      expect(row.maxLeverage).toBeNull();
      expect(row.sideName).toBeNull();
      expect(row.isDelisted).toBe(false);
    }
  });
});

describe("buildPredictionRows", () => {
  const ctxsOf = () => buildSpotRows(SPOT_FIXTURE).predictionCtxs;

  it("pins the measured invariant the design rests on: side marks sum to 1", () => {
    // If a fixture edit ever breaks this, the yes-mark-as-probability row is
    // no longer showing what it claims to show.
    const ctxs = ctxsOf();
    const sum = toBigNumber(ctxs.get("#102380")!.markPx).plus(ctxs.get("#102381")!.markPx);

    expect(sum.toFixed()).toBe("1");
  });

  it("builds ONE row per outcome, priced by the yes side, volumes summed", () => {
    const rows = buildPredictionRows(ctxsOf(), { outcomes: [BRAZIL] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "prediction",
      symbol: "Brazil",
      sideName: "Yes",
      wireCoin: "#102380",
      px: "0.7175",
      markPx: "0.7175",
      prevDayPx: "0.7175",
      // 11.48 (yes) + 4.52 (no), summed as BigNumber — one market's volume,
      // not one side's.
      dayNtlVlm: "16",
      funding: null,
      openInterest: null,
      maxLeverage: null,
      szDecimals: null,
      isDelisted: false,
    });
  });

  it("drops an outcome the catalog does not list — no placeholder name", () => {
    // A settled outcome is deleted from `outcomeMeta` while its ctxs live on.
    // Inventing "Outcome 7002" would present a guess as knowledge.
    const rows = buildPredictionRows(ctxsOf(), { outcomes: [BRAZIL] });

    expect(rows.some((row) => row.wireCoin.startsWith("#7002"))).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("drops an outcome the catalog lists without a name", () => {
    const rows = buildPredictionRows(ctxsOf(), { outcomes: [BRAZIL, UNNAMED_OTHER] });

    expect(rows.map((row) => row.symbol)).toEqual(["Brazil"]);
  });

  it("drops an outcome whose yes-side ctx is missing rather than pricing it off the no side", () => {
    const noSideOnly = new Map([["#102381", ctxsOf().get("#102381")!]]);

    expect(buildPredictionRows(noSideOnly, { outcomes: [BRAZIL] })).toEqual([]);
  });
});

describe("change24hPct", () => {
  it("computes a signed percentage from the wire strings", () => {
    // SOL slid overnight: (75.3765 − 75.563) / 75.563 × 100 — the sign must
    // survive, a gain and a loss are not the same news.
    expect(change24hPct("75.3765", "75.563")).toBe("-0.25");
    expect(change24hPct("0.5417", "0.5397")).toBe("0.37");
  });

  it('reports a flat market as "0.00", which is a real number, not an absence', () => {
    expect(change24hPct("0.7175", "0.7175")).toBe("0.00");
  });

  it("returns null — never a fake 0.00 — when either side is unknowable", () => {
    // `prevDayPx` is "0.0" on a market that did not exist yesterday (the @1
    // fixture pair): the change is unknowable, not zero and not infinite.
    expect(change24hPct("1.0936", "0.0")).toBeNull();
    expect(change24hPct(null, "75.563")).toBeNull();
    expect(change24hPct("75.3765", null)).toBeNull();
    expect(change24hPct("75.3765", "-1")).toBeNull();
    expect(change24hPct("abc", "75.563")).toBeNull();
    expect(change24hPct("75.3765", "abc")).toBeNull();
  });
});

describe("overlayMids", () => {
  it("returns the SAME array reference when no price moved", () => {
    // This runs on a 15 s poll; a fresh array on a quiet market re-renders
    // every row for nothing.
    const rows = buildPerpRows(PERP_FIXTURE);
    const unchanged = overlayMids(rows, {
      SOL: "75.3765",
      APT: "0.5417",
      POLYX: "0.029315",
    });

    expect(unchanged).toBe(rows);
  });

  it("returns the same reference for prediction rows against an empty poll", () => {
    // A prediction row's px is its mark; an absent mid falls back to the mark,
    // so an empty poll changes nothing.
    const rows = buildPredictionRows(buildSpotRows(SPOT_FIXTURE).predictionCtxs, {
      outcomes: [BRAZIL],
    });

    expect(overlayMids(rows, {})).toBe(rows);
  });

  it("swaps only the moved rows, keeping every other row's identity", () => {
    const rows = buildPerpRows(PERP_FIXTURE);
    const next = overlayMids(rows, { SOL: "76.0", APT: "0.5417", POLYX: "0.029315" });

    expect(next).not.toBe(rows);
    expect(next[0].px).toBe("76.0");
    expect(next[0]).not.toBe(rows[0]);
    // Unmoved rows keep their object identity so their list rows skip render.
    expect(next[1]).toBe(rows[1]);
    expect(next[2]).toBe(rows[2]);
    // The input is data someone else may still hold — never mutated.
    expect(rows[0].px).toBe("75.3765");
  });

  it("falls back to the mark for a coin the poll does not carry", () => {
    const rows = buildPerpRows(PERP_FIXTURE);
    const next = overlayMids(rows, { SOL: "75.3765", POLYX: "0.029315" });

    // APT's built px was its mid; with no fresh mid the honest price is the
    // snapshot's mark, not a stale mid presented as current.
    expect(next[1].px).toBe("0.5416");
  });
});

describe("sortRows", () => {
  it("orders by volume descending, compared as numbers rather than strings", () => {
    // Lexicographically "9.5" > "1000.0". The 24h-volume column is exactly
    // where that bug produces a plausible-looking but shuffled list.
    const polyx = buildPerpRows(PERP_FIXTURE)[2];
    const small: MarketRow = { ...polyx, symbol: "AAA", dayNtlVlm: "9.5" };
    const large: MarketRow = { ...polyx, symbol: "ZZZ", dayNtlVlm: "1000.0" };

    expect(sortRows([small, large]).map((row) => row.symbol)).toEqual(["ZZZ", "AAA"]);
  });

  it("breaks volume ties by symbol, stably across input orders", () => {
    // 63 of 210 live perps tie at exactly "0.0" — without a total order they
    // would shuffle on every rebuild.
    const rows = buildPerpRows(PERP_FIXTURE, { includeDelisted: true });
    const sorted = sortRows(rows).map((row) => row.symbol);
    const reSorted = sortRows([...rows].reverse()).map((row) => row.symbol);

    expect(sorted).toEqual(["SOL", "APT", "MATIC", "POLYX"]);
    expect(reSorted).toEqual(sorted);
  });

  it("returns a new array and leaves the input untouched", () => {
    const rows = buildPerpRows(PERP_FIXTURE);
    const before = rows.map((row) => row.symbol);
    const sorted = sortRows(rows);

    expect(sorted).not.toBe(rows);
    expect(rows.map((row) => row.symbol)).toEqual(before);
  });
});

describe("orderRows", () => {
  // A real perp row as the base, so every field the ranking touches carries a
  // wire-shaped value; each case overrides only what it is about.
  const base = (): MarketRow => buildPerpRows(PERP_FIXTURE)[0];
  const row = (symbol: string, overrides: Partial<MarketRow>): MarketRow => ({
    ...base(),
    symbol,
    wireCoin: symbol,
    ...overrides,
  });

  /** +10%, flat, -10%, and one whose change is unknowable. */
  const spread = (): MarketRow[] => [
    row("FLAT", { px: "100", prevDayPx: "100" }),
    row("UP", { px: "110", prevDayPx: "100" }),
    // `prevDayPx` "0.0" — the market did not exist yesterday.
    row("FRESH", { px: "100", prevDayPx: "0.0" }),
    row("DOWN", { px: "90", prevDayPx: "100" }),
  ];

  it("returns the INPUT ARRAY REFERENCE for volume, not a re-sorted copy", () => {
    // The hook already volume-sorted this once per TTL. A fresh array here
    // defeats every identity check downstream — the blank-query passthrough,
    // the unmoved-row reuse in `overlayMids`, and the list's data compare.
    const rows = buildPerpRows(PERP_FIXTURE);
    const ordered = orderRows(rows, "volume");

    expect(ordered.rows).toBe(rows);
    expect(ordered.unranked).toEqual([]);
  });

  it("ranks gainers by 24h change and parks the unknowable ones in unranked", () => {
    // The pin: FRESH must NOT land between FLAT and DOWN. Sorting a null
    // change as zero claims the exchange reported a flat day.
    const { rows, unranked } = orderRows(spread(), "gainers");

    expect(rows.map((entry) => entry.symbol)).toEqual(["UP", "FLAT", "DOWN"]);
    expect(unranked.map((entry) => entry.symbol)).toEqual(["FRESH"]);
  });

  it("ranks losers most-negative first, with the same unranked bucket", () => {
    const { rows, unranked } = orderRows(spread(), "losers");

    expect(rows.map((entry) => entry.symbol)).toEqual(["DOWN", "FLAT", "UP"]);
    expect(unranked.map((entry) => entry.symbol)).toEqual(["FRESH"]);
  });

  it("ranks open interest by NOTIONAL, not by contract count", () => {
    // 1,000,000 contracts of a $0.001 market is $1k of open interest; 10
    // contracts of a $60,000 one is $600k. Ranking on the raw size puts the
    // cheapest market on top of the list.
    const rows = [
      row("CHEAP", { openInterest: "1000000", markPx: "0.001" }),
      row("DEAR", { openInterest: "10", markPx: "60000" }),
    ];

    expect(orderRows(rows, "oi").rows.map((entry) => entry.symbol)).toEqual(["DEAR", "CHEAP"]);
  });

  it("cannot rank a row that has no open interest — null is not zero", () => {
    // Spot rows carry `openInterest: null` because the concept does not exist
    // there; the mode is perps-only in the UI, and this is why.
    const { spot } = buildSpotRows(SPOT_FIXTURE);
    const { rows, unranked } = orderRows(spot, "oi");

    expect(rows).toEqual([]);
    expect(unranked).toHaveLength(spot.length);
  });

  it("breaks ties by symbol, stably across input orders", () => {
    const tied = [
      row("ZZZ", { px: "110", prevDayPx: "100" }),
      row("AAA", { px: "110", prevDayPx: "100" }),
      row("MMM", { px: "110", prevDayPx: "100" }),
    ];
    const forward = orderRows(tied, "gainers").rows.map((entry) => entry.symbol);
    const reversed = orderRows([...tied].reverse(), "gainers").rows.map((entry) => entry.symbol);

    expect(forward).toEqual(["AAA", "MMM", "ZZZ"]);
    expect(reversed).toEqual(forward);
  });

  it("leaves the input array untouched", () => {
    const rows = spread();
    const before = rows.map((entry) => entry.symbol);
    const ordered = orderRows(rows, "gainers");

    expect(ordered.rows).not.toBe(rows);
    expect(rows.map((entry) => entry.symbol)).toEqual(before);
  });
});

describe("filterRows", () => {
  const allRows = () => {
    const { spot, predictionCtxs } = buildSpotRows(SPOT_FIXTURE);
    return [
      ...buildPerpRows(PERP_FIXTURE),
      ...spot,
      ...buildPredictionRows(predictionCtxs, { outcomes: [BRAZIL] }),
    ];
  };

  it("matches symbols case-insensitively", () => {
    const rows = allRows();

    expect(filterRows(rows, "sol").map((row) => row.symbol)).toEqual(["SOL"]);
    expect(filterRows(rows, "PuRr").map((row) => row.symbol)).toEqual(["PURR"]);
  });

  it("matches a prediction row by its side name too", () => {
    const hit = filterRows(allRows(), "yes");

    expect(hit.map((row) => row.symbol)).toEqual(["Brazil"]);
  });

  it("returns the input array unchanged for a blank query", () => {
    const rows = allRows();

    expect(filterRows(rows, "")).toBe(rows);
    expect(filterRows(rows, "   ")).toBe(rows);
  });

  it("returns an empty list — honestly empty — when nothing matches", () => {
    expect(filterRows(allRows(), "zzzz")).toEqual([]);
  });
});
