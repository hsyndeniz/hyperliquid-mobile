import { createIdentity } from "@/hyperliquid/core/identity";
import {
  NOTIFICATION_LOG_CAP,
  NotificationStore,
  readNotification,
} from "@/hyperliquid/state/notifications";
import type { Scoped, SubscriptionChannel, SubscriptionTarget } from "@/hyperliquid/types/domain";

const NOW = 1_700_000_000_000;

function targetFor(
  address = "0x1111111111111111111111111111111111111111",
  channel: SubscriptionChannel = "notification"
): SubscriptionTarget {
  return {
    identity: createIdentity({ env: "mainnet", accountId: address, address }),
    channel,
    coin: null,
    aggregation: null,
    interval: null,
  };
}

function event(
  value: unknown,
  target: SubscriptionTarget = targetFor(),
  receivedAt = NOW
): Scoped<unknown> {
  return { target, value, serverTime: null, receivedAt, isSnapshot: false };
}

function seeded(): NotificationStore {
  const store = new NotificationStore();
  store.setTarget(targetFor());
  return store;
}

describe("appending messages", () => {
  it("keeps two identical strings from the same millisecond as two entries", () => {
    // The wire supplies no id, and the text and the timestamp both collide in
    // practice — so a repeated liquidation warning must not collapse into one
    // row. `seq` is minted locally for exactly this.
    const store = seeded();
    store.apply(event({ notification: "Margin call" }, targetFor(), NOW));
    store.apply(event({ notification: "Margin call" }, targetFor(), NOW));

    expect(store.read()).toHaveLength(2);
    expect(store.read().map((n) => n.seq)).toEqual([1, 2]);
  });

  it("stamps receivedAt from the envelope, since the channel carries no server time", () => {
    const store = seeded();
    store.apply(event({ notification: "hi" }, targetFor(), NOW + 500));
    expect(store.read()[0].receivedAt).toBe(NOW + 500);
  });

  it("evicts the oldest past the cap, keeping the newest", () => {
    const store = seeded();
    for (let i = 1; i <= NOTIFICATION_LOG_CAP + 1; i += 1) {
      store.apply(event({ notification: `m${i}` }));
    }
    const kept = store.read();
    expect(kept).toHaveLength(NOTIFICATION_LOG_CAP);
    expect(kept[0].text).toBe("m2");
    expect(kept[kept.length - 1].text).toBe(`m${NOTIFICATION_LOG_CAP + 1}`);
  });

  it("returns a referentially stable snapshot between mutations", () => {
    // `read()` is the getSnapshot for useSyncExternalStore — a fresh array each
    // call re-renders forever.
    const store = seeded();
    store.apply(event({ notification: "one" }));
    const first = store.read();
    expect(store.read()).toBe(first);
    store.apply(event({ notification: "two" }));
    expect(store.read()).not.toBe(first);
  });
});

describe("rejecting what it cannot read", () => {
  it("counts a malformed frame and stores nothing", () => {
    // An `undefined` stored here renders as an empty toast, which is worse than
    // no toast at all.
    const store = seeded();
    for (const payload of [{}, { notification: 42 }, { notification: "" }, null, 7, []]) {
      expect(store.apply(event(payload))).toBe(false);
    }
    expect(store.read()).toEqual([]);
    expect(store.dropped).toBe(6);
  });

  it("drops an event whose target names a different channel", () => {
    // A store paired with the wrong channel silently drops every event —
    // `accountSession.ts` documents this trap for `BoundStore`. The guard is
    // what makes it a counted drop rather than a wrong write.
    const store = seeded();
    const wrongChannel = targetFor("0x1111111111111111111111111111111111111111", "userFills");
    expect(store.apply(event({ notification: "hi" }, wrongChannel))).toBe(false);
    expect(store.dropped).toBe(1);
  });

  it("drops an event for a different identity", () => {
    const store = seeded();
    const other = targetFor("0x2222222222222222222222222222222222222222");
    expect(store.apply(event({ notification: "not yours" }, other))).toBe(false);
    expect(store.read()).toEqual([]);
  });

  it("reads a bare string too, since the live shape has never been observed", () => {
    expect(readNotification("plain")).toBe("plain");
    expect(readNotification({ notification: "wrapped" })).toBe("wrapped");
    expect(readNotification("")).toBeNull();
  });
});

