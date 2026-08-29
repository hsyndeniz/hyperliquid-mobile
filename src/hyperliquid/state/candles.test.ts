import { createIdentity } from "@/hyperliquid/core/identity";
import { observeServerTime, resetClock } from "@/hyperliquid/core/clock";
import {
  CandleStore,
  bucketStart,
  intervalMs,
  intervalSeconds,
  isClosed,
} from "@/hyperliquid/state/candles";
import type { Candle, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});

const target: SubscriptionTarget = {
  identity,
  channel: "candle",
  coin: "BTC",
  aggregation: null,
  interval: "1m",
};

const otherInterval: SubscriptionTarget = { ...target, interval: "1h" };

const MINUTE = 60_000;

function candle(openTime: number, overrides: Partial<Candle> = {}): Candle {
  return {
    openTime,
    closeTime: openTime + MINUTE - 1,
    interval: "1m",
    coin: "BTC",
    open: "100",
    high: "110",
    low: "90",
    close: "105",
    volume: "1",
    trades: 10,
    ...overrides,
  };
}

function scoped(value: Candle, receivedAt: number, on = target): Scoped<Candle> {
  return { target: on, value, serverTime: null, receivedAt, isSnapshot: false };
}

describe("bucket maths", () => {
  it("maps every interval to its documented width", () => {
    expect(intervalMs("1m")).toBe(60_000);
    expect(intervalMs("1h")).toBe(3_600_000);
    expect(intervalMs("1d")).toBe(86_400_000);
    // Fixed 30 days, not a calendar month.
    expect(intervalMs("1M")).toBe(30 * 86_400_000);
    expect(intervalSeconds("5m")).toBe(300);
  });

  it("floors to the epoch bucket, not to local midnight", () => {
    // 2024-01-01T00:00:30Z falls in the bucket that opened at :00:00.
    const at = Date.UTC(2024, 0, 1, 0, 0, 30);
    expect(bucketStart(at, "1m")).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
    expect(bucketStart(at, "1h")).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
    expect(bucketStart(at, "1d")).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
  });

  it("treats a bucket as closed only once its close time has passed", () => {
    const bar = candle(0);
    expect(isClosed(bar, MINUTE - 1)).toBe(false);
    expect(isClosed(bar, MINUTE)).toBe(true);
  });
});

