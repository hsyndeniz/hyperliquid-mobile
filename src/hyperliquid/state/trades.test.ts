import { scope } from "@/hyperliquid/core/freshness";
import { createIdentity } from "@/hyperliquid/core/identity";
import { TAPE_CAP, TAPE_MAX_AGE_MS, TradesStore, type TradeRow } from "@/hyperliquid/state/trades";
import type { SubscriptionTarget } from "@/hyperliquid/types/domain";

const NOW = 1_800_000_000_000;
const identity = createIdentity({
  env: "testnet",
  accountId: "acc",
  address: "0xabcdef0123456789abcdef0123456789abcdef01",
});

function target(coin: string): SubscriptionTarget {
  return { identity, channel: "trades", coin, aggregation: null, interval: null };
}

/** Matches the real wire shape: the channel delivers an ARRAY of these rows. */
function row(tid: number, overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    coin: "BTC",
    side: "B",
    px: "97000",
    sz: "0.5",
    time: NOW,
    hash: "0x00",
    tid,
    users: ["0xaaa", "0xbbb"],
    ...overrides,
  };
}

function event(coin: string, rows: readonly TradeRow[], at = NOW) {
  return scope(target(coin), rows, { now: () => at });
}

describe("TradesStore", () => {
  it("holds prints for the current target", () => {
    const store = new TradesStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", [row(1)]));
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0].px).toBe("97000");
  });

  it("reads empty before anything arrives", () => {
    const store = new TradesStore();
    store.setTarget(target("BTC"));
    expect(store.read()).toEqual([]);
  });

  it("normalises the wire side letters at the boundary", () => {
    // "B" is the buy aggressor, "A" the sell — single letters must not survive
    // to render branches.
    const store = new TradesStore();
    store.setTarget(target("BTC"));
    store.apply(event("BTC", [row(1, { side: "B" }), row(2, { side: "A", time: NOW + 1 })]));

    expect(store.read()[0].side).toBe("sell");
    expect(store.read()[1].side).toBe("buy");
  });

  describe("echo checks", () => {
    it("DROPS an event for another market rather than storing it", () => {
      // In-flight ETH events keep arriving after a switch to BTC. Storing one
      // is how another coin's prints end up under the wrong header.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)]));
      store.apply(event("ETH", [row(2, { coin: "ETH", px: "3400" })]));

      expect(store.read()).toHaveLength(1);
      expect(store.read()[0].px).toBe("97000");
      expect(store.dropped).toBe(1);
    });

    it("DROPS a mismatched row inside an otherwise-correct envelope", () => {
      // The envelope check alone passes a mixed batch through wholesale; each
      // row's own `coin` field is the wire's echo and must be verified.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1), row(2, { coin: "ETH", px: "3400" })]));

      expect(store.read()).toHaveLength(1);
      expect(store.read()[0].tid).toBe(1);
      expect(store.dropped).toBe(1);
    });

    it("stores nothing with no target at all", () => {
      const store = new TradesStore();
      store.apply(event("BTC", [row(1)]));
      expect(store.read()).toEqual([]);
    });
  });

  describe("dedup across overlapping batches", () => {
    it("does not grow when batches overlap", () => {
      // The subscribe-time backlog and every reconnect replay overlap with rows
      // already held — the SDK resubscribes on every socket open.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1), row(2, { time: NOW + 1 })]));
      store.apply(event("BTC", [row(2, { time: NOW + 1 }), row(3, { time: NOW + 2 })]));

      expect(store.size).toBe(3);
      expect(store.read().map((t) => t.tid)).toEqual([3, 2, 1]);
    });

    it("keeps the first-seen row when a tid arrives again", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1, { px: "97000" })]));
      store.apply(event("BTC", [row(1, { px: "99999" })]));

      expect(store.read()[0].px).toBe("97000");
    });
  });

  describe("ordering", () => {
    it("reads newest first by time, tiebroken on tid", () => {
      // Several prints routinely share a millisecond on a busy market; tid is
      // assigned in execution order, so it is the correct tiebreak.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(
        event("BTC", [
          row(10, { time: NOW }),
          row(12, { time: NOW + 5 }),
          row(11, { time: NOW + 5 }),
        ])
      );

      expect(store.read().map((t) => t.tid)).toEqual([12, 11, 10]);
    });
  });

  describe("retention cap", () => {
    it("evicts the OLDEST past the cap, never the newest", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      const rows = Array.from({ length: TAPE_CAP + 5 }, (_, i) => row(i, { time: NOW + i }));
      store.apply(event("BTC", rows));

      expect(store.size).toBe(TAPE_CAP);
      const tids = store.read().map((t) => t.tid);
      // Newest survives at the head; the five oldest (tids 0-4) are gone.
      expect(tids[0]).toBe(TAPE_CAP + 4);
      expect(tids[tids.length - 1]).toBe(5);
    });

    it("holds the cap across successive batches", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      const first = Array.from({ length: TAPE_CAP }, (_, i) => row(i, { time: NOW + i }));
      store.apply(event("BTC", first));
      store.apply(event("BTC", [row(9_000, { time: NOW + 9_000 })]));

      expect(store.size).toBe(TAPE_CAP);
      expect(store.read()[0].tid).toBe(9_000);
      // tid 0 was the oldest print and pays for the newcomer.
      expect(store.read().some((t) => t.tid === 0)).toBe(false);
    });
  });

  describe("target switches", () => {
    it("clears immediately on a target switch", () => {
      // An empty tape renders as loading; a stale one renders as wrong.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)]));
      store.setTarget(target("ETH"));
      expect(store.read()).toEqual([]);
    });

    it("does not clear when the target is set to the same market again", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)]));
      store.setTarget(target("BTC"));
      expect(store.read()).toHaveLength(1);
    });
  });

  describe("referential stability", () => {
    it("returns the same array while contents are unchanged", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)]));

      expect(store.read()).toBe(store.read());
    });

    it("keeps the same array across an all-duplicate replay", () => {
      // A reconnect replays rows already held. If that invalidates the memo,
      // every replay forces a pointless re-render of the whole tape.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1), row(2, { time: NOW + 1 })]));
      const before = store.read();

      store.apply(event("BTC", [row(1), row(2, { time: NOW + 1 })], NOW + 50));

      expect(store.read()).toBe(before);
    });

    it("returns a new array once a genuinely new print lands", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)]));
      const before = store.read();

      store.apply(event("BTC", [row(2, { time: NOW + 1 })]));

      expect(store.read()).not.toBe(before);
      expect(store.read()).toHaveLength(2);
    });
  });

  describe("freshness gate", () => {
    it("is not stale before anything arrives", () => {
      // Empty is "nothing yet", not stale — same distinction BookStore draws.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      expect(store.isStale(NOW + TAPE_MAX_AGE_MS * 10)).toBe(false);
    });

    it("flips stale once the feed goes quiet past the gate", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)], NOW));

      expect(store.isStale(NOW + TAPE_MAX_AGE_MS)).toBe(false);
      expect(store.isStale(NOW + TAPE_MAX_AGE_MS + 1)).toBe(true);
    });

    it("counts an all-duplicate replay as proof of life", () => {
      // The replay adds nothing to the tape, but the feed demonstrably works.
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)], NOW));
      store.apply(event("BTC", [row(1)], NOW + TAPE_MAX_AGE_MS));

      expect(store.isStale(NOW + TAPE_MAX_AGE_MS * 2 - 1)).toBe(false);
    });
  });

  describe("subscription", () => {
    it("notifies on apply, switch and clear", () => {
      const store = new TradesStore();
      let count = 0;
      store.subscribe(() => {
        count += 1;
      });

      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)]));
      store.clear();
      expect(count).toBe(3);
    });

    it("does not notify for a dropped event or an all-duplicate replay", () => {
      const store = new TradesStore();
      store.setTarget(target("BTC"));
      store.apply(event("BTC", [row(1)]));
      let count = 0;
      store.subscribe(() => {
        count += 1;
      });

      store.apply(event("ETH", [row(2, { coin: "ETH" })]));
      store.apply(event("BTC", [row(1)]));
      expect(count).toBe(0);
    });

    it("removes a listener on unsubscribe", () => {
      const store = new TradesStore();
      let count = 0;
      const off = store.subscribe(() => {
        count += 1;
      });
      off();
      store.setTarget(target("BTC"));
      expect(count).toBe(0);
    });

    it("keeps feeding the others when one listener throws", () => {
      const store = new TradesStore();
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
