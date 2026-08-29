import { createStore } from "jotai";

import { clearHlStorage, hlStringStorage } from "@/hyperliquid/storage/mmkv";
import { hlKey, persistedAtom } from "@/hyperliquid/storage/jotaiStorage";

/**
 * Proves the jotai <-> MMKV bridge actually works. Phase 4 defines the store's
 * shape; this pins the mechanism it will sit on.
 */
describe("persistedAtom", () => {
  beforeEach(() => {
    clearHlStorage();
  });

  it("round-trips a value through MMKV", () => {
    const atom = persistedAtom(hlKey("tick"), 1);
    const store = createStore();
    store.set(atom, 42);
    expect(JSON.parse(hlStringStorage.getItem("hl:tick")!)).toBe(42);
  });

  it("rehydrates a stored value at init rather than flashing the default", () => {
    // getOnInit: true — the default would render initialValue first and swap
    // afterwards, which is a visible flash and a hazard for gating UI.
    hlStringStorage.setItem("hl:pref", JSON.stringify("stored"));
    const store = createStore();
    expect(store.get(persistedAtom(hlKey("pref"), "default"))).toBe("stored");
  });

  it("falls back to the initial value when nothing is stored", () => {
    expect(createStore().get(persistedAtom(hlKey("absent"), "default"))).toBe("default");
  });

  it("stays synchronous — the reason atoms are not promises", () => {
    const value = createStore().get(persistedAtom(hlKey("sync"), 0));
    expect(value).not.toBeInstanceOf(Promise);
  });

  it("rejects a schema-drifted value via the validator, so bad state cannot go live", () => {
    hlStringStorage.setItem("hl:validated", JSON.stringify({ unexpected: true }));
    const isNumber = (v: unknown): v is number => typeof v === "number";
    const atom = persistedAtom(hlKey("validated"), 7, { validate: isNumber });
    expect(createStore().get(atom)).toBe(7);
  });

  it("namespaces keys so a Hyperliquid wipe is a prefix scan", () => {
    expect(hlKey("orders", "pending")).toBe("hl:orders:pending");
  });
});