describe("identity switching", () => {
  it("drops every message when the target changes", () => {
    // The leak this prevents: one account's liquidation warning rendered under
    // another account's header.
    const store = seeded();
    store.apply(event({ notification: "A's warning" }));
    expect(store.read()).toHaveLength(1);

    store.setTarget(targetFor("0x2222222222222222222222222222222222222222"));
    expect(store.read()).toEqual([]);
    expect(store.unacknowledged()).toEqual([]);
  });

  it("restarts the sequence and the acknowledgement watermark", () => {
    // Carrying `acknowledgedThrough` across a switch would mark the new
    // account's first messages as already seen.
    const store = seeded();
    store.apply(event({ notification: "A" }));
    store.acknowledge(1);

    const next = targetFor("0x2222222222222222222222222222222222222222");
    store.setTarget(next);
    store.apply(event({ notification: "B" }, next));

    // The whole log, not `read()[0]` — reading the first entry passes against a
    // missing clear, because A is still sitting in front of B.
    expect(store.read().map((n) => [n.seq, n.text])).toEqual([[1, "B"]]);
    expect(store.unacknowledged().map((n) => n.text)).toEqual(["B"]);
  });

  it("does not clear when the same target is set again", () => {
    const store = seeded();
    store.apply(event({ notification: "keep me" }));
    store.setTarget(targetFor());
    expect(store.read()).toHaveLength(1);
  });
});

describe("acknowledgement", () => {
  it("marks only up to the given seq, so a message arriving mid-toast survives", () => {
    // "Acknowledge all" would swallow anything that landed while the toast was
    // on screen — the user never sees it and nothing records that.
    const store = seeded();
    store.apply(event({ notification: "first" }));
    store.apply(event({ notification: "second" }));

    const shown = store.unacknowledged();
    expect(shown.map((n) => n.text)).toEqual(["first", "second"]);

    // A third arrives while the caller is rendering the first two.
    store.apply(event({ notification: "third" }));
    store.acknowledge(shown[shown.length - 1].seq);

    expect(store.unacknowledged().map((n) => n.text)).toEqual(["third"]);
  });

  it("never moves the watermark backwards", () => {
    const store = seeded();
    store.apply(event({ notification: "a" }));
    store.apply(event({ notification: "b" }));
    store.acknowledge(2);
    store.acknowledge(1);
    expect(store.unacknowledged()).toEqual([]);
  });
});

describe("staleness", () => {
  it("is NOT stale before anything has arrived", () => {
    // A quiet notification channel is normal — most accounts get none for days.
    // Reporting stale here would warn on every healthy new session.
    const store = seeded();
    expect(store.isStale(NOW + 86_400_000, 60_000)).toBe(false);
  });

  it("goes stale once a message has arrived and then aged out", () => {
    const store = seeded();
    store.apply(event({ notification: "hi" }, targetFor(), NOW));
    expect(store.isStale(NOW + 30_000, 60_000)).toBe(false);
    expect(store.isStale(NOW + 61_000, 60_000)).toBe(true);
  });

  it("honours an explicit markStale", () => {
    const store = seeded();
    store.markStale();
    expect(store.isStale(NOW, 60_000)).toBe(true);
  });
});

describe("clear", () => {
  it("empties the log without disturbing the target or the counters", () => {
    const store = seeded();
    store.apply(event({ notification: "hi" }));
    store.apply(event(null));
    expect(store.dropped).toBe(1);

    store.clear();
    expect(store.read()).toEqual([]);
    expect(store.currentTarget()).not.toBeNull();
    expect(store.dropped).toBe(1);
  });
});

describe("listeners", () => {
  it("notifies on append, acknowledge and clear", () => {
    const store = seeded();
    let calls = 0;
    const unsubscribe = store.subscribe(() => (calls += 1));

    store.apply(event({ notification: "a" }));
    store.acknowledge(1);
    store.clear();
    expect(calls).toBe(3);

    unsubscribe();
    store.apply(event({ notification: "b" }));
    expect(calls).toBe(3);
  });

  it("survives a listener that throws", () => {
    const store = seeded();
    store.subscribe(() => {
      throw new Error("render failed");
    });
    let second = 0;
    store.subscribe(() => (second += 1));
    expect(() => store.apply(event({ notification: "a" }))).not.toThrow();
    expect(second).toBe(1);
  });
});

describe("unacknowledged() is referentially stable", () => {
  // It is read through `useStoreValue`, whose selector runs every render and
  // is compared with `Object.is`. A fresh array per call would re-render
  // forever; a cache that never invalidates would freeze the banner. Both
  // failures are invisible to a test that only checks the contents.
  it("returns the same array while nothing has changed", () => {
    const store = seeded();
    expect(store.unacknowledged()).toBe(store.unacknowledged());
  });

  it("returns a NEW array once a message arrives", () => {
    const store = seeded();
    const before = store.unacknowledged();
    store.apply(event({ notification: "Margin call" }));
    expect(store.unacknowledged()).not.toBe(before);
    expect(store.unacknowledged().length).toBeGreaterThan(before.length);
  });

  it("returns a NEW array once a message is acknowledged", () => {
    const store = seeded();
    store.apply(event({ notification: "Margin call" }));
    const pending = store.unacknowledged();
    expect(pending.length).toBeGreaterThan(0);
    store.acknowledge(pending[pending.length - 1]!.seq);
    expect(store.unacknowledged()).not.toBe(pending);
    expect(store.unacknowledged()).toHaveLength(0);
  });
});
