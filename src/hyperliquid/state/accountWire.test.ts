/**
 * Fixtures are recorded from live testnet accounts, not hand-written.
 *
 * A hand-written fixture can only encode what the author already believes, and
 * this project has already shipped 500 green tests standing on an invented
 * shape. Every number asserted below came off the wire.
 */

import { BigNumber } from "bignumber.js";

import {
  fillKey,
  fundingEarned,
  isZeroAmount,
  parseClearinghouseState,
  parseFill,
  parseFills,
  parseOpenOrder,
  parseOpenOrders,
  parseSpotState,
  parseTwapSliceFills,
  positionSideOf,
} from "@/hyperliquid/state/accountWire";
import { HlError } from "@/hyperliquid/core/errors";

import chsMixed from "@/hyperliquid/state/__fixtures__/chs-mixed-testnet.json";
import chsIsolated from "@/hyperliquid/state/__fixtures__/chs-isolated-testnet.json";
import chsEmpty from "@/hyperliquid/state/__fixtures__/chs-empty-testnet.json";
import fooMixed from "@/hyperliquid/state/__fixtures__/foo-mixed-testnet.json";
import fooTrigger from "@/hyperliquid/state/__fixtures__/foo-iso-testnet.json";
import fillsA from "@/hyperliquid/state/__fixtures__/fills-testnet.json";
import fillsB from "@/hyperliquid/state/__fixtures__/fills-b-testnet.json";
import twapFixture from "@/hyperliquid/state/__fixtures__/twap-testnet.json";
import spotMixed from "@/hyperliquid/state/__fixtures__/spot-mixed-testnet.json";
import spotEmpty from "@/hyperliquid/state/__fixtures__/spot-empty-testnet.json";

const WITH_POSITIONS = [
  ["mixed cross/isolated", chsMixed],
  ["mostly isolated", chsIsolated],
] as const;

