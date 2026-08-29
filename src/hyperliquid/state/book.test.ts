import { scope } from "@/hyperliquid/core/freshness";
import { createIdentity } from "@/hyperliquid/core/identity";
import {
  BOOK_MAX_AGE_MS,
  BookStore,
  asksOf,
  bestAsk,
  bestBid,
  bidsOf,
  type BookSnapshot,
} from "@/hyperliquid/state/book";
import type { SubscriptionTarget } from "@/hyperliquid/types/domain";

const NOW = 1_800_000_000_000;
const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});

function target(coin: string): SubscriptionTarget {
  return { identity, channel: "l2Book", coin, aggregation: null, interval: null };
}

/** Matches the real wire shape: `levels` is a [bids, asks] tuple. */
function book(px: string, time = NOW): BookSnapshot {
  return { coin: "BTC", time, levels: [[{ px, sz: "1" }], [{ px, sz: "1" }]] };
}

function event(coin: string, px: string, at = NOW) {
  return scope(target(coin), book(px), { now: () => at });
}

describe("BookStore", () => {
  it("holds a book for the current target", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));
    expect(bidsOf(store.read(NOW)!)[0].px).toBe("97000");
  });

  it("reads null before anything arrives", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    expect(store.read(NOW)).toBeNull();
  });

  it("DROPS an event for another market rather than storing it", () => {
    // In-flight ETH events keep arriving after a switch to BTC. Storing one is
    // how the wrong book ends up under the right name.
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));
    store.apply(event("ETH", "3400"));

    expect(bidsOf(store.read(NOW)!)[0].px).toBe("97000");
    expect(store.dropped).toBe(1);
  });

  it("clears immediately on a target switch", () => {
    // An empty book renders as loading; a stale one renders as wrong.
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));
    store.setTarget(target("ETH"));
    expect(store.read(NOW)).toBeNull();
  });

  it("does not clear when the target is set to the same market again", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));
    store.setTarget(target("BTC"));
    expect(store.read(NOW)).not.toBeNull();
  });

  it("refuses to serve a book past its age limit", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000", NOW));

    expect(store.read(NOW + BOOK_MAX_AGE_MS)).not.toBeNull();
    expect(store.read(NOW + BOOK_MAX_AGE_MS + 1)).toBeNull();
  });

  it("distinguishes 'nothing yet' from 'held but stale'", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    expect(store.isStale(NOW)).toBe(false);

    store.apply(event("BTC", "97000", NOW));
    expect(store.isStale(NOW + BOOK_MAX_AGE_MS + 1)).toBe(true);
    // The envelope survives so a surface can show last-known values greyed out.
    expect(store.readScoped()).not.toBeNull();
  });

  it("markStale keeps the values but stops calling them fresh", () => {
    // Resume-from-background: better to grey out last-known numbers than flash
    // an empty book, but they must never read as live.
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));

    store.markStale();

    expect(store.read(NOW)).toBeNull();
    expect(bidsOf(store.readScoped()!.value)[0].px).toBe("97000");
  });

  it("accepts fresh data again after being marked stale", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));
    store.markStale();
    store.apply(event("BTC", "97100", NOW));
    expect(bidsOf(store.read(NOW)!)[0].px).toBe("97100");
  });

  it("exposes named accessors so no call site indexes the tuple by hand", () => {
    const snapshot = book("97000");
    expect(bidsOf(snapshot)[0].px).toBe("97000");
    expect(asksOf(snapshot)[0].px).toBe("97000");
    expect(bestBid(snapshot)?.px).toBe("97000");
    expect(bestAsk(snapshot)?.px).toBe("97000");
  });

  it("tolerates a book with an empty side", () => {
    const empty: BookSnapshot = { coin: "BTC", time: NOW, levels: [[], []] };
    expect(bestBid(empty)).toBeNull();
    expect(bidsOf(empty)).toEqual([]);
  });

  it("reads null with no target at all", () => {
    const store = new BookStore();
    store.apply(event("BTC", "97000"));
    expect(store.read(NOW)).toBeNull();
  });

  describe("subscription", () => {
    it("notifies on apply, switch and clear", () => {
      const store = new BookStore();
      let count = 0;
      store.subscribe(() => {
        count += 1;
      });

      store.setTarget(target("BTC"));
      store.apply(event("BTC", "97000"));
      store.clear();
      expect(count).toBe(3);
    });

    it("does not notify for a dropped event", () => {
      const store = new BookStore();
      store.setTarget(target("BTC"));
      let count = 0;
      store.subscribe(() => {
        count += 1;
      });
      store.apply(event("ETH", "3400"));
      expect(count).toBe(0);
    });

    it("removes a listener on unsubscribe", () => {
      const store = new BookStore();
      let count = 0;
      const off = store.subscribe(() => {
        count += 1;
      });
      off();
      store.setTarget(target("BTC"));
      expect(count).toBe(0);
    });

    it("keeps feeding the others when one listener throws", () => {
      const store = new BookStore();
      let reached = false;
      store.subscribe(() => {
        throw new Error("bad consumer");
      });
      store.subscribe(() => {
        reached = true;
      });
      store.setTarget(target("BTC"));
      expect(reached).toBe(true);
    });
  });
});

