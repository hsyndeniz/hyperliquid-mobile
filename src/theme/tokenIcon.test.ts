/**
 * The wire coin is not a ticker, and getting that wrong shows the wrong logo
 * next to someone's position. Each case below is a real Hyperliquid wire form.
 */

import { tickerOf, tokenIconSvg, tokenMonogram } from "@/theme/tokenIcon";

describe("reading a ticker out of a wire coin", () => {
  it("passes a plain perp through", () => {
    expect(tickerOf("BTC")).toBe("BTC");
  });

  it("strips a builder-dex prefix, which names the VENUE not the asset", () => {
    // `xyz:BTC` is BTC on a HIP-3 dex. Keying artwork on `xyz` would show the
    // wrong logo — or none — on every builder-dex market.
    expect(tickerOf("xyz:BTC")).toBe("BTC");
  });

  it("refuses a spot pair id, which is an index and can never have artwork", () => {
    expect(tickerOf("@107")).toBeNull();
  });

  it("refuses outcome markets in all three of their wire spellings", () => {
    // `#N` book, `+N` balance row, `oN` settled — none is a token.
    expect(tickerOf("#12")).toBeNull();
    expect(tickerOf("+9930")).toBeNull();
    expect(tickerOf("o5")).toBeNull();
  });
});

describe("resolving artwork", () => {
  it("finds a major directly", () => {
    expect(tokenIconSvg("BTC")).toContain("<svg");
  });

  it("finds it through a builder-dex prefix", () => {
    expect(tokenIconSvg("xyz:BTC")).toBe(tokenIconSvg("BTC"));
  });

  it("resolves a k-prefixed 1000x market to its underlying asset", () => {
    // kPEPE is PEPE priced in thousands — the same asset, so the same logo.
    // Without this, three live mainnet markets render a fallback for no reason.
    expect(tokenIconSvg("kPEPE")).toBe(tokenIconSvg("PEPE"));
  });

  it("returns null rather than guessing when there is no artwork", () => {
    // WLD is genuinely absent from the icon set under every spelling; 109 of
    // 232 mainnet perps are. A fallback is correct here — a wrong logo is not.
    expect(tokenIconSvg("WLD")).toBeNull();
    expect(tokenIconSvg("@107")).toBeNull();
  });
});

describe("the fallback monogram, which about half of all rows will use", () => {
  it("names the ASSET, not the venue, for a builder-dex market", () => {
    expect(tokenMonogram("xyz:BTC")).toBe("BT");
  });

  it("keeps a pair id legible instead of rendering the marker", () => {
    expect(tokenMonogram("@107")).toBe("107");
  });

  it("never returns empty, whatever the wire sends", () => {
    expect(tokenMonogram("@").length).toBeGreaterThan(0);
    expect(tokenMonogram("").length).toBeGreaterThan(0);
  });
});
