import { scope } from "@/hyperliquid/core/freshness";
import { createIdentity } from "@/hyperliquid/core/identity";
import { AssetCtxStore, CTX_MAX_AGE_MS, toAssetCtxView } from "@/hyperliquid/state/assetCtx";
import type { SubscriptionTarget } from "@/hyperliquid/types/domain";
import type { IActiveAssetCtxEvent, IPerpAssetCtx } from "@/hyperliquid/types/sdk";

const NOW = 1_800_000_000_000;
const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});

function target(coin: string): SubscriptionTarget {
  return { identity, channel: "activeAssetCtx", coin, aggregation: null, interval: null };
}

/** Matches the wire shape of a perp ctx, every price a string. */
function ctx(over: Partial<IPerpAssetCtx> = {}): IPerpAssetCtx {
  return {
    prevDayPx: "96000.0",
    dayNtlVlm: "1234567.89",
    markPx: "97000.0",
    midPx: "97001.5",
    funding: "0.0000125",
    openInterest: "1043.2",
    premium: "0.0000103",
    oraclePx: "96998.0",
    impactPxs: ["96999.0", "97003.0"],
    dayBaseVlm: "12.5",
    ...over,
  };
}

function event(coin: string, over: Partial<IPerpAssetCtx> = {}, at = NOW) {
  const value: IActiveAssetCtxEvent = { coin, ctx: ctx(over) };
  return scope(target(coin), value, { now: () => at });
}

describe("toAssetCtxView", () => {
  it("keeps wire strings verbatim", () => {
    const view = toAssetCtxView(ctx());
    expect(view.markPx).toBe("97000.0");
    expect(view.oraclePx).toBe("96998.0");
    expect(view.funding).toBe("0.0000125");
    expect(view.openInterest).toBe("1043.2");
    expect(view.prevDayPx).toBe("96000.0");
    expect(view.dayNtlVlm).toBe("1234567.89");
    expect(view.impactPxs).toEqual(["96999.0", "97003.0"]);
  });

  it("passes the co-null trio through as null, never '0'", () => {
    // Bookless perps ship midPx/premium/impactPxs null together (55/210
    // measured). A "0" default would render a fabricated price of zero.
    const view = toAssetCtxView(ctx({ midPx: null, premium: null, impactPxs: null }));
    expect(view.midPx).toBeNull();
    expect(view.premium).toBeNull();
    expect(view.impactPxs).toBeNull();
    expect(view.markPx).toBe("97000.0");
  });
});

describe("AssetCtxStore", () => {
  it("holds a ctx for the current target", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC"));
    expect(store.read(NOW)!.markPx).toBe("97000.0");
  });

  it("reads null before anything arrives", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    expect(store.read(NOW)).toBeNull();
  });

  it("reads null with no target at all, and counts the drop", () => {
    const store = new AssetCtxStore();
    store.apply(event("BTC"));
    expect(store.read(NOW)).toBeNull();
    expect(store.dropped).toBe(1);
  });

  it("DROPS an event for another market rather than storing it", () => {
    // In-flight ETH events keep arriving after a switch to BTC. Storing one is
    // how the wrong funding ends up under the right name.
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC"));
    store.apply(event("ETH", { markPx: "3400.0" }));

    expect(store.read(NOW)!.markPx).toBe("97000.0");
    expect(store.dropped).toBe(1);
  });

  it("clears immediately on a target switch", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC"));
    store.setTarget(target("ETH"));
    expect(store.read(NOW)).toBeNull();
  });

  it("does not clear when the target is set to the same market again", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC"));
    store.setTarget(target("BTC"));
    expect(store.read(NOW)).not.toBeNull();
  });

  it("refuses to serve a ctx past its age limit", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", {}, NOW));

    expect(store.read(NOW + CTX_MAX_AGE_MS)).not.toBeNull();
    expect(store.read(NOW + CTX_MAX_AGE_MS + 1)).toBeNull();
  });

  it("distinguishes 'nothing yet' from 'held but stale'", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    expect(store.isStale(NOW)).toBe(false);

    store.apply(event("BTC", {}, NOW));
    expect(store.isStale(NOW + CTX_MAX_AGE_MS + 1)).toBe(true);
    // The envelope survives so a surface can show last-known values greyed out.
    expect(store.readScoped()).not.toBeNull();
  });

  it("markStale keeps the values but stops calling them fresh", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC"));

    store.markStale();

    expect(store.read(NOW)).toBeNull();
    expect(store.readScoped()!.value.markPx).toBe("97000.0");
  });

  it("accepts fresh data again after being marked stale", () => {
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC"));
    store.markStale();
    store.apply(event("BTC", { markPx: "97100.0" }, NOW));
    expect(store.read(NOW)!.markPx).toBe("97100.0");
  });

  it("returns the SAME view object across reads until the next event", () => {
    // The useSyncExternalStore rule: getSnapshot re-runs every render and React
    // compares with Object.is — a fresh object per read re-renders forever.
    const store = new AssetCtxStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC"));

    const first = store.read(NOW);
    expect(store.read(NOW)).toBe(first);
    expect(store.read(NOW + 5_000)).toBe(first);
    expect(store.readScoped()!.value).toBe(first);

    store.apply(event("BTC", { markPx: "97100.0" }, NOW + 6_000));
    const second = store.read(NOW + 6_000);
    expect(second).not.toBe(first);
    expect(store.read(NOW + 6_000)).toBe(second);
  });

  describe("subscription", () => {
    it("notifies on apply, switch and clear", () => {
      const store = new AssetCtxStore();
      let count = 0;
      store.subscribe(() => {
        count += 1;
      });

      store.setTarget(target("BTC"));
      store.apply(event("BTC"));
      store.clear();
      expect(count).toBe(3);
    });

    it("does not notify for a dropped event", () => {
      const store = new AssetCtxStore();
      store.setTarget(target("BTC"));
      let count = 0;
      store.subscribe(() => {
        count += 1;
      });
      store.apply(event("ETH", { markPx: "3400.0" }));
      expect(count).toBe(0);
    });

    it("removes a listener on unsubscribe", () => {
      const store = new AssetCtxStore();
      let count = 0;
      const off = store.subscribe(() => {
        count += 1;
      });
      off();
      store.setTarget(target("BTC"));
      expect(count).toBe(0);
    });

    it("keeps feeding the others when one listener throws", () => {
      const store = new AssetCtxStore();
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
