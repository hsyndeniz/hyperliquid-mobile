/**
 * The filter taxonomy.
 *
 * `marketKindOf` carries the weight here. It is the one filter that cannot be
 * derived by reading row labels — the venue is encoded in the coin string —
 * and getting it wrong files a holding under a venue it can never appear on.
 */

import {
  marketKindOf,
  marketOptions,
  matchesFilters,
  roleOf,
  searchMarkets,
  type FilterOption,
} from "@/components/vaults/feedFilters";

describe("marketKindOf", () => {
  it("reads the spot index form", () => {
    expect(marketKindOf("@107")).toBe("spot");
    expect(marketKindOf("@0")).toBe("spot");
  });

  it("reads the one named spot pair", () => {
    // PURR/USDC predates the index form and is still spelled out.
    expect(marketKindOf("PURR/USDC")).toBe("spot");
  });

  it("files prediction outcomes as SPOT, in all three wire spellings", () => {
    // An outcome holding lives in `spotClearinghouseState.balances` and never
    // in `assetPositions`; calling it a perp files it under the one place it
    // can never appear.
    expect(marketKindOf("#7")).toBe("spot"); // book / candles / trades
    expect(marketKindOf("+7")).toBe("spot"); // balance row
    expect(marketKindOf("o7")).toBe("spot"); // settled shares
  });

  it("keeps a builder-dex market as a PERP despite the prefix", () => {
    // The colon names the dex, not a different venue.
    expect(marketKindOf("xyz:BTC")).toBe("perp");
  });

  it("treats an ordinary ticker as a perp", () => {
    expect(marketKindOf("BTC")).toBe("perp");
    expect(marketKindOf("kSHIB")).toBe("perp");
    // A ticker that merely CONTAINS a digit is not an outcome id.
    expect(marketKindOf("0G")).toBe("perp");
    expect(marketKindOf("2Z")).toBe("perp");
  });

  it("does not mistake a leading 'o' ticker for an outcome", () => {
    // `oN` is an outcome only when the rest is all digits.
    expect(marketKindOf("OP")).toBe("perp");
    expect(marketKindOf("ondo")).toBe("perp");
  });
});

describe("marketOptions", () => {
  it("dedupes, sorts, and always leads with All", () => {
    expect(marketOptions(["SOL", "BTC", "SOL", "ADA"]).map((o) => o.id)).toEqual([
      "all",
      "ADA",
      "BTC",
      "SOL",
    ]);
  });

  it("offers only All when there is nothing on screen", () => {
    expect(marketOptions([]).map((o) => o.id)).toEqual(["all"]);
  });
});

describe("searchMarkets", () => {
  const options: readonly FilterOption[] = [
    { id: "all", label: "All" },
    { id: "BTC", label: "BTC" },
    { id: "ETH", label: "ETH" },
    { id: "kSHIB", label: "kSHIB" },
  ];

  it("matches case-insensitively on a substring", () => {
    expect(searchMarkets(options, "sh").map((o) => o.id)).toEqual(["all", "kSHIB"]);
    expect(searchMarkets(options, "BT").map((o) => o.id)).toEqual(["all", "BTC"]);
  });

  it("keeps All so the menu can never strand the reader", () => {
    // Without this a no-match search leaves an empty menu and no way back.
    expect(searchMarkets(options, "zzzz").map((o) => o.id)).toEqual(["all"]);
  });

  it("returns everything for an empty query", () => {
    expect(searchMarkets(options, "   ")).toHaveLength(4);
  });
});

describe("matchesFilters", () => {
  const perpLong = { coin: "BTC", sideId: "long" as const, isActive: true };
  const spotBuy = { coin: "@107", sideId: "buy" as const, isActive: true };
  const balance = { coin: null, sideId: null, isActive: false };

  it("passes everything when nothing is selected", () => {
    expect(matchesFilters(perpLong, {})).toBe(true);
    expect(matchesFilters(balance, {})).toBe(true);
  });

  it("filters by side", () => {
    expect(matchesFilters(perpLong, { side: "long" })).toBe(true);
    expect(matchesFilters(perpLong, { side: "short" })).toBe(false);
    expect(matchesFilters(spotBuy, { side: "buy" })).toBe(true);
  });

  it("filters by venue, reading the coin's encoding", () => {
    expect(matchesFilters(perpLong, { type: "perp" })).toBe(true);
    expect(matchesFilters(perpLong, { type: "spot" })).toBe(false);
    expect(matchesFilters(spotBuy, { type: "spot" })).toBe(true);
  });

  it("filters by market", () => {
    expect(matchesFilters(perpLong, { market: "BTC" })).toBe(true);
    expect(matchesFilters(perpLong, { market: "ETH" })).toBe(false);
  });

  it("filters balances by Active", () => {
    expect(matchesFilters(balance, { asset: "active" })).toBe(false);
    expect(matchesFilters({ ...balance, isActive: true }, { asset: "active" })).toBe(true);
  });

  it("never lets a filter a row cannot answer empty the list", () => {
    // A Side selection must not wipe the Balances tab; a balance has no side,
    // and `all` is what a tab without that control always sends.
    expect(matchesFilters(balance, { side: "all", type: "all", market: "all" })).toBe(true);
  });

  it("combines filters as AND", () => {
    expect(matchesFilters(perpLong, { side: "long", type: "perp", market: "BTC" })).toBe(true);
    expect(matchesFilters(perpLong, { side: "long", type: "spot", market: "BTC" })).toBe(false);
  });
});

describe("roleOf", () => {
  it("reads a crossed fill as the TAKER", () => {
    // Crossing the spread takes liquidity; there is no `role` on the wire.
    expect(roleOf(true)).toBe("taker");
    expect(roleOf(false)).toBe("maker");
  });
});

describe("matchesFilters — role", () => {
  const taker = { coin: "BTC", sideId: null, isActive: true, roleId: "taker" as const };
  const maker = { coin: "BTC", sideId: null, isActive: true, roleId: "maker" as const };

  it("filters by role", () => {
    expect(matchesFilters(taker, { role: "taker" })).toBe(true);
    expect(matchesFilters(taker, { role: "maker" })).toBe(false);
    expect(matchesFilters(maker, { role: "maker" })).toBe(true);
  });

  it("hides a row with no role once a role is demanded", () => {
    // A funding row has no maker/taker; asking for takers must not sweep it in.
    expect(matchesFilters({ coin: "BTC", sideId: null, isActive: true }, { role: "taker" })).toBe(
      false
    );
  });

  it("leaves roleless rows alone when the filter is All", () => {
    expect(matchesFilters({ coin: "BTC", sideId: null, isActive: true }, { role: "all" })).toBe(
      true
    );
  });
});
