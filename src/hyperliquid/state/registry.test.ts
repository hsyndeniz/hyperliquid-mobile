import { createIdentity } from "@/hyperliquid/core/identity";
import { SubscriptionRegistry, type SubscriptionHandle } from "@/hyperliquid/state/registry";
import type { SubscriptionTarget } from "@/hyperliquid/types/domain";

const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});
const other = createIdentity({
  env: "testnet",
  accountId: "acc-2",
  address: "0x2222222222222222222222222222222222222222",
});

function target(coin: string, overrides: Partial<SubscriptionTarget> = {}): SubscriptionTarget {
  return { identity, channel: "l2Book", coin, aggregation: null, interval: null, ...overrides };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Records handles, and can hold a subscribe open to force a race. */
function tracker() {
  const opened: string[] = [];
  const unsubscribed: string[] = [];
  let held: Promise<void> | null = null;
  let release: (() => void) | null = null;

  const subscribe = async (t: SubscriptionTarget): Promise<SubscriptionHandle> => {
    if (held) await held;
    opened.push(t.coin ?? "-");
    return {
      unsubscribe: async () => {
        unsubscribed.push(t.coin ?? "-");
      },
    };
  };

  return {
    subscribe,
    opened,
    unsubscribed,
    /** Make the next subscribe block until `release()`. */
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: async () => {
      const r = release;
      held = null;
      release = null;
      r?.();
      await tick();
    },
  };
}

describe("SubscriptionRegistry", () => {
  it("opens a subscription and reports it active", async () => {
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);
    await registry.add(target("BTC"));
    expect(registry.isActive(target("BTC"))).toBe(true);
    expect(t.opened).toEqual(["BTC"]);
  });

  it("is idempotent — adding twice opens once", async () => {
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);
    await registry.add(target("BTC"));
    await registry.add(target("BTC"));
    expect(t.opened).toEqual(["BTC"]);
    expect(registry.activeCount).toBe(1);
  });

  it("treats a different aggregation as a different subscription", async () => {
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);
    await registry.add(target("BTC"));
    await registry.add(
      target("BTC", { aggregation: { nSigFigs: 3, mantissa: null, fast: false } })
    );
    expect(registry.activeCount).toBe(2);
  });

  it("removes a subscription", async () => {
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);
    await registry.add(target("BTC"));
    await registry.remove(target("BTC"));
    expect(registry.isActive(target("BTC"))).toBe(false);
    expect(t.unsubscribed).toEqual(["BTC"]);
  });

  it("tolerates removing something never added", async () => {
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);
    await expect(registry.remove(target("BTC"))).resolves.toBeUndefined();
  });

  it("closes the stale-create race: a subscribe finishing after removal is torn down", async () => {
    // The core bug. BTC subscribe is in flight; the user switches away before it
    // completes. Without the desire re-check the handle would be registered and
    // the feed would keep writing into state for a coin nobody is viewing.
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);

    t.hold();
    const adding = registry.add(target("BTC"));
    await tick(); // let the subscribe start and block
    const removing = registry.remove(target("BTC"));
    await t.release();
    await Promise.allSettled([adding, removing]);

    expect(registry.isActive(target("BTC"))).toBe(false);
    expect(t.unsubscribed).toContain("BTC");
  });

  it("discards a subscribe that completes after the generation was bumped", async () => {
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);

    t.hold();
    const adding = registry.add(target("BTC"));
    await tick(); // let the subscribe start and block
    void registry.releaseAll(); // transport rebuilt underneath us
    await t.release();
    await Promise.allSettled([adding]);

    expect(registry.isActive(target("BTC"))).toBe(false);
    expect(t.unsubscribed).toContain("BTC");
  });

  it("does not wedge a market when a subscribe fails", async () => {
    let attempt = 0;
    const registry = new SubscriptionRegistry(async (tgt) => {
      attempt += 1;
      if (attempt === 1) throw new Error("socket down");
      return { unsubscribe: async () => undefined, coin: tgt.coin } as SubscriptionHandle;
    });

    await expect(registry.add(target("BTC"))).rejects.toThrow("socket down");
    await expect(registry.add(target("BTC"))).resolves.toBeUndefined();
    expect(registry.isActive(target("BTC"))).toBe(true);
  });

  describe("reconcile", () => {
    it("makes the live set exactly the requested set", async () => {
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.reconcile([target("BTC"), target("ETH")]);
      await registry.reconcile([target("ETH"), target("SOL")]);

      expect(registry.activeCount).toBe(2);
      expect(registry.isActive(target("BTC"))).toBe(false);
      expect(registry.isActive(target("SOL"))).toBe(true);
      expect(t.unsubscribed).toEqual(["BTC"]);
    });

    it("does not reopen what is already live", async () => {
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.reconcile([target("BTC")]);
      await registry.reconcile([target("BTC")]);
      expect(t.opened).toEqual(["BTC"]);
    });

    it("empties the set", async () => {
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.reconcile([target("BTC")]);
      await registry.reconcile([]);
      expect(registry.activeCount).toBe(0);
    });
  });

  describe("identity teardown", () => {
    it("drops only the switched-away account's subscriptions", async () => {
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.add(target("BTC"));
      await registry.add({ ...target("ETH"), identity: other });

      await registry.removeForIdentity(identity);

      expect(registry.isActive(target("BTC"))).toBe(false);
      expect(registry.isActive({ ...target("ETH"), identity: other })).toBe(true);
    });
  });

  describe("onFailed", () => {
    it("frees the key so a reconcile can re-open it", async () => {
      // The SDK calls `onError` once, AFTER it has already removed the
      // subscription and detached the listener. Without eviction the registry
      // keeps a key for a channel that no longer exists, `add()` returns early
      // on `active.has(key)`, and every later reconcile treats the dead channel
      // as live — the screen simply stops updating, with no staleness marker,
      // because the store is never told either.
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.add(target("BTC"));
      expect(registry.isActive(target("BTC"))).toBe(true);

      registry.onFailed(target("BTC"));
      await tick();
      expect(registry.isActive(target("BTC"))).toBe(false);
      // Still WANTED — that is what makes it repairable.
      expect(registry.isDesired(target("BTC"))).toBe(true);

      await registry.add(target("BTC"));
      expect(registry.isActive(target("BTC"))).toBe(true);
      expect(t.opened.filter((c: string) => c === "BTC")).toHaveLength(2);
    });

    it("does NOT unsubscribe — the SDK already tore it down", async () => {
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.add(target("BTC"));
      registry.onFailed(target("BTC"));
      await tick();
      expect(t.unsubscribed).toEqual([]);
    });

    it("is inert for a key it does not hold", async () => {
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      expect(() => registry.onFailed(target("ETH"))).not.toThrow();
      await tick();
      expect(registry.activeCount).toBe(0);
    });
  });

  describe("closeAll / releaseAll", () => {
    it("closeAll unsubscribes everything", async () => {
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.add(target("BTC"));
      await registry.add(target("ETH"));
      await registry.closeAll();
      expect(registry.activeCount).toBe(0);
      expect(t.unsubscribed.sort()).toEqual(["BTC", "ETH"]);
    });

    it("releaseAll UNSUBSCRIBES before dropping — the rebuild leak", async () => {
      // This asserted the opposite until the review: `forgetAll` dropped the
      // handles and left `unsubscribed` empty, which reads as harmless and is
      // not. The SDK keys listener registrations by function identity and
      // `createSubscribeFn` mints a fresh closure per call, so a handle dropped
      // rather than unsubscribed leaves the old listener attached with nothing
      // able to reach it; the re-add then registers a second beside it, once
      // per resume. See `registry.releaseAll` for why the "it would only throw
      // over a dead socket" justification was false.
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.add(target("BTC"));
      await registry.releaseAll();
      expect(registry.activeCount).toBe(0);
      expect(t.unsubscribed).toEqual(["BTC"]);
    });

    it("releaseAll keeps the desired set, so a re-add is a no-op-free rebuild", async () => {
      // The difference from `closeAll`: this is a rebuild, not a teardown.
      const t = tracker();
      const registry = new SubscriptionRegistry(t.subscribe);
      await registry.add(target("BTC"));
      await registry.releaseAll();
      expect(registry.isDesired(target("BTC"))).toBe(true);

      // And the re-add actually opens: a surviving ACTIVE entry would make
      // `add()` return early and the rebuild would silently do nothing.
      await registry.add(target("BTC"));
      expect(registry.isActive(target("BTC"))).toBe(true);
      expect(t.opened.filter((coin: string) => coin === "BTC")).toHaveLength(2);
    });
  });

  it("counts distinct users, which Hyperliquid caps at 10", async () => {
    const t = tracker();
    const registry = new SubscriptionRegistry(t.subscribe);
    await registry.add(target("BTC"));
    await registry.add(target("ETH"));
    await registry.add({ ...target("SOL"), identity: other });
    expect(registry.distinctUserCount()).toBe(2);
  });
});

