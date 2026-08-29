import {
  AccountSession,
  MAX_USERS_PER_CONNECTION,
  UNFILTERABLE_CHANNELS,
  accountTargetsFor,
  type AccountRegistry,
  type BoundStore,
} from "@/hyperliquid/state/accountSession";
import { createIdentity, identityKey } from "@/hyperliquid/core/identity";
import type { HlIdentity, SubscriptionTarget } from "@/hyperliquid/types/domain";

const A = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
const B = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});

function harness(distinctUsers = 0) {
  const order: string[] = [];
  const targets: SubscriptionTarget[][] = [];

  const registry: AccountRegistry = {
    removeForIdentity: async (identity: HlIdentity) => {
      order.push(`removeForIdentity:${identityKey(identity)}`);
    },
    reconcile: async (next) => {
      order.push("reconcile");
      targets.push([...next]);
    },
    invalidateInFlight: () => {
      order.push("invalidateInFlight");
    },
    reconcileWithin: async (_channels, next) => {
      order.push("reconcileWithin");
      targets.push([...next]);
    },
    onFailed: () => undefined,
    releaseAll: async () => {
      order.push("releaseAll");
    },
    closeAll: async () => {
      order.push("closeAll");
    },
    activeCount: 0,
    distinctUserCount: () => distinctUsers,
  };

  // Bound to real channels, so the test exercises the same lookup production
  // does. An earlier version handed every store the same target and passed
  // while the open-orders and spot stores dropped 100% of their events.
  const CHANNELS = ["clearinghouseState", "spotState", "openOrders", "userFills"] as const;
  const stores: BoundStore[] = CHANNELS.map((channel, i) => ({
    channel,
    store: {
      setTarget: (target) =>
        order.push(`setTarget${i}:${target === null ? "null" : target.channel}`),
      markStale: () => order.push(`markStale${i}`),
    },
  }));

  const budget = {
    forget: (identity: HlIdentity) => order.push(`forget:${identityKey(identity)}`),
  };
  const rebuildTransport = jest.fn(async () => {
    order.push("rebuildTransport");
  });

  return {
    order,
    targets,
    rebuildTransport,
    session: new AccountSession({ registry, stores, budget, rebuildTransport }),
  };
}

describe("accountTargetsFor", () => {
  it("covers every channel an account needs, all identity-scoped", () => {
    const targets = accountTargetsFor(A);
    expect(targets.map((t) => t.channel)).toEqual([
      "clearinghouseState",
      "spotState",
      "openOrders",
      "userFills",
      "userTwapSliceFills",
      "orderUpdates",
      "notification",
    ]);
    expect(targets.every((t) => t.identity === A && t.coin === null)).toBe(true);
  });

  it("can be narrowed, for a read-only view that wants no order stream", () => {
    const targets = accountTargetsFor(A, ["clearinghouseState", "spotState"]);
    expect(targets).toHaveLength(2);
  });
});

