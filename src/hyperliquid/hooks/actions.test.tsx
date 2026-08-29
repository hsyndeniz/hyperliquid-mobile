/**
 * The two write actions, checked at the level where they can lose money.
 *
 * `placeOrders` and `cancelOrders` are mocked — they have their own suites, and
 * re-testing them here would hide what this file is actually for: the handful
 * of decisions this hook makes before calling them. Each one below is a
 * specific, expensive failure:
 *
 * | Decision | What getting it wrong does |
 * | --- | --- |
 * | direction | closing a long as a BUY **doubles** the position at market |
 * | `reduceOnly` | a rounding error opens the opposite position |
 * | fresh mid | a stale price on an IOC crosses the book at the wrong level |
 * | refuse when unpriced | guessing a reference price fills at any price |
 * | size | the position's own size, unsigned |
 *
 * Assertions are on the **wire leg** `{a, b, p, s, r, t}` rather than on the
 * builder's input, because that is the shape that actually reaches the
 * exchange — `b` is isBuy, `r` is reduceOnly, `t.limit.tif` the time-in-force.
 */

import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useOrderActions, type ActionResult } from "@/hyperliquid/hooks/actions";
import type { HyperliquidSession } from "@/hyperliquid/session";
import type { OpenOrderRow, Position } from "@/hyperliquid/types/domain";

const mockPlaceOrders = jest.fn();
const mockCancelOrders = jest.fn();
const mockAllMids = jest.fn();
const mockUpdateIsolatedMargin = jest.fn();
/** Rows the fake `openOrders` store reports; set per test. */
let openOrderRows: OpenOrderRow[] = [];

jest.mock("@/hyperliquid/orders/place", () => ({
  placeOrders: (...args: unknown[]) => mockPlaceOrders(...args),
}));
jest.mock("@/hyperliquid/orders/exchange", () => ({
  cancelOrders: (...args: unknown[]) => mockCancelOrders(...args),
  updateIsolatedMargin: (...args: unknown[]) => mockUpdateIsolatedMargin(...args),
}));
jest.mock("@/hyperliquid/api/clients", () => ({
  getInfoClient: () => ({ allMids: () => mockAllMids() }),
  getHttpTransport: () => ({}),
}));
jest.mock("@/hyperliquid/hooks/assets", () => ({
  assetIndex: async () => ({ getAssetId: () => 0 }),
}));
jest.mock("@/hyperliquid/assets", () => ({
  resolveAssetSpec: () => ({ assetId: 0, szDecimals: 5, marketType: "perp" }),
}));

/** Enough of a session for the hook; the parts it touches and nothing else. */
function fakeSession(): HyperliquidSession {
  return {
    state: () => ({
      identity: {
        env: "testnet",
        accountId: "acc",
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        dex: null,
        subAccount: null,
      },
      agent: { status: { kind: "ready" } },
    }),
    exchangeClient: () => ({}),
    stores: {
      openOrders: { read: () => ({ rows: openOrderRows, unconfirmed: [] }) },
    },
  } as unknown as HyperliquidSession;
}

function longPosition(): Position {
  return {
    coin: "BTC",
    side: "long",
    // Unsigned by contract — `side` carries the direction.
    size: "0.0002",
    leverage: 20,
    entryPxDisplay: "63000",
    unrealizedPnl: "-0.15",
    liquidationPx: null,
  } as unknown as Position;
}

function makeProbe(): {
  Probe: () => null;
  actions: () => ReturnType<typeof useOrderActions>;
} {
  const seen: ReturnType<typeof useOrderActions>[] = [];
  function Probe(): null {
    seen.push(useOrderActions(fakeSession()));
    return null;
  }
  return { Probe, actions: () => seen[seen.length - 1] };
}

