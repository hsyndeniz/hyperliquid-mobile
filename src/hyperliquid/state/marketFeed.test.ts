import { subscriptionKey } from "@/hyperliquid/core/identity";
import {
  MarketFeed,
  marketIdentity,
  marketTarget,
  type MarketListener,
} from "@/hyperliquid/state/marketFeed";
import type { SubscriptionApi } from "@/hyperliquid/state/channels";
import type { SubscriptionHandle } from "@/hyperliquid/state/registry";
import type { Scoped } from "@/hyperliquid/types/domain";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = 1_700_000_000_000;

interface FakeCall {
  method: string;
  params: Record<string, unknown>;
  /** The wire listener `channels.ts` registered — call it to emit an event. */
  emit: (data: unknown) => void;
}

/**
 * In-memory SubscriptionApi: records subscribe/unsubscribe calls and captures
 * each subscription's wire listener so tests can drive events through the
 * real scoping path.
 */
function fakeApi(label: string) {
  const calls: FakeCall[] = [];
  const unsubscribed: string[] = [];
  const make =
    (method: string) =>
    async (params: unknown, listener: (data: unknown) => void): Promise<SubscriptionHandle> => {
      const call: FakeCall = { method, params: params as Record<string, unknown>, emit: listener };
      calls.push(call);
      return {
        unsubscribe: async () => {
          unsubscribed.push(`${method}:${String(call.params.coin ?? "-")}`);
        },
      };
    };
  return {
    label,
    calls,
    unsubscribed,
    api: {
      candle: make("candle"),
      activeAssetCtx: make("activeAssetCtx"),
      l2Book: make("l2Book"),
      bbo: make("bbo"),
      trades: make("trades"),
    } as unknown as SubscriptionApi,
  };
}

function collector() {
  const events: Scoped<unknown>[] = [];
  const listener: MarketListener = (event) => events.push(event);
  return { events, listener };
}

const btc1m = () =>
  marketTarget({ env: "testnet", channel: "candle", coin: "BTC", interval: "1m" });
const eth1m = () =>
  marketTarget({ env: "testnet", channel: "candle", coin: "ETH", interval: "1m" });

describe("marketIdentity", () => {
  it("builds the synthetic env-scoped identity", () => {
    const identity = marketIdentity("testnet");
    expect(identity.accountId).toBe("market-data-testnet");
    expect(identity.address).toBe("0x0000000000000000000000000000000000000001");
    expect(identity.env).toBe("testnet");
    expect(identity.dex).toBeNull();
    expect(identity.subAccount).toBeNull();
  });

  it("is referentially stable per env and distinct across envs", () => {
    expect(marketIdentity("testnet")).toBe(marketIdentity("testnet"));
    expect(marketIdentity("mainnet")).not.toBe(marketIdentity("testnet"));
    expect(marketIdentity("mainnet").accountId).toBe("market-data-mainnet");
  });
});

describe("marketTarget", () => {
  it("scopes the target under the market identity with no aggregation", () => {
    const target = btc1m();
    expect(target.identity).toBe(marketIdentity("testnet"));
    expect(target.channel).toBe("candle");
    expect(target.coin).toBe("BTC");
    expect(target.interval).toBe("1m");
    expect(target.aggregation).toBeNull();
  });

  it("leaves interval null for non-candle channels", () => {
    const target = marketTarget({ env: "testnet", channel: "activeAssetCtx", coin: "BTC" });
    expect(target.interval).toBeNull();
  });

  it("keys distinct intervals as distinct subscriptions", () => {
    const hour = marketTarget({ env: "testnet", channel: "candle", coin: "BTC", interval: "1h" });
    expect(subscriptionKey(btc1m())).not.toBe(subscriptionKey(hour));
  });

  it("an l2Book target without aggregation keys exactly as it always has", () => {
    const target = marketTarget({ env: "testnet", channel: "l2Book", coin: "BTC" });
    expect(target.aggregation).toBeNull();
    // The literal string, not a comparison against another builder call: this
    // is the cache key every pre-aggregation caller minted, and a drift here
    // silently orphans their ref-counts into a fresh entry.
    expect(subscriptionKey(target)).toBe(
      "testnet|market-data-testnet|0x0000000000000000000000000000000000000001|-|-|l2Book|BTC|-|-"
    );
  });

  it("keys targets differing only in aggregation as distinct subscriptions", () => {
    const raw = marketTarget({ env: "testnet", channel: "l2Book", coin: "BTC" });
    const aggregated = marketTarget({
      env: "testnet",
      channel: "l2Book",
      coin: "BTC",
      aggregation: { nSigFigs: 5, mantissa: 5, fast: true },
    });
    // The SDK treats aggregation as part of the subscription's identity; a
    // shared key would leave two writers racing into one store slice.
    expect(subscriptionKey(raw)).not.toBe(subscriptionKey(aggregated));
    expect(subscriptionKey(aggregated)).toContain("5/5/f");
  });
});

