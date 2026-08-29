import { HlError } from "@/hyperliquid/core/errors";
import { createIdentity } from "@/hyperliquid/core/identity";
import { createSubscribeFn, type SubscriptionApi } from "@/hyperliquid/state/channels";
import type { Scoped, SubscriptionTarget } from "@/hyperliquid/types/domain";

const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const SUB = "0x1111111111111111111111111111111111111111";
const NOW = 1_800_000_000_000;
const identity = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });

function target(overrides: Partial<SubscriptionTarget> = {}): SubscriptionTarget {
  return {
    identity,
    channel: "l2Book",
    coin: "BTC",
    aggregation: null,
    interval: null,
    ...overrides,
  };
}

/** Records the params each channel was called with, and captures its listener. */
function api() {
  const calls: { channel: string; params: unknown }[] = [];
  const listeners: ((data: unknown) => void)[] = [];
  const handle = { unsubscribe: async () => undefined };

  const make = (channel: string) => async (params: unknown, listener: (d: unknown) => void) => {
    calls.push({ channel, params });
    listeners.push(listener);
    return handle;
  };

  const stub = {
    l2Book: make("l2Book"),
    bbo: make("bbo"),
    allMids: make("allMids"),
    trades: make("trades"),
    candle: make("candle"),
    activeAssetCtx: make("activeAssetCtx"),
    activeAssetData: make("activeAssetData"),
    webData3: make("webData3"),
    orderUpdates: make("orderUpdates"),
    userEvents: make("userEvents"),
    userFills: make("userFills"),
    notification: make("notification"),
    clearinghouseState: make("clearinghouseState"),
    openOrders: make("openOrders"),
    spotState: make("spotState"),
    userTwapSliceFills: make("userTwapSliceFills"),
  } as unknown as SubscriptionApi;

  return { stub, calls, listeners };
}

describe("createSubscribeFn — parameter mapping", () => {
  it("sends the coin for a market channel", async () => {
    const a = api();
    await createSubscribeFn({ api: a.stub, sink: () => {} })(target());
    expect(a.calls[0]).toEqual({ channel: "l2Book", params: { coin: "BTC" } });
  });

  it("sends aggregation exactly as the key describes it", async () => {
    // Aggregation is part of subscription identity; sending a different shape
    // than the key implies would let two subscriptions collide.
    const a = api();
    await createSubscribeFn({ api: a.stub, sink: () => {} })(
      target({ aggregation: { nSigFigs: 3, mantissa: 5, fast: true } })
    );
    expect(a.calls[0].params).toEqual({ coin: "BTC", nSigFigs: 3, mantissa: 5, fast: true });
  });

  it("omits aggregation fields that are null rather than sending nulls", async () => {
    const a = api();
    await createSubscribeFn({ api: a.stub, sink: () => {} })(
      target({ aggregation: { nSigFigs: null, mantissa: null, fast: false } })
    );
    expect(a.calls[0].params).toEqual({ coin: "BTC" });
  });

  it("sends the user for account channels", async () => {
    const a = api();
    const subscribe = createSubscribeFn({ api: a.stub, sink: () => {} });
    await subscribe(target({ channel: "orderUpdates", coin: null }));
    await subscribe(target({ channel: "webData3", coin: null }));
    expect(a.calls.map((c) => c.params)).toEqual([{ user: ADDRESS }, { user: ADDRESS }]);
  });

  it("uses the sub-account address when one is selected", async () => {
    // Hyperliquid attributes activity to the sub-account, so subscribing with
    // the parent address would watch the wrong account.
    const a = api();
    const subIdentity = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: ADDRESS,
      subAccount: SUB,
    });
    await createSubscribeFn({ api: a.stub, sink: () => {} })(
      target({ channel: "orderUpdates", coin: null, identity: subIdentity })
    );
    expect(a.calls[0].params).toEqual({ user: SUB });
  });

  it("scopes allMids to a builder DEX, and omits dex for the main one", async () => {
    const a = api();
    const subscribe = createSubscribeFn({ api: a.stub, sink: () => {} });
    await subscribe(target({ channel: "allMids", coin: null }));
    await subscribe(
      target({ channel: "allMids", coin: null, identity: { ...identity, dex: "xyz" } })
    );
    expect(a.calls.map((c) => c.params)).toEqual([{}, { dex: "xyz" }]);
  });

  it("requires the interval on the TARGET, not on the wiring", async () => {
    // One subscribe function must serve every interval — the interval is part
    // of the subscription's identity, so it belongs on the target.
    const a = api();
    await expect(
      createSubscribeFn({ api: a.stub, sink: () => {} })(target({ channel: "candle" }))
    ).rejects.toThrow(HlError);

    await createSubscribeFn({ api: a.stub, sink: () => {} })(
      target({ channel: "candle", interval: "1m" })
    );
    expect(a.calls[0].params).toEqual({ coin: "BTC", interval: "1m" });
  });

  it("serves multiple intervals from ONE subscribe function", async () => {
    const a = api();
    const subscribe = createSubscribeFn({ api: a.stub, sink: () => {} });
    await subscribe(target({ channel: "candle", interval: "1m" }));
    await subscribe(target({ channel: "candle", interval: "1h" }));
    expect(a.calls.map((c) => (c.params as { interval: string }).interval)).toEqual(["1m", "1h"]);
  });

  it("refuses a market channel with no coin instead of subscribing to nothing", async () => {
    const a = api();
    await expect(
      createSubscribeFn({ api: a.stub, sink: () => {} })(target({ coin: null }))
    ).rejects.toThrow(/requires a coin/);
  });
});

