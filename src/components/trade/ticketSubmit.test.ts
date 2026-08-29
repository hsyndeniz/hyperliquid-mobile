/**
 * Ticket → wire, pinned on the rules that lose money when wrong:
 *
 * - TP/SL brackets are REVERSE side, reduce-only, `normalTpsl` — and which
 *   child is tp vs sl comes from the CHECKBOX, never from comparing prices.
 * - Trigger prices reach `buildTriggerOrder` raw, so its directional snap
 *   (earlier-firing) is the one that runs — not a truncation here.
 * - A TWAP is not legs; a non-TWAP is not a TWAP payload. Both throw.
 */

import { positionTpslLegs, ticketToLegs, twapPayload } from "@/components/trade/ticketSubmit";
import type { TicketContext, TicketState } from "@/components/trade/orderForm";
import { snapTriggerPrice, type AssetSpec } from "@/hyperliquid/orders/build";

const ASSET: AssetSpec = { assetId: 0, szDecimals: 5, marketType: "perp" };

const CTX: TicketContext = {
  kind: "perp",
  marketType: "perp",
  symbol: "BTC",
  szDecimals: 5,
  markPx: "64000",
  midPx: "64010",
  baseAvailable: null,
  available: "1000",
  positionSize: null,
  leverage: 10,
  maintenanceMarginRate: null,
  takerFeeRate: null,
  makerFeeRate: null,
  isSignedIn: true,
  canTrade: true,
};

function ticket(overrides: Partial<TicketState>): TicketState {
  return {
    type: "limit",
    side: "long",
    sizeUnit: "base",
    size: "0.01",
    price: "64000",
    triggerPrice: "",
    scaleStart: "",
    scaleEnd: "",
    legCount: "2",
    runtime: "30m",
    tif: "Gtc",
    reduceOnly: false,
    randomize: false,
    tpEnabled: false,
    tpPrice: "",
    slEnabled: false,
    slPrice: "",
    ...overrides,
  };
}

describe("ticketToLegs", () => {
  it("builds a plain limit as one leg, na grouping", () => {
    const { legs, grouping } = ticketToLegs(ticket({}), CTX, ASSET);
    expect(legs).toHaveLength(1);
    expect(grouping).toBe("na");
    expect(legs[0]).toMatchObject({ a: 0, b: true, p: "64000", s: "0.01", r: false });
    expect(legs[0]!.t).toEqual({ limit: { tif: "Gtc" } });
  });

  it("slips a market order from the MID, as an IOC", () => {
    const { legs } = ticketToLegs(ticket({ type: "market" }), CTX, ASSET);
    expect(legs[0]!.t).toEqual({ limit: { tif: "Ioc" } });
    // Slipped UP from 64010 for a buy — never the raw reference.
    expect(Number(legs[0]!.p)).toBeGreaterThan(64010);
  });

  it("attaches TP/SL as reverse-side, reduce-only market triggers under normalTpsl", () => {
    const { legs, grouping } = ticketToLegs(
      ticket({ tpEnabled: true, tpPrice: "70000", slEnabled: true, slPrice: "60000" }),
      CTX,
      ASSET
    );
    expect(grouping).toBe("normalTpsl");
    expect(legs).toHaveLength(3);
    const [parent, tp, sl] = legs;
    expect(parent!.b).toBe(true);
    // The brackets CLOSE what the parent opens: reverse side, reduce only.
    for (const child of [tp!, sl!]) {
      expect(child.b).toBe(false);
      expect(child.r).toBe(true);
      expect("trigger" in child.t && child.t.trigger.isMarket).toBe(true);
    }
    expect("trigger" in tp!.t && tp!.t.trigger.tpsl).toBe("tp");
    expect("trigger" in sl!.t && sl!.t.trigger.tpsl).toBe("sl");
  });

  it("classifies tp vs sl by the CHECKBOX, not by comparing prices", () => {
    // A user can type a "take profit" below the mid; the intent is still tp.
    const { legs } = ticketToLegs(ticket({ tpEnabled: true, tpPrice: "50000" }), CTX, ASSET);
    expect("trigger" in legs[1]!.t && legs[1]!.t.trigger.tpsl).toBe("tp");
  });

  it("keeps na grouping when the checkbox is on but no price was typed", () => {
    const { legs, grouping } = ticketToLegs(ticket({ tpEnabled: true, tpPrice: "" }), CTX, ASSET);
    expect(legs).toHaveLength(1);
    expect(grouping).toBe("na");
  });

  it("hands the trigger price to the builder RAW, so the directional snap runs", () => {
    // A long's stop-loss snaps toward firing EARLIER. If this module
    // pre-rounded with plain truncation, the two would disagree.
    const raw = "63999.9999";
    const { legs } = ticketToLegs(
      ticket({ type: "stopMarket", side: "long", triggerPrice: raw, price: "" }),
      CTX,
      ASSET
    );
    // side "long" on a stopMarket ticket is a BUY stop — the segment names
    // the order's own direction, and tpsl comes from the type.
    const expected = snapTriggerPrice(raw, true, ASSET, "sl");
    expect("trigger" in legs[0]!.t && legs[0]!.t.trigger.triggerPx).toBe(expected);
  });

  it("spreads a scale ticket into its ladder", () => {
    const { legs, grouping } = ticketToLegs(
      ticket({ type: "scale", scaleStart: "63000", scaleEnd: "64000", legCount: "4", size: "0.4" }),
      CTX,
      ASSET
    );
    expect(grouping).toBe("na");
    expect(legs).toHaveLength(4);
  });

  it("refuses a TWAP ticket — that path has no legs", () => {
    expect(() => ticketToLegs(ticket({ type: "twap" }), CTX, ASSET)).toThrow(/TWAP/);
  });
});

