/**
 * The detail views, and the caveats that make several of their fields honest.
 *
 * A detail sheet is where a raw wire value gets shown to someone who may act on
 * it. Each case below is a field that is actively misleading without the note
 * beside it.
 */

import {
  fillDetail,
  fundingDetail,
  ledgerDetail,
  orderDetail,
  orderHistoryDetail,
  positionDetail,
} from "@/components/portfolio/rowDetail";
import type { LedgerRow } from "@/hyperliquid/history/ledger";
import type { OrderLifecycle } from "@/hyperliquid/history/orders";
import type { Fill, OpenOrderRow, Position } from "@/hyperliquid/types/domain";

function fieldFor(
  detail: { fields: { label: string; value: string; caveat?: string }[] },
  label: string
) {
  const field = detail.fields.find((f) => f.label === label);
  if (!field) throw new Error(`no field "${label}"`);
  return field;
}

const FILL = {
  key: "1:2",
  tid: 0,
  oid: 5,
  coin: "BTC",
  side: "buy",
  px: "63645.0",
  sz: "0.00024",
  time: 1,
  startPosition: "0",
  dir: "Open Long",
  closedPnl: "0.0",
  fee: "-0.03",
  feeToken: "HYPE",
  builderFee: null,
  crossed: true,
  hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  twapId: null,
  liquidation: null,
  source: "fill",
} as unknown as Fill;

describe("fillDetail", () => {
  it("warns that the transaction hash is not a key", () => {
    // Not unique, and all-zero on 5.6% of mainnet fills. Shown bare, it invites
    // someone to dedupe on it.
    expect(fieldFor(fillDetail(FILL), "Transaction").caveat).toMatch(/not unique/i);
  });

  it("says closedPnl is gross of fees and only meaningful on a close", () => {
    expect(fieldFor(fillDetail(FILL), "Closed P&L").caveat).toMatch(/gross of fees/i);
  });

  it("shows the fee with its own token and flags that it may be a rebate", () => {
    const fee = fieldFor(fillDetail(FILL), "Fee");

    // `-0.03 HYPE`, not `-$0.03`: the token is not always USDC.
    expect(fee.value).toBe("-0.03 HYPE");
    expect(fee.caveat).toMatch(/rebate/i);
  });

  it("says a zero trade id is a real value", () => {
    // Every Spot Dust Conversion carries `tid: 0`.
    expect(fieldFor(fillDetail(FILL), "Trade id").caveat).toMatch(/real value/i);
  });

  it("does not add a liquidation caveat when there was no liquidation", () => {
    expect(fieldFor(fillDetail(FILL), "Liquidation").caveat).toBeUndefined();
  });

  it("warns that a liquidation block is attached to BOTH counterparties", () => {
    const detail = fillDetail({
      ...FILL,
      liquidation: { liquidatedUser: null, markPx: "1", method: "market" },
    } as Fill);

    // Otherwise every maker who absorbed someone else's liquidation reads as
    // having been liquidated themselves.
    expect(fieldFor(detail, "Liquidation").caveat).toMatch(/both/i);
  });
});

describe("positionDetail", () => {
  it("shows funding since open with the paid-positive convention stated", () => {
    const field = fieldFor(positionDetail(POSITION), "Funding paid");
    expect(field.value).toBe(POSITION.fundingPaid.sinceOpen);
    // Without the caveat a cost reads as income: the sign here is the
    // position's convention (positive = paid), the OPPOSITE of the ledger's.
    expect(field.caveat).toMatch(/positive means you paid/);
  });

  const POSITION = {
    coin: "BTC",
    side: "long",
    size: "0.00024",
    leverage: 20,
    entryPxDisplay: "63645.0",
    unrealizedPnl: "-0.11",
    returnOnEquity: "-0.15",
    liquidationPx: null,
    marginMode: "cross",
    // Live wire values: positive = funding this position PAID.
    fundingPaid: { allTime: "0.008535", sinceOpen: "0.008535", sinceChange: "0.008535" },
  } as unknown as Position;

  it("shows the size plainly — the direction is already in the subtitle", () => {
    // "unsigned — side carries direction" was a note for developers reading
    // wire semantics, not for a user reading their position.
    expect(fieldFor(positionDetail(POSITION), "Size").caveat).toBeUndefined();
    expect(positionDetail(POSITION).subtitle).toMatch(/long/);
  });

  it("renders return on equity as a percentage, not a ten-decimal ratio", () => {
    expect(fieldFor(positionDetail(POSITION), "Return on equity").value).toBe("-15.00%");
  });

  it("explains a missing liquidation price instead of showing a bare dash", () => {
    const field = fieldFor(positionDetail(POSITION), "Liquidation price");

    expect(field.value).toBe("--");
    expect(field.caveat).toMatch(/not published/i);
  });

  it("adds no caveat when a liquidation price exists", () => {
    const detail = positionDetail({ ...POSITION, liquidationPx: "60000" } as Position);

    expect(fieldFor(detail, "Liquidation price").caveat).toBeUndefined();
  });
});

