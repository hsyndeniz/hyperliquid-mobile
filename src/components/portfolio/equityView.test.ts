/**
 * The equity split's one rule: `total` only when every part is known.
 *
 * A total over two of three parts is a confident-looking understatement — the
 * exact failure this module replaced, where the hero showed the perp value
 * alone as "Account value". Each null case is pinned separately so a future
 * "default it to zero" regression fails by name.
 */

import { combinedPerpEquity, equityBreakdown } from "@/components/portfolio/equityView";
import type { SubAccountSummary } from "@/hyperliquid/subaccounts/types";
import type { SpotBalance } from "@/hyperliquid/types/domain";
import type { VaultPosition } from "@/hyperliquid/vaults/types";

function balance(overrides: Partial<SpotBalance> & { coin: string; total: string }): SpotBalance {
  return {
    kind: "token",
    hold: "0.0",
    available: overrides.total,
    costBasisNtl: "0.0",
    ...overrides,
  } as SpotBalance;
}

function vault(equity: string): VaultPosition {
  return { vaultAddress: "0xa15", equity, lockedUntilMs: 0 } as unknown as VaultPosition;
}

const PRICES: ReadonlyMap<string, string> = new Map([["HYPE", "2.5"]]);

describe("equityBreakdown", () => {
  it("sums all three parts when every source has spoken", () => {
    const result = equityBreakdown({
      perpValue: "2.62",
      balances: [balance({ coin: "USDC", total: "10.5" }), balance({ coin: "HYPE", total: "2" })],
      prices: PRICES,
      vaultPositions: [vault("5.000938")],
    });
    // USDC at par (10.5) + HYPE 2 × 2.5 (5) = 15.50; vault rounds to cents.
    expect(result.spot).toBe("15.50");
    expect(result.vaults).toBe("5.00");
    expect(result.total).toBe("23.12");
    expect(result.unpriced).toEqual([]);
  });

  it("keeps total null while the perp frame is missing", () => {
    const result = equityBreakdown({
      perpValue: null,
      balances: [],
      prices: PRICES,
      vaultPositions: [],
    });
    expect(result.perp).toBeNull();
    expect(result.total).toBeNull();
  });

  it("keeps total null while spot balances have not arrived", () => {
    const result = equityBreakdown({
      perpValue: "2.62",
      balances: null,
      prices: PRICES,
      vaultPositions: [],
    });
    expect(result.spot).toBeNull();
    expect(result.total).toBeNull();
  });

  it("keeps total null while the vault read is pending", () => {
    const result = equityBreakdown({
      perpValue: "2.62",
      balances: [],
      prices: PRICES,
      vaultPositions: null,
    });
    expect(result.vaults).toBeNull();
    expect(result.total).toBeNull();
  });

  it("renders empty spot and vaults as zero, not null — nothing IS an answer", () => {
    const result = equityBreakdown({
      perpValue: "2.62",
      balances: [],
      prices: PRICES,
      vaultPositions: [],
    });
    expect(result.spot).toBe("0.00");
    expect(result.vaults).toBe("0.00");
    expect(result.total).toBe("2.62");
  });

  it("names unpriced coins instead of silently dropping them", () => {
    const result = equityBreakdown({
      perpValue: "0",
      balances: [balance({ coin: "USDC", total: "3" }), balance({ coin: "MYSTERY", total: "100" })],
      prices: PRICES,
      vaultPositions: [],
    });
    expect(result.spot).toBe("3.00");
    expect(result.unpriced).toEqual(["MYSTERY"]);
  });

  it("never names a zero holding as unpriced — the wire sends 0.0 rows", () => {
    const result = equityBreakdown({
      perpValue: "0",
      balances: [balance({ coin: "MYSTERY", total: "0.0" })],
      prices: PRICES,
      vaultPositions: [],
    });
    expect(result.unpriced).toEqual([]);
    expect(result.spot).toBe("0.00");
  });
});

describe("combinedPerpEquity", () => {
  const sub = (perpEquityTotal: string): SubAccountSummary =>
    ({ perpEquityTotal }) as unknown as SubAccountSummary;

  it("sums the master and every sub's perp equity with BigNumber", () => {
    expect(combinedPerpEquity("2.65", [sub("10.1"), sub("0.25")])).toBe("13.00");
  });

  it("is null while either source has not loaded", () => {
    expect(combinedPerpEquity(null, [sub("1")])).toBeNull();
    expect(combinedPerpEquity("2.65", null)).toBeNull();
  });

  it("is the master alone over an empty sub list — the caller gates display", () => {
    expect(combinedPerpEquity("2.65", [])).toBe("2.65");
  });

  it("skips a malformed sub equity rather than poisoning the total", () => {
    expect(combinedPerpEquity("1", [sub("abc"), sub("2")])).toBe("3.00");
  });
});