describe("twapPayload", () => {
  it("parses the runtime into whole minutes and carries the reference price", () => {
    const payload = twapPayload(
      ticket({ type: "twap", size: "0.05", runtime: "2h30m", randomize: true }),
      CTX,
      ASSET
    );
    expect(payload).toMatchObject({
      assetId: 0,
      isBuy: true,
      size: "0.05",
      durationMinutes: 150,
      randomize: true,
      referencePrice: "64010",
    });
  });

  it("refuses a non-TWAP ticket", () => {
    expect(() => twapPayload(ticket({}), CTX, ASSET)).toThrow(/Not a TWAP/);
  });

  it("refuses an unparseable runtime loudly — blockers should have caught it", () => {
    expect(() => twapPayload(ticket({ type: "twap", runtime: "banana" }), CTX, ASSET)).toThrow();
  });
});

describe("positionTpslLegs", () => {
  it("brackets a LONG with reverse-side, reduce-only, whole-position market triggers", () => {
    const { legs, grouping } = positionTpslLegs({
      asset: ASSET,
      side: "long",
      takeProfitPrice: "70000",
      stopLossPrice: "60000",
    });

    expect(grouping).toBe("positionTpsl");
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      // A long is closed by a SELL.
      expect(leg.b).toBe(false);
      expect(leg.r).toBe(true);
      // "0" is the legal encoding of "track the whole position" — it is what
      // makes positionTpsl mean anything, and it must not be formatted away.
      expect(leg.s).toBe("0");
      expect(leg.t).toHaveProperty("trigger");
    }
    expect((legs[0]!.t as { trigger: { tpsl: string; isMarket: boolean } }).trigger).toMatchObject({
      tpsl: "tp",
      isMarket: true,
    });
    expect((legs[1]!.t as { trigger: { tpsl: string } }).trigger.tpsl).toBe("sl");
  });

  it("brackets a SHORT on the buy side", () => {
    const { legs } = positionTpslLegs({
      asset: ASSET,
      side: "short",
      takeProfitPrice: "60000",
      stopLossPrice: "",
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]!.b).toBe(true);
    expect(legs[0]!.r).toBe(true);
  });

  it("labels tp/sl from INTENT, never from the price's side of the market", () => {
    // A stop typed above a long's entry is still a stop. Inferring from the
    // price would silently refile it as a take-profit.
    const { legs } = positionTpslLegs({
      asset: ASSET,
      side: "long",
      takeProfitPrice: "",
      stopLossPrice: "99999",
    });
    expect((legs[0]!.t as { trigger: { tpsl: string } }).trigger.tpsl).toBe("sl");
  });

  it("returns nothing to submit when neither price is set", () => {
    const { legs, grouping } = positionTpslLegs({
      asset: ASSET,
      side: "long",
      takeProfitPrice: "",
      stopLossPrice: "",
    });
    expect(legs).toEqual([]);
    expect(grouping).toBe("na");
  });
});