describe("closePosition", () => {
  let tree: ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAllMids.mockResolvedValue({ BTC: "64000" });
    mockPlaceOrders.mockResolvedValue({ kind: "settled", result: { legs: [{ kind: "filled" }] } });
  });

  afterEach(() => act(() => tree?.unmount()));

  async function close(position: Position) {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    await act(async () => {
      await probe.actions().closePosition(position);
    });
    return mockPlaceOrders.mock.calls[0]?.[0];
  }

  it("closes a LONG with a SELL", async () => {
    // The line that doubles a position if written backwards.
    const call = await close(longPosition());

    expect(call.orders[0].b).toBe(false);
  });

  it("closes a SHORT with a BUY", async () => {
    const call = await close({ ...longPosition(), side: "short" } as Position);

    expect(call.orders[0].b).toBe(true);
  });

  it("sets reduceOnly", async () => {
    // Without it, a rounding error or a concurrent fill flips the position to
    // the other side instead of flattening it.
    const call = await close(longPosition());

    expect(call.orders[0].r).toBe(true);
  });

  it("sends the position's own size", async () => {
    const call = await close(longPosition());

    expect(call.orders[0].s).toBe("0.0002");
  });

  it("prices as an IOC through the book, not at the mid", async () => {
    // A market order is an IOC limit priced through the book. A sell priced AT
    // the mid may simply not fill.
    const call = await close(longPosition());

    expect(call.orders[0].t.limit.tif).toBe("Ioc");
    expect(Number(call.orders[0].p)).toBeLessThan(64000);
  });

  it("reads the mid FRESH on every close", async () => {
    await close(longPosition());
    await close(longPosition());

    // Twice, not once from a cache: a stale mid is exactly the wrong input to
    // a market order, which is why this path bypasses the price cache.
    expect(mockAllMids).toHaveBeenCalledTimes(2);
  });

  it("refuses rather than guessing when the coin has no live price", async () => {
    mockAllMids.mockResolvedValue({ ETH: "3000" });

    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    let result: ActionResult | undefined;
    await act(async () => {
      result = await probe.actions().closePosition(longPosition());
    });

    expect(result).toMatchObject({ kind: "failed" });
    // Nothing was sent — a guessed reference crosses the book at any cost.
    expect(mockPlaceOrders).not.toHaveBeenCalled();
  });

  it("reports an UNKNOWN submit as unknown — neither failed nor done", async () => {
    // The order may well have landed; the journal holds the cloid. Reporting
    // "failed" invites a double close — and reporting "done", which this
    // asserted until 2026-08-29, is the mirror-image lie: it let the TP/SL
    // sheet close as if the bracket had been placed. Only a genuine unknown
    // gets this kind; a definite refusal must fail loudly (below).
    mockPlaceOrders.mockResolvedValue({ kind: "unknown", cloids: [], expiresAt: 0 });

    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    let result: ActionResult | undefined;
    await act(async () => {
      result = await probe.actions().closePosition(longPosition());
    });

    expect(result).toMatchObject({ kind: "unknown" });
    expect(result?.kind === "unknown" && result.note).toMatch(/check open orders/i);
  });

  it("reports a rejected_locally close as FAILED — nothing was sent, retry is safe", async () => {
    // The old behavior folded this into the unknown note, clearing the
    // spinner with no error while the position silently stayed open.
    mockPlaceOrders.mockResolvedValue({
      kind: "rejected_locally",
      error: new Error("schema refused the size"),
    });

    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    let result: ActionResult | undefined;
    await act(async () => {
      result = await probe.actions().closePosition(longPosition());
    });

    expect(result).toMatchObject({ kind: "failed" });
  });

  it("reports a settled REFUSAL as failed — settled means answered, not placed", async () => {
    // A top-level {status:"err"} settles with anyAccepted:false; claiming
    // "done" leaves the user believing they are flat with the position open.
    mockPlaceOrders.mockResolvedValue({
      kind: "settled",
      result: {
        legs: [{ kind: "rejected", index: 0, error: "Price band" }],
        anyAccepted: false,
        anyRejected: true,
        isPartial: false,
        batchRejected: true,
        serverError: "Cannot process action",
      },
    });

    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    let result: ActionResult | undefined;
    await act(async () => {
      result = await probe.actions().closePosition(longPosition());
    });

    expect(result).toMatchObject({ kind: "failed" });
    expect(result?.kind === "failed" && result.error.message).toMatch(/cannot process action/i);
  });
});

describe("cancelOrder", () => {
  let tree: ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCancelOrders.mockResolvedValue({ ok: true });
  });

  afterEach(() => act(() => tree?.unmount()));

  const row = { oid: 123, coin: "BTC" } as OpenOrderRow;

  it("cancels one order at a time", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    await act(async () => {
      await probe.actions().cancelOrder(row);
    });

    // One per call, deliberately: a bulk cancel throws if any one oid is
    // already filled while the others still took effect, and there is no way
    // to tell which from the throw.
    expect(mockCancelOrders.mock.calls[0][0].cancels).toEqual([{ assetId: 0, oid: 123 }]);
  });

  it("reports a refused cancel as failed", async () => {
    mockCancelOrders.mockResolvedValue({ ok: false, error: new Error("already filled") });

    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    let result: ActionResult | undefined;
    await act(async () => {
      result = await probe.actions().cancelOrder(row);
    });

    expect(result).toMatchObject({ kind: "failed" });
  });
});