describe("fast/deep stream separation", () => {
  // Measured on the testnet wire: with a `fast: true` and a `fast: false`
  // subscription for one coin open on the SAME socket, the server fans BOTH
  // streams to BOTH listeners — every frame of a 15 s window reached each one.
  // The request starts a stream; it does not filter one. The payload's `fast`
  // marker is the only discriminator, and it was exact: marked ⇒ 5 levels,
  // unmarked ⇒ 20, with no exceptions.
  function aggregated(coin: string, fast: boolean): SubscriptionTarget {
    return {
      identity,
      channel: "l2Book",
      coin,
      aggregation: { nSigFigs: null, mantissa: null, fast },
      interval: null,
    };
  }

  /**
   * A frame as the app really receives it: scoped to the SUBSCRIBED target
   * (each SDK callback stamps its own), carrying whichever stream's marker the
   * server actually sent. Scoping it to the other target instead would be
   * caught by the existing target guard and prove nothing — the whole point is
   * that these frames arrive correctly scoped.
   */
  function frame(subscribed: SubscriptionTarget, px: string, markerFast: boolean, at = NOW) {
    const snapshot: BookSnapshot = {
      coin: subscribed.coin!,
      time: at,
      levels: [[{ px, sz: "1" }], [{ px, sz: "1" }]],
      ...(markerFast ? { fast: true as const } : {}),
    };
    return scope(subscribed, snapshot, { now: () => at });
  }

  it("a GROUPED store drops an ungrouped frame, and vice versa", () => {
    // The same fan-out trap one axis over. The SDK dispatches on the channel
    // name and filters on coin alone, so after a grouping switch the previous
    // stream keeps arriving — correctly scoped — until the unsubscribe lands,
    // and repopulates the ladder with the old price grid.
    //
    // `spread` is the payload's own discriminator: the SDK documents it as
    // "only present when nSigFigs is non-null".
    const grouped: SubscriptionTarget = {
      identity,
      channel: "l2Book",
      coin: "BTC",
      aggregation: { nSigFigs: 2, mantissa: null, fast: false },
      interval: null,
    };
    const ungrouped = aggregated("BTC", false);

    const groupedStore = new BookStore();
    groupedStore.setTarget(grouped);
    // An UNGROUPED frame carries no spread — not this store's.
    groupedStore.apply(frame(grouped, "100", false));
    expect(groupedStore.read(NOW)).toBeNull();
    // Its own frame does carry one.
    const withSpread = frame(grouped, "101", false);
    groupedStore.apply({ ...withSpread, value: { ...withSpread.value, spread: "0.5" } });
    expect(groupedStore.read(NOW)?.levels[0][0]?.px).toBe("101");

    const ungroupedStore = new BookStore();
    ungroupedStore.setTarget(ungrouped);
    const stray = frame(ungrouped, "999", false);
    ungroupedStore.apply({ ...stray, value: { ...stray.value, spread: "0.5" } });
    expect(ungroupedStore.read(NOW)).toBeNull();
  });

  it("a deep store DROPS a fast-marked frame delivered on its own subscription", () => {
    // Without this the 0.5 s fast stream overwrites the 5 s deep one ~10x a
    // second and the deep store holds 5 levels forever — a merged ladder that
    // silently never deepens.
    const deep = aggregated("BTC", false);
    const store = new BookStore();
    store.setTarget(deep);
    store.apply(frame(deep, "97000", false));
    store.apply(frame(deep, "96000", true, NOW + 100));

    expect(bidsOf(store.read(NOW + 100)!)[0].px).toBe("97000");
    expect(store.dropped).toBe(1);
  });

  it("a fast store DROPS an unmarked frame delivered on its own subscription", () => {
    const fast = aggregated("BTC", true);
    const store = new BookStore();
    store.setTarget(fast);
    store.apply(frame(fast, "97000", true));
    store.apply(frame(fast, "96000", false, NOW + 100));

    expect(bidsOf(store.read(NOW + 100)!)[0].px).toBe("97000");
    expect(store.dropped).toBe(1);
  });

  it("each store accepts its own stream", () => {
    const fast = aggregated("BTC", true);
    const fastStore = new BookStore();
    fastStore.setTarget(fast);
    fastStore.apply(frame(fast, "97000", true));
    expect(bidsOf(fastStore.read(NOW)!)[0].px).toBe("97000");
    expect(fastStore.dropped).toBe(0);

    const deep = aggregated("BTC", false);
    const deepStore = new BookStore();
    deepStore.setTarget(deep);
    deepStore.apply(frame(deep, "96000", false));
    expect(bidsOf(deepStore.read(NOW)!)[0].px).toBe("96000");
    expect(deepStore.dropped).toBe(0);
  });

  it("treats an absent aggregation as the deep stream — an unmarked frame is its own", () => {
    // `marketTarget` defaults aggregation to null, which sends no `fast` field
    // and so receives the 20-level stream.
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));
    expect(bidsOf(store.read(NOW)!)[0].px).toBe("97000");
    expect(store.dropped).toBe(0);
  });
});