describe("createSubscribeFn — event scoping", () => {
  it("stamps every event with its target and receive time", async () => {
    const a = api();
    const events: Scoped<unknown>[] = [];
    await createSubscribeFn({ api: a.stub, sink: (e) => events.push(e), now: () => NOW })(target());

    a.listeners[0]({ levels: [[], []] });

    expect(events).toHaveLength(1);
    expect(events[0].receivedAt).toBe(NOW);
    expect(events[0].target.coin).toBe("BTC");
    expect(events[0].value).toEqual({ levels: [[], []] });
  });

  it("scopes each channel to its own target, so a shared sink stays unambiguous", async () => {
    const a = api();
    const events: Scoped<unknown>[] = [];
    const subscribe = createSubscribeFn({
      api: a.stub,
      sink: (e) => events.push(e),
      now: () => NOW,
    });
    await subscribe(target({ coin: "BTC" }));
    await subscribe(target({ coin: "ETH" }));

    a.listeners[0]("btc-book");
    a.listeners[1]("eth-book");

    expect(events.map((e) => e.target.coin)).toEqual(["BTC", "ETH"]);
  });
});

describe("createSubscribeFn — error routing", () => {
  it("reports a post-confirmation failure rather than leaving a silently dead feed", async () => {
    const seen: { coin: string | null; error: unknown }[] = [];
    let capturedOnError: ((e: unknown) => void) | undefined;

    const stub = {
      l2Book: async (_p: unknown, _l: unknown, options: { onError: (e: unknown) => void }) => {
        capturedOnError = options.onError;
        return { unsubscribe: async () => undefined };
      },
    } as unknown as SubscriptionApi;

    await createSubscribeFn({
      api: stub,
      sink: () => {},
      onError: (t, error) => seen.push({ coin: t.coin, error }),
    })(target());

    capturedOnError?.(new Error("socket died"));
    expect(seen).toHaveLength(1);
    expect(seen[0].coin).toBe("BTC");
  });

  it("lets a pre-confirmation failure reject, which is the other half of the path", async () => {
    const stub = {
      l2Book: async () => {
        throw new Error("refused");
      },
    } as unknown as SubscriptionApi;

    await expect(createSubscribeFn({ api: stub, sink: () => {} })(target())).rejects.toThrow(
      "refused"
    );
  });
});

