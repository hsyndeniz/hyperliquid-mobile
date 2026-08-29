import { OpenOrdersStore, UNCONFIRMED_TTL_MS } from "@/hyperliquid/state/openOrders";
import { parseOpenOrders } from "@/hyperliquid/state/accountWire";
import { createIdentity } from "@/hyperliquid/core/identity";
import type { Cloid } from "@/hyperliquid/orders/cloid";
import type { OpenOrderRow, Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

import triggerOrders from "@/hyperliquid/state/__fixtures__/foo-iso-testnet.json";

const NOW = 1_800_000_000_000;
const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});
const dexIdentity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
  dex: "xyz",
});

function targetFor(id = identity): SubscriptionTarget {
  return { identity: id, channel: "openOrders", coin: null, aggregation: null, interval: null };
}
const target = targetFor();

const RECORDED = parseOpenOrders(triggerOrders);

const CLOID_A = `0x${"a1".repeat(16)}` as Cloid;
const CLOID_B = `0x${"b2".repeat(16)}` as Cloid;

function row(oid: number, overrides: Partial<OpenOrderRow> = {}): OpenOrderRow {
  return { ...RECORDED[0], oid, cloid: null, ...overrides };
}

function event(
  value: readonly OpenOrderRow[],
  receivedAt = NOW,
  on = target
): Scoped<readonly OpenOrderRow[]> {
  return { target: on, value, serverTime: null, receivedAt, isSnapshot: true };
}