/**
 * The three money actions that had NO coverage at all until 2026-08-29 —
 * `setPositionTpsl`, `closeAll` and `adjustIsolatedMargin`. The gap mattered
 * most for the TP/SL replace: a refactor could drop the cancel-existing-first
 * step, reorder it after the place, or stop refusing when the cancel fails,
 * and every suite would stay green while users accumulated stacked brackets.
 */
describe("setPositionTpsl", () => {
  let tree: ReactTestRenderer;

  function bracketRow(oid: number): OpenOrderRow {
    return { oid, coin: "BTC", isTrigger: true, isPositionTpsl: true } as unknown as OpenOrderRow;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    openOrderRows = [];
    mockCancelOrders.mockResolvedValue({ ok: true });
    mockPlaceOrders.mockResolvedValue({
      kind: "settled",
      result: { legs: [{ kind: "resting" }], anyAccepted: true, isPartial: false },
    });
  });

  afterEach(() => act(() => tree?.unmount()));

  async function apply(prices: { takeProfitPrice: string; stopLossPrice: string }) {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    let result: ActionResult | undefined;
    await act(async () => {
      result = await probe.actions().setPositionTpsl(longPosition(), prices);
    });
    return { result, actions: probe.actions };
  }

  it("cancels this coin's existing whole-position brackets BEFORE placing", async () => {
    openOrderRows = [bracketRow(11), bracketRow(12)];
    const order: string[] = [];
    mockCancelOrders.mockImplementation(async () => {
      order.push("cancel");
      return { ok: true };
    });
    mockPlaceOrders.mockImplementation(async () => {
      order.push("place");
      return { kind: "settled", result: { legs: [], anyAccepted: true, isPartial: false } };
    });

    await apply({ takeProfitPrice: "70000", stopLossPrice: "" });

    // Ordering is the whole point: the exchange ADDS a bracket rather than
    // superseding one, so placing first would leave two live.
    expect(order).toEqual(["cancel", "place"]);
    expect(mockCancelOrders.mock.calls[0][0].cancels.map((c: { oid: number }) => c.oid)).toEqual([
      11, 12,
    ]);
  });

  it("leaves another coin's brackets and the user's own stop limits alone", async () => {
    openOrderRows = [
      bracketRow(11),
      { oid: 22, coin: "ETH", isTrigger: true, isPositionTpsl: true } as unknown as OpenOrderRow,
      // A hand-placed stop is the user's own order, not this sheet's to cancel.
      { oid: 33, coin: "BTC", isTrigger: true, isPositionTpsl: false } as unknown as OpenOrderRow,
    ];

    await apply({ takeProfitPrice: "70000", stopLossPrice: "" });

    expect(mockCancelOrders.mock.calls[0][0].cancels.map((c: { oid: number }) => c.oid)).toEqual([
      11,
    ]);
  });

  it("refuses to place when clearing the old bracket fails", async () => {
    openOrderRows = [bracketRow(11)];
    mockCancelOrders.mockResolvedValue({ ok: false, error: new Error("cancel refused") });

    const { result } = await apply({ takeProfitPrice: "70000", stopLossPrice: "" });

    expect(result).toMatchObject({ kind: "failed" });
    // Pressing on would leave the old bracket beside the new one — the exact
    // outcome the cancel exists to prevent.
    expect(mockPlaceOrders).not.toHaveBeenCalled();
  });

  it("treats an empty ticket as a deliberate CLEAR, not an error", async () => {
    openOrderRows = [bracketRow(11)];

    const { result } = await apply({ takeProfitPrice: "", stopLossPrice: "" });

    expect(result).toMatchObject({ kind: "done" });
    expect(mockCancelOrders).toHaveBeenCalled();
    expect(mockPlaceOrders).not.toHaveBeenCalled();
  });

  it("refuses a second apply while the first is still unconfirmed", async () => {
    // The stacking window. A just-placed bracket is not in `rows` for a second
    // or two, so the cancel above finds nothing and a second apply STACKS.
    // The store deliberately keeps reporting no rows here, which is exactly
    // the state that used to slip through.
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });

    let first: ActionResult | undefined;
    await act(async () => {
      first = await probe
        .actions()
        .setPositionTpsl(longPosition(), { takeProfitPrice: "70000", stopLossPrice: "" });
    });
    expect(first).toMatchObject({ kind: "done" });

    let second: ActionResult | undefined;
    await act(async () => {
      second = await probe
        .actions()
        .setPositionTpsl(longPosition(), { takeProfitPrice: "71000", stopLossPrice: "" });
    });

    expect(second).toMatchObject({ kind: "failed" });
    expect(second?.kind === "failed" && second.error.message).toMatch(/still confirming/i);
    // One placement, not two.
    expect(mockPlaceOrders).toHaveBeenCalledTimes(1);
  });

  it("allows the next apply once the bracket appears in a snapshot", async () => {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    await act(async () => {
      await probe
        .actions()
        .setPositionTpsl(longPosition(), { takeProfitPrice: "70000", stopLossPrice: "" });
    });

    // The exchange confirms it: now it is cancellable, so the block lifts.
    openOrderRows = [bracketRow(11)];

    let second: ActionResult | undefined;
    await act(async () => {
      second = await probe
        .actions()
        .setPositionTpsl(longPosition(), { takeProfitPrice: "71000", stopLossPrice: "" });
    });

    expect(second).toMatchObject({ kind: "done" });
    expect(mockCancelOrders.mock.calls.at(-1)?.[0].cancels).toEqual([{ assetId: 0, oid: 11 }]);
  });
});

