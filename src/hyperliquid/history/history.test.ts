import { HlError } from "@/hyperliquid/core/errors";
import {
  LEDGER_PAGE_CAP,
  fetchLedgerPage,
  ledgerAmount,
  ledgerDexes,
  ledgerDirection,
  ledgerKey,
  ledgerPageWindow,
  mergeLedger,
  parseLedger,
  seedLedger,
  totalLedgerAmount,
  type LedgerRow,
} from "@/hyperliquid/history/ledger";
import {
  ORDER_HISTORY_CAP,
  TERMINAL_STATUSES,
  fetchOrderHistory,
  groupByOrder,
  parseOrderEvents,
} from "@/hyperliquid/history/orders";
import {
  TwapStore,
  parseTwapStates,
  twapAveragePrice,
  twapProgress,
} from "@/hyperliquid/history/twap";
import type { Hex } from "@/hyperliquid/types/domain";

const ME = "0x0e7d09a53f348fcef8bb139af9ebb552f4a33fe9" as Hex;
const OTHER = "0x1111111111111111111111111111111111111111";

function row(time: number, hash: string, delta: Record<string, unknown>): LedgerRow {
  return { time, hash, type: String(delta.type), delta };
}

describe("the ledger's paging trap", () => {
  it("reports hasMore on a full page, because the cap truncates the NEWEST rows", async () => {
    // Measured: the response caps at 2000 and, when `startTime` is supplied,
    // keeps the OLDEST. A caller that ignores this shows a history that stopped
    // months ago and never advances.
    const full = Array.from({ length: LEDGER_PAGE_CAP }, (_, i) => ({
      time: 1_000 + i,
      hash: `0x${i}`,
      delta: { type: "deposit", usdc: "1.0" },
    }));
    const page = await fetchLedgerPage({
      probe: { userNonFundingLedgerUpdates: async () => full },
      user: ME,
      startTime: 0,
    });
    expect(page.hasMore).toBe(true);
    // +1ms, because both bounds are INCLUSIVE — reusing the last timestamp
    // re-reads that row, and skipping past it drops its same-millisecond
    // siblings (up to 10 observed sharing one).
    expect(page.nextStartTime).toBe(1_000 + LEDGER_PAGE_CAP - 1 + 1);
  });

  it("seeds from the NEWEST end by omitting startTime entirely", async () => {
    // The parameter the SDK documents as having no effect is what flips the
    // endpoint to newest-first. Passing `startTime: 0` gets a disjoint window —
    // zero shared rows on four measured accounts.
    const sent: Record<string, unknown>[] = [];
    await seedLedger({
      probe: {
        userNonFundingLedgerUpdates: async (p) => {
          sent.push(p as Record<string, unknown>);
          return [];
        },
      },
      user: ME,
    });
    expect("startTime" in sent[0]).toBe(false);
  });

  it("refuses an inverted window rather than reading its empty answer as 'no history'", async () => {
    await expect(
      fetchLedgerPage({
        probe: { userNonFundingLedgerUpdates: async () => [] },
        user: ME,
        startTime: 2_000,
        endTime: 1_000,
      })
    ).rejects.toThrow(HlError);
  });
});

describe("the ledger dedup key", () => {
  it("survives two rows sharing a hash AND a millisecond", () => {
    // Measured on a real account: deduping by hash — or by (time, hash) — would
    // drop a genuine 99,999 USDC withdrawal.
    const a = row(1, "0xsame", { type: "withdraw", usdc: "99999.0", nonce: 1 });
    const b = row(1, "0xsame", { type: "withdraw", usdc: "1.0", nonce: 2 });
    expect(ledgerKey(a)).not.toBe(ledgerKey(b));
    expect(mergeLedger([a], [b])).toHaveLength(2);
  });

  it("does not duplicate a row seen on two overlapping pages", () => {
    const a = row(5, "0xa", { type: "deposit", usdc: "10.0" });
    expect(mergeLedger([a], [a])).toHaveLength(1);
  });

  it("keeps rows in time order after a merge", () => {
    const merged = mergeLedger(
      [row(3, "0xc", { type: "deposit", usdc: "1.0" })],
      [row(1, "0xa", { type: "deposit", usdc: "1.0" })]
    );
    expect(merged.map((r) => r.time)).toEqual([1, 3]);
  });
});