describe("OpenOrdersStore", () => {
  let store: OpenOrdersStore;
  beforeEach(() => {
    store = new OpenOrdersStore();
    store.setTarget(target);
  });

  it("holds the recorded trigger orders", () => {
    store.apply(event(RECORDED));
    expect(store.size).toBe(RECORDED.length);
    expect(store.read().rows.filter((r) => r.isTrigger)).toHaveLength(4);
  });

  it("replaces wholesale, so a cancelled order disappears", () => {
    // The event carries the full array with no delta marker; a merging store
    // keeps cancelled orders on screen forever.
    store.apply(event([row(1), row(2)], 1_000));
    store.apply(event([row(1)], 2_000));

    expect(store.size).toBe(1);
    expect(store.byOid(2)).toBeNull();
  });

  it("keys on oid, not on cloid", () => {
    // A real trader reused one cloid across two oids a second apart; a
    // cloid-keyed map loses one of the orders.
    store.apply(
      event([row(57378687005, { cloid: CLOID_A }), row(57378791975, { cloid: CLOID_A })])
    );

    expect(store.size).toBe(2);
  });

  it("does not notify on an identical repeat snapshot", () => {
    store.apply(event([row(1)], 1_000));
    const listener = jest.fn();
    store.subscribe(listener);

    const changed = store.apply(event([row(1)], 6_000));

    expect(changed).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("refuses a snapshot answered for a different dex", () => {
    // A real-but-wrong dex answers 200 with an empty list, which renders as
    // "no open orders" to someone holding live resting risk.
    store.setTarget(targetFor(dexIdentity));
    const accepted = store.apply(event([], NOW, targetFor(dexIdentity)), "");

    expect(accepted).toBe(false);
    expect(store.rejected).toBe(1);
  });

  it("accepts a snapshot whose echoed dex matches", () => {
    store.setTarget(targetFor(dexIdentity));
    expect(store.apply(event([row(1)], NOW, targetFor(dexIdentity)), "xyz")).toBe(true);
  });

  describe("the unconfirmed overlay", () => {
    const submitted = {
      cloid: CLOID_A,
      oid: null,
      label: null,
      submittedAt: 1_000,
      expiresAt: 2_000,
    };

    it("never enters the authoritative map", () => {
      // Reconciler verdicts can carry a null oid and, called without an
      // identity, can even belong to another account — an oid-keyed store fed
      // them gets a phantom the user cannot cancel.
      store.addUnconfirmed(submitted);

      expect(store.size).toBe(0);
      expect(store.read().rows).toEqual([]);
      expect(store.read().unconfirmed).toHaveLength(1);
    });

    it("is evicted once the real row appears", () => {
      store.addUnconfirmed(submitted);
      store.apply(event([row(1, { cloid: CLOID_A })], 1_500));

      expect(store.read().unconfirmed).toEqual([]);
      expect(store.byOid(1)).not.toBeNull();
    });

    it("survives a snapshot taken before we submitted", () => {
      store.addUnconfirmed(submitted);
      // Taken at 500, before submittedAt 1000 — its silence proves nothing.
      store.apply(event([], 500));

      expect(store.read().unconfirmed).toHaveLength(1);
    });

    it("survives a later snapshot while reconciliation is still pending", () => {
      store.addUnconfirmed(submitted);
      store.apply(event([], 1_500)); // after submit, before expiry

      expect(store.read().unconfirmed).toHaveLength(1);
    });

    it("is evicted by a later snapshot once reconciliation has given up", () => {
      store.addUnconfirmed(submitted);
      store.apply(event([], 2_500));

      expect(store.read().unconfirmed).toEqual([]);
    });

    it("is evicted by the hard TTL even if nothing else fires", () => {
      store.addUnconfirmed({ ...submitted, submittedAt: 10_000, expiresAt: 11_000 });
      // A snapshot older than submittedAt cannot evict via rule 2, so only the
      // backstop can — without it a broken feed leaves a ghost row forever.
      store.apply(event([], 11_000 + UNCONFIRMED_TTL_MS + 1));

      expect(store.read().unconfirmed).toEqual([]);
    });

    it("can be evicted explicitly by a terminal order update", () => {
      store.addUnconfirmed(submitted);
      expect(store.removeUnconfirmed(CLOID_A)).toBe(true);
      expect(store.removeUnconfirmed(CLOID_B)).toBe(false);
      expect(store.read().unconfirmed).toEqual([]);
    });

    it("clears on an identity switch", () => {
      store.addUnconfirmed(submitted);
      store.setTarget(targetFor(dexIdentity));
      expect(store.read().unconfirmed).toEqual([]);
    });
  });

  it("records truncation from the dual-endpoint seed", () => {
    // Observed on testnet: frontendOpenOrders returned 100 rows for a
    // 3,196-order account, and the 100 were not the newest.
    store.setCoverage({ truncated: true, totalKnown: 3_196 });

    expect(store.read().truncated).toBe(true);
    expect(store.read().totalKnown).toBe(3_196);
  });

  it("drops a snapshot for another identity", () => {
    store.apply(event([row(1)], NOW, targetFor(dexIdentity)));
    expect(store.size).toBe(0);
    expect(store.dropped).toBe(1);
  });

  it("survives a throwing subscriber", () => {
    store.subscribe(() => {
      throw new Error("render failed");
    });
    const healthy = jest.fn();
    store.subscribe(healthy);

    expect(() => store.apply(event([row(1)]))).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });
});

describe("read() is a usable getSnapshot", () => {
  // Same rule as CandleStore: React compares getSnapshot's result with
  // Object.is on every render, so a fresh object each call loops forever.
  it("returns the identical object across repeated reads", () => {
    const store = new OpenOrdersStore();
    store.setTarget(target);
    expect(store.read()).toBe(store.read());

    store.apply(event([row(1)]));
    expect(store.read()).toBe(store.read());
  });

  it("returns a new object once anything mutates", () => {
    const store = new OpenOrdersStore();
    store.setTarget(target);
    store.apply(event([row(1)], 1_000));

    const beforeRows = store.read();
    store.apply(event([row(1), row(2)], 2_000));
    expect(store.read()).not.toBe(beforeRows);

    const beforeOverlay = store.read();
    store.addUnconfirmed({
      cloid: CLOID_B,
      oid: null,
      label: null,
      submittedAt: 1,
      expiresAt: 2,
    });
    expect(store.read()).not.toBe(beforeOverlay);

    const beforeCoverage = store.read();
    store.setCoverage({ truncated: true, totalKnown: 99 });
    expect(store.read()).not.toBe(beforeCoverage);
  });

  it("returns a new object when only the overlay changed", () => {
    // The authoritative rows can be byte-identical while an overlay entry is
    // evicted; the early return on an unchanged signature must still invalidate.
    const store = new OpenOrdersStore();
    store.setTarget(target);
    store.addUnconfirmed({
      cloid: CLOID_A,
      oid: null,
      label: null,
      submittedAt: 1_000,
      expiresAt: 2_000,
    });
    store.apply(event([row(1)], 1_100));

    const before = store.read();
    expect(before.unconfirmed).toHaveLength(1);

    store.apply(event([row(1)], 3_000)); // identical rows, evicts the overlay

    expect(store.read()).not.toBe(before);
    expect(store.read().unconfirmed).toEqual([]);
  });
});

describe("overlay eviction reaches subscribers", () => {
  it("notifies when an identical snapshot evicts an overlay entry", () => {
    // The case that matters, and the one that is silent: an order that never
    // rested produces a byte-identical snapshot, so the eviction that removes it
    // always lands on the unchanged-signature path. Dropping the memoised view
    // is not enough — `useSyncExternalStore` only re-reads on a commit, so with
    // no emit a subscriber renders the evicted pending row indefinitely.
    const store = new OpenOrdersStore();
    store.setTarget(target);
    store.apply(event([row(1)], 1_000));

    store.addUnconfirmed({
      cloid: CLOID_B,
      oid: null,
      label: null,
      submittedAt: 1_000,
      expiresAt: 1_500,
    });

    const listener = jest.fn();
    store.subscribe(listener);

    // Identical rows, later timestamp: eviction rule 2 fires.
    const changed = store.apply(event([row(1)], 3_000));

    expect(changed).toBe(false);
    expect(store.read().unconfirmed).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still does not notify when an identical snapshot evicts nothing", () => {
    // The suppression that makes a 5s heartbeat affordable must survive.
    const store = new OpenOrdersStore();
    store.setTarget(target);
    store.apply(event([row(1)], 1_000));

    const listener = jest.fn();
    store.subscribe(listener);
    store.apply(event([row(1)], 6_000));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the overlay never duplicates a confirmed row", () => {
  it("ignores an unconfirmed entry whose cloid is already a real row", () => {
    // `read()` spreads rows and overlay with no de-duplication, so adding a
    // cloid that is already confirmed renders the same order twice. Routine
    // rather than exotic: startup reconciliation probes over HTTP while the ~5s
    // snapshot has usually already delivered the row.
    const store = new OpenOrdersStore();
    store.setTarget(target);
    store.apply(event([row(1, { cloid: CLOID_A })], 1_000));

    const added = store.addUnconfirmed({
      cloid: CLOID_A,
      oid: 1,
      label: null,
      submittedAt: 2_000,
      expiresAt: 3_000,
    });

    expect(added).toBe(false);
    expect(store.read().unconfirmed).toEqual([]);
    expect(store.read().rows).toHaveLength(1);
  });

  it("still accepts one the authoritative rows do not carry", () => {
    const store = new OpenOrdersStore();
    store.setTarget(target);
    store.apply(event([row(1, { cloid: CLOID_A })], 1_000));

    expect(
      store.addUnconfirmed({
        cloid: CLOID_B,
        oid: null,
        label: null,
        submittedAt: 2_000,
        expiresAt: 3_000,
      })
    ).toBe(true);
    expect(store.read().unconfirmed).toHaveLength(1);
  });
});
