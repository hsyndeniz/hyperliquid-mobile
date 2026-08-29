/**
 * Family aggregation, pinned to the mainnet HLP numbers it was written from.
 *
 * The load-bearing cases are the REFUSALS. Every field this module declines to
 * compute (entry price across opposing legs, liquidation price across any two
 * legs, margin across mixed modes) is a field the official web app prints a
 * number for, so a regression here does not look like a bug — it looks like
 * parity. These tests are the only thing that keeps the distinction.
 */

import {
  aggregateFamily,
  familyAccountValue,
  familyAddresses,
  type FamilyMember,
} from "@/hyperliquid/vaults/family";
import type { Hex, MarginMode, Position } from "@/hyperliquid/types/domain";
import type { VaultDetail } from "@/hyperliquid/vaults/types";

/** A position with only the fields aggregation reads set meaningfully. */
function pos(over: {
  coin: string;
  signedSize: string;
  notionalValue: string;
  unrealizedPnl: string;
  entryNotional: string;
  marginUsed: string;
  liquidationPx?: string | null;
  marginMode?: MarginMode;
  fundingSinceOpen?: string;
}): Position {
  const signed = Number(over.signedSize);
  return {
    coin: over.coin,
    side: signed < 0 ? "short" : "long",
    size: String(Math.abs(signed)),
    signedSize: over.signedSize,
    marginMode: over.marginMode ?? "cross",
    leverage: 20,
    isolatedRawUsd: null,
    entryPxDisplay: "0",
    notionalValue: over.notionalValue,
    entryNotional: over.entryNotional,
    unrealizedPnl: over.unrealizedPnl,
    returnOnEquity: "0",
    liquidationPx: over.liquidationPx ?? null,
    marginUsed: over.marginUsed,
    tierMaxLeverage: 50,
    fundingPaid: { allTime: "0", sinceOpen: over.fundingSinceOpen ?? "0", sinceChange: "0" },
  };
}

function member(address: string, positions: Position[], accountValue = "0"): FamilyMember {
  return { address: address as Hex, positions, accountValue, withdrawable: accountValue };
}

describe("familyAddresses", () => {
  it("walks a parent down to its children", () => {
    const detail = {
      address: "0xparent",
      relationship: { kind: "parent", childAddresses: ["0xa", "0xb"] },
    } as unknown as VaultDetail;
    expect(familyAddresses(detail)).toEqual(["0xparent", "0xa", "0xb"]);
  });

  it("never walks a child UP to its parent", () => {
    // A child that borrowed its parent's family would report the whole
    // group's book as its own strategy's.
    const child = { address: "0xchild", relationship: { kind: "child" } } as unknown as VaultDetail;
    expect(familyAddresses(child)).toEqual(["0xchild"]);
    const normal = {
      address: "0xsolo",
      relationship: { kind: "normal" },
    } as unknown as VaultDetail;
    expect(familyAddresses(normal)).toEqual(["0xsolo"]);
  });
});

describe("familyAccountValue", () => {
  it("sums the family — the parent alone is not the vault's money", () => {
    // The measured HLP split: the parent holds $48.2M of $87.2M.
    expect(
      familyAccountValue([
        member("0xparent", [], "48189974.23"),
        member("0xa", [], "3052491.37"),
        member("0xb", [], "30000000"),
      ])
    ).toBe("81242465.6");
  });
});

