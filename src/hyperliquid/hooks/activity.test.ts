/**
 * The activity arithmetic.
 *
 * Every case is a way this block can state something false about a user's
 * trading — a fabricated win rate, a fee total that adds share counts to
 * dollars, or a rebate rendered as a cost.
 */

import { realizedByCoin, summariseActivity } from "@/hyperliquid/hooks/activity";
import type { Fill } from "@/hyperliquid/types/domain";

function fill(overrides: Partial<Fill>): Fill {
  return {
    key: `${Math.random()}`,
    tid: 0,
    oid: 1,
    coin: "BTC",
    side: "buy",
    px: "100",
    sz: "1",
    time: 1,
    startPosition: "0",
    dir: "Open Long",
    closedPnl: "0.0",
    fee: "0.1",
    feeToken: "USDC",
    builderFee: null,
    crossed: true,
    hash: "0x0",
    twapId: null,
    liquidation: null,
    source: "fill",
    ...overrides,
  } as Fill;
}

describe("volume", () => {
  it("is price times size, summed", () => {
    const summary = summariseActivity([
      fill({ px: "63645.0", sz: "0.00024" }),
      fill({ px: "0.51", sz: "20.0" }),
    ]);

    // 15.2748 + 10.2
    expect(summary.volumeUsd).toBe("25.47");
  });

  it("is zero for no fills, without dividing by anything", () => {
    expect(summariseActivity([]).volumeUsd).toBe("0.00");
  });
});

describe("win rate", () => {
  it("counts only fills that CLOSED something", () => {
    // Opening fills report `closedPnl: "0.0"`. Counting them as losses drags
    // the rate toward zero for a user who has simply opened positions.
    const summary = summariseActivity([
      fill({ closedPnl: "0.0" }),
      fill({ closedPnl: "0.0" }),
      fill({ closedPnl: "5" }),
      fill({ closedPnl: "-2" }),
    ]);

    expect(summary.closedCount).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.winRate).toBe("0.5000");
  });

  it("is null — NOT zero — when nothing has been closed", () => {
    // "0% win rate" is a damning claim about someone who has never closed a
    // trade. `null` renders as "--".
    const summary = summariseActivity([fill({ closedPnl: "0.0" })]);

    expect(summary.closedCount).toBe(0);
    expect(summary.winRate).toBeNull();
  });

  it("does not count a break-even close as a win", () => {
    // A zero-PnL fill is not a close at all by this definition, so it neither
    // adds a win nor a loss.
    const summary = summariseActivity([fill({ closedPnl: "0" }), fill({ closedPnl: "1" })]);

    expect(summary.closedCount).toBe(1);
    expect(summary.wins).toBe(1);
  });

  it("sums realised PnL across closes only", () => {
    const summary = summariseActivity([
      fill({ closedPnl: "0.0" }),
      fill({ closedPnl: "5.25" }),
      fill({ closedPnl: "-2.25" }),
    ]);

    expect(summary.realizedPnl).toBe("3.00");
  });
});

describe("fees", () => {
  it("totals USDC fees including the builder fee", () => {
    const summary = summariseActivity([
      fill({ fee: "0.10", feeToken: "USDC", builderFee: "0.02" }),
      fill({ fee: "0.05", feeToken: "USDC", builderFee: null }),
    ]);

    expect(summary.feesUsdc).toBe("0.15");
  });

  it("keeps a maker rebate NEGATIVE", () => {
    // A negative fee is a rebate — real on 433 of 4,000 measured fills. Taking
    // an absolute value turns money earned into money spent.
    const summary = summariseActivity([
      fill({ fee: "-0.03", feeToken: "USDC" }),
      fill({ fee: "0.01", feeToken: "USDC" }),
    ]);

    expect(summary.feesUsdc).toBe("-0.02");
  });

  it("does NOT add a non-USDC fee into the dollar total", () => {
    // Measured live: an outcome fill on this project's own account paid its fee
    // in `+102251` shares. Summing blind adds share counts to dollars.
    const summary = summariseActivity([
      fill({ fee: "0.10", feeToken: "USDC" }),
      fill({ fee: "3", feeToken: "+102251" }),
    ]);

    expect(summary.feesUsdc).toBe("0.1");
    expect(summary.otherFeeTokens).toEqual(["+102251"]);
  });

  it("names a non-USDC fee token rather than silently dropping it", () => {
    const summary = summariseActivity([fill({ fee: "0.0004", feeToken: "HYPE" })]);

    // The USDC figure would otherwise read as "you paid nothing".
    expect(summary.feesUsdc).toBe("0");
    expect(summary.otherFeeTokens).toContain("HYPE");
  });

  it("does not name a token that carried no fee", () => {
    const summary = summariseActivity([fill({ fee: "0", feeToken: "PURR" })]);

    expect(summary.otherFeeTokens).toEqual([]);
  });
});

describe("scope", () => {
  it("reports how many fills the numbers cover", () => {
    // The store holds what the socket pushed plus a REST seed — not all-time.
    // A screen must be able to say so.
    expect(summariseActivity([fill({}), fill({})]).fillCount).toBe(2);
  });
});

describe("realizedByCoin", () => {
  it("excludes coins that only ever opened — absence, not $0.00", () => {
    const rows = realizedByCoin([
      fill({ coin: "BTC", closedPnl: "0.0" }),
      fill({ coin: "ETH", closedPnl: "2.5" }),
    ]);
    expect(rows.map((row) => row.coin)).toEqual(["ETH"]);
  });

  it("sums per coin with BigNumber and counts closes", () => {
    const rows = realizedByCoin([
      fill({ coin: "BTC", closedPnl: "0.1" }),
      fill({ coin: "BTC", closedPnl: "0.2" }),
      fill({ coin: "BTC", closedPnl: "-0.05" }),
    ]);
    expect(rows).toEqual([{ coin: "BTC", pnl: "0.25", closedCount: 3 }]);
  });

  it("orders by absolute impact, so a big loss is not buried under small wins", () => {
    const rows = realizedByCoin([
      fill({ coin: "ETH", closedPnl: "1" }),
      fill({ coin: "BTC", closedPnl: "-50" }),
      fill({ coin: "SOL", closedPnl: "3" }),
    ]);
    expect(rows.map((row) => row.coin)).toEqual(["BTC", "SOL", "ETH"]);
  });

  it("is empty for no fills", () => {
    expect(realizedByCoin([])).toEqual([]);
  });
});