describe("AccountSession.switchTo", () => {
  it("stops writers, clears stores, forgets the budget, then resubscribes — in that order", async () => {
    const { session, order } = harness();
    await session.switchTo(A);
    order.length = 0;

    await session.switchTo(B);

    // Clearing before the new subscribe is what stops account A's balance
    // sitting under account B's header; the guard alone cannot do it.
    expect(order[0]).toBe(`removeForIdentity:${identityKey(A)}`);
    const clears = order.filter((step) => step.endsWith(":null"));
    expect(clears).toHaveLength(4);
    expect(order.indexOf(`forget:${identityKey(A)}`)).toBeGreaterThan(
      order.indexOf("setTarget0:null")
    );
    expect(order.indexOf("rebuildTransport")).toBeLessThan(order.indexOf("reconcileWithin"));
    expect(order[order.length - 1]).toBe("reconcileWithin");
  });

  it("rebuilds the transport, because orderUpdates carries no user field", async () => {
    // Verified catastrophic: two accounts on one transport, and each listener
    // received an identical 4,815-update orderUpdates stream. Nothing
    // downstream can filter frames that do not name a user.
    const { session, rebuildTransport } = harness();
    await session.switchTo(A);
    await session.switchTo(B);

    expect(rebuildTransport).toHaveBeenCalledTimes(2);
    expect(UNFILTERABLE_CHANNELS.has("orderUpdates")).toBe(true);
    expect(UNFILTERABLE_CHANNELS.has("userFills")).toBe(false);
  });

  it("does no work when the identity has not actually changed", async () => {
    const { session, order } = harness();
    await session.switchTo(A);
    order.length = 0;

    const targets = await session.switchTo(
      createIdentity({ env: "testnet", accountId: "acc", address: A.address })
    );

    expect(order).toEqual([]);
    expect(targets).toHaveLength(7);
  });

  it("invalidates in-flight subscribes BEFORE the transport is rebuilt", async () => {
    // The generation token exists so a subscribe issued against a dying socket
    // discards itself rather than registering a handle against the new one. It
    // was never armed here: `rebuildTransport` destroys the socket, and only
    // `closeAll()` bumped — which runs on logout, not on an account switch.
    // Order matters: a bump after the rebuild leaves the same window open.
    const { session, order } = harness();
    await session.switchTo(A);
    order.length = 0;

    await session.switchTo(B);

    const invalidate = order.indexOf("invalidateInFlight");
    const rebuild = order.indexOf("rebuildTransport");
    expect(invalidate).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBeGreaterThanOrEqual(0);
    expect(invalidate).toBeLessThan(rebuild);
  });

  it("closes everything when switching to no identity", async () => {
    const { session, order } = harness();
    await session.switchTo(A);
    order.length = 0;

    const targets = await session.switchTo(null);

    expect(targets).toEqual([]);
    expect(order).toContain("closeAll");
    expect(session.currentIdentity()).toBeNull();
  });

  it("subscribes the full channel set for the new identity", async () => {
    const { session, targets } = harness();
    await session.switchTo(B);

    expect(targets[0].map((t) => t.channel)).toContain("clearinghouseState");
    expect(targets[0].every((t) => identityKey(t.identity) === identityKey(B))).toBe(true);
  });
});

describe("a teardown racing an in-flight switch", () => {
  it("serialises them, so the sign-out is what survives", async () => {
    // The pair that actually happens: `HyperliquidSession.stop()` calls
    // `switchTo(null)` while a `start()` is already inside
    // `switchTo(identity)`. `switchTo` awaits five times and had no mutual
    // exclusion, so the two interleaved — and when the start's call resumed it
    // set store targets and reconciled the account channels back onto a
    // session that had already published `null`, leaving live subscriptions
    // for an account the user had signed out of.
    //
    // Asserted on ORDER rather than on a flag: the claim is that the second
    // call observes a settled world, which is exactly what interleaving broke.
    const { session, order, rebuildTransport } = harness();

    // Hold the first switch open inside one of its awaits.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rebuildTransport.mockImplementationOnce(async () => {
      order.push("rebuildTransport");
      await held;
    });

    const first = session.switchTo(A);
    // Queued behind it, not interleaved with it.
    const teardown = session.switchTo(null);

    // Nothing from the teardown may appear before the first switch finishes.
    expect(order).not.toContain("closeAll");

    release();
    await Promise.all([first, teardown]);

    // The teardown ran, and it ran LAST — so the end state is signed out.
    expect(order).toContain("closeAll");
    expect(order.indexOf("closeAll")).toBeGreaterThan(order.lastIndexOf("reconcileWithin"));
  });

  it("keeps serving switches after one of them fails", async () => {
    // The queue must not be wedged by a rejection, or a single transport
    // failure would leave the session unable to switch or sign out at all.
    const { session, rebuildTransport } = harness();
    rebuildTransport.mockRejectedValueOnce(new Error("transport gone"));

    await expect(session.switchTo(A)).rejects.toThrow("transport gone");
    await expect(session.switchTo(B)).resolves.toBeDefined();
  });
});