describe("account channels", () => {
  const dexIdentity = createIdentity({
    env: "testnet",
    accountId: "acc",
    address: ADDRESS,
    dex: "xyz",
  });

  function accountTarget(channel: SubscriptionTarget["channel"], id = identity) {
    return target({ identity: id, channel, coin: null });
  }

  it("sends dex on the channels whose request carries one", async () => {
    // A real-but-wrong dex answers 200 with a well-formed EMPTY account, so an
    // omitted dex shows "no positions" to someone holding live risk.
    const { stub, calls } = api();
    const subscribe = createSubscribeFn({ api: stub, sink: () => {}, now: () => NOW });

    await subscribe(accountTarget("clearinghouseState", dexIdentity));
    await subscribe(accountTarget("openOrders", dexIdentity));

    expect(calls[0].params).toEqual({ user: ADDRESS, dex: "xyz" });
    expect(calls[1].params).toEqual({ user: ADDRESS, dex: "xyz" });
  });

  it("sends an empty dex for the main dex rather than omitting it", async () => {
    const { stub, calls } = api();
    const subscribe = createSubscribeFn({ api: stub, sink: () => {}, now: () => NOW });

    await subscribe(accountTarget("clearinghouseState"));

    expect(calls[0].params).toEqual({ user: ADDRESS, dex: "" });
  });

  it("never sends dex on spot, which is not dex-scoped", async () => {
    const { stub, calls } = api();
    const subscribe = createSubscribeFn({ api: stub, sink: () => {}, now: () => NOW });

    await subscribe(accountTarget("spotState", dexIdentity));

    expect(calls[0].params).toEqual({ user: ADDRESS });
  });

  it("pins fill aggregation off", async () => {
    // An aggregated row reuses a constituent fill's `tid` with a summed size and
    // arrives on the same channel with no marker, so mixing modes double-counts.
    const { stub, calls } = api();
    const subscribe = createSubscribeFn({ api: stub, sink: () => {}, now: () => NOW });

    await subscribe(accountTarget("userFills"));

    expect(calls[0].params).toEqual({ user: ADDRESS, aggregateByTime: false });
  });

  it("subscribes TWAP slices, which appear in no other feed", async () => {
    const { stub, calls } = api();
    const subscribe = createSubscribeFn({ api: stub, sink: () => {}, now: () => NOW });

    await subscribe(accountTarget("userTwapSliceFills"));

    expect(calls[0].channel).toBe("userTwapSliceFills");
    expect(calls[0].params).toEqual({ user: ADDRESS });
  });

  it("uses the sub-account address when one is set", async () => {
    const subIdentity = createIdentity({
      env: "testnet",
      accountId: "acc",
      address: ADDRESS,
      subAccount: SUB,
    });
    const { stub, calls } = api();
    const subscribe = createSubscribeFn({ api: stub, sink: () => {}, now: () => NOW });

    await subscribe(accountTarget("clearinghouseState", subIdentity));

    expect((calls[0].params as { user: string }).user).toBe(SUB);
  });
});

describe("server time extraction", () => {
  async function emit(channel: SubscriptionTarget["channel"], data: unknown) {
    const { stub, listeners } = api();
    const events: Scoped<unknown>[] = [];
    const subscribe = createSubscribeFn({
      api: stub,
      sink: (e) => events.push(e),
      now: () => NOW,
    });
    await subscribe(target({ channel, coin: channel === "l2Book" ? "BTC" : null }));
    listeners[0](data);
    return events[0];
  }

  it("reads the nested timestamp on clearinghouseState", async () => {
    // A top-level `data.time` read returns null here, and freshness then falls
    // back to the device clock — so a server-side dead feed reads as fresh.
    const event = await emit("clearinghouseState", {
      clearinghouseState: { time: 123_456 },
      user: ADDRESS,
    });
    expect(event.serverTime).toBe(123_456);
  });

  it("returns null for channels that carry no emission time", async () => {
    for (const channel of ["openOrders", "spotState", "userFills"] as const) {
      const event = await emit(channel, { isSnapshot: true, fills: [] });
      expect(event.serverTime).toBeNull();
      // Never silently equal to receivedAt — that is what hides a dead feed.
      expect(event.serverTime).not.toBe(event.receivedAt);
    }
  });

  it("does not mistake a fill's trade time for an emission time", async () => {
    // A fill's `time` is when the trade happened. Mapping it in makes an idle
    // feed read as arbitrarily stale depending on when the account last traded.
    const event = await emit("userFills", { fills: [{ time: 1 }], isSnapshot: true });
    expect(event.serverTime).toBeNull();
  });

  it("still reads the top-level timestamp on l2Book", async () => {
    const event = await emit("l2Book", { coin: "BTC", time: 999, levels: [[], []] });
    expect(event.serverTime).toBe(999);
  });
});

describe("snapshot flag", () => {
  async function emit(data: unknown) {
    const { stub, listeners } = api();
    const events: Scoped<unknown>[] = [];
    const subscribe = createSubscribeFn({
      api: stub,
      sink: (e) => events.push(e),
      now: () => NOW,
    });
    await subscribe(target({ channel: "userFills", coin: null }));
    listeners[0](data);
    return events[0];
  }

  it("marks a snapshot frame", async () => {
    expect((await emit({ isSnapshot: true, fills: [] })).isSnapshot).toBe(true);
  });

  it("treats an ABSENT flag as a delta, not as a snapshot", async () => {
    // The flag is absent on deltas rather than false, so any `!isSnapshot` test
    // gets it backwards.
    expect((await emit({ fills: [] })).isSnapshot).toBe(false);
  });
});
