import {
  averageEntryPrice,
  fetchOutcomeHoldings,
  holdingByWireCoin,
  nonZero,
  outcomeHoldingsOf,
  parseOutcomeHoldings,
  totalCostBasis,
} from "@/hyperliquid/predictions/holdings";
import { parseSpotState } from "@/hyperliquid/state/accountWire";

import holder from "@/hyperliquid/predictions/__fixtures__/spot-balances-holder-mainnet.json";

const balances = (holder as { balances: unknown[] }).balances;

describe("the recorded mainnet holder", () => {
  const holdings = parseOutcomeHoldings(balances);

  it("finds outcome rows the perp position parser cannot see", () => {
    // The whole point of this module. `state/accountWire.ts` reads
    // `clearinghouseState.assetPositions`, which held 0 outcome rows on 4 of 4
    // live holders while spot balances held 5-20.
    expect(holdings.unsettled.length + holdings.settled.length).toBeGreaterThan(0);
  });

  it("ignores ordinary spot coins entirely", () => {
    // USDC is in the same array and is not a prediction market.
    const coins = [
      ...holdings.unsettled.map((h) => h.balanceCoin),
      ...holdings.settled.map((h) => h.balanceCoin),
    ];
    expect(coins.every((coin) => /^[+o]\d+$/.test(coin))).toBe(true);
    expect(coins).not.toContain("USDC");
  });

  it("decodes a live `+N` row into an addressable market", () => {
    // 2 of the holder's 16 outcome rows carry shares; the other 14 are closed
    // positions the exchange keeps at zero.
    const [live] = nonZero(holdings.unsettled);
    expect(nonZero(holdings.unsettled)).toHaveLength(2);
    expect(live.balanceCoin).toBe(`+${live.outcomeId * 10 + live.sideIndex}`);
    expect(live.wireCoin).toBe(`#${live.outcomeId * 10 + live.sideIndex}`);
    expect(live.assetId).toBe(100_000_000 + live.outcomeId * 10 + live.sideIndex);
  });

  it("separates the two prefixes as recorded", () => {
    expect(holdings.unsettled).toHaveLength(10);
    expect(holdings.settled).toHaveLength(6);
    // Every settled row on this holder is already at zero — they resolved and
    // paid out. `nonZero` is what keeps them off a portfolio screen.
    expect(nonZero(holdings.settled)).toHaveLength(0);
  });

  it("reads `hold` — shares locked in a resting order are not sellable", () => {
    const locked = nonZero(holdings.unsettled).find((h) => h.held !== "0.0");
    expect(locked?.held).toBe("93.0");
  });

  it("keeps every quantity a string", () => {
    for (const h of holdings.unsettled) {
      expect(typeof h.shares).toBe("string");
      expect(typeof h.costBasis).toBe("string");
    }
  });
});

describe("the three row shapes", () => {
  const rows = [
    { coin: "USDC", token: 0, total: "8093.99658198", hold: "0.0", entryNtl: "0.0" },
    { coin: "+10170", total: "6923.0", hold: "0.0", entryNtl: "3535.56496788" },
    { coin: "o498", total: "12.0", hold: "0.0", entryNtl: "6.0" },
  ];

  it("splits them by prefix, not by the absent `token` field", () => {
    // Outcome rows happen to carry no `token`, but the prefix is what actually
    // encodes the meaning, and a wire that started sending `token` would not
    // change what `+10170` is.
    const { unsettled, settled } = parseOutcomeHoldings(rows);
    expect(unsettled).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(unsettled[0].shares).toBe("6923.0");
    expect(settled[0].outcomeId).toBe(498);
  });

  it("reads `oN` as an OUTCOME ID, never as the side encoding", () => {
    // `o482` is outcome 482 — settledOutcome(482) resolves it to "Argentina".
    // Decoding it as `outcomeId*10 + sideIndex` gives outcome 48 side 2, and no
    // market has a side 2.
    const { settled } = parseOutcomeHoldings([
      { coin: "o482", total: "5.0", hold: "0.0", entryNtl: "2.5" },
    ]);
    expect(settled[0].outcomeId).toBe(482);
    expect(settled[0]).not.toHaveProperty("sideIndex");
  });

  it("does not confuse a settled row for a live one, or vice versa", () => {
    const { unsettled, settled } = parseOutcomeHoldings([
      { coin: "+482", total: "1.0", hold: "0.0", entryNtl: "0.5" },
      { coin: "o482", total: "1.0", hold: "0.0", entryNtl: "0.5" },
    ]);
    // `+482` is outcome 48 side 2 by the encoding; `o482` is outcome 482. Same
    // digits, different markets.
    expect(unsettled[0].outcomeId).toBe(48);
    expect(unsettled[0].sideIndex).toBe(2);
    expect(settled[0].outcomeId).toBe(482);
  });

  it("drops rows it cannot attribute", () => {
    expect(parseOutcomeHoldings([{ coin: "+abc" }, { coin: "" }, null, 42])).toEqual({
      unsettled: [],
      settled: [],
    });
    expect(parseOutcomeHoldings(null)).toEqual({ unsettled: [], settled: [] });
  });

  it("defaults a missing quantity to 0 rather than undefined", () => {
    const { unsettled } = parseOutcomeHoldings([{ coin: "+10170" }]);
    expect(unsettled[0]).toMatchObject({ shares: "0", held: "0", costBasis: "0" });
  });
});

