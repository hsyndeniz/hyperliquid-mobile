/**
 * The cache that keeps a tab switch from spending weight.
 *
 * Every case here is one of the two ways this can do real damage: serve one
 * account's data to another, or hold on to something it should have re-asked
 * for. Speed is not the risk; staleness and leakage are.
 */

import {
  PRICE_CACHE_TTL_MS,
  REST_CACHE_TTL_MS,
  RestCache,
  readThrough,
  restCache,
  restCacheKey,
} from "@/hyperliquid/api/restCache";

const A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("restCacheKey", () => {
  it("includes the user, so one account cannot read another's", () => {
    expect(restCacheKey("ledger", A)).not.toBe(restCacheKey("ledger", B));
  });

  it("is case-insensitive on the address", () => {
    // The wire is lowercase; a caller may hold a checksummed address. Keying on
    // the raw string would miss the cache AND store two copies of one account.
    expect(restCacheKey("ledger", A)).toBe(restCacheKey("ledger", A.toLowerCase()));
  });

  it("separates two reads for the same user", () => {
    expect(restCacheKey("ledger", A)).not.toBe(restCacheKey("historicalOrders", A));
  });
});

describe("RestCache", () => {
  let cache: RestCache;

  beforeEach(() => {
    cache = new RestCache();
  });

  it("returns a value written inside the TTL", () => {
    cache.write("k", [1, 2], 1_000);
    expect(cache.read("k", 1_500, 60_000)).toEqual([1, 2]);
  });

  it("expires exactly AT the TTL, not after it", () => {
    cache.write("k", "v", 1_000);
    expect(cache.read("k", 1_000 + 59_999, 60_000)).toBe("v");
    expect(cache.read("k", 1_000 + 60_000, 60_000)).toBeUndefined();
  });

  it("drops an expired entry rather than leaving it to accumulate", () => {
    cache.write("k", "v", 0);
    expect(cache.size()).toBe(1);
    cache.read("k", 999_999, 60_000);
    // A long session across several accounts would otherwise grow unbounded.
    expect(cache.size()).toBe(0);
  });

  it("returns undefined for a key never written", () => {
    expect(cache.read("nope", 0, 60_000)).toBeUndefined();
  });

  it("distinguishes a cached `null` from a miss", () => {
    // `undefined` means "not cached". A caller storing a legitimate null must
    // still get a hit, or it re-fetches forever.
    cache.write("k", null, 0);
    expect(cache.read("k", 1, 60_000)).toBeNull();
  });

  it("forgets everything on a bare invalidate", () => {
    cache.write("a", 1, 0);
    cache.write("b", 2, 0);
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });

  it("forgets one account's entries by address suffix on sign-out", () => {
    cache.write(restCacheKey("ledger", A), "A's transfers", 0);
    cache.write(restCacheKey("historicalOrders", A), "A's orders", 0);
    cache.write(restCacheKey("ledger", B), "B's transfers", 0);

    cache.invalidate(A.toLowerCase());

    expect(cache.read(restCacheKey("ledger", A), 1, 60_000)).toBeUndefined();
    expect(cache.read(restCacheKey("historicalOrders", A), 1, 60_000)).toBeUndefined();
    // B is signed in and untouched.
    expect(cache.read(restCacheKey("ledger", B), 1, 60_000)).toBe("B's transfers");
  });
});

describe("readThrough", () => {
  beforeEach(() => restCache.invalidate());

  it("calls the fetcher once, then serves the cache", async () => {
    const fetch = jest.fn().mockResolvedValue(["row"]);

    const first = await readThrough({ key: "k", ttlMs: 60_000, now: 0, fetch });
    const second = await readThrough({ key: "k", ttlMs: 60_000, now: 1_000, fetch });

    expect(first).toEqual({ value: ["row"], cached: false });
    expect(second).toEqual({ value: ["row"], cached: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a deferral", async () => {
    // `null` is the weight budget declining. Caching it would turn one deferred
    // call into a full minute of them — the opposite of the point.
    const fetch = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(["row"]);

    const first = await readThrough({ key: "k", ttlMs: 60_000, now: 0, fetch });
    const second = await readThrough({ key: "k", ttlMs: 60_000, now: 1, fetch });

    expect(first.value).toBeNull();
    expect(second.value).toEqual(["row"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when ttlMs is 0, which is how refresh() bypasses it", async () => {
    const fetch = jest.fn().mockResolvedValue(["fresh"]);
    await readThrough({ key: "k", ttlMs: 60_000, now: 0, fetch });

    // "I just made a transfer and want to see it" must reach the exchange.
    const forced = await readThrough({ key: "k", ttlMs: 0, now: 1, fetch });

    expect(forced.cached).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never serves one account's read for another", async () => {
    const fetchA = jest.fn().mockResolvedValue("A's data");
    const fetchB = jest.fn().mockResolvedValue("B's data");

    await readThrough({ key: restCacheKey("ledger", A), ttlMs: 60_000, now: 0, fetch: fetchA });
    const b = await readThrough({
      key: restCacheKey("ledger", B),
      ttlMs: 60_000,
      now: 1,
      fetch: fetchB,
    });

    expect(b.value).toBe("B's data");
    expect(fetchB).toHaveBeenCalledTimes(1);
  });
});

describe("TTL choices", () => {
  it("gives prices a shorter life than history", () => {
    // History changes only when the user acts and has a live websocket
    // counterpart; a price moves continuously.
    expect(PRICE_CACHE_TTL_MS).toBeLessThan(REST_CACHE_TTL_MS);
  });
});

describe("onInvalidate", () => {
  it("tells every reader of a key when it is dropped", () => {
    // The bug: a shared cache with per-reader copies. A vault screen mounts
    // three readers of one equity; refreshing the one that submitted left the
    // other two rendering pre-transfer numbers, and quoting from them.
    const cache = new RestCache();
    const woken: string[] = [];
    cache.write("userVaultEquities:0xa", 1, 0);
    cache.onInvalidate("userVaultEquities:0xa", () => woken.push("row"));
    cache.onInvalidate("userVaultEquities:0xa", () => woken.push("sheet"));
    cache.onInvalidate("delegatorSummary:0xa", () => woken.push("unrelated"));

    cache.invalidate("userVaultEquities");

    expect(woken).toEqual(["row", "sheet"]);
  });

  it("stays silent on a clear-all, which is sign-out", () => {
    // "Forget everything" must not mean "everyone refetch" — that would spend
    // weight re-asking for the departing account's data.
    const cache = new RestCache();
    const woken: string[] = [];
    cache.onInvalidate("userVaultEquities:0xa", () => woken.push("row"));
    cache.invalidate();
    expect(woken).toEqual([]);
  });

  it("unsubscribes", () => {
    const cache = new RestCache();
    const woken: string[] = [];
    const off = cache.onInvalidate("k", () => woken.push("x"));
    off();
    cache.invalidate("k");
    expect(woken).toEqual([]);
  });

  it("keeps telling the others when one reader throws", () => {
    const cache = new RestCache();
    const woken: string[] = [];
    cache.onInvalidate("k", () => {
      throw new Error("bad reader");
    });
    cache.onInvalidate("k", () => woken.push("survivor"));
    expect(() => cache.invalidate("k")).not.toThrow();
    expect(woken).toEqual(["survivor"]);
  });
});