describe("the busy slot", () => {
  let tree: ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    openOrderRows = [];
    mockAllMids.mockResolvedValue({ BTC: "64000", ETH: "3000" });
  });

  afterEach(() => act(() => tree?.unmount()));

  it("a finishing action does not clear another action's busy key", async () => {
    // One slot for six actions, and every completion used to clear it
    // unconditionally, so a finishing action wiped a CONCURRENT one's busy
    // state. Closing Y while a TP/SL replace on X sat between its cancel and
    // its place re-armed X's Apply button mid-flight — precisely the window in
    // which a second apply stacks a bracket.
    //
    // Driven for real: X's submit is held open, Y runs to completion against
    // it, and X must still read as busy afterwards.
    let releaseX: (value: unknown) => void = () => {};
    const xInFlight = new Promise((resolve) => {
      releaseX = resolve;
    });

    const settled = {
      kind: "settled",
      result: { legs: [], anyAccepted: true, isPartial: false },
    };
    // X parks; everything after it completes immediately.
    mockPlaceOrders.mockImplementationOnce(async () => {
      await xInFlight;
      return settled;
    });
    mockPlaceOrders.mockResolvedValue(settled);

    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });

    const positionX = longPosition();
    const keyX = probe.actions().positionKey(positionX);

    // X starts and parks inside placeOrders.
    let xDone: Promise<ActionResult> | undefined;
    await act(async () => {
      xDone = probe.actions().closePosition(positionX);
      await Promise.resolve();
    });
    expect(probe.actions().isBusy(keyX)).toBe(true);

    // Y is a REAL second action on a different position — it runs start to
    // finish while X is still in flight, and its completion must not touch X's
    // slot. (An action that early-returns, like `cancelAll([])`, never sets or
    // clears the slot and would prove nothing.)
    const positionY = { ...longPosition(), coin: "ETH" } as Position;
    await act(async () => {
      await probe.actions().closePosition(positionY);
    });

    expect(probe.actions().isBusy(keyX)).toBe(true);

    await act(async () => {
      releaseX(undefined);
      await xDone;
    });
    expect(probe.actions().isBusy(keyX)).toBe(false);
  });
});

describe("adjustIsolatedMargin", () => {
  let tree: ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateIsolatedMargin.mockResolvedValue({ ok: true });
  });

  afterEach(() => act(() => tree?.unmount()));

  async function adjust(amountUsd: string) {
    const probe = makeProbe();
    await act(async () => {
      tree = create(<probe.Probe />);
    });
    let result: ActionResult | undefined;
    await act(async () => {
      result = await probe.actions().adjustIsolatedMargin(longPosition(), amountUsd);
    });
    return { result, call: mockUpdateIsolatedMargin.mock.calls[0]?.[0] };
  }

  it("passes the amount through with its sign — the sign is the verb", async () => {
    const added = await adjust("25");
    expect(added.call.amountUsd).toBe("25");

    jest.clearAllMocks();
    mockUpdateIsolatedMargin.mockResolvedValue({ ok: true });
    const removed = await adjust("-25");
    // A removal that lost its sign ADDS margin instead — the opposite action.
    expect(removed.call.amountUsd).toBe("-25");
  });

  it("reports a refusal as failed rather than claiming the margin moved", async () => {
    mockUpdateIsolatedMargin.mockResolvedValue({ ok: false, error: new Error("insufficient") });

    const { result } = await adjust("25");

    expect(result).toMatchObject({ kind: "failed" });
  });
});
