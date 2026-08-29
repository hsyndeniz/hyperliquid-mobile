import { VaultDirectoryStore } from "@/hyperliquid/state/vaultDirectory";
import type { VaultDirectory } from "@/hyperliquid/vaults/directory";
import type { Hex } from "@/hyperliquid/types/domain";

const ADDRESS = "0x00000000000000000000000000000000000000aa" as Hex;

function directory(): VaultDirectory {
  return {
    env: "testnet",
    fetchedAtMs: 1_700_000_000_000,
    top: [],
    index: new Map([[ADDRESS, { name: "Alpha", isClosed: false }]]),
    collisions: new Map(),
  };
}

describe("VaultDirectoryStore", () => {
  it("returns a referentially stable snapshot between mutations", () => {
    const store = new VaultDirectoryStore();
    store.set(directory());
    // The getSnapshot rule: identical reads must be identical references, or
    // useSyncExternalStore re-renders forever.
    expect(store.read()).toBe(store.read());
    expect(store.fetchState()).toBe(store.fetchState());
  });

  it("notifies on set and clears to null, not to an empty directory", () => {
    const store = new VaultDirectoryStore();
    let ticks = 0;
    store.subscribe(() => (ticks += 1));
    store.set(directory());
    expect(ticks).toBe(1);
    store.clear();
    // null is "we have not looked", distinct from a directory with no vaults.
    expect(store.read()).toBeNull();
    expect(ticks).toBe(2);
  });

  it("upserts an index entry with a wholesale replace, case-insensitively", () => {
    const store = new VaultDirectoryStore();
    store.set(directory());
    const before = store.read();
    store.upsertIndex("0x00000000000000000000000000000000000000BB" as Hex, {
      name: "Testnet HLP",
      isClosed: false,
    });
    const after = store.read();
    expect(after).not.toBe(before);
    expect(after!.index.get("0x00000000000000000000000000000000000000bb" as Hex)).toEqual({
      name: "Testnet HLP",
      isClosed: false,
    });
    // The original map was not mutated in place.
    expect(before!.index.has("0x00000000000000000000000000000000000000bb" as Hex)).toBe(false);
  });

  it("skips the notify when an upsert changes nothing", () => {
    const store = new VaultDirectoryStore();
    store.set(directory());
    let ticks = 0;
    store.subscribe(() => (ticks += 1));
    store.upsertIndex(ADDRESS, { name: "Alpha", isClosed: false });
    expect(ticks).toBe(0);
    expect(store.read()).toBe(store.read());
  });

  it("is a no-op before any directory exists", () => {
    const store = new VaultDirectoryStore();
    store.upsertIndex(ADDRESS, { name: "Alpha", isClosed: false });
    expect(store.read()).toBeNull();
  });
});