describe("orderDetail", () => {
  const ROW = {
    oid: 9,
    cloid: null,
    coin: "BTC",
    side: "buy",
    limitPx: "60000",
    remainingSz: "0.0001",
    originalSz: "0.0002",
    placedAt: 1,
    isTrigger: false,
    triggerPx: null,
    triggerCondition: "N/A",
    orderType: "Limit",
    tif: "Gtc",
    reduceOnly: false,
    isPositionTpsl: false,
    children: [],
  } as unknown as OpenOrderRow;

  it("notes that the remaining size is what a cancel acts on", () => {
    // The row shows `remainingSz`; a cancel-and-replace built on `originalSz`
    // re-places the wrong quantity.
    expect(fieldFor(orderDetail(ROW), "Remaining").caveat).toMatch(/cancel acts on/i);
  });

  it("warns that a client id is not unique", () => {
    expect(fieldFor(orderDetail(ROW), "Client id").caveat).toMatch(/not unique/i);
  });
});

describe("orderHistoryDetail", () => {
  const ORDER = {
    oid: 1,
    cloid: null,
    coin: "BTC",
    side: "buy",
    events: [{}],
    finalStatus: "open",
    isTerminal: false,
    placedAt: 1,
    lastAt: 2,
  } as unknown as OrderLifecycle;

  it("says a non-terminal status means the history ended, not that it is live", () => {
    expect(fieldFor(orderHistoryDetail(ORDER), "Final status").caveat).toMatch(
      /NOT that the order is live/i
    );
  });

  it("adds no such caveat once the order reached a terminal status", () => {
    const detail = orderHistoryDetail({
      ...ORDER,
      finalStatus: "filled",
      isTerminal: true,
    } as OrderLifecycle);

    expect(fieldFor(detail, "Final status").caveat).toBeUndefined();
  });

  it("says the placed time is the FIRST event", () => {
    // `order.timestamp` holds the FIRE time for a trigger order that fired.
    expect(fieldFor(orderHistoryDetail(ORDER), "Placed").caveat).toMatch(/first event/i);
  });
});

describe("ledgerDetail", () => {
  const VIEWER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ROW: LedgerRow = {
    time: 1,
    hash: "0x0",
    type: "send",
    delta: {
      type: "send",
      usdc: "3.0",
      user: VIEWER,
      destination: VIEWER,
      sourceDex: "",
      destinationDex: "spot",
    },
  };

  it("shows the raw delta verbatim", () => {
    // `history/ledger.ts` keeps it unparsed because new types keep appearing —
    // the detail view is where that record belongs.
    const value = fieldFor(ledgerDetail(ROW, VIEWER), "Raw record").value;

    expect(value).toContain("sourceDex");
    expect(value).toContain("3.0");
  });

  it("reports an internal move as internal, not as a withdrawal", () => {
    // Both sides are the viewer — 45.7% of `send` rows.
    expect(fieldFor(ledgerDetail(ROW, VIEWER), "Direction").value).toBe("internal");
  });

  it("explains that an empty dex name is the default perp dex", () => {
    const field = fieldFor(ledgerDetail(ROW, VIEWER), "Between");

    expect(field.value).toBe("perp → spot");
    expect(field.caveat).toMatch(/default perp dex/i);
  });
});

describe("fundingDetail", () => {
  const PAID = {
    time: 1_786_629_600_020,
    coin: "BTC",
    usdc: "-0.000191",
    szi: "0.00024",
    fundingRate: "0.0000125",
  };

  it("labels the amount by its live-verified sign", () => {
    expect(fundingDetail(PAID).subtitle).toMatch(/paid/);
    expect(fundingDetail({ ...PAID, usdc: "0.000343" }).subtitle).toMatch(/received/);
  });

  it("renders the rate at FULL precision — two decimals would show 0.00%", () => {
    const field = fundingDetail(PAID).fields.find((f) => f.label === "Funding rate");

    expect(field?.value).toBe("0.00125%");
  });

  it("keeps the position size signed, with the caveat that explains it", () => {
    const field = fundingDetail({ ...PAID, szi: "-0.5" }).fields.find(
      (f) => f.label === "Position size"
    );

    expect(field?.value).toBe("-0.5");
    expect(field?.caveat).toMatch(/short/i);
  });
});