describe("aggregateFamily", () => {
  it("passes a single leg through, liquidation price and all", () => {
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "BTC",
          signedSize: "-0.08377",
          notionalValue: "5287.64617",
          unrealizedPnl: "1.024712",
          entryNotional: "5288.670882",
          marginUsed: "264.382308",
          liquidationPx: "35631810.9",
        }),
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coin: "BTC",
      netSignedSize: "-0.08377",
      netSize: "0.08377",
      side: "short",
      legs: 1,
      conflicted: false,
      liquidationPx: "35631810.9",
      marginUsed: "264.382308",
    });
  });

  it("nets the measured opposing HLP legs and refuses entry and liquidation", () => {
    // child 1 short 0.08377 BTC, child 4 long 0.11668 BTC — the real pair.
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "BTC",
          signedSize: "-0.08377",
          notionalValue: "5287.64617",
          unrealizedPnl: "1.024712",
          entryNotional: "5288.670882",
          marginUsed: "264.382308",
          liquidationPx: "35631810.9",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "BTC",
          signedSize: "0.11668",
          notionalValue: "7365.5",
          unrealizedPnl: "0.166053",
          entryNotional: "7365.333947",
          marginUsed: "368.275",
          liquidationPx: null,
        }),
      ]),
    ]);

    expect(rows[0]).toMatchObject({
      netSignedSize: "0.03291",
      side: "long",
      conflicted: true,
      legs: 2,
      // Additive and exactly true.
      unrealizedPnl: "1.190765",
      grossNotional: "12653.14617",
      marginUsed: "632.657308",
    });
    // The two refusals. A blended entry here would be (5288.67 + 7365.33) /
    // 0.03291 ≈ $384,500 — a BTC entry price four times reality.
    expect(rows[0]!.entryPx).toBeNull();
    // Only child 1 reports a liquidation price; publishing it would present
    // one strategy's liquidation as the whole family's.
    expect(rows[0]!.liquidationPx).toBeNull();
  });

  it("blends an entry price only when every leg agrees on direction", () => {
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "ETH",
          signedSize: "2",
          notionalValue: "6000",
          unrealizedPnl: "0",
          entryNotional: "6000",
          marginUsed: "300",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "ETH",
          signedSize: "2",
          notionalValue: "7000",
          unrealizedPnl: "0",
          entryNotional: "7000",
          marginUsed: "350",
        }),
      ]),
    ]);
    // (6000 + 7000) / 4 — a real average entry, because both legs are long.
    expect(rows[0]!.entryPx).toBe("3250");
    expect(rows[0]!.conflicted).toBe(false);
    // Still two legs, so still no single liquidation price.
    expect(rows[0]!.liquidationPx).toBeNull();
  });

  it("refuses margin when legs mix cross and isolated", () => {
    // The domain type says these are different quantities; summing mixes them.
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "SOL",
          signedSize: "10",
          notionalValue: "1000",
          unrealizedPnl: "0",
          entryNotional: "1000",
          marginUsed: "50",
          marginMode: "cross",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "SOL",
          signedSize: "10",
          notionalValue: "1000",
          unrealizedPnl: "0",
          entryNotional: "1000",
          marginUsed: "60",
          marginMode: "isolated",
        }),
      ]),
    ]);
    expect(rows[0]!.marginUsed).toBeNull();
  });

  it("keeps a fully-hedged coin as a flat row, not a missing one", () => {
    // Net zero, but real margin is posted and real PnL is running. Dropping
    // the row would hide capital the vault has committed.
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "HYPE",
          signedSize: "-100",
          notionalValue: "5700",
          unrealizedPnl: "-32.8",
          entryNotional: "5667.2",
          marginUsed: "285",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "HYPE",
          signedSize: "100",
          notionalValue: "5700",
          unrealizedPnl: "23.3",
          entryNotional: "5676.7",
          marginUsed: "285",
        }),
      ]),
    ]);
    expect(rows[0]).toMatchObject({
      isFlat: true,
      netSize: "0",
      grossNotional: "11400",
      unrealizedPnl: "-9.5",
      marginUsed: "570",
    });
    // No size to divide by — an entry price would be a division by zero.
    expect(rows[0]!.entryPx).toBeNull();
  });

  it("orders by GROSS exposure so a hedged coin does not sink to the bottom", () => {
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "SMALL",
          signedSize: "1",
          notionalValue: "100",
          unrealizedPnl: "0",
          entryNotional: "100",
          marginUsed: "5",
        }),
        pos({
          coin: "HEDGED",
          signedSize: "-50",
          notionalValue: "9000",
          unrealizedPnl: "0",
          entryNotional: "9000",
          marginUsed: "450",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "HEDGED",
          signedSize: "50",
          notionalValue: "9000",
          unrealizedPnl: "0",
          entryNotional: "9000",
          marginUsed: "450",
        }),
      ]),
    ]);
    // HEDGED nets to zero but carries $18k of exposure and $900 of margin.
    expect(rows.map((row) => row.coin)).toEqual(["HEDGED", "SMALL"]);
  });

  it("sums funding across legs", () => {
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "PUMP",
          signedSize: "1",
          notionalValue: "10",
          unrealizedPnl: "0",
          entryNotional: "10",
          marginUsed: "1",
          fundingSinceOpen: "13.05",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "PUMP",
          signedSize: "1",
          notionalValue: "10",
          unrealizedPnl: "0",
          entryNotional: "10",
          marginUsed: "1",
          fundingSinceOpen: "-25.78",
        }),
      ]),
    ]);
    expect(rows[0]!.fundingSinceOpen).toBe("-12.73");
  });

  it("is empty for a family that holds nothing", () => {
    expect(aggregateFamily([member("0xparent", [])])).toEqual([]);
  });
});