describe("MarketFeed refcount", () => {
  it("two opens on one key subscribe once; the last close unsubscribes", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api });
    const a = collector();
    const b = collector();

    // Two structurally-equal targets built independently: keying must be by
    // subscriptionKey, not object identity.
    const closeA = feed.open(btc1m(), a.listener);
    const closeB = feed.open(btc1m(), b.listener);
    await tick();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].params).toEqual({ coin: "BTC", interval: "1m" });
    expect(feed.activeCount()).toBe(1);

    closeA();
    await tick();
    expect(fake.unsubscribed).toEqual([]);
    expect(feed.activeCount()).toBe(1);

    closeB();
    await tick();
    expect(fake.unsubscribed).toEqual(["candle:BTC"]);
    expect(feed.activeCount()).toBe(0);
  });

  it("close is idempotent — a double close does not steal the survivor's feed", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api });
    const a = collector();
    const b = collector();

    const closeA = feed.open(btc1m(), a.listener);
    feed.open(btc1m(), b.listener);
    await tick();

    closeA();
    closeA();
    await tick();
    expect(fake.unsubscribed).toEqual([]);
    expect(feed.activeCount()).toBe(1);
  });

  it("round-trips l2Book aggregation into the subscribe payload", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api });

    feed.open(
      marketTarget({
        env: "testnet",
        channel: "l2Book",
        coin: "BTC",
        aggregation: { nSigFigs: 5, mantissa: 5, fast: true },
      }),
      collector().listener
    );
    feed.open(
      marketTarget({ env: "testnet", channel: "l2Book", coin: "ETH" }),
      collector().listener
    );
    await tick();

    // The aggregated target reaches the wire with exactly the fields the key
    // describes; the default target sends coin ALONE — an explicit
    // `nSigFigs: undefined` would still change the SDK's payload-serialised
    // subscription identity.
    expect(fake.calls.map((call) => call.params)).toEqual([
      { coin: "BTC", nSigFigs: 5, mantissa: 5, fast: true },
      { coin: "ETH" },
    ]);
    expect(feed.activeCount()).toBe(2);
  });

  it("distinct intervals on one coin are two live subscriptions", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api });

    feed.open(btc1m(), collector().listener);
    feed.open(
      marketTarget({ env: "testnet", channel: "candle", coin: "BTC", interval: "1h" }),
      collector().listener
    );
    await tick();

    expect(fake.calls.map((call) => call.params.interval).sort()).toEqual(["1h", "1m"]);
    expect(feed.activeCount()).toBe(2);
  });
});

