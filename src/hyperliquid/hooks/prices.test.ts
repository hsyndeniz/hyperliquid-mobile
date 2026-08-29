/**
 * The price join, and the two places it must return `null` instead of a number.
 *
 * Every case here is a way a portfolio can quietly show the wrong money: a
 * balance matched against the wrong market's mid, a `$0.00` where "no quote"
 * belongs, or a PnL invented against a cost basis that does not exist.
 */

import { joinSpotPrices, pnlOf, valueOf } from "@/hyperliquid/hooks/prices";

/** Shaped like the live payload: `universe` names PAIRS, `tokens` names TOKENS. */
const SPOT_META = {
  tokens: [
    { name: "USDC", index: 0 },
    { name: "PURR", index: 1 },
    { name: "HYPE", index: 150 },
  ],
  universe: [
    { name: "PURR/USDC", tokens: [1, 0] },
    { name: "@107", tokens: [150, 0] },
  ],
};

describe("joinSpotPrices", () => {
  it("keys the mid by the BASE TOKEN name, not by the pair id it arrives under", () => {
    // The whole point: `allMids` says `@107`, the balance row says `HYPE`. A
    // client that skips the universe join prices every spot token at nothing.
    const prices = joinSpotPrices(SPOT_META, { "@107": "32.6275", "PURR/USDC": "4.60235" });

    expect(prices.get("HYPE")).toBe("32.6275");
    expect(prices.get("PURR")).toBe("4.60235");
    expect(prices.has("@107")).toBe(false);
  });

  it("takes the BASE side of a pair, never the quote", () => {
    // `tokens` is [base, quote]. Reading index 1 would price every token on the
    // exchange as USDC — a plausible-looking map that is entirely wrong.
    const prices = joinSpotPrices(SPOT_META, { "@107": "32.6275" });

    expect(prices.get("HYPE")).toBe("32.6275");
    expect(prices.get("USDC")).toBeUndefined();
  });

  it("keeps the first pair when a token is quoted against several", () => {
    const meta = {
      tokens: [
        { name: "USDC", index: 0 },
        { name: "USDT", index: 2 },
        { name: "HYPE", index: 150 },
      ],
      universe: [
        { name: "@107", tokens: [150, 0] },
        { name: "@200", tokens: [150, 2] },
      ],
    };
    const prices = joinSpotPrices(meta, { "@107": "32.6275", "@200": "31.0" });

    expect(prices.get("HYPE")).toBe("32.6275");
  });

  it("skips a pair with no mid rather than storing undefined", () => {
    const prices = joinSpotPrices(SPOT_META, { "@107": "32.6275" });

    expect(prices.has("PURR")).toBe(false);
    expect(prices.size).toBe(1);
  });

  it("returns an empty map for a malformed meta instead of throwing", () => {
    expect(joinSpotPrices(null, { "@107": "1" }).size).toBe(0);
    expect(joinSpotPrices({ universe: [{ name: "@107" }] }, { "@107": "1" }).size).toBe(0);
  });
});

describe("valueOf", () => {
  it("values USDC at its own amount without consulting a price", () => {
    // USDC has no `allMids` entry at all — it is the quote asset. Without this
    // case the largest holding on most accounts renders "--".
    expect(valueOf("USDC", "8.0", new Map())).toBe("8.0");
  });

  it("multiplies amount by mid", () => {
    expect(valueOf("HYPE", "2", new Map([["HYPE", "32.6275"]]))).toBe("65.26");
  });

  it("returns null — NOT zero — for a token with no quote", () => {
    // A `0` here renders as $0.00, which reads as "this is worthless" for a
    // holding that merely has no price. `null` renders as "--".
    expect(valueOf("WIF", "100", new Map())).toBeNull();
  });
});

describe("pnlOf", () => {
  it("subtracts the cost basis from the value", () => {
    expect(pnlOf("65.26", "60.00")).toBe("5.26");
  });

  it("returns null when there is no value to compare against", () => {
    expect(pnlOf(null, "60.00")).toBeNull();
  });

  it('returns null for a "0.0" cost basis rather than claiming the whole value as profit', () => {
    // `costBasisNtl` is "0.0" for USDC and for anything never bought. Treating
    // that as an entry price reports a 100% gain on a deposit.
    expect(pnlOf("8.0", "0.0")).toBeNull();
    expect(pnlOf("8.0", "")).toBeNull();
  });
});

describe("joinSpotPrices — outcome markets", () => {
  // `allMids` quotes an outcome as `#102251`; the BALANCE row says `+102251`.
  // Looking up only the balance spelling reports "no price" for a market the
  // exchange is actively quoting — the same wire-coin trap in a third form.
  const MIDS = { "#102250": "0.49", "#102251": "0.51", "@107": "32.6275" };

  it("keys an outcome mid to the + spelling a balance uses", () => {
    const prices = joinSpotPrices(SPOT_META, MIDS);

    expect(prices.get("+102251")).toBe("0.51");
    expect(valueOf("+102251", "20.0", prices)).toBe("10.20");
  });

  it("keeps both sides of a market distinct", () => {
    // They sum to exactly 1 — measured 310 of 310 live. Collapsing them onto
    // one key would value a No-Change holding at the Change price.
    const prices = joinSpotPrices(SPOT_META, MIDS);

    expect(prices.get("+102250")).toBe("0.49");
    expect(prices.get("+102251")).toBe("0.51");
  });

  it("does not disturb the token join", () => {
    const prices = joinSpotPrices(SPOT_META, MIDS);

    expect(prices.get("HYPE")).toBe("32.6275");
  });

  it("leaves an outcome with no mid unpriced rather than at zero", () => {
    // A settled market drops out of `allMids`. "--" is right; $0.00 is not.
    const prices = joinSpotPrices(SPOT_META, MIDS);

    expect(valueOf("+999990", "20.0", prices)).toBeNull();
  });
});