describe("readHeld", () => {
  it("serves the held snapshot past the age limit, by the same reference read() gave", () => {
    // The stale-book UX greys out last-known values; read() stays the freshness
    // authority and readHeld is the display path once it returns null. Same
    // reference as the fresh read, so identity-keyed consumers don't re-render
    // when the book merely crosses the age limit.
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000", NOW));
    const fresh = store.read(NOW);

    expect(store.read(NOW + BOOK_MAX_AGE_MS + 1)).toBeNull();
    expect(store.readHeld()).toBe(fresh);
  });

  it("returns null after a target switch — old is tolerable, another market's is not", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", "97000"));
    store.setTarget(target("ETH"));
    expect(store.readHeld()).toBeNull();
  });

  it("returns null before anything arrives", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    expect(store.readHeld()).toBeNull();
  });
});

describe("out-of-order and stale handling", () => {
  it("DROPS a late older snapshot instead of moving the book backwards", () => {
    // Websocket frames are not guaranteed in order; without this the price
    // visibly ticks the wrong way with no error anywhere.
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(scope(target("BTC"), book("97000", NOW), { now: () => NOW }));
    store.apply(scope(target("BTC"), book("96000", NOW - 500), { now: () => NOW - 500 }));

    expect(bidsOf(store.read(NOW)!)[0].px).toBe("97000");
  });

  it("accepts a newer snapshot", () => {
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(scope(target("BTC"), book("97000", NOW), { now: () => NOW }));
    store.apply(scope(target("BTC"), book("97100", NOW + 500), { now: () => NOW + 500 }));
    expect(bidsOf(store.read(NOW + 500)!)[0].px).toBe("97100");
  });

  it("markStale preserves the timestamps a greyed-out render needs", () => {
    // Zeroing them destroys exactly the "as of 14:32" the stale UI wants.
    const store = new BookStore();
    store.setTarget(target("BTC"));
    store.apply(scope(target("BTC"), book("97000", NOW), { now: () => NOW }));

    store.markStale();

    expect(store.read(NOW)).toBeNull();
    expect(store.readScoped()?.receivedAt).toBe(NOW);
    expect(store.readScoped()?.value.time).toBe(NOW);
  });
});