describe("MarketFeed fanout", () => {
  it("routes an event only to the listeners of its key, scoped and stamped", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api, now: () => NOW });
    const a = collector();
    const b = collector();

    const btc = btc1m();
    feed.open(btc, a.listener);
    feed.open(eth1m(), b.listener);
    await tick();

    const btcCall = fake.calls.find((call) => call.params.coin === "BTC")!;
    const payload = { s: "BTC", i: "1m", o: "100", c: "101" };
    btcCall.emit(payload);

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);
    // The real scoping path ran: same value reference, target keyed to what
    // was opened, receivedAt from the injected clock.
    expect(a.events[0].value).toBe(payload);
    expect(subscriptionKey(a.events[0].target)).toBe(subscriptionKey(btc));
    expect(a.events[0].receivedAt).toBe(NOW);
  });

  it("both listeners of one key receive each event", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api });
    const a = collector();
    const b = collector();

    feed.open(btc1m(), a.listener);
    feed.open(btc1m(), b.listener);
    await tick();

    fake.calls[0].emit({ s: "BTC" });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("drops an event arriving after the last close without throwing", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api });
    const a = collector();

    const close = feed.open(btc1m(), a.listener);
    await tick();
    close();
    await tick();

    // The socket may still deliver a frame between remove and the server
    // acknowledging it.
    expect(() => fake.calls[0].emit({ s: "BTC" })).not.toThrow();
    expect(a.events).toHaveLength(0);
  });
});

describe("MarketFeed rebuild", () => {
  it("re-adds exactly the keys with listeners, on the CURRENT client", async () => {
    let active = fakeApi("first");
    const feed = new MarketFeed({ api: () => active.api });

    feed.open(btc1m(), collector().listener);
    const closeEth = feed.open(eth1m(), collector().listener);
    await tick();
    const first = active;
    expect(first.calls.map((call) => call.params.coin).sort()).toEqual(["BTC", "ETH"]);

    closeEth();
    await tick();

    // The transport was rebuilt: a NEW client exists and the old one is dead.
    active = fakeApi("second");
    const second = active;
    await feed.rebuild();

    // Only the key that still has listeners, and only on the new client.
    expect(second.calls.map((call) => call.params.coin)).toEqual(["BTC"]);
    expect(first.calls).toHaveLength(2);
    // The old handles ARE unsubscribed — this asserted the opposite until the
    // review, and the opposite was the leak. The SDK keys listener
    // registrations by function identity and `createSubscribeFn` mints a fresh
    // closure per call, so a handle merely dropped leaves its listener attached
    // with nothing able to reach it, and the re-add adds a second beside it.
    // Issuing the unsubscribe is safe even on a socket that is gone: the SDK
    // sends a frame only when the socket is OPEN and otherwise just detaches
    // locally, which is exactly the part that has to happen.
    expect(first.unsubscribed.sort()).toEqual(["candle:BTC", "candle:ETH"]);
    expect(feed.activeCount()).toBe(1);
  });

  it("keeps fanout flowing to the surviving listener after rebuild", async () => {
    let active = fakeApi("first");
    const feed = new MarketFeed({ api: () => active.api });
    const a = collector();

    feed.open(btc1m(), a.listener);
    await tick();

    active = fakeApi("second");
    const second = active;
    await feed.rebuild();

    second.calls[0].emit({ s: "BTC" });
    expect(a.events).toHaveLength(1);
  });

  it("close() after rebuild does not throw and tears down the NEW handle only", async () => {
    let active = fakeApi("first");
    const feed = new MarketFeed({ api: () => active.api });

    const close = feed.open(btc1m(), collector().listener);
    await tick();
    const first = active;

    active = fakeApi("second");
    const second = active;
    await feed.rebuild();

    expect(() => close()).not.toThrow();
    await tick();
    expect(second.unsubscribed).toEqual(["candle:BTC"]);
    // Released during the rebuild, not left dangling — see above.
    expect(first.unsubscribed).toEqual(["candle:BTC"]);
    expect(feed.activeCount()).toBe(0);
  });

  it("is a no-op with no listeners", async () => {
    const fake = fakeApi("only");
    const feed = new MarketFeed({ api: () => fake.api });
    await feed.rebuild();
    expect(fake.calls).toHaveLength(0);
    expect(feed.activeCount()).toBe(0);
  });
});
