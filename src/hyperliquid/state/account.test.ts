import { observeServerTime, resetClock } from "@/hyperliquid/core/clock";
import { ACCOUNT_STALE_AFTER_MS, AccountStore } from "@/hyperliquid/state/account";
import { parseClearinghouseState } from "@/hyperliquid/state/accountWire";
import { createIdentity } from "@/hyperliquid/core/identity";
import type { AccountSnapshot, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

import chsMixed from "@/hyperliquid/state/__fixtures__/chs-mixed-testnet.json";
import chsEmpty from "@/hyperliquid/state/__fixtures__/chs-empty-testnet.json";

const NOW = 1_800_000_000_000;
const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";

const identity = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });
const otherIdentity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0x1111111111111111111111111111111111111111",
});

function targetFor(id = identity): SubscriptionTarget {
  return {
    identity: id,
    channel: "clearinghouseState",
    coin: null,
    aggregation: null,
    interval: null,
  };
}

const target = targetFor();

function snapshot(overrides: Partial<AccountSnapshot["summary"]> = {}): AccountSnapshot {
  const parsed = parseClearinghouseState(chsMixed);
  return { ...parsed, summary: { ...parsed.summary, ...overrides } };
}

function event(
  value: AccountSnapshot,
  receivedAt = NOW,
  on: SubscriptionTarget = target
): Scoped<AccountSnapshot> {
  return {
    target: on,
    value,
    serverTime: value.summary.serverTime,
    receivedAt,
    isSnapshot: true,
  };
}

const ECHO = { dex: "", user: ADDRESS };

