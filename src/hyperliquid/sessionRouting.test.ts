import { createDispatcher, type RoutingCounters } from "@/hyperliquid/sessionRouting";
import { AccountStore } from "@/hyperliquid/state/account";
import { FillsStore } from "@/hyperliquid/state/fills";
import { OpenOrdersStore } from "@/hyperliquid/state/openOrders";
import { NotificationStore } from "@/hyperliquid/state/notifications";
import { SpotBalanceStore } from "@/hyperliquid/state/spot";
import { createIdentity, identityKey as identityKeyOf } from "@/hyperliquid/core/identity";
import { clearPending, listPending, recordPending } from "@/hyperliquid/orders/pending";
import type { Cloid } from "@/hyperliquid/orders/cloid";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

import chsMixed from "@/hyperliquid/state/__fixtures__/chs-mixed-testnet.json";
import spotMixed from "@/hyperliquid/state/__fixtures__/spot-mixed-testnet.json";
import fillsFixture from "@/hyperliquid/state/__fixtures__/fills-testnet.json";
import twapFixture from "@/hyperliquid/state/__fixtures__/twap-testnet.json";
import openOrdersFixture from "@/hyperliquid/state/__fixtures__/foo-iso-testnet.json";

const ADDRESS = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347";
const NOW = 1_800_000_000_000;
const identity = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });

const CLOID_A = `0x${"a1".repeat(16)}` as Cloid;

function targetFor(channel: SubscriptionTarget["channel"]): SubscriptionTarget {
  return { identity, channel, coin: null, aggregation: null, interval: null };
}

function stores() {
  const set = {
    account: new AccountStore(),
    openOrders: new OpenOrdersStore(),
    fills: new FillsStore(),
    spot: new SpotBalanceStore(),
    notifications: new NotificationStore(),
  };
  for (const [channel, store] of [
    ["clearinghouseState", set.account],
    ["openOrders", set.openOrders],
    ["userFills", set.fills],
    ["spotState", set.spot],
    ["notification", set.notifications],
  ] as const) {
    store.setTarget(targetFor(channel));
  }
  return set;
}

function event(channel: SubscriptionTarget["channel"], value: unknown): Scoped<unknown> {
  return {
    target: targetFor(channel),
    value,
    serverTime: null,
    receivedAt: NOW,
    isSnapshot: true,
  };
}

describe("routing live wire shapes into stores", () => {
  it("routes clearinghouseState, verifying the echoed identity", () => {
    const set = stores();
    createDispatcher(set)(
      event("clearinghouseState", { clearinghouseState: chsMixed, dex: "", user: ADDRESS })
    );

    expect(set.account.read()?.positions).toHaveLength(chsMixed.assetPositions.length);
    expect(set.account.rejected).toBe(0);
  });

  it("refuses a clearinghouseState answered for a different account", () => {
    // A wrong-but-real dex returns HTTP 200 with a well-formed EMPTY account, so
    // the echo check is the only thing between a user and a calm "no positions"
    // screen while they hold live risk.
    const set = stores();
    createDispatcher(set)(
      event("clearinghouseState", { clearinghouseState: chsMixed, dex: "test", user: ADDRESS })
    );

    expect(set.account.read()).toBeNull();
    expect(set.account.rejected).toBe(1);
  });

  it("reads openOrders from `orders`, not from `openOrders`", () => {
    // The event's array field is `orders`. Reading the channel's own name gives
    // undefined, which parses to an empty list and renders as "no open orders".
    const set = stores();
    createDispatcher(set)(event("openOrders", { orders: openOrdersFixture, dex: "" }));

    expect(set.openOrders.size).toBe(openOrdersFixture.length);
    expect(set.openOrders.read().rows.filter((r) => r.isTrigger)).toHaveLength(4);
  });

  it("routes spotState, including outcome rows with no token", () => {
    const set = stores();
    createDispatcher(set)(event("spotState", { spotState: spotMixed }));

    const state = set.spot.read();
    expect(state?.balances).toHaveLength(spotMixed.balances.length);
    expect(state?.balances.filter((b) => b.kind === "outcome").length).toBeGreaterThan(0);
  });

  it("routes userFills", () => {
    const set = stores();
    createDispatcher(set)(event("userFills", { fills: fillsFixture }));
    expect(set.fills.size).toBe(fillsFixture.length);
  });

  it("routes TWAP slices into the same keyspace", () => {
    // They appear in no other feed, so without this a user running a TWAP sees
    // the position move with no fills at all.
    const set = stores();
    createDispatcher(set)(event("userTwapSliceFills", { twapSliceFills: twapFixture }));

    expect(set.fills.size).toBe(twapFixture.length);
    expect(set.fills.read().every((f) => f.source === "twapSlice")).toBe(true);
  });
});