describe("direction, which is not on the wire", () => {
  it("calls a SELF-transfer internal, not outgoing", () => {
    // 45.7% of `send` rows have user === destination === the viewer. Rendering
    // one as money leaving tells a user they paid a stranger.
    const self = row(1, "0xa", {
      type: "send",
      user: ME.toLowerCase(),
      destination: ME.toLowerCase(),
      sourceDex: "",
      destinationDex: "spot",
      usdc: "50.0",
    });
    expect(ledgerDirection(self, ME)).toBe("internal");
    expect(ledgerDexes(self)).toEqual({ from: "", to: "spot" });
  });

  it("reads in and out from the addresses", () => {
    const incoming = row(1, "0xa", { type: "send", user: OTHER, destination: ME.toLowerCase() });
    const outgoing = row(1, "0xb", { type: "send", user: ME.toLowerCase(), destination: OTHER });
    expect(ledgerDirection(incoming, ME)).toBe("in");
    expect(ledgerDirection(outgoing, ME)).toBe("out");
  });

  it("compares addresses case-insensitively", () => {
    // The wire is lowercase; a caller may hold a checksummed address. A
    // case-sensitive compare reports every row as unknown.
    const incoming = row(1, "0xa", { type: "send", user: OTHER, destination: ME.toLowerCase() });
    expect(ledgerDirection(incoming, ME.toUpperCase())).toBe("in");
  });

  it("calls a vault withdrawal IN — `user` there is the RECIPIENT, not the payer", () => {
    // The address inference reads `user` as the payer, right for `send` and
    // wrong here: the SDK documents `vaultWithdraw.user` as "address of the
    // user withdrawing funds", and the delta carries no `destination`. So
    // `from === me` matched and the row was labelled "out" — money ARRIVING,
    // painted danger-red with a minus sign in the row, the detail sheet and the
    // CSV export.
    const withdrawal = row(1, "0xa", {
      type: "vaultWithdraw",
      vault: "0xvault",
      user: ME.toLowerCase(),
      requestedUsd: "500.0",
      netWithdrawnUsd: "497.31",
    });
    expect(ledgerDirection(withdrawal, ME)).toBe("in");
  });

  it("calls leader commission IN — same shape, same recipient meaning", () => {
    const commission = row(1, "0xa", {
      type: "vaultLeaderCommission",
      user: ME.toLowerCase(),
      usdc: "12.5",
    });
    expect(ledgerDirection(commission, ME)).toBe("in");
  });

  it("still says unknown for ANOTHER follower's vault row", () => {
    // A vault's own ledger carries every follower's rows. Claiming a direction
    // relative to a viewer who is not on the row is exactly what the old branch
    // protected against, and it has to survive the fix.
    const someoneElse = row(1, "0xa", {
      type: "vaultWithdraw",
      vault: "0xvault",
      user: OTHER,
      requestedUsd: "1.0",
    });
    expect(ledgerDirection(someoneElse, ME)).toBe("unknown");
  });

  it("uses the type when there is no counterparty at all", () => {
    expect(ledgerDirection(row(1, "0xa", { type: "deposit", usdc: "5.0" }), ME)).toBe("in");
    expect(ledgerDirection(row(1, "0xb", { type: "withdraw", usdc: "5.0" }), ME)).toBe("out");
    expect(ledgerDirection(row(1, "0xc", { type: "spotGenesis" }), ME)).toBe("unknown");
  });

  it("says unknown when neither side is the viewer, which is REAL", () => {
    // A vault's own ledger carries every follower's deposits, and
    // `vaultWithdraw.user` is frequently somebody else.
    const foreign = row(1, "0xa", { type: "vaultWithdraw", user: OTHER, destination: OTHER });
    expect(ledgerDirection(foreign, ME)).toBe("unknown");
  });
});