describe("aggregateFamily — the derived columns", () => {
  it("keeps leverage and margin mode only when every leg agrees", () => {
    const same = aggregateFamily([
      member("0xa", [
        pos({
          coin: "BTC",
          signedSize: "1",
          notionalValue: "63000",
          unrealizedPnl: "100",
          entryNotional: "62900",
          marginUsed: "3145",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "BTC",
          signedSize: "1",
          notionalValue: "63000",
          unrealizedPnl: "50",
          entryNotional: "62950",
          marginUsed: "3147.5",
        }),
      ]),
    ]);
    expect(same[0]).toMatchObject({ leverage: 20, marginMode: "cross" });
  });

  it("refuses leverage when two strategies run the coin differently", () => {
    // One number here would pick a winner between two real settings.
    const mixed = aggregateFamily([
      member("0xa", [
        pos({
          coin: "BTC",
          signedSize: "1",
          notionalValue: "63000",
          unrealizedPnl: "0",
          entryNotional: "63000",
          marginUsed: "3150",
        }),
      ]),
      member("0xb", [
        {
          ...pos({
            coin: "BTC",
            signedSize: "1",
            notionalValue: "63000",
            unrealizedPnl: "0",
            entryNotional: "63000",
            marginUsed: "6300",
          }),
          leverage: 10,
        },
      ]),
    ]);
    expect(mixed[0]!.leverage).toBeNull();
  });

  it("derives the mark from any leg — it is market-wide, not per-leg", () => {
    // 5287.64617 / 0.08377 = 63,121.0 — the same price both legs mark against,
    // so taking one is exact rather than an average.
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "BTC",
          signedSize: "-0.08377",
          notionalValue: "5287.64617",
          unrealizedPnl: "1",
          entryNotional: "5288",
          marginUsed: "264",
        }),
      ]),
    ]);
    expect(rows[0]!.markPx).toBe("63121");
  });

  it("has no mark for a position with no size", () => {
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "BTC",
          signedSize: "0",
          notionalValue: "0",
          unrealizedPnl: "0",
          entryNotional: "0",
          marginUsed: "0",
        }),
      ]),
    ]);
    expect(rows[0]!.markPx).toBeNull();
  });

  it("returns PnL over the margin actually posted", () => {
    // 150 / 6292.5 — both terms exactly additive, so the ratio is true for
    // the family in a way a blended entry price never is.
    const rows = aggregateFamily([
      member("0xa", [
        pos({
          coin: "BTC",
          signedSize: "1",
          notionalValue: "63000",
          unrealizedPnl: "100",
          entryNotional: "62900",
          marginUsed: "3145",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "BTC",
          signedSize: "1",
          notionalValue: "63000",
          unrealizedPnl: "50",
          entryNotional: "62950",
          marginUsed: "3147.5",
        }),
      ]),
    ]);
    expect(rows[0]!.returnOnMargin).toBe("0.02383790226460071514");
  });

  it("has no return when margin is unknown or zero", () => {
    const mixedMode = aggregateFamily([
      member("0xa", [
        pos({
          coin: "SOL",
          signedSize: "10",
          notionalValue: "1000",
          unrealizedPnl: "5",
          entryNotional: "995",
          marginUsed: "50",
          marginMode: "cross",
        }),
      ]),
      member("0xb", [
        pos({
          coin: "SOL",
          signedSize: "10",
          notionalValue: "1000",
          unrealizedPnl: "5",
          entryNotional: "995",
          marginUsed: "60",
          marginMode: "isolated",
        }),
      ]),
    ]);
    expect(mixedMode[0]!.returnOnMargin).toBeNull();

    const noMargin = aggregateFamily([
      member("0xa", [
        pos({
          coin: "SOL",
          signedSize: "10",
          notionalValue: "1000",
          unrealizedPnl: "5",
          entryNotional: "995",
          marginUsed: "0",
        }),
      ]),
    ]);
    expect(noMargin[0]!.returnOnMargin).toBeNull();
  });
});