describe("removeForIdentity scans BOTH maps", () => {
  it("tears down a target that is active but no longer desired", async () => {
    // `removeByKey` deletes from `desired` synchronously and unsubscribes inside
    // the mutation queue. Between those two steps a subscription is active and
    // not desired — invisible to a scan of `desired` alone, and therefore still
    // writing into state under a docstring promising the opposite.
    const registry = new SubscriptionRegistry(async () => ({
      unsubscribe: async () => undefined,
    }));
    const t = target("BTC");
    await registry.add(t);
    expect(registry.isActive(t)).toBe(true);

    // Reach the exact state: still open, no longer wanted.
    (registry as unknown as { desired: Map<string, unknown> }).desired.clear();
    expect(registry.isDesired(t)).toBe(false);
    expect(registry.isActive(t)).toBe(true);

    await registry.removeForIdentity(t.identity);
    expect(registry.isActive(t)).toBe(false);
  });
});

describe("invalidateInFlight", () => {
  it("makes a subscribe already in flight discard itself", async () => {
    // The account-switch path rebuilds the transport. Without a bump, a
    // subscribe still in flight registers its handle against a socket that no
    // longer exists.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let unsubscribed = 0;

    const registry = new SubscriptionRegistry(async () => {
      await gate;
      return { unsubscribe: async () => void (unsubscribed += 1) };
    });

    const t = target("ETH");
    const pending = registry.add(t);
    registry.invalidateInFlight();
    release!();
    await pending;

    expect(registry.isActive(t)).toBe(false);
    // The handle that arrived late is unsubscribed rather than leaked.
    expect(unsubscribed).toBe(1);
  });
});

