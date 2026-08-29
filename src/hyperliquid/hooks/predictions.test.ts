/**
 * Decoding a `+N` balance coin back to the market it names.
 *
 * Getting this wrong labels one bet with another market's question, which is
 * worse than showing the raw encoding — the user cannot tell it is wrong.
 *
 * Fixture is real testnet data: outcome 10225 is *"June Fed rate change"* with
 * sides `["Change", "No Change"]`, and the account under test holds `+102251`.
 */

import { namedOutcomeFor } from "@/hyperliquid/hooks/predictions";
import type { PredictionOutcome } from "@/hyperliquid/predictions/types";

function outcome(outcomeId: number, name: string, sideNames: string[]): PredictionOutcome {
  return {
    outcomeId,
    name,
    description: "",
    attributes: null,
    quoteToken: "USDC",
    venue: null,
    sides: sideNames.map((sideName, sideIndex) => ({
      sideIndex,
      name: sideName,
      assetId: 100_000_000 + outcomeId * 10 + sideIndex,
      wireCoin: `#${outcomeId * 10 + sideIndex}`,
      balanceCoin: `+${outcomeId * 10 + sideIndex}`,
    })),
  };
}

const CATALOG = {
  outcomes: [
    outcome(10225, "June Fed rate change", ["Change", "No Change"]),
    outcome(1022, "A market whose id is a PREFIX of the one above", ["Yes", "No"]),
  ],
};

describe("namedOutcomeFor", () => {
  it("splits the low digit off as the side index", () => {
    // `102251` is outcome 10225 side 1 — NOT outcome 102251, and not outcome
    // 1022 side 51. The off-by-one-digit reading is the failure this guards.
    expect(namedOutcomeFor("+102251", CATALOG)).toEqual({
      outcome: CATALOG.outcomes[0],
      sideName: "No Change",
    });
  });

  it("distinguishes the two sides of one market", () => {
    expect(namedOutcomeFor("+102250", CATALOG)?.sideName).toBe("Change");
    expect(namedOutcomeFor("+102251", CATALOG)?.sideName).toBe("No Change");
  });

  it("does not confuse a market whose id is a prefix of another's", () => {
    // `+10220` is outcome 1022 side 0. A string-prefix match would hand back
    // outcome 10225 and label the holding with the wrong question entirely.
    expect(namedOutcomeFor("+10220", CATALOG)?.outcome.outcomeId).toBe(1022);
  });

  it("returns null for an outcome the catalog does not list", () => {
    // A SETTLED outcome is deleted from `outcomeMeta` — documented, not an
    // error — so this is a live state, and the caller must render the encoding.
    expect(namedOutcomeFor("+99990", CATALOG)).toBeNull();
  });

  it("returns a null sideName rather than dropping a known market", () => {
    // Side 7 of a two-sided market: the encoding permits ten. The market is
    // still identified; only the side is unknown.
    const named = namedOutcomeFor("+102257", CATALOG);
    expect(named?.outcome.outcomeId).toBe(10225);
    expect(named?.sideName).toBeNull();
  });

  it("accepts both live spellings of the same market side", () => {
    // `+102251` on a spot balance, `#102251` on a fill/order/book. Identical
    // encoding, different sigil — measured live: the outcome fill on this
    // project's own test account arrives as `#102251` while the holding it
    // created is `+102251`.
    expect(namedOutcomeFor("#102251", CATALOG)).toEqual(namedOutcomeFor("+102251", CATALOG));
  });

  it("refuses the `oN` spelling, whose N is a DIFFERENT number", () => {
    // On a settled share `N` is the outcome id itself, not
    // `outcomeId * 10 + sideIndex`. Decoding `o10225` the same way would
    // resolve to outcome 1022 side 5 — a real market, and the wrong one.
    expect(namedOutcomeFor("o10225", CATALOG)).toBeNull();
  });

  it("returns null for coins that are not outcome markets at all", () => {
    for (const coin of ["USDC", "HYPE", "@107", "+", "+abc", "#", "#abc"]) {
      expect(namedOutcomeFor(coin, CATALOG)).toBeNull();
    }
  });

  it("returns null while the catalog is still loading", () => {
    expect(namedOutcomeFor("+102251", null)).toBeNull();
  });
});