describe("CandleStore", () => {
  let store: CandleStore;
  beforeEach(() => {
    store = new CandleStore();
    store.setTarget(target);
  });

  it("upserts by open time rather than appending", () => {
    // The feed re-sends the same bucket on every trade. Appending would produce
    // thousands of duplicate bars a minute.
    store.apply(scoped(candle(0, { close: "101" }), 1_000), 1_000);
    store.apply(scoped(candle(0, { close: "102" }), 2_000), 2_000);
    store.apply(scoped(candle(0, { close: "103" }), 3_000), 3_000);

    expect(store.size).toBe(1);
    expect(store.read().forming?.close).toBe("103");
  });

  it("keeps the forming bar out of the committed array", () => {
    store.apply(scoped(candle(0), 10), MINUTE + 10); // closed
    store.apply(scoped(candle(MINUTE), MINUTE + 10), MINUTE + 10); // forming

    const { committed, forming } = store.read();
    expect(committed.map((c) => c.openTime)).toEqual([0]);
    expect(forming?.openTime).toBe(MINUTE);
    // A bar in both is drawn twice by every chart library that takes them apart.
    expect(committed.some((c) => c.openTime === forming?.openTime)).toBe(false);
  });

  describe("the committed array's IDENTITY, which the chart keys on", () => {
    // `CandleChartCard`'s effect states the contract it depends on: "the store's
    // committed array reference only changes when its content did". The store
    // broke it — `apply` nulled both memos on every accepted frame, so a
    // revision of the forming bar rebuilt a fresh 300-element array and the
    // chart re-uploaded 300 unchanged bars across the JS->UI bridge, at the
    // 1-4 Hz a liquid perp trades at, for an hour at a time on a 1h chart.
    it("holds the SAME array across a forming-bar revision", () => {
      store.apply(scoped(candle(0), 10), MINUTE + 10); // closed -> committed
      store.apply(scoped(candle(MINUTE), MINUTE + 10), MINUTE + 10); // forming
      const first = store.read().committed;

      // Three more revisions of the forming bucket — the common case by far.
      store.apply(scoped(candle(MINUTE, { close: "111" }), MINUTE + 20), MINUTE + 20);
      store.apply(scoped(candle(MINUTE, { close: "112" }), MINUTE + 30), MINUTE + 30);
      store.apply(scoped(candle(MINUTE, { close: "113" }), MINUTE + 40), MINUTE + 40);

      const after = store.read();
      expect(after.committed).toBe(first); // identity, not equality
      expect(after.forming?.close).toBe("113"); // and the forming bar DID update
    });

    it("mints a new array when a late frame revises an already-closed bucket", () => {
      // The hole the optimisation left. `settle()` runs on a timer armed at the
      // bucket's close, so by the time the exchange's FINAL frame for that
      // bucket arrives — milliseconds later, routinely — the forming pointer is
      // already null. The old condition asked "is this a new bucket, or did the
      // forming pointer move?" and got no to both, so it kept the memo while
      // `buckets` took the settled values. The chart then showed a last closed
      // bar the store itself disagreed with, for good.
      store.apply(scoped(candle(0), 10), MINUTE + 10);
      store.settle(2 * MINUTE);
      const before = store.read().committed;
      expect(before[0]?.close).toBe("105");

      store.apply(scoped(candle(0, { close: "999", volume: "42" }), 2 * MINUTE), 2 * MINUTE);

      const after = store.read().committed;
      expect(after).not.toBe(before);
      expect(after[0]?.close).toBe("999");
      expect(store.latestClose()).toBe("999");
    });

    it("mints a new array when a bucket graduates", () => {
      store.apply(scoped(candle(0), 10), MINUTE + 10);
      store.apply(scoped(candle(MINUTE), MINUTE + 10), MINUTE + 10);
      const first = store.read().committed;

      // A new bucket opens: the old forming bar joins the committed set.
      store.apply(scoped(candle(2 * MINUTE), 2 * MINUTE + 10), 2 * MINUTE + 10);
      const after = store.read().committed;
      expect(after).not.toBe(first);
      expect(after.map((c) => c.openTime)).toEqual([0, MINUTE]);
    });

    it("mints a new array when the target changes", () => {
      store.apply(scoped(candle(0), 10), MINUTE + 10);
      const first = store.read().committed;
      store.setTarget({ ...target, coin: "ETH" });
      expect(store.read().committed).not.toBe(first);
    });
  });

  it("returns candles in ascending order regardless of arrival order", () => {
    // Renderers binary-search without validating; order has to be guaranteed here.
    store.apply(scoped(candle(2 * MINUTE), 10), 10 * MINUTE);
    store.apply(scoped(candle(0), 20), 10 * MINUTE);
    store.apply(scoped(candle(MINUTE), 30), 10 * MINUTE);

    expect(store.read().committed.map((c) => c.openTime)).toEqual([0, MINUTE, 2 * MINUTE]);
  });

  describe("settle", () => {
    it("closes a bucket whose time has passed with no further event", () => {
      // The feed emits only on trades. Measured on testnet, BTC 1m produced two
      // events in eighty seconds and none at all for a bucket with no trades —
      // so a store that rolls over only on `t` changing shows a dead bucket as
      // live indefinitely.
      store.apply(scoped(candle(0), 10), 10);
      expect(store.read().forming?.openTime).toBe(0);

      expect(store.settle(MINUTE + 1)).toBe(true);

      const { committed, forming } = store.read();
      expect(forming).toBeNull();
      expect(committed.map((c) => c.openTime)).toEqual([0]);
    });

    it("leaves a bucket that is genuinely still open alone", () => {
      store.apply(scoped(candle(0), 10), 10);
      expect(store.settle(MINUTE - 1)).toBe(false);
      expect(store.read().forming?.openTime).toBe(0);
    });

    it("is a no-op when nothing is forming", () => {
      expect(store.settle(Date.now())).toBe(false);
    });

    it("notifies subscribers, so a live readout stops showing the dead close", () => {
      store.apply(scoped(candle(0), 10), 10);
      const listener = jest.fn();
      store.subscribe(listener);
      store.settle(MINUTE + 1);
      expect(listener).toHaveBeenCalled();
    });
  });

  it("drops a late event for a bucket older than the one forming", () => {
    store.apply(scoped(candle(MINUTE, { close: "200" }), 100), 100);
    // A straggler for the previous bucket carries a partial view of a bar that
    // has already finished; applying it would rewrite settled history.
    store.apply(scoped(candle(0, { close: "1" }), 110), 110);

    expect(store.dropped).toBe(1);
    expect(store.size).toBe(1);
  });

  it("drops events for another interval on the same coin", () => {
    // BTC/1m and BTC/1h are different series; without `interval` in the key they
    // collide and each overwrites the other.
    store.apply(scoped(candle(0), 10, otherInterval), 10);
    expect(store.size).toBe(0);
    expect(store.dropped).toBe(1);
  });

  it("clears when pointed at a different interval", () => {
    store.apply(scoped(candle(0), 10), 10);
    store.setTarget(otherInterval);
    expect(store.size).toBe(0);
  });

  describe("seed", () => {
    it("routes the snapshot's unfinished last row to forming", () => {
      const history = [candle(0), candle(MINUTE), candle(2 * MINUTE)];
      const now = 2 * MINUTE + 30_000; // inside the third bucket

      store.seed(target, history, now);

      const { committed, forming } = store.read();
      expect(committed.map((c) => c.openTime)).toEqual([0, MINUTE]);
      expect(forming?.openTime).toBe(2 * MINUTE);
    });

    it("commits every row when the snapshot ends on a closed bucket", () => {
      store.seed(target, [candle(0), candle(MINUTE)], 5 * MINUTE);
      expect(store.read().committed).toHaveLength(2);
      expect(store.read().forming).toBeNull();
    });

    it("ignores a snapshot for a different series", () => {
      store.seed(otherInterval, [candle(0)], MINUTE);
      expect(store.size).toBe(0);
      expect(store.dropped).toBe(1);
    });

    it("lets a live event revise a bar the snapshot already provided", () => {
      // Snapshot ranges are inclusive at both ends and the last row is usually
      // the forming bar, so overlap between REST and websocket is normal.
      store.seed(target, [candle(0, { close: "100" })], 30_000);
      store.apply(scoped(candle(0, { close: "150" }), 40_000), 40_000);

      expect(store.size).toBe(1);
      expect(store.read().forming?.close).toBe("150");
    });
  });

  it("reports the forming close as the latest price, then the last committed one", () => {
    store.apply(scoped(candle(0, { close: "111" }), 10), 10);
    expect(store.latestClose()).toBe("111");

    store.settle(MINUTE + 1);
    expect(store.latestClose()).toBe("111");

    store.clear();
    expect(store.latestClose()).toBeNull();
  });

  it("measures staleness on the feed, never on the candles", () => {
    // Committed bars are historical facts — an 11-second silence must not
    // discard 5,000 of them the way a value-level TTL would.
    store.apply(scoped(candle(0), 1_000), 1_000);
    expect(store.isStale(2_000, 10_000)).toBe(false);
    expect(store.isStale(60_000, 10_000)).toBe(true);
    expect(store.read().committed.length + (store.read().forming ? 1 : 0)).toBe(1);
  });

  it("survives a throwing subscriber", () => {
    store.subscribe(() => {
      throw new Error("render failed");
    });
    const healthy = jest.fn();
    store.subscribe(healthy);

    expect(() => store.apply(scoped(candle(0), 10), 10)).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = jest.fn();
    store.subscribe(listener)();
    store.apply(scoped(candle(0), 10), 10);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("read() is a usable getSnapshot", () => {
  // `useSyncExternalStore` calls getSnapshot on EVERY render and compares with
  // Object.is. A fresh object each call is an infinite render loop, not a slow
  // one — so referential stability here is a correctness property, not a
  // micro-optimisation.
  function seeded(): CandleStore {
    const store = new CandleStore();
    store.setTarget(target);
    store.seed(target, [candle(0)], 30_000); // still forming
    return store;
  }

  it("returns the identical object across repeated reads", () => {
    const store = seeded();
    expect(store.read()).toBe(store.read());
  });

  it("returns a new object once anything mutates", () => {
    for (const mutate of [
      (s: CandleStore) => s.settle(MINUTE + 1),
      (s: CandleStore) => s.apply(scoped(candle(MINUTE), MINUTE + 10), MINUTE + 10),
      (s: CandleStore) => s.clear(),
      (s: CandleStore) => s.seed(target, [candle(MINUTE)], MINUTE + 10),
    ]) {
      const store = seeded();
      const before = store.read();
      mutate(store);
      expect(store.read()).not.toBe(before);
      // ...and is stable again afterwards.
      expect(store.read()).toBe(store.read());
    }
  });

  it("is stable on an empty store, which is the first render", () => {
    const store = new CandleStore();
    store.setTarget(target);
    expect(store.read()).toBe(store.read());
  });
});

describe("isClosed across a skewed device clock", () => {
  const REAL = 1_800_000_000_000;

  afterEach(resetClock);

  function candleClosingAt(closeTime: number): Candle {
    return {
      openTime: closeTime - 60_000,
      closeTime,
      open: "1",
      high: "1",
      low: "1",
      close: "1",
      volume: "1",
      trades: 1,
      interval: "1m",
      coin: "BTC",
    };
  }

  it("does not close a bucket early when the device clock runs fast", () => {
    // A bucket boundary is an instant the EXCHANGE decides has passed. On a
    // phone 30s fast the forming bar was killed 30s before it actually closed,
    // and the out-of-order guard that keys on the forming pointer went with it.
    for (let i = 0; i < 5; i += 1) observeServerTime(REAL - 30_000 + i, REAL + i);
    // The bucket closes 10s from true now; the fast phone reads 20s past it.
    expect(isClosed(candleClosingAt(REAL - 30_000 + 10_000), REAL)).toBe(false);
  });

  it("still closes a bucket whose boundary has genuinely passed", () => {
    for (let i = 0; i < 5; i += 1) observeServerTime(REAL - 30_000 + i, REAL + i);
    expect(isClosed(candleClosingAt(REAL - 30_000 - 1_000), REAL)).toBe(true);
  });
});