describe("AccountSession.resubscribe", () => {
  it("releases the old handles BEFORE rebuilding", async () => {
    // The resume-from-background path. The held handles refer to a socket that
    // is very likely gone, and they must be UNSUBSCRIBED rather than dropped:
    // the SDK keys its listener registrations by function identity, so a
    // dropped handle leaves its listener attached with nothing able to reach
    // it, and the re-add attaches a second beside it — once per resume,
    // unbounded for the session. Ordering still matters for the reason it
    // always did: a surviving active entry makes the re-add a no-op.
    const { session, order } = harness();
    await session.switchTo(A);
    order.length = 0;

    await session.resubscribe();

    const forget = order.indexOf("releaseAll");
    const rebuild = order.indexOf("reconcileWithin");
    expect(forget).toBeGreaterThanOrEqual(0);
    expect(rebuild).toBeGreaterThan(forget);
  });

  it("rebuilds the same channels for the same identity", async () => {
    const { session, targets } = harness();
    await session.switchTo(A);
    const first = targets[targets.length - 1].map((t) => t.channel);

    await session.resubscribe();
    expect(targets[targets.length - 1].map((t) => t.channel)).toEqual(first);
  });

  it("does nothing when no identity is current", async () => {
    const { session, order } = harness();
    await session.resubscribe();
    expect(order).toEqual([]);
  });
});

describe("AccountSession.markAllStale", () => {
  it("flags every store, so a resume greys out rather than blanking", async () => {
    const { session, order } = harness();
    await session.switchTo(A);
    order.length = 0;

    session.markAllStale();

    expect(order).toEqual(["markStale0", "markStale1", "markStale2", "markStale3"]);
  });
});

describe("the user cap is actually enforced now", () => {
  it("refuses a switch that would exceed it", async () => {
    // `assertCapacity` had zero production callers: the cap was documented,
    // measured at 15 against the published 10, given an error message — and
    // never consulted. The server answers a 16th user by closing the whole
    // connection, not by refusing one subscribe.
    const { session } = harness(MAX_USERS_PER_CONNECTION);
    await expect(session.switchTo(A)).rejects.toThrow(/can track 15 users/);
  });

  it("still allows an ordinary switch, which nets to zero new users", async () => {
    const { session } = harness(MAX_USERS_PER_CONNECTION - 1);
    await expect(session.switchTo(A)).resolves.toBeDefined();
  });

  it("never refuses a switch to no identity", async () => {
    const { session } = harness(MAX_USERS_PER_CONNECTION);
    await expect(session.switchTo(null)).resolves.toEqual([]);
  });
});

describe("AccountSession.assertCapacity", () => {
  it("permits an identity while under the server's cap", () => {
    expect(() => harness(MAX_USERS_PER_CONNECTION - 1).session.assertCapacity()).not.toThrow();
  });

  it("refuses to exceed the cap the server actually enforces", () => {
    // 15, not the 10 the published rate-limit page states.
    expect(() => harness(MAX_USERS_PER_CONNECTION).session.assertCapacity()).toThrow(/15 users/);
  });
});

describe("each store gets ITS OWN channel's target", () => {
  it("never hands a store a target naming a different channel", async () => {
    // The defect this replaced: every store received `targets[0]`, so a store
    // guarding on `subscriptionKey` (which includes the channel) rejected every
    // event. Positions rendered; open orders and spot balances silently did not.
    const { session, order } = harness();
    order.length = 0;

    await session.switchTo(A);

    const assigned = order.filter(
      (step) => step.startsWith("setTarget") && !step.endsWith(":null")
    );
    expect(assigned).toEqual([
      "setTarget0:clearinghouseState",
      "setTarget1:spotState",
      "setTarget2:openOrders",
      "setTarget3:userFills",
    ]);
  });

  it("refuses a store bound to a channel the session does not subscribe", async () => {
    // Better to fail loudly at wiring time than to leave a store permanently
    // targetless and silently empty.
    const session = new AccountSession({
      registry: {
        removeForIdentity: async () => undefined,
        reconcile: async () => undefined,
        closeAll: async () => undefined,
        invalidateInFlight: () => undefined,
        reconcileWithin: async () => undefined,
        onFailed: () => undefined,
        releaseAll: async () => undefined,
        activeCount: 0,
        distinctUserCount: () => 0,
      },
      stores: [
        { channel: "l2Book", store: { setTarget: () => undefined, markStale: () => undefined } },
      ],
    });

    await expect(session.switchTo(A)).rejects.toThrow(/No target for channel l2Book/);
  });
});