describe("reconcileWithin leaves other channels alone", () => {
  it("does NOT tear down a chart when the account set is reconciled", () => {
    // The bug: `switchTo` used a plain `reconcile`, which makes the live set
    // EXACTLY the account channels — so an l2Book subscription on the same
    // registry was removed with nothing to re-add it. A chart on the same screen
    // as the account switcher froze permanently, no error, no reload.
    const registry = new SubscriptionRegistry(async () => ({
      unsubscribe: async () => undefined,
    }));
    const chart = target("BTC", { channel: "l2Book" });
    const account = target("", { channel: "clearinghouseState", coin: null });

    return (async () => {
      await registry.add(chart);
      await registry.add(account);
      expect(registry.isActive(chart)).toBe(true);

      // A switch: the account set changes, the chart does not belong to it.
      const next = target("", { channel: "clearinghouseState", coin: null, identity: other });
      await registry.reconcileWithin(new Set(["clearinghouseState"]), [next]);

      expect(registry.isActive(chart)).toBe(true);
      expect(registry.isActive(account)).toBe(false);
      expect(registry.isActive(next)).toBe(true);
    })();
  });

  it("a plain reconcile still removes everything, for a caller that owns it all", async () => {
    const registry = new SubscriptionRegistry(async () => ({
      unsubscribe: async () => undefined,
    }));
    const chart = target("BTC", { channel: "l2Book" });
    await registry.add(chart);
    await registry.reconcile([]);
    expect(registry.isActive(chart)).toBe(false);
  });
});