describe("ledger amounts stay exact", () => {
  it("never rounds a 20-significant-digit money string", () => {
    // Measured: 15 type.field combinations carry values lossy through Number().
    const big = row(1, "0xa", { type: "deposit", usdc: "1500000.8799999999" });
    expect(ledgerAmount(big)).toBe("1500000.8799999999");
    expect(totalLedgerAmount([big])).toBe("1500000.8799999999");
  });

  it("sums without float drift", () => {
    expect(
      totalLedgerAmount([
        row(1, "0xa", { type: "deposit", usdc: "0.1" }),
        row(2, "0xb", { type: "deposit", usdc: "0.2" }),
      ])
    ).toBe("0.3");
  });

  it("prefers the USD value of a token move over the raw token amount", () => {
    expect(
      ledgerAmount(row(1, "0xa", { type: "spotTransfer", amount: "1000.0", usdcValue: "42.5" }))
    ).toBe("42.5");
  });
});

describe("the ledger parser degrades rather than throwing", () => {
  it("drops only the malformed rows", () => {
    const rows = parseLedger([
      { time: 1, hash: "0xa", delta: { type: "deposit", usdc: "1.0" } },
      null,
      42,
      { time: "not a number", delta: { type: "deposit" } },
      { time: 2, delta: null },
      { time: 3, hash: "0xb", delta: { usdc: "1.0" } },
    ]);
    expect(rows).toHaveLength(1);
  });

  it("keeps a type the SDK does not declare", () => {
    // `gossipPriorityGasAuction` is the 6th most common type on the wire and is
    // absent from the SDK's union entirely — a switch written from that type
    // narrows it to `never` and drops it.
    const rows = parseLedger([
      {
        time: 1,
        hash: "0xa",
        delta: { type: "gossipPriorityGasAuction", token: "HYPE", amount: "1.0" },
      },
    ]);
    expect(rows[0].type).toBe("gossipPriorityGasAuction");
  });

  it("keeps the all-zero hash, which means 'no L1 tx' rather than 'missing'", () => {
    const zero = "0x" + "0".repeat(64);
    expect(parseLedger([{ time: 1, hash: zero, delta: { type: "deposit" } }])[0].hash).toBe(zero);
  });
});

describe("order history is a stream of EVENTS, not orders", () => {
  const lifecycle = [
    {
      order: { oid: 7, coin: "BTC", side: "B", timestamp: 100 },
      status: "open",
      statusTimestamp: 100,
    },
    {
      order: { oid: 7, coin: "BTC", side: "B", timestamp: 100 },
      status: "filled",
      statusTimestamp: 100,
    },
    {
      order: { oid: 8, coin: "ETH", side: "A", timestamp: 50 },
      status: "canceled",
      statusTimestamp: 50,
    },
  ];

  it("collapses repeated oids into one order", () => {
    // Keying a list by oid renders duplicates; counting rows roughly doubles the
    // order count.
    const orders = groupByOrder(parseOrderEvents(lifecycle));
    expect(orders).toHaveLength(2);
    expect(orders.find((o) => o.oid === 7)!.events).toHaveLength(2);
  });

  it("puts a terminal event last even when it shares a timestamp with the placement", () => {
    // Both rows carry statusTimestamp 100. A plain sort renders "filled" above
    // "placed" at random.
    const order = groupByOrder(parseOrderEvents(lifecycle)).find((o) => o.oid === 7)!;
    expect(order.events.map((e) => e.status)).toEqual(["open", "filled"]);
    expect(order.finalStatus).toBe("filled");
    expect(order.isTerminal).toBe(true);
  });

  it("does NOT treat a status of 'open' as a live order", () => {
    // The SDK's doc says "active and waiting to be filled". Taken literally it
    // showed 907 phantom live orders on an account with 3.
    const open = groupByOrder(
      parseOrderEvents([
        { order: { oid: 9, coin: "BTC", side: "B" }, status: "open", statusTimestamp: 1 },
      ])
    )[0];
    expect(open.isTerminal).toBe(false);
    // The type carries no `isLive`, deliberately — there is no such fact here.
    expect(open).not.toHaveProperty("isLive");
  });

  it("takes placedAt from the first EVENT, not order.timestamp", () => {
    // A trigger order that fires re-enters under the same oid with
    // `order.timestamp` rewritten to the FIRE time, so that field would report a
    // stop-loss as placed the moment it triggered.
    const order = groupByOrder(
      parseOrderEvents([
        {
          order: { oid: 1, coin: "BTC", side: "B", timestamp: 500 },
          status: "open",
          statusTimestamp: 100,
        },
        {
          order: { oid: 1, coin: "BTC", side: "B", timestamp: 500 },
          status: "filled",
          statusTimestamp: 500,
        },
      ])
    )[0];
    expect(order.placedAt).toBe(100);
  });

  it("carries the cloid forward as the one per-order constant", () => {
    const cloid = `0x${"a".repeat(32)}`;
    const order = groupByOrder(
      parseOrderEvents([
        { order: { oid: 1, coin: "BTC", side: "B", cloid }, status: "open", statusTimestamp: 1 },
        { order: { oid: 1, coin: "BTC", side: "B" }, status: "filled", statusTimestamp: 2 },
      ])
    )[0];
    expect(order.cloid).toBe(cloid);
  });

  it("flags truncation, because there is NO way to page past it", () => {
    const full = Array.from({ length: ORDER_HISTORY_CAP }, (_, i) => ({
      order: { oid: i, coin: "BTC", side: "B" },
      status: "filled",
      statusTimestamp: i,
    }));
    return fetchOrderHistory({
      probe: { historicalOrders: async () => full },
      user: ME,
    }).then((history) => {
      expect(history.truncated).toBe(true);
      expect(history.orders).toHaveLength(ORDER_HISTORY_CAP);
    });
  });
});