describe("orderUpdates writes no order row", () => {
  beforeEach(() => clearPending());

  it("resolves the journal and evicts the overlay, but adds no row", () => {
    // `orderUpdates` carries the plain shape with no triggerPx, orderType or
    // tif — a stop-loss read from it renders as a resting limit at its trigger.
    const set = stores();
    set.openOrders.addUnconfirmed({
      cloid: CLOID_A,
      oid: null,
      label: null,
      submittedAt: NOW,
      expiresAt: NOW,
    });
    recordPending({
      cloids: [CLOID_A],
      identityKey: identityKeyOf(identity),
      address: ADDRESS,
      expiresAt: NOW,
      submittedAt: NOW,
    });

    createDispatcher(set)(event("orderUpdates", [{ order: { cloid: CLOID_A }, status: "filled" }]));

    expect(set.openOrders.size).toBe(0);
    expect(set.openOrders.read().unconfirmed).toEqual([]);
    expect(listPending()).toEqual([]);
  });

  it("ignores an update with no cloid rather than throwing", () => {
    const set = stores();
    expect(() =>
      createDispatcher(set)(event("orderUpdates", [{ order: { oid: 1 }, status: "open" }]))
    ).not.toThrow();
  });
});

describe("a malformed payload degrades rather than crashing", () => {
  it("counts the rejection and leaves the held value in place", () => {
    // The failure mode this whole approach exists to avoid: a shape change
    // must stop the numbers updating, not put NaN on screen.
    const set = stores();
    const counters: RoutingCounters = { rejected: new Map() };
    const dispatch = createDispatcher(set, counters);

    dispatch(event("clearinghouseState", { clearinghouseState: chsMixed, dex: "", user: ADDRESS }));
    const good = set.account.read();

    dispatch(
      event("clearinghouseState", {
        clearinghouseState: { ...chsMixed, withdrawable: undefined },
        dex: "",
        user: ADDRESS,
      })
    );

    expect(set.account.read()).toBe(good);
    expect(counters.rejected.get("clearinghouseState")).toBe(1);
  });

  it("does not throw out of the dispatcher", () => {
    // A throw here would escape into the websocket listener and kill the feed.
    const set = stores();
    expect(() =>
      createDispatcher(set)(event("spotState", { spotState: "nonsense" }))
    ).not.toThrow();
  });

  it("ignores channels an account session does not own", () => {
    const set = stores();
    expect(() => createDispatcher(set)(event("l2Book", { levels: [[], []] }))).not.toThrow();
    expect(set.account.read()).toBeNull();
  });
});

describe("a wire shape change must not wipe the order list", () => {
  it("rejects a missing orders field instead of synthesising an empty snapshot", () => {
    // `openOrders` does a whole-snapshot REPLACE, so a `?? []` default here is
    // not a degraded read — it is a wipe. A renamed field would parse cleanly to
    // zero rows and show "no open orders" to someone holding live resting
    // stop-losses, with nothing counted and nothing logged.
    const set = stores();
    const counters: RoutingCounters = { rejected: new Map() };
    const dispatch = createDispatcher(set, counters);

    dispatch(event("openOrders", { orders: openOrdersFixture, dex: "" }));
    expect(set.openOrders.size).toBe(openOrdersFixture.length);

    // The wire renames the array.
    dispatch(event("openOrders", { openOrders: openOrdersFixture, dex: "" }));

    expect(set.openOrders.size).toBe(openOrdersFixture.length);
    expect(counters.rejected.get("openOrders")).toBe(1);
  });

  it("rejects a null orders field too", () => {
    const set = stores();
    const counters: RoutingCounters = { rejected: new Map() };
    const dispatch = createDispatcher(set, counters);

    dispatch(event("openOrders", { orders: openOrdersFixture, dex: "" }));
    dispatch(event("openOrders", { orders: null, dex: "" }));

    expect(set.openOrders.size).toBe(openOrdersFixture.length);
    expect(counters.rejected.get("openOrders")).toBe(1);
  });

  it("still accepts a genuinely empty order list", () => {
    // The guard must not confuse "no orders" with "no field".
    const set = stores();
    const dispatch = createDispatcher(set);

    dispatch(event("openOrders", { orders: openOrdersFixture, dex: "" }));
    dispatch(event("openOrders", { orders: [], dex: "" }));

    expect(set.openOrders.size).toBe(0);
  });
});

describe("notification routing", () => {
  it("stores a message the dispatcher previously discarded in silence", () => {
    // Before this, `notification` fell into the dispatcher's `default` branch —
    // a bare `return` that writes nothing, logs nothing and is not even counted
    // by `record()`, because that branch cannot throw.
    const set = stores();
    createDispatcher(set)(event("notification", { notification: "Liquidation warning" }));
    expect(set.notifications.read().map((n) => n.text)).toEqual(["Liquidation warning"]);
  });

  it("counts an unreadable frame rather than storing an empty message", () => {
    const set = stores();
    const dispatch = createDispatcher(set);
    for (const payload of [{}, { notification: 42 }, { notification: "" }, null]) {
      dispatch(event("notification", payload));
    }
    expect(set.notifications.read()).toEqual([]);
    expect(set.notifications.dropped).toBe(4);
  });

  it("does not let a notification reach any other store", () => {
    const set = stores();
    createDispatcher(set)(event("notification", { notification: "hello" }));
    expect(set.account.read()).toBeNull();
    expect(set.openOrders.read().rows).toEqual([]);
    expect(set.fills.read()).toEqual([]);
  });
});