/** Deep clone so a mutation test cannot leak into the next one. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("primitives", () => {
  it("compares zero numerically, because every wire zero is '0.0'", () => {
    // `value === "0"` never fires against this API.
    expect(isZeroAmount("0.0")).toBe(true);
    expect(isZeroAmount("0")).toBe(true);
    expect(isZeroAmount("0.00000000")).toBe(true);
    expect(isZeroAmount("0.00000001")).toBe(false);
  });

  it("reads direction only from the sign of szi", () => {
    expect(positionSideOf("-16248.8155")).toBe("short");
    expect(positionSideOf("0.0001")).toBe("long");
  });

  it("flips funding exactly once for an 'earned' surface", () => {
    const paid = { allTime: "-124.932687", sinceOpen: "35.380996", sinceChange: "0.0" };
    expect(fundingEarned(paid)).toEqual({
      allTime: "124.932687",
      sinceOpen: "-35.380996",
      sinceChange: "0",
    });
  });
});

describe("parseClearinghouseState", () => {
  it.each(WITH_POSITIONS)("parses every position on the %s account", (_label, fixture) => {
    const snapshot = parseClearinghouseState(fixture);
    expect(snapshot.positions.length).toBeGreaterThan(0);
    expect(snapshot.positions.length).toBe(fixture.assetPositions.length);
  });

  it("keeps the two margin buckets apart", () => {
    // The wire ships identical field names in both. On this recorded account
    // they differ by nearly 2x, so reading the wrong one halves the balance.
    const { summary } = parseClearinghouseState(chsMixed);
    expect(summary.total.accountValue).toBe("9874.495684");
    expect(summary.cross.accountValue).toBe("5094.590129");
    expect(summary.total.accountValue).not.toBe(summary.cross.accountValue);
  });

  it.each(WITH_POSITIONS)(
    "satisfies total = cross + isolated margin on the %s account",
    (_label, fixture) => {
      const { summary, positions } = parseClearinghouseState(fixture);
      const isolatedMargin = positions
        .filter((p) => p.marginMode === "isolated")
        .reduce((total, p) => total.plus(p.marginUsed), new BigNumber(0));

      expect(
        new BigNumber(summary.total.accountValue)
          .minus(summary.cross.accountValue)
          .minus(isolatedMargin)
          .toFixed()
      ).toBe("0");
    }
  );

  it.each(WITH_POSITIONS)("sums notional across all positions on the %s account", (_l, fixture) => {
    const { summary, positions } = parseClearinghouseState(fixture);
    const sum = positions.reduce((t, p) => t.plus(p.notionalValue), new BigNumber(0));
    expect(new BigNumber(summary.total.totalNotional).minus(sum).toFixed()).toBe("0");
  });

  describe("returnOnEquity", () => {
    it.each(WITH_POSITIONS)(
      "is unrealizedPnl x leverage / entryNotional on the %s account",
      (_label, fixture) => {
        // The denominator is entry notional, NOT marginUsed. Both formulas agree
        // at zero PnL, so a fresh-position fixture cannot tell them apart.
        for (const p of parseClearinghouseState(fixture).positions) {
          const expected = new BigNumber(p.unrealizedPnl).times(p.leverage).div(p.entryNotional);
          expect(expected.minus(p.returnOnEquity).abs().toNumber()).toBeLessThan(5e-11);
        }
      }
    );

    it("is NOT unrealizedPnl / marginUsed — the negative control", () => {
      const positions = parseClearinghouseState(chsIsolated).positions.filter(
        (p) => !isZeroAmount(p.unrealizedPnl)
      );
      expect(positions.length).toBeGreaterThan(0);

      const wrong = positions.filter((p) =>
        new BigNumber(p.unrealizedPnl)
          .div(p.marginUsed)
          .minus(p.returnOnEquity)
          .abs()
          .isLessThan(5e-11)
      );
      // If this ever became true the two formulas would be indistinguishable and
      // the assertion above would stop protecting anything.
      expect(wrong.length).toBeLessThan(positions.length);
    });
  });

  it.each(WITH_POSITIONS)(
    "derives an exact entry notional that entryPx only approximates on %s",
    (_label, fixture) => {
      for (const p of parseClearinghouseState(fixture).positions) {
        // entryNotional is subtraction-only, so it is exact; entryPx is the same
        // quantity truncated, and dividing by size must land within one tick of it.
        const implied = new BigNumber(p.entryNotional).div(p.size);
        const drift = implied.minus(p.entryPxDisplay).abs().div(implied);
        expect(drift.toNumber()).toBeLessThan(1e-3);
        // Truncation toward zero: the published price never exceeds the true one.
        expect(new BigNumber(p.entryPxDisplay).isLessThanOrEqualTo(implied.times(1.000001))).toBe(
          true
        );
      }
    }
  );

  it("keeps a null liquidation price null rather than coercing it to zero", () => {
    // 3 of 10 positions on this account. Rendering "$0.00" reads as imminent
    // liquidation when the truth is that there is no liquidation price at all.
    const positions = parseClearinghouseState(chsMixed).positions;
    const unliquidatable = positions.filter((p) => p.liquidationPx === null);

    expect(unliquidatable).toHaveLength(3);
    expect(positions.every((p) => p.liquidationPx !== "0" && p.liquidationPx !== "0.0")).toBe(true);
  });

  it.each(WITH_POSITIONS)("marks isolated positions structurally on %s", (_label, fixture) => {
    for (const p of parseClearinghouseState(fixture).positions) {
      // rawUsd is present iff isolated — 0 of 1,469 cross positions carried it.
      expect(p.isolatedRawUsd === null).toBe(p.marginMode === "cross");
    }
  });

  it.each(WITH_POSITIONS)("computes cross margin as notional / leverage on %s", (_l, fixture) => {
    const cross = parseClearinghouseState(fixture).positions.filter(
      (p) => p.marginMode === "cross"
    );
    expect(cross.length).toBeGreaterThan(0);
    for (const p of cross) {
      const derived = new BigNumber(p.notionalValue).div(p.leverage);
      expect(derived.minus(p.marginUsed).abs().toNumber()).toBeLessThan(1e-6);
    }
  });

  it("agrees size and side so they cannot disagree downstream", () => {
    for (const p of parseClearinghouseState(chsMixed).positions) {
      expect(new BigNumber(p.size).isPositive()).toBe(true);
      expect(new BigNumber(p.signedSize).isNegative()).toBe(p.side === "short");
      expect(new BigNumber(p.size).toFixed()).toBe(new BigNumber(p.signedSize).abs().toFixed());
    }
  });

  it("parses a funded account holding no positions", () => {
    const snapshot = parseClearinghouseState(chsEmpty);
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.summary.total.accountValue).toBe("11.0");
  });

  it("records the echoed dex so a wrong-dex response can be spotted", () => {
    // A real-but-wrong dex returns HTTP 200 with a fully-formed empty account.
    expect(parseClearinghouseState(chsEmpty, { dex: "test" }).summary.dex).toBe("test");
    expect(parseClearinghouseState(chsEmpty).summary.dex).toBe("");
  });

  describe("shape drift", () => {
    it("rejects a response missing a field the domain type reads", () => {
      const broken = clone(chsMixed) as Record<string, unknown>;
      delete broken.withdrawable;
      expect(() => parseClearinghouseState(broken)).toThrow(HlError);
    });

    it("rejects a money field that arrives as a number", () => {
      const broken = clone(chsMixed);
      (broken.assetPositions[0].position as Record<string, unknown>).szi = 1.5;
      expect(() => parseClearinghouseState(broken)).toThrow(/szi is not a string/);
    });

    it("rejects a liquidation price that arrives as a number", () => {
      const broken = clone(chsMixed);
      (broken.assetPositions[0].position as Record<string, unknown>).liquidationPx = 0;
      expect(() => parseClearinghouseState(broken)).toThrow(/neither a string nor null/);
    });

    it("rejects exponential notation, which this API never emits", () => {
      const broken = clone(chsMixed);
      (broken.assetPositions[0].position as Record<string, unknown>).unrealizedPnl = "1e-8";
      expect(() => parseClearinghouseState(broken)).toThrow(/not a plain decimal/);
    });

    it("rejects a zero-size position rather than displaying it", () => {
      // A flat position is removed from the array. One reported as zero means
      // the whole-replace invariant the store rests on has broken.
      const broken = clone(chsMixed);
      (broken.assetPositions[0].position as Record<string, unknown>).szi = "0.0";
      expect(() => parseClearinghouseState(broken)).toThrow(/is zero/);
    });

    it("warns about an unknown key but still parses", () => {
      // The API adds fields. Refusing to parse would take the portfolio offline
      // over an addition this client does not even read.
      const extended = clone(chsMixed) as Record<string, unknown>;
      extended.someNewField = { anything: true };
      const onUnknownKeys = jest.fn();

      const snapshot = parseClearinghouseState(extended, { onUnknownKeys });

      expect(onUnknownKeys).toHaveBeenCalledWith(["someNewField"]);
      expect(snapshot.positions.length).toBe(chsMixed.assetPositions.length);
    });
  });
});

describe("parseOpenOrder", () => {
  it("separates remaining size from the size that was placed", () => {
    // A 10 BTC order that filled 7 reports sz "3"; a cancel-and-replace built on
    // that column re-places the wrong quantity.
    const row = parseOpenOrder({
      oid: 1,
      coin: "BTC",
      side: "B",
      limitPx: "50000.0",
      sz: "3.0",
      origSz: "10.0",
      timestamp: 1_700_000_000_000,
    });
    expect(row.remainingSz).toBe("3.0");
    expect(row.originalSz).toBe("10.0");
  });

  it("nulls the trigger price on a non-trigger order", () => {
    // The wire sends "0.0" there, which renders as a real stop at zero.
    const row = parseOpenOrder({
      oid: 1,
      coin: "BTC",
      side: "A",
      limitPx: "50000.0",
      sz: "1.0",
      origSz: "1.0",
      timestamp: 1,
      isTrigger: false,
      triggerPx: "0.0",
    });
    expect(row.triggerPx).toBeNull();
  });

  it("keeps a real trigger price", () => {
    const triggers = parseOpenOrders(fooTrigger).filter((o) => o.isTrigger);
    expect(triggers.length).toBe(4);
    for (const order of triggers) {
      expect(order.triggerPx).not.toBeNull();
      expect(order.triggerCondition).not.toBe("");
    }
  });

  it("treats an absent reduceOnly as false", () => {
    // The wire uses `reduceOnly?: true` — present or absent, never false.
    const base = {
      oid: 1,
      coin: "BTC",
      side: "B",
      limitPx: "1.0",
      sz: "1.0",
      origSz: "1.0",
      timestamp: 1,
    };
    expect(parseOpenOrder(base).reduceOnly).toBe(false);
    expect(parseOpenOrder({ ...base, reduceOnly: true }).reduceOnly).toBe(true);
  });

  it("normalises the cloid when present and nulls it otherwise", () => {
    const base = {
      oid: 1,
      coin: "BTC",
      side: "B",
      limitPx: "1.0",
      sz: "1.0",
      origSz: "1.0",
      timestamp: 1,
    };
    expect(parseOpenOrder({ ...base, cloid: null }).cloid).toBeNull();
    expect(parseOpenOrder(base).cloid).toBeNull();
    const withCloid = parseOpenOrder({ ...base, cloid: `0x${"AB".repeat(16)}` });
    expect(withCloid.cloid).toBe(`0x${"ab".repeat(16)}`);
  });

  it("parses a recorded order list", () => {
    expect(parseOpenOrders(fooMixed).length).toBe(fooMixed.length);
  });
});

describe("parseFill", () => {
  const A = parseFills(fillsA);
  const B = parseFills(fillsB);

  it("keys on oid:tid", () => {
    expect(fillKey(123, 456)).toBe("123:456");
    expect(A[0].key).toBe(`${A[0].oid}:${A[0].tid}`);
  });

  it.each([
    ["A", A],
    ["B", B],
  ])("produces a distinct key for every recorded fill on account %s", (_label, fills) => {
    expect(new Set(fills.map((f) => f.key)).size).toBe(fills.length);
  });

  it("would lose rows if keyed on hash instead", () => {
    // Not hypothetical: 1,322 of 2,000 fills on this account share a hash, and
    // 876 carry the all-zero hash. Keying on it silently drops two thirds.
    const byHash = new Set(B.map((f) => f.hash));
    expect(byHash.size).toBeLessThan(B.length);
    expect(new Set(B.map((f) => f.key)).size).toBe(B.length);
  });

  it("keeps a maker rebate negative rather than taking the magnitude", () => {
    const rebate = parseFill({
      ...(fillsA[0] as object),
      fee: "-0.0000123",
    });
    expect(new BigNumber(rebate.fee).isNegative()).toBe(true);
  });

  it("carries the fee token, because fees are not always USDC", () => {
    // Recorded on this account: USDC, PURR and an outcome token. Summing `fee`
    // blind adds token quantities to dollars.
    const tokens = new Set(A.map((f) => f.feeToken));
    expect(tokens.size).toBeGreaterThanOrEqual(1);
    expect(A.every((f) => typeof f.feeToken === "string" && f.feeToken.length > 0)).toBe(true);
  });

  it("keeps dir verbatim, since the value set is open", () => {
    // The recorded set includes "Liquidated Isolated Long", "Auto-Deleveraging",
    // "Settlement", "Buy" and "Sell" — spot and liquidation values that fall
    // through any exhaustive long/short switch.
    const dirs = new Set(A.map((f) => f.dir));
    expect(dirs.size).toBeGreaterThan(3);
    expect([...dirs].every((d) => typeof d === "string")).toBe(true);
  });

  it("leaves liquidatedUser null when the wire omits it", () => {
    // The liquidation block is attached to BOTH counterparties, so a missing
    // value must not fall through to "you were liquidated".
    const fill = parseFill({
      ...(fillsA[0] as object),
      liquidation: { markPx: "100.0", method: "market" },
    });
    expect(fill.liquidation?.liquidatedUser).toBeNull();
  });

  it("lowercases liquidatedUser so an address comparison is safe", () => {
    const fill = parseFill({
      ...(fillsA[0] as object),
      liquidation: { liquidatedUser: `0x${"AB".repeat(20)}`, markPx: "1.0", method: "market" },
    });
    expect(fill.liquidation?.liquidatedUser).toBe(`0x${"ab".repeat(20)}`);
  });

  it("tags ordinary fills as fills", () => {
    expect(A.every((f) => f.source === "fill")).toBe(true);
  });
});

describe("parseTwapSliceFills", () => {
  const slices = parseTwapSliceFills(twapFixture);

  it("takes twapId from the outer object, since the inner one is always null", () => {
    expect(slices.length).toBeGreaterThan(0);
    expect(slices.every((s) => s.twapId !== null)).toBe(true);
    expect(slices.every((s) => s.source === "twapSlice")).toBe(true);
  });

  it("shares the fill keyspace so a server-side merge cannot double-count", () => {
    expect(slices.every((s) => s.key === `${s.oid}:${s.tid}`)).toBe(true);
  });
});

describe("parseSpotState", () => {
  it("handles outcome rows that carry no token", () => {
    // 142 of 196 rows on this account — the dominant case, not an edge case.
    // Keying a map by `token` collides all of them under one undefined key.
    const state = parseSpotState(spotMixed);
    const outcomes = state.balances.filter((b) => b.kind === "outcome");

    expect(outcomes.length).toBe(142);
    expect(outcomes.every((b) => b.token === null)).toBe(true);
    expect(state.balances.filter((b) => b.kind === "token").every((b) => b.token !== null)).toBe(
      true
    );
  });

  it("derives available as total minus hold", () => {
    for (const b of parseSpotState(spotMixed).balances) {
      expect(new BigNumber(b.available).toFixed()).toBe(
        new BigNumber(b.total).minus(b.hold).toFixed()
      );
    }
  });

  it("reports portfolio margin as absent rather than zero on an ordinary account", () => {
    // Defaulting the ratio to "0" renders a PM health bar at 0% for everyone.
    expect(parseSpotState(spotMixed).portfolioMargin).toBeNull();
    expect(parseSpotState(spotEmpty).portfolioMargin).toBeNull();
  });

  it("reads tokenToAvailableAfterMaintenance as pairs, not as an object", () => {
    // The wire sends [[0,"6473640.48"],[1204,"92508.11"],…]. Object.entries on
    // that yields numeric indices and array values, which format as garbage.
    const map = parseSpotState(spotMixed).availableAfterMaintenance;
    expect(map).not.toBeNull();
    expect(map!.size).toBe(8);
    expect(typeof map!.get(0)).toBe("string");
  });

  it("leaves the maintenance map null when the wire omits it", () => {
    expect(parseSpotState(spotEmpty).availableAfterMaintenance).toBeNull();
  });

  it("keeps entryNtl named as a cost basis", () => {
    // It is "0.0" for USDC, so rendering it as current value shows $0.00 for
    // the largest holding on most accounts.
    const usdc = parseSpotState(spotEmpty).balances.find((b) => b.coin === "USDC");
    expect(usdc).toBeDefined();
    expect(typeof usdc!.costBasisNtl).toBe("string");
  });
});