describe("TWAP", () => {
  const state = {
    coin: "BTC",
    side: "B",
    sz: "100.0",
    executedSz: "25.0",
    executedNtl: "1250.0",
    minutes: 30,
    reduceOnly: false,
    randomize: true,
    timestamp: 1_000,
  };

  it("parses the [twapId, state] tuple form", () => {
    const parsed = parseTwapStates({ states: [[42, state]] });
    expect(parsed[0]).toMatchObject({ twapId: 42, coin: "BTC", isBuy: true, size: "100.0" });
  });

  it("computes progress and average price exactly", () => {
    const [parsed] = parseTwapStates({ states: [[42, state]] });
    expect(twapProgress(parsed)).toBe("0.25");
    expect(twapAveragePrice(parsed)).toBe("50");
  });

  it("returns null progress rather than 0 when the total is unusable", () => {
    // A bar sitting at 0% claims nothing has executed. That is a different
    // statement from "we cannot tell".
    const [zero] = parseTwapStates({ states: [[1, { ...state, sz: "0.0" }]] });
    expect(twapProgress(zero)).toBeNull();
    const [fresh] = parseTwapStates({ states: [[1, { ...state, executedSz: "0.0" }]] });
    expect(twapAveragePrice(fresh)).toBeNull();
  });

  it("distinguishes 'no frame yet' from 'no TWAPs running'", () => {
    // The wrong dex answers with an empty array and no error, so these two states
    // must not collapse — one warrants a spinner, the other an empty state.
    const store = new TwapStore();
    store.setDex("");
    expect(store.read()).toBeNull();
    expect(store.hasHeard()).toBe(false);

    store.apply({ states: [] }, 1);
    expect(store.read()).toEqual([]);
    expect(store.hasHeard()).toBe(true);
  });

  it("REPLACES on each frame, because the feed is a full-set heartbeat", () => {
    const store = new TwapStore();
    store.setDex("");
    store.apply({ states: [[1, state]] }, 1);
    store.apply({ states: [[2, state]] }, 2);
    expect(store.read()!.map((s) => s.twapId)).toEqual([2]);
  });

  it("clears when the dex changes, because a TWAP set is dex-scoped", () => {
    // Measured: `{user}` returned 0 TWAPs while `{user, dex:"xyz"}` returned the
    // 2 that were running.
    const store = new TwapStore();
    store.setDex("");
    store.apply({ states: [[1, state]] }, 1);
    store.setDex("xyz");
    expect(store.read()).toBeNull();
    expect(store.currentDex()).toBe("xyz");
  });
});

