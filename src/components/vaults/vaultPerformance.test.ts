import {
  periodOf,
  periodPnl,
  periodReturn,
  periodVolume,
  returnPercent,
} from "@/components/vaults/vaultPerformance";
import type { PortfolioPeriod } from "@/hyperliquid/vaults/types";

function period(over: Partial<PortfolioPeriod> & { period: string }): PortfolioPeriod {
  return {
    accountValueHistory: [],
    pnlHistory: [],
    vlm: "0.0",
    ...over,
  };
}

/** The measured HLP month: profitable while account value fell by a third. */
const HLP_MONTH = period({
  period: "month",
  accountValueHistory: [
    [1, "252478596.42"],
    [2, "186966387.87"],
  ],
  pnlHistory: [
    [1, "0.0"],
    [2, "6188.27"],
  ],
  vlm: "0.0",
});

describe("periodOf", () => {
  it("finds a period and is null for one the wire did not send", () => {
    expect(periodOf([HLP_MONTH], "month")).toBe(HLP_MONTH);
    expect(periodOf([HLP_MONTH], "week")).toBeNull();
    expect(periodOf([], "month")).toBeNull();
  });
});

describe("periodPnl", () => {
  it("measures P&L over the P&L series, ignoring the value collapse", () => {
    // Account value fell $252M → $187M on withdrawals; the vault still MADE
    // money. A value delta would report a $65M loss.
    expect(periodPnl(HLP_MONTH)).toBe("6188.27");
  });

  it("is null with nothing to subtract", () => {
    expect(periodPnl(null)).toBeNull();
    expect(periodPnl(period({ period: "day", pnlHistory: [[1, "5"]] }))).toBeNull();
    expect(
      periodPnl(
        period({
          period: "day",
          pnlHistory: [
            [1, "x"],
            [2, "y"],
          ],
        })
      )
    ).toBeNull();
  });
});

describe("periodReturn", () => {
  it("divides P&L by the equity the window opened with", () => {
    // 6188.27 / 252478596.42
    expect(periodReturn(HLP_MONTH)).toBe("0.00002451007763725749");
  });

  it("is null when the window opened at zero equity — the measured allTime case", () => {
    // HLP's allTime series starts empty. 0% there would claim a flat all-time
    // return for a vault that has earned millions.
    expect(
      periodReturn(
        period({
          period: "allTime",
          accountValueHistory: [
            [1, "0"],
            [2, "500"],
          ],
          pnlHistory: [
            [1, "0"],
            [2, "500"],
          ],
        })
      )
    ).toBeNull();
  });

  it("is null when there is no P&L to measure", () => {
    expect(periodReturn(null)).toBeNull();
  });

  it("carries a loss through as negative", () => {
    expect(
      periodReturn(
        period({
          period: "day",
          accountValueHistory: [[1, "1000"]],
          pnlHistory: [
            [1, "0"],
            [2, "-50"],
          ],
        })
      )
    ).toBe("-0.05");
  });
});

describe("returnPercent", () => {
  it("signs a gain and leaves a true zero unsigned", () => {
    expect(returnPercent("0.0025")).toBe("+0.25%");
    expect(returnPercent("-0.05")).toBe("-5.00%");
    expect(returnPercent("0")).toBe("0.00%");
  });

  it("passes null through rather than inventing a figure", () => {
    expect(returnPercent(null)).toBeNull();
    expect(returnPercent("nonsense")).toBeNull();
  });
});

describe("periodVolume", () => {
  it("reports the wire's zero as zero — the official app shows the same", () => {
    // A measured "0.0" is an answer; only an absent period is unknown.
    expect(periodVolume(HLP_MONTH)).toBe("0");
    expect(periodVolume(null)).toBeNull();
  });

  it("reports a real volume", () => {
    expect(periodVolume(period({ period: "day", vlm: "1234.5" }))).toBe("1234.5");
  });
});
