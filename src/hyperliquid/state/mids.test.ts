import { MidsStore } from "@/hyperliquid/state/mids";

const NOW = 1_800_000_000_000;

/** The three measured key families of `allMids`, wire spellings exactly. */
function payload(over: Record<string, string> = {}): Record<string, string> {
  return { BTC: "97000.5", "@107": "12.345", "#102170": "0.55", ...over };
}

describe("MidsStore", () => {
  it("reads as absent before the first poll", () => {
    const store = new MidsStore();
    expect(store.mid("BTC")).toBeNull();
    expect(store.readAll()).toBeNull();
    expect(store.ageMs(NOW)).toBeNull();
    expect(store.version).toBe(0);
  });

  it("serves the wire string for every key family after a poll", () => {
    const store = new MidsStore();
    store.set(payload(), NOW);
    expect(store.mid("BTC")).toBe("97000.5");
    expect(store.mid("@107")).toBe("12.345");
    expect(store.mid("#102170")).toBe("0.55");
  });

  it("reads null for an unknown coin, never '0'", () => {
    const store = new MidsStore();
    store.set(payload(), NOW);
    expect(store.mid("DOGE")).toBeNull();
    // A coin spelled like a prototype key must not read a function as a price.
    expect(store.mid("toString")).toBeNull();
  });

  it("reports the age of the last poll", () => {
    const store = new MidsStore();
    store.set(payload(), NOW);
    expect(store.ageMs(NOW)).toBe(0);
    expect(store.ageMs(NOW + 5_000)).toBe(5_000);
  });

  it("notifies on the first poll", () => {
    const store = new MidsStore();
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.set(payload(), NOW);
    expect(count).toBe(1);
    expect(store.version).toBe(1);
  });

  it("does NOT notify when an identical poll lands, but still refreshes the age", () => {
    // Quiet markets return unchanged payloads every 15 s; notifying would
    // re-render every visible row for zero pixel change. The poll still
    // succeeded, though — a quiet market is not a stale one.
    const store = new MidsStore();
    store.set(payload(), NOW);
    const held = store.readAll();
    const version = store.version;

    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.set(payload(), NOW + 15_000);

    expect(count).toBe(0);
    expect(store.version).toBe(version);
    // The held reference survives so selector snapshots stay Object.is-equal.
    expect(store.readAll()).toBe(held);
    expect(store.ageMs(NOW + 15_000)).toBe(0);
  });

  it("notifies when a value changes", () => {
    const store = new MidsStore();
    store.set(payload(), NOW);
    const held = store.readAll();

    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.set(payload({ BTC: "97100.0" }), NOW + 15_000);

    expect(count).toBe(1);
    expect(store.version).toBe(2);
    expect(store.mid("BTC")).toBe("97100.0");
    expect(store.readAll()).not.toBe(held);
  });

  it("notifies when a key is added", () => {
    const store = new MidsStore();
    store.set(payload(), NOW);
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    store.set(payload({ ETH: "3400.0" }), NOW + 15_000);
    expect(count).toBe(1);
    expect(store.mid("ETH")).toBe("3400.0");
  });

  it("notifies when a key is removed", () => {
    // A delisting drops the coin from the map; its rows must learn the mid is
    // gone rather than keep serving the last one forever.
    const store = new MidsStore();
    store.set(payload(), NOW);
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    const { "#102170": _gone, ...rest } = payload();
    store.set(rest, NOW + 15_000);
    expect(count).toBe(1);
    expect(store.mid("#102170")).toBeNull();
  });

  it("removes a listener on unsubscribe", () => {
    const store = new MidsStore();
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    off();
    store.set(payload(), NOW);
    expect(count).toBe(0);
  });

  it("keeps feeding the others when one listener throws", () => {
    const store = new MidsStore();
    let reached = false;
    store.subscribe(() => {
      throw new Error("bad consumer");
    });
    store.subscribe(() => {
      reached = true;
    });
    store.set(payload(), NOW);
    expect(reached).toBe(true);
  });
});
