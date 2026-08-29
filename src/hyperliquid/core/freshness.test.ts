import { deriveConnectionState } from "@/hyperliquid/api/clients";
import { resetClock } from "@/hyperliquid/core/clock";
import { ageMs, freshValue, isForTarget, isFresh, scope } from "@/hyperliquid/core/freshness";
import { createIdentity } from "@/hyperliquid/core/identity";
import type { SubscriptionTarget } from "@/hyperliquid/types/domain";

const NOW = 1_800_000_000_000;
const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});

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

// `scope` feeds the skew estimator, so one test's synthetic stamps must not
// reach the next one's age math.
beforeEach(resetClock);

describe("scope", () => {
  it("stamps receivedAt once, at the boundary", () => {
    const s = scope(target(), { levels: [] }, { now: () => NOW });
    expect(s.receivedAt).toBe(NOW);
    expect(s.serverTime).toBeNull();
    expect(s.isSnapshot).toBe(false);
  });

  it("carries a server timestamp and snapshot flag when supplied", () => {
    const s = scope(target(), 1, { serverTime: NOW - 5, isSnapshot: true, now: () => NOW });
    expect(s.serverTime).toBe(NOW - 5);
    expect(s.isSnapshot).toBe(true);
  });
});

describe("isForTarget", () => {
  it("accepts the same target", () => {
    expect(isForTarget(scope(target(), 1, { now: () => NOW }), target())).toBe(true);
  });

  it("rejects a different coin — the stale-book-after-symbol-switch case", () => {
    const forBtc = scope(target({ coin: "BTC" }), 1, { now: () => NOW });
    expect(isForTarget(forBtc, target({ coin: "ETH" }))).toBe(false);
  });

  it("rejects a different account, DEX, or network", () => {
    const base = scope(target(), 1, { now: () => NOW });
    const other = createIdentity({
      env: "testnet",
      accountId: "other",
      address: "0x2222222222222222222222222222222222222222",
    });
    expect(isForTarget(base, target({ identity: other }))).toBe(false);
    expect(isForTarget(base, target({ identity: { ...identity, dex: "xyz" } }))).toBe(false);
    expect(isForTarget(base, target({ identity: { ...identity, env: "mainnet" } }))).toBe(false);
  });

  it("rejects a different book aggregation, which is a distinct subscription", () => {
    const coarse = scope(target({ aggregation: { nSigFigs: 3, mantissa: null, fast: false } }), 1, {
      now: () => NOW,
    });
    expect(
      isForTarget(coarse, target({ aggregation: { nSigFigs: 5, mantissa: null, fast: false } }))
    ).toBe(false);
  });
});

describe("ageMs", () => {
  it("prefers the server clock, since a mobile clock can be badly wrong", () => {
    const s = scope(target(), 1, { serverTime: NOW - 1000, now: () => NOW });
    expect(ageMs(s, NOW)).toBe(1000);
  });

  it("falls back to receivedAt when the channel has no timestamp", () => {
    const s = scope(target(), 1, { now: () => NOW - 500 });
    expect(ageMs(s, NOW)).toBe(500);
  });
});

describe("isFresh / freshValue", () => {
  it("requires BOTH the right target and an acceptable age", () => {
    const s = scope(target(), "book", { now: () => NOW });
    expect(isFresh(s, target(), 1000, NOW)).toBe(true);
    expect(isFresh(s, target(), 1000, NOW + 5000)).toBe(false); // too old
    expect(isFresh(s, target({ coin: "ETH" }), 1000, NOW)).toBe(false); // wrong market
  });

  it("treats missing data as not fresh", () => {
    expect(isFresh(null, target(), 1000, NOW)).toBe(false);
    expect(isFresh(undefined, target(), 1000, NOW)).toBe(false);
  });

  it("returns null rather than another market's value", () => {
    const s = scope(target({ coin: "BTC" }), "btc-book", { now: () => NOW });
    expect(freshValue(s, target({ coin: "BTC" }), 1000, NOW)).toBe("btc-book");
    expect(freshValue(s, target({ coin: "ETH" }), 1000, NOW)).toBeNull();
  });
});

describe("deriveConnectionState", () => {
  it("reports idle with no socket", () => {
    expect(deriveConnectionState(null)).toBe("idle");
  });

  it("reports open only when the socket is actually open", () => {
    expect(deriveConnectionState({ readyState: 1, terminated: false })).toBe("open");
  });

  it("treats connecting and closing as connecting", () => {
    expect(deriveConnectionState({ readyState: 0, terminated: false })).toBe("connecting");
    expect(deriveConnectionState({ readyState: 2, terminated: false })).toBe("connecting");
  });

  it("reports terminated even while the socket claims to be connecting", () => {
    // The reconnecting layer reports CONNECTING through every retry, so
    // readyState alone would show "connecting" forever during an outage.
    expect(deriveConnectionState({ readyState: 0, terminated: true })).toBe("terminated");
  });

  it("reports terminated for a closed socket", () => {
    expect(deriveConnectionState({ readyState: 3, terminated: false })).toBe("terminated");
  });
});

describe("ageMs across a skewed device clock", () => {
  /** Teach the clock that this device runs `skewMs` behind the exchange. */
  function learnSkew(skewMs: number): void {
    for (let i = 0; i < 5; i += 1) {
      const at = NOW + i * 500;
      scope(target(), i, { serverTime: at + skewMs, now: () => at });
    }
  }

  it("reports true age rather than the difference between two clocks", () => {
    learnSkew(60_000);
    const received = NOW + 5_000;
    const s = scope(target(), 1, { serverTime: received + 60_000, now: () => received });

    // Three seconds later, read on the device's own clock. Subtracting the raw
    // server stamp would give MINUS 57 seconds — a frame from the future.
    expect(ageMs(s, received + 3_000)).toBe(3_000);
  });

  it("does not let a slow clock pass stale data off as live", () => {
    // The failure this guards: every freshness gate in the app is `age <=
    // maxAge`, and a negative age passes every one of them. A phone a minute
    // behind would render a book that stopped updating half a minute ago as
    // current, and let an order be placed against it.
    learnSkew(60_000);
    const received = NOW + 5_000;
    const s = scope(target(), 1, { serverTime: received + 60_000, now: () => received });

    expect(isFresh(s, target(), 10_000, received + 30_000)).toBe(false);
  });

  it("leaves a channel that stamps no server time alone", () => {
    // `receivedAt` is already on the device clock; correcting it would invent
    // an error that was never there.
    learnSkew(60_000);
    const s = scope(target(), 1, { now: () => NOW });
    expect(ageMs(s, NOW + 3_000)).toBe(3_000);
  });
});
