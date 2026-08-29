import { FillsStore, MAX_FILLS } from "@/hyperliquid/state/fills";
import { parseFills } from "@/hyperliquid/state/accountWire";
import { createIdentity } from "@/hyperliquid/core/identity";
import type { Fill, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

import fillsFixture from "@/hyperliquid/state/__fixtures__/fills-testnet.json";

const NOW = 1_800_000_000_000;
const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});
const other = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0x1111111111111111111111111111111111111111",
});

function targetFor(id = identity): SubscriptionTarget {
  return { identity: id, channel: "userFills", coin: null, aggregation: null, interval: null };
}
const target = targetFor();

const RECORDED = parseFills(fillsFixture);

function event(
  value: readonly Fill[],
  options: { isSnapshot?: boolean; receivedAt?: number; on?: SubscriptionTarget } = {}
): Scoped<readonly Fill[]> {
  return {
    target: options.on ?? target,
    value,
    serverTime: null,
    receivedAt: options.receivedAt ?? NOW,
    isSnapshot: options.isSnapshot ?? false,
  };
}

function syntheticFill(oid: number, tid: number, overrides: Partial<Fill> = {}): Fill {
  return { ...RECORDED[0], key: `${oid}:${tid}`, oid, tid, ...overrides };
}

describe("FillsStore", () => {
  let store: FillsStore;
  let onNew: jest.Mock;

  beforeEach(() => {
    onNew = jest.fn();
    store = new FillsStore(onNew);
    store.setTarget(target);
  });

  it("stores every recorded fill under a distinct key", () => {
    store.apply(event(RECORDED));
    expect(store.size).toBe(RECORDED.length);
  });

  describe("the reconnect replay", () => {
    it("does not grow when the same snapshot arrives twice", () => {
      // The SDK resubscribes on every socket open and replays the newest ~30
      // fills into the same listener — measured at 28-30 duplicates per
      // reconnect. An appending store shows each trade repeatedly.
      store.apply(event(RECORDED, { isSnapshot: true }));
      const afterFirst = store.size;

      store.apply(event(RECORDED, { isSnapshot: true }));

      expect(store.size).toBe(afterFirst);
    });

    it("fires no side effect for a replayed snapshot", () => {
      // Otherwise the phone buzzes thirty times for trades from an hour ago.
      store.apply(event(RECORDED, { isSnapshot: true }));
      expect(onNew).not.toHaveBeenCalled();
    });

    it("fires the side effect for a live delta", () => {
      const fresh = syntheticFill(999_001, 999_001);
      store.apply(event([fresh]));

      expect(onNew).toHaveBeenCalledTimes(1);
      expect(onNew.mock.calls[0][0]).toEqual([fresh]);
    });

    it("treats an ABSENT snapshot flag as a delta", () => {
      // `isSnapshot` is absent on deltas rather than false, so any `!isSnapshot`
      // test classifies every live fill as a replay and silences all toasts.
      const scoped = {
        target,
        value: [syntheticFill(999_002, 999_002)],
        serverTime: null,
        receivedAt: NOW,
      } as unknown as Scoped<readonly Fill[]>;

      store.apply(scoped);

      expect(onNew).toHaveBeenCalledTimes(1);
    });

    it("reports only genuinely new fills, not the whole batch", () => {
      const a = syntheticFill(1, 1);
      const b = syntheticFill(2, 2);
      store.apply(event([a]));
      onNew.mockClear();

      const fresh = store.apply(event([a, b]));

      expect(fresh).toEqual([b]);
      expect(onNew).toHaveBeenCalledWith([b]);
    });

    it("merges a snapshot into deeper history rather than replacing it", () => {
      // The websocket snapshot is only the newest ~30 rows; the REST seed goes
      // much deeper. Replacing would discard what the user already had.
      store.seed(target, RECORDED, NOW);
      const deep = store.size;

      store.apply(event(RECORDED.slice(0, 5), { isSnapshot: true }));

      expect(store.size).toBe(deep);
    });
  });

  describe("the dedup key", () => {
    it("keeps two dust conversions that share tid 0", () => {
      // Every Spot Dust Conversion carries `tid: 0`. Keying on tid alone
      // collapses all of them into one row.
      const dustA = syntheticFill(500, 0, { dir: "Spot Dust Conversion" });
      const dustB = syntheticFill(501, 0, { dir: "Spot Dust Conversion" });

      store.apply(event([dustA, dustB]));

      expect(store.size).toBe(2);
      expect(new Set([dustA, dustB].map((f) => f.tid)).size).toBe(1);
    });

    it("keeps every partial fill of one order", () => {
      // A partially-filled order produces many fills under one oid — keying on
      // oid drops 26.4% of rows.
      store.apply(event([syntheticFill(700, 1), syntheticFill(700, 2), syntheticFill(700, 3)]));
      expect(store.size).toBe(3);
    });

    it("keeps fills that share the all-zero hash", () => {
      // 5.6% of mainnet fills carry it; keying on hash drops 31.2% of rows.
      const zero = `0x${"0".repeat(64)}` as Fill["hash"];
      store.apply(
        event([syntheticFill(800, 1, { hash: zero }), syntheticFill(801, 2, { hash: zero })])
      );
      expect(store.size).toBe(2);
    });

    it("revises a row that arrives again under the same key", () => {
      store.apply(event([syntheticFill(900, 1, { closedPnl: "1.0" })]));
      store.apply(event([syntheticFill(900, 1, { closedPnl: "2.0" })]));

      expect(store.size).toBe(1);
      expect(store.byKey("900:1")?.closedPnl).toBe("2.0");
    });
  });

  it("returns fills newest first", () => {
    const older = syntheticFill(1, 1, { time: 1_000 });
    const newer = syntheticFill(2, 2, { time: 2_000 });
    store.apply(event([older, newer]));

    expect(store.read().map((f) => f.key)).toEqual([newer.key, older.key]);
  });

  it("breaks a timestamp tie on arrival order, newest arrival first", () => {
    // Several fills routinely share a millisecond, and the server clock can lead
    // the device clock, so `time` alone is not a total order.
    const first = syntheticFill(1, 1, { time: 5_000 });
    const second = syntheticFill(2, 2, { time: 5_000 });
    store.apply(event([first]));
    store.apply(event([second]));

    expect(store.read().map((f) => f.key)).toEqual([second.key, first.key]);
  });

  it("drops fills for another identity", () => {
    store.apply(event([syntheticFill(1, 1)], { on: targetFor(other) }));
    expect(store.size).toBe(0);
    expect(store.dropped).toBe(1);
  });

  it("clears on an identity switch", () => {
    store.apply(event(RECORDED));
    store.setTarget(targetFor(other));
    expect(store.size).toBe(0);
    expect(store.read()).toEqual([]);
  });

  it("bounds retention, dropping the oldest trades", () => {
    const many = Array.from({ length: MAX_FILLS + 25 }, (_, i) =>
      syntheticFill(i, i, { time: 1_000 + i })
    );
    store.apply(event(many));

    expect(store.size).toBe(MAX_FILLS);
    expect(store.byKey("0:0")).toBeNull();
    expect(store.byKey(`${many.length - 1}:${many.length - 1}`)).not.toBeNull();
  });

  it("survives a throwing subscriber", () => {
    store.subscribe(() => {
      throw new Error("render failed");
    });
    const healthy = jest.fn();
    store.subscribe(healthy);

    expect(() => store.apply(event([syntheticFill(1, 1)]))).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });
});
