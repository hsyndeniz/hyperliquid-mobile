/**
 * The window rule in the vault activity cache key.
 *
 * Not a formatting test: this decides whether a UI control respends the
 * family's request weight. `readActivity` time-bounds `trades`, `funding` and
 * `ledger` only — every other feed calls its probe with no `startTime` — but
 * the window sat in the key for all of them, so toggling it on Open Orders
 * invalidated a perfectly good cache and refetched identical rows at
 * `ACTIVITY_WEIGHT.openOrders` 40 x 8 members = 320 weight. Three taps is 960
 * of the 1000 a minute the app actually enforces.
 */

import { activityCacheKey, WINDOWED_KINDS } from "@/hyperliquid/hooks/vaults";

const OPTS = { windowMs: 24 * 60 * 60 * 1000, aggregate: false, twapView: "active" };
const VAULT = "0xa150000000000000000000000000000000000b0a";

describe("activityCacheKey", () => {
  it("ignores the window for a feed that has no time bound", () => {
    const day = activityCacheKey("testnet", VAULT, "openOrders", OPTS);
    const week = activityCacheKey("testnet", VAULT, "openOrders", {
      ...OPTS,
      windowMs: 7 * 24 * 3600_000,
    });
    expect(day).toBe(week);
  });

  it("keeps the window for a feed that IS time-bounded", () => {
    // The opposite error would be worse: reusing a 24h answer for a 30d request
    // shows the wrong span with no sign of it.
    const day = activityCacheKey("testnet", VAULT, "trades", OPTS);
    const week = activityCacheKey("testnet", VAULT, "trades", {
      ...OPTS,
      windowMs: 7 * 24 * 3600_000,
    });
    expect(day).not.toBe(week);
  });

  it("bounds exactly the three feeds readActivity passes `since` to", () => {
    expect([...WINDOWED_KINDS].sort()).toEqual(["funding", "ledger", "trades"]);
  });

  it("still separates env, vault, kind and aggregation", () => {
    const base = activityCacheKey("testnet", VAULT, "trades", OPTS);
    expect(activityCacheKey("mainnet", VAULT, "trades", OPTS)).not.toBe(base);
    expect(activityCacheKey("testnet", "0xdead", "trades", OPTS)).not.toBe(base);
    expect(activityCacheKey("testnet", VAULT, "funding", OPTS)).not.toBe(base);
    expect(activityCacheKey("testnet", VAULT, "trades", { ...OPTS, aggregate: true })).not.toBe(
      base
    );
  });
});