describe("derived figures", () => {
  const holding = { shares: "6923.0", costBasis: "3535.56496788" };

  it("computes the average entry price from two wire values", () => {
    // Both terms come off the wire, so this derives no price-dependent number —
    // the rule `state/accountWire.ts` follows when it refuses to recompute
    // `unrealizedPnl`. Anything needing a CURRENT value must take a book price,
    // and that stays out of this module.
    // 3535.56496788 / 6923 = 0.5106983920092445471616… — about 51 cents a share
    // on a market that pays $1 or $0.
    expect(averageEntryPrice(holding)).toBe("0.51069839200924454716");
  });

  it("returns null for zero shares, not zero", () => {
    // A zero average reads as "bought at nothing" — a free position rather than
    // no position.
    expect(averageEntryPrice({ shares: "0.0", costBasis: "0.0" })).toBeNull();
  });

  it("sums cost basis exactly", () => {
    // 0.1 + 0.2 is 0.30000000000000004 as a double.
    expect(totalCostBasis([{ costBasis: "0.1" }, { costBasis: "0.2" }])).toBe("0.3");
    expect(totalCostBasis([])).toBe("0");
  });

  it("filters out closed positions, whose rows persist at zero", () => {
    const rows = [
      { shares: "0.0", costBasis: "0.0" },
      { shares: "12.0", costBasis: "6.0" },
    ];
    expect(nonZero(rows)).toHaveLength(1);
  });

  it("finds a holding by the wire coin the feeds echo", () => {
    const holdings = parseOutcomeHoldings([
      { coin: "+10170", total: "6923.0", hold: "0.0", entryNtl: "3535.56" },
    ]);
    expect(holdingByWireCoin(holdings, "#10170")?.shares).toBe("6923.0");
    expect(holdingByWireCoin(holdings, "#99999")).toBeNull();
  });
});

describe("reading from the live spot store", () => {
  it("finds the same holdings the socket already delivered", () => {
    // The store renames the wire's fields on the way in, so handing its rows to
    // `parseOutcomeHoldings` type-checks against `unknown` and silently yields
    // zero for every quantity. This is why the second reader exists.
    const stored = parseSpotState({
      balances: [
        { coin: "USDC", token: 0, total: "100.0", hold: "0.0", entryNtl: "0.0" },
        { coin: "+10170", total: "6923.0", hold: "93.0", entryNtl: "3535.56496788" },
        { coin: "o498", total: "12.0", hold: "0.0", entryNtl: "6.0" },
      ],
    });

    const holdings = outcomeHoldingsOf(stored);
    expect(holdings.unsettled).toHaveLength(1);
    expect(holdings.settled).toHaveLength(1);
    expect(holdings.unsettled[0]).toMatchObject({
      outcomeId: 1017,
      sideIndex: 0,
      wireCoin: "#10170",
      shares: "6923.0",
      held: "93.0",
      costBasis: "3535.56496788",
    });
  });

  it("agrees with the raw-wire parser row for row", () => {
    // Two readers, one decoder. If they ever disagree, one screen shows a
    // position the other does not.
    const raw = (holder as { balances: unknown[] }).balances;
    const viaWire = parseOutcomeHoldings(raw);
    const viaStore = outcomeHoldingsOf(parseSpotState({ balances: raw }));
    expect(viaStore).toEqual(viaWire);
  });

  it("reads an unseeded store as empty rather than throwing", () => {
    expect(outcomeHoldingsOf(null)).toEqual({ unsettled: [], settled: [] });
  });
});

describe("fetchOutcomeHoldings", () => {
  it("reads the user's spot state and parses only the outcome rows", async () => {
    const calls: { user: string }[] = [];
    const holdings = await fetchOutcomeHoldings({
      probe: {
        spotClearinghouseState: async (params) => {
          calls.push(params);
          return { balances };
        },
      },
      user: "0x0e7d09a53f348fcef8bb139af9ebb552f4a33fe9",
    });

    expect(calls[0].user).toBe("0x0e7d09a53f348fcef8bb139af9ebb552f4a33fe9");
    expect(holdings.unsettled.length).toBeGreaterThan(0);
  });

  it("survives a response with no balances at all", async () => {
    const holdings = await fetchOutcomeHoldings({
      probe: { spotClearinghouseState: async () => null },
      user: "0x1",
    });
    expect(holdings).toEqual({ unsettled: [], settled: [] });
  });
});