describe("TERMINAL_STATUSES completeness", () => {
  /**
   * The SDK's own declared union, transcribed from
   * `@nktkas/hyperliquid/esm/api/info/_methods/historicalOrders.d.ts`.
   *
   * Pinned here because the previous set was assembled from what a test
   * account happened to produce and silently omitted 15 entries — which showed
   * up as 148 of 149 real orders reporting "no final status".
   */
  const DECLARED = [
    "open",
    "filled",
    "canceled",
    "triggered",
    "rejected",
    "marginCanceled",
    "vaultWithdrawalCanceled",
    "openInterestCapCanceled",
    "selfTradeCanceled",
    "reduceOnlyCanceled",
    "siblingFilledCanceled",
    "delistedCanceled",
    "liquidatedCanceled",
    "scheduledCancel",
    "tickRejected",
    "minTradeNtlRejected",
    "perpMarginRejected",
    "reduceOnlyRejected",
    "badAloPxRejected",
    "iocCancelRejected",
    "badTriggerPxRejected",
    "marketOrderNoLiquidityRejected",
    "positionIncreaseAtOpenInterestCapRejected",
    "positionFlipAtOpenInterestCapRejected",
    "tooAggressiveAtOpenInterestCapRejected",
    "openInterestIncreaseRejected",
    "insufficientSpotBalanceRejected",
    "oracleRejected",
    "perpMaxPositionRejected",
    "tooManyOpenOrdersRejected",
    "internalCancel",
    "outcomeSettledCanceled",
  ];

  /** The only two that are NOT an ending. */
  const LIVE = new Set(["open", "triggered"]);

  it("covers every declared status that ends an order", () => {
    const missing = DECLARED.filter((s) => !LIVE.has(s) && !TERMINAL_STATUSES.has(s));
    expect(missing).toEqual([]);
  });

  it("does not claim a live status is terminal", () => {
    // `triggered` especially: a trigger order that fired becomes a resting
    // order and keeps emitting events.
    for (const status of LIVE) expect(TERMINAL_STATUSES.has(status)).toBe(false);
  });

  it("marks an IOC rejection terminal", () => {
    // The specific omission that produced the bug: this status accounted for
    // 148 of 149 orders on the account it was measured against.
    expect(TERMINAL_STATUSES.has("iocCancelRejected")).toBe(true);
  });
});

describe("ledgerAmount", () => {
  it("reads a vault withdrawal's NET, the only money field it carries", () => {
    // `vaultWithdraw` carries none of usdcValue/usdc/amount — its money fields
    // are requestedUsd, commission, closingCost, basis, netWithdrawnUsd. Every
    // vault withdrawal therefore showed "--" in the row, blank in the detail
    // sheet and an empty cell in the CSV. The NET is what landed in the
    // account; `requestedUsd` is the gross ask and is not what we show.
    const withdrawal = row(1, "0xa", {
      type: "vaultWithdraw",
      vault: "0xvault",
      user: ME.toLowerCase(),
      requestedUsd: "500.0",
      netWithdrawnUsd: "497.31",
    });
    expect(ledgerAmount(withdrawal)).toBe("497.31");
  });
});

describe("ledgerPageWindow", () => {
  /** Only `time` matters to the window; the rest of a row is irrelevant. */
  const at = (time: number) => ({ time }) as unknown as LedgerRow;

  it("bounds the walk at the seed's oldest row", () => {
    expect(ledgerPageWindow({ cursor: 0, seedRows: [at(500), at(900)] })).toEqual({
      startTime: 0,
      endTime: 500,
    });
  });

  it("keeps that bound fixed as the cursor advances — the regression", () => {
    // The bug: the bound was recomputed from seed + already-walked rows, so it
    // moved OLDER every page and slid below the cursor. From page two the fetch
    // threw an inverted-window error, AFTER the budget had been charged, with
    // `done` still false — so the button stayed live and every tap cost 20 more.
    const seedRows = [at(500), at(900)];
    expect(ledgerPageWindow({ cursor: 200, seedRows })?.endTime).toBe(500);
    expect(ledgerPageWindow({ cursor: 400, seedRows })?.endTime).toBe(500);
  });

  it("refuses to build a window that ends before it starts", () => {
    // The caller must not spend weight on a request that cannot succeed.
    expect(ledgerPageWindow({ cursor: 501, seedRows: [at(500)] })).toBeNull();
  });

  it("allows a cursor exactly at the bound — a one-instant window is valid", () => {
    expect(ledgerPageWindow({ cursor: 500, seedRows: [at(500)] })).toEqual({
      startTime: 500,
      endTime: 500,
    });
  });

  it("returns null when the seed is empty", () => {
    expect(ledgerPageWindow({ cursor: 0, seedRows: [] })).toBeNull();
  });
});
