import { clearHlStorage, hlStorage, hlStringStorage } from "@/hyperliquid/storage/mmkv";

describe("hlStringStorage", () => {
  beforeEach(() => {
    clearHlStorage();
  });

  it("round-trips a value", () => {
    hlStringStorage.setItem("k", "v");
    expect(hlStringStorage.getItem("k")).toBe("v");
  });

  it("returns null for a missing key, as the Web Storage contract requires", () => {
    // jotai's createJSONStorage distinguishes null (absent) from a stored value;
    // MMKV returns undefined, so the adapter must translate.
    expect(hlStringStorage.getItem("nope")).toBeNull();
  });

  it("removes a value", () => {
    hlStringStorage.setItem("k", "v");
    hlStringStorage.removeItem("k");
    expect(hlStringStorage.getItem("k")).toBeNull();
  });

  it("is synchronous — the reason jotai atoms stay synchronous", () => {
    hlStringStorage.setItem("k", "v");
    const value = hlStringStorage.getItem("k");
    expect(value).not.toBeInstanceOf(Promise);
    expect(value).toBe("v");
  });

  it("round-trips JSON payloads without mangling them", () => {
    const payload = JSON.stringify({ coin: "BTC", size: "0.001" });
    hlStringStorage.setItem("order", payload);
    expect(JSON.parse(hlStringStorage.getItem("order")!)).toEqual({
      coin: "BTC",
      size: "0.001",
    });
  });
});

describe("clearHlStorage", () => {
  it("wipes the Hyperliquid instance", () => {
    hlStringStorage.setItem("a", "1");
    hlStringStorage.setItem("b", "2");
    clearHlStorage();
    expect(hlStringStorage.getItem("a")).toBeNull();
    expect(hlStringStorage.getItem("b")).toBeNull();
  });
});

describe("hlStorage", () => {
  beforeEach(() => {
    clearHlStorage();
  });

  it("exposes the underlying instance for key enumeration", () => {
    hlStringStorage.setItem("hl:one", "1");
    hlStringStorage.setItem("hl:two", "2");
    expect(hlStorage().getAllKeys().sort()).toEqual(["hl:one", "hl:two"]);
  });

  it("returns the same instance across calls", () => {
    expect(hlStorage()).toBe(hlStorage());
  });
});
