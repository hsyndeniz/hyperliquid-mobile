import { SpotBalanceStore } from "@/hyperliquid/state/spot";
import { parseSpotState } from "@/hyperliquid/state/accountWire";
import { createIdentity } from "@/hyperliquid/core/identity";
import type { Scoped, SpotState, SubscriptionTarget } from "@/hyperliquid/types/domain";

import spotMixed from "@/hyperliquid/state/__fixtures__/spot-mixed-testnet.json";
import spotEmpty from "@/hyperliquid/state/__fixtures__/spot-empty-testnet.json";

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
  return { identity: id, channel: "spotState", coin: null, aggregation: null, interval: null };
}
const target = targetFor();

function event(value: SpotState, receivedAt = NOW, on = target): Scoped<SpotState> {
  return { target: on, value, serverTime: null, receivedAt, isSnapshot: true };
}

describe("SpotBalanceStore", () => {
  let store: SpotBalanceStore;
  beforeEach(() => {
    store = new SpotBalanceStore();
    store.setTarget(target);
  });

  it("holds a parsed spot state", () => {
    const state = parseSpotState(spotMixed);
    store.apply(event(state));

    expect(store.read()?.balances).toHaveLength(state.balances.length);
  });

  it("finds a balance by coin, not by token", () => {
    // 142 of 196 rows on this account carry no `token` at all, so a token-keyed
    // index collides all of them under one undefined key.
    store.apply(event(parseSpotState(spotMixed)));
    const outcome = store.read()!.balances.find((b) => b.kind === "outcome")!;

    expect(store.balanceOf(outcome.coin)?.coin).toBe(outcome.coin);
    expect(store.balanceOf("NOTACOIN")).toBeNull();
  });

  it("keeps the balance list past its freshness window", () => {
    // A blank balance list reads as "your funds are gone" — and deposited USDC
    // lands in spot, so this is often the whole account.
    store.apply(event(parseSpotState(spotEmpty), NOW));

    expect(store.isStale(NOW + 60_000, 15_000)).toBe(true);
    expect(store.read()?.balances).toHaveLength(1);
  });

  it("does not notify on an identical repeat push", () => {
    store.apply(event(parseSpotState(spotEmpty), 1_000));
    const listener = jest.fn();
    store.subscribe(listener);

    expect(store.apply(event(parseSpotState(spotEmpty), 6_000))).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies when a balance changes", () => {
    store.apply(event(parseSpotState(spotEmpty), 1_000));
    const listener = jest.fn();
    store.subscribe(listener);

    store.apply(event(parseSpotState(spotMixed), 6_000));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops a push for another identity", () => {
    store.apply(event(parseSpotState(spotEmpty), NOW, targetFor(other)));
    expect(store.read()).toBeNull();
    expect(store.dropped).toBe(1);
  });

  it("clears on an identity switch", () => {
    store.apply(event(parseSpotState(spotMixed)));
    store.setTarget(targetFor(other));
    expect(store.read()).toBeNull();
  });

  it("markStale flags without discarding", () => {
    store.apply(event(parseSpotState(spotMixed), NOW));
    store.markStale();

    expect(store.isStale(NOW, 15_000)).toBe(true);
    expect(store.read()).not.toBeNull();
  });

  it("survives a throwing subscriber", () => {
    store.subscribe(() => {
      throw new Error("render failed");
    });
    const healthy = jest.fn();
    store.subscribe(healthy);

    expect(() => store.apply(event(parseSpotState(spotEmpty)))).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });
});

describe("read() is a stable getSnapshot", () => {
  it("keeps the spot state identical across an identical push", () => {
    // Same rule as AccountStore: a fresh object for unchanged content
    // re-renders every balance row on each 5s heartbeat.
    const store = new SpotBalanceStore();
    store.setTarget(target);
    store.apply(event(parseSpotState(spotMixed), 1_000));
    const before = store.read();

    store.apply(event(parseSpotState(spotMixed), 6_000));

    expect(store.read()).toBe(before);
  });

  it("returns a new state once balances change", () => {
    const store = new SpotBalanceStore();
    store.setTarget(target);
    store.apply(event(parseSpotState(spotEmpty), 1_000));
    const before = store.read();

    store.apply(event(parseSpotState(spotMixed), 6_000));

    expect(store.read()).not.toBe(before);
  });
});
