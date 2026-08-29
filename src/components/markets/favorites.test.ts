import { hlStringStorage } from "@/hyperliquid/storage/mmkv";
import { FavoritesStore } from "@/components/markets/favorites";

const KEY = "hl:markets:favorites";

describe("FavoritesStore", () => {
  beforeEach(() => {
    hlStringStorage.removeItem(KEY);
  });

  it("toggles a coin on and off", () => {
    const store = new FavoritesStore();
    expect(store.read().has("BTC")).toBe(false);
    store.toggle("BTC");
    expect(store.read().has("BTC")).toBe(true);
    store.toggle("BTC");
    expect(store.read().has("BTC")).toBe(false);
  });

  it("persists across a re-created store instance", () => {
    // The MMKV mock is an in-memory map shared per test file, so a second
    // instance is exactly an app relaunch: same disk, fresh memory.
    const first = new FavoritesStore();
    first.toggle("BTC");
    first.toggle("@107");
    const second = new FavoritesStore();
    expect([...second.read()].sort()).toEqual(["@107", "BTC"]);
  });

  it("unpinning persists too", () => {
    const first = new FavoritesStore();
    first.toggle("BTC");
    first.toggle("BTC");
    expect(new FavoritesStore().read().size).toBe(0);
  });

  it("keeps read() identity stable across calls without writes", () => {
    const store = new FavoritesStore();
    const before = store.read();
    expect(store.read()).toBe(before);
    store.toggle("BTC");
    const after = store.read();
    expect(after).not.toBe(before);
    expect(store.read()).toBe(after);
  });

  it("notifies subscribers on toggle and stops after unsubscribe", () => {
    const store = new FavoritesStore();
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.read().size));
    store.toggle("BTC");
    expect(seen).toEqual([1]);
    unsubscribe();
    store.toggle("ETH");
    expect(seen).toEqual([1]);
  });

  it("reads absent storage as an empty set", () => {
    expect(new FavoritesStore().read().size).toBe(0);
  });

  it("reads corrupt storage as an empty set", () => {
    hlStringStorage.setItem(KEY, "{not json");
    expect(new FavoritesStore().read().size).toBe(0);
  });

  it("reads a non-array payload as an empty set", () => {
    hlStringStorage.setItem(KEY, JSON.stringify({ BTC: true }));
    expect(new FavoritesStore().read().size).toBe(0);
  });

  it("drops non-string entries rather than pinning garbage", () => {
    hlStringStorage.setItem(KEY, JSON.stringify(["BTC", 7, null]));
    const store = new FavoritesStore();
    expect([...store.read()]).toEqual(["BTC"]);
  });
});