describe("AccountStore", () => {
  let store: AccountStore;
  beforeEach(() => {
    store = new AccountStore();
    store.setTarget(target);
  });

  it("holds a parsed snapshot and indexes positions by coin", () => {
    const value = snapshot();
    store.apply(event(value), ECHO);

    expect(store.read()?.positions).toHaveLength(value.positions.length);
    const first = value.positions[0];
    expect(store.positionByCoin(first.coin)?.coin).toBe(first.coin);
    expect(store.positionByCoin("NOTACOIN")).toBeNull();
  });

  it("drops an event for a different identity", () => {
    store.apply(event(snapshot(), NOW, targetFor(otherIdentity)), ECHO);
    expect(store.read()).toBeNull();
    expect(store.dropped).toBe(1);
  });

  it("clears held state when pointed at a different account", () => {
    store.apply(event(snapshot()), ECHO);
    expect(store.read()).not.toBeNull();

    store.setTarget(targetFor(otherIdentity));

    // The guard drops future writes; only this clears what is already shown.
    expect(store.read()).toBeNull();
    expect(store.dropped).toBe(0);
  });

  it("treats setTarget with the same key as a no-op", () => {
    store.apply(event(snapshot()), ECHO);
    store.setTarget(targetFor());
    expect(store.read()).not.toBeNull();
  });

  describe("echo verification", () => {
    it("refuses a snapshot answered for a different dex", () => {
      // A real-but-wrong dex returns HTTP 200 with a well-formed EMPTY account,
      // so the dangerous case is precisely the one that looks valid.
      const accepted = store.apply(event(snapshot()), { dex: "test", user: ADDRESS });

      expect(accepted).toBe(false);
      expect(store.read()).toBeNull();
      expect(store.rejected).toBe(1);
    });

    it("refuses a snapshot answered for a different address", () => {
      // A never-used address also returns zeros with no error frame, which
      // masks an address-derivation bug as an empty portfolio.
      store.apply(event(snapshot()), {
        dex: "",
        user: "0x9999999999999999999999999999999999999999",
      });
      expect(store.read()).toBeNull();
      expect(store.rejected).toBe(1);
    });

    it("compares addresses case-insensitively", () => {
      expect(store.apply(event(snapshot()), { dex: "", user: ADDRESS.toUpperCase() })).toBe(true);
    });

    it("accepts an event carrying no echo, for the REST seed path", () => {
      expect(store.apply(event(snapshot()))).toBe(true);
    });
  });

  describe("monotonicity", () => {
    it("drops a push older than what is held", () => {
      // The websocket lags an HTTP fetch by 2.8-4.4s, so the first push after a
      // REST seed is routinely older and would walk the balance backwards.
      store.apply(event(snapshot({ serverTime: 1_000, withdrawable: "500.0" })), ECHO);
      store.apply(event(snapshot({ serverTime: 900, withdrawable: "1.0" })), ECHO);

      expect(store.read()?.summary.withdrawable).toBe("500.0");
      expect(store.dropped).toBe(1);
    });

    it("accepts a push at the same server time with new content", () => {
      store.apply(event(snapshot({ serverTime: 1_000, withdrawable: "500.0" })), ECHO);
      store.apply(event(snapshot({ serverTime: 1_000, withdrawable: "600.0" })), ECHO);
      expect(store.read()?.summary.withdrawable).toBe("600.0");
    });
  });

  describe("content diffing", () => {
    it("does not notify on a byte-identical repeat push", () => {
      // Measured: 21 byte-identical snapshots in 95s. Emitting on each would
      // give the whole portfolio tree a new object identity every 5s forever.
      store.apply(event(snapshot({ serverTime: 1_000 })), ECHO);
      const listener = jest.fn();
      store.subscribe(listener);

      const accepted = store.apply(event(snapshot({ serverTime: 2_000 })), ECHO);

      expect(accepted).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it("still advances freshness on an identical push", () => {
      store.apply(event(snapshot({ serverTime: 1_000 }), 1_000), ECHO);
      expect(store.isStale(1_000 + ACCOUNT_STALE_AFTER_MS + 1)).toBe(true);

      store.apply(event(snapshot({ serverTime: 20_000 }), 20_000), ECHO);

      // Nothing changed, but the feed is demonstrably alive.
      expect(store.isStale(20_100)).toBe(false);
    });

    it("notifies when any field actually changes", () => {
      store.apply(event(snapshot({ serverTime: 1_000, withdrawable: "1.0" })), ECHO);
      const listener = jest.fn();
      store.subscribe(listener);

      store.apply(event(snapshot({ serverTime: 2_000, withdrawable: "2.0" })), ECHO);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  it("removes a closed position rather than keeping it at zero", () => {
    // A flat position vanishes from the array; the wire never reports szi "0.0".
    const full = snapshot({ serverTime: 1_000 });
    const closedCoin = full.positions[0].coin;
    const fewer: AccountSnapshot = {
      summary: { ...full.summary, serverTime: 2_000 },
      positions: full.positions.slice(1),
    };

    store.apply(event(full), ECHO);
    expect(store.positionByCoin(closedCoin)).not.toBeNull();

    store.apply(event(fewer), ECHO);

    expect(store.positionByCoin(closedCoin)).toBeNull();
    expect(store.read()?.positions).toHaveLength(full.positions.length - 1);
  });

  describe("staleness", () => {
    it("keeps showing the last value past the freshness window", () => {
      // An empty book renders as loading; an empty account renders as
      // "your money is gone". There is deliberately no value-level TTL.
      store.apply(event(snapshot({ serverTime: NOW }), NOW), ECHO);

      const muchLater = NOW + 10 * ACCOUNT_STALE_AFTER_MS;
      expect(store.isStale(muchLater)).toBe(true);
      expect(store.read()).not.toBeNull();
      expect(store.read()?.positions.length).toBeGreaterThan(0);
    });

    it("reports stale before anything has arrived", () => {
      expect(store.isStale(NOW)).toBe(true);
    });

    it("markStale flags without discarding", () => {
      store.apply(event(snapshot({ serverTime: NOW }), NOW), ECHO);
      store.markStale();

      expect(store.isStale(NOW)).toBe(true);
      expect(store.read()).not.toBeNull();
    });

    it("clears the stale flag on the next accepted push", () => {
      store.apply(event(snapshot({ serverTime: 1_000, withdrawable: "1.0" }), 1_000), ECHO);
      store.markStale();
      store.apply(event(snapshot({ serverTime: 2_000, withdrawable: "2.0" }), 2_000), ECHO);

      expect(store.isStale(2_100)).toBe(false);
    });
  });

  it("holds an account with no positions without treating it as absent", () => {
    const empty = parseClearinghouseState(chsEmpty);
    store.apply(event(empty), ECHO);

    expect(store.read()).not.toBeNull();
    expect(store.read()?.positions).toEqual([]);
    expect(store.read()?.summary.total.accountValue).toBe("11.0");
  });

  it("survives a throwing subscriber", () => {
    store.subscribe(() => {
      throw new Error("render failed");
    });
    const healthy = jest.fn();
    store.subscribe(healthy);

    expect(() => store.apply(event(snapshot()), ECHO)).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = jest.fn();
    store.subscribe(listener)();
    store.apply(event(snapshot()), ECHO);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("read() is a stable getSnapshot", () => {
  // `useStoreValue` calls `select(store)` on EVERY render and compares with
  // Object.is. A store that hands back a new object for unchanged content
  // re-renders the whole portfolio tree on every 5s heartbeat — which is the
  // exact cost the content check was added to avoid.
  let store: AccountStore;
  beforeEach(() => {
    store = new AccountStore();
    store.setTarget(target);
  });

  it("returns the identical snapshot across repeated reads", () => {
    store.apply(event(snapshot()), ECHO);
    expect(store.read()).toBe(store.read());
  });

  it("keeps the snapshot identical across an identical push", () => {
    store.apply(event(snapshot({ serverTime: 1_000 }), 1_000), ECHO);
    const before = store.read();

    store.apply(event(snapshot({ serverTime: 2_000 }), 2_000), ECHO);

    expect(store.read()).toBe(before);
    expect(store.read()?.positions).toBe(before?.positions);
  });

  it("still advances freshness while holding the value identity", () => {
    store.apply(event(snapshot({ serverTime: 1_000 }), 1_000), ECHO);
    store.apply(event(snapshot({ serverTime: 20_000 }), 20_000), ECHO);
    expect(store.isStale(20_100)).toBe(false);
  });

  it("returns a new snapshot once anything actually changes", () => {
    store.apply(event(snapshot({ serverTime: 1_000, withdrawable: "1.0" }), 1_000), ECHO);
    const before = store.read();

    store.apply(event(snapshot({ serverTime: 2_000, withdrawable: "2.0" }), 2_000), ECHO);

    expect(store.read()).not.toBe(before);
  });

  it("preserves per-coin identity for positions that did not move", () => {
    // What makes `usePosition` cheap: every row wakes on every push, but React
    // bails out unless THAT coin's object changed.
    const first = snapshot({ serverTime: 1_000 });
    store.apply(event(first), ECHO);
    const unchangedCoin = first.positions[1].coin;
    const heldBefore = store.positionByCoin(unchangedCoin);

    const second = snapshot({ serverTime: 2_000 });
    const positions = [...second.positions];
    positions[0] = { ...positions[0], unrealizedPnl: "999.0" };
    store.apply(event({ ...second, positions }), ECHO);

    expect(store.positionByCoin(unchangedCoin)).toBe(heldBefore);
    expect(store.positionByCoin(positions[0].coin)).not.toBe(first.positions[0]);
  });
});

describe("AccountStore staleness across a skewed device clock", () => {
  const REAL = 1_800_000_000_000;
  const SKEW_MS = 30_000;

  afterEach(resetClock);

  /** Teach the clock that this device runs `SKEW_MS` behind the exchange. */
  function learnSkew(): void {
    for (let i = 0; i < 5; i += 1) observeServerTime(REAL + SKEW_MS + i, REAL + i);
  }

  it("does not report a dead feed as live when the device clock is slow", () => {
    // The failure: `isStale` used to subtract the raw exchange stamp from a
    // device `now`. On a phone 30s slow that makes a frame look 30s NEWER than
    // it is, so a feed that died 40s ago passes a 15s staleness gate and the
    // portfolio keeps rendering equity, withdrawable and positions as live.
    learnSkew();
    const store = new AccountStore();
    store.setTarget(target);
    // Proves the frame was actually taken — without a target `apply` is a no-op
    // and `isStale` returns true for the wrong reason.
    expect(store.apply(event(snapshot({ serverTime: REAL + SKEW_MS }), REAL), ECHO)).toBe(true);

    expect(store.isStale(REAL + 40_000, 15_000)).toBe(true);
  });

  it("does not report a live feed as stale when the device clock is fast", () => {
    // The mirror failure: every surface papered with "stale" on a healthy feed.
    for (let i = 0; i < 5; i += 1) observeServerTime(REAL - SKEW_MS + i, REAL + i);
    const store = new AccountStore();
    store.setTarget(target);
    expect(store.apply(event(snapshot({ serverTime: REAL - SKEW_MS }), REAL), ECHO)).toBe(true);

    expect(store.isStale(REAL + 1_000, 15_000)).toBe(false);
  });
});
