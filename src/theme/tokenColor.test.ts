/**
 * The brand-colour extractor.
 *
 * Every case here is a real failure mode of the naive version — take the first
 * saturated fill — measured against the icons this app actually ships.
 */

import {
  brandColorOfSvg,
  hexToHsl,
  hslToHex,
  normalizeHex,
  readableTextColor,
  tokenColor,
  withAlpha,
} from "@/theme/tokenColor";

const bleed = (hex: string): string => `<svg><path fill="${hex}" d="M24 0H0v24h24z"/></svg>`;

describe("normalizeHex", () => {
  it("expands shorthand, since icons mix `#fff` and `#ffffff`", () => {
    expect(normalizeHex("#fff")).toBe("#ffffff");
    expect(normalizeHex("#F7931A")).toBe("#f7931a");
  });

  it("drops an alpha channel rather than reading it as colour", () => {
    expect(normalizeHex("#f7931aff")).toBe("#f7931a");
  });

  it("rejects a length no SVG uses", () => {
    expect(normalizeHex("#12345")).toBeNull();
  });
});

describe("hsl round trip", () => {
  it.each(["#f7931a", "#246dd3", "#2e3bff", "#7aeead"])("survives %s", (hex) => {
    expect(hslToHex(hexToHsl(hex))).toBe(hex);
  });

  it("keeps a grey grey", () => {
    expect(hexToHsl("#808080").s).toBe(0);
  });
});

describe("brandColorOfSvg", () => {
  it("takes the full-bleed background square — it IS the brand colour", () => {
    // BTC's real icon. Orange is already legible, so it passes through with
    // only the band applied.
    const color = brandColorOfSvg(bleed("#F7931A"));
    expect(color).not.toBeNull();
    expect(hexToHsl(color!).h).toBeCloseTo(hexToHsl("#f7931a").h, 0);
  });

  it("REJECTS a black background square and scores the mark instead", () => {
    // `algo` ships `#000` full-bleed. Taking it would paint a black chip and a
    // black sparkline that vanish on a dark card.
    const svg = `<svg><path fill="#000" d="M24 0H0v24h24z"/><path fill="#2e7d32"/></svg>`;
    const color = brandColorOfSvg(svg);
    expect(color).not.toBeNull();
    expect(hexToHsl(color!).s).toBeGreaterThan(0.2);
  });

  it("REJECTS a white background square too", () => {
    // `air` ships `#fff`. Same failure, opposite end.
    const svg = `<svg><path fill="#fff" d="M24 0H0v24h24z"/><path fill="#c62828"/></svg>`;
    expect(brandColorOfSvg(svg)).not.toBe("#ffffff");
  });

  it("prefers a vivid mid-tone over a pale facet", () => {
    // ETH's icon carries a near-white facet. Taking the first saturated fill
    // picked it, and the tint washed out on a light card.
    const svg = `<svg><path fill="#ecf0f1"/><path fill="#627eea"/></svg>`;
    const color = brandColorOfSvg(svg);
    expect(hexToHsl(color!).h).toBeCloseTo(hexToHsl("#627eea").h, 0);
  });

  it("is null for a monochrome icon rather than inventing a colour", () => {
    expect(brandColorOfSvg(`<svg><path fill="#000"/><path fill="#fff"/></svg>`)).toBeNull();
  });

  describe("the legibility band", () => {
    it("lifts a colour too dark to see on a dark card", () => {
      const color = brandColorOfSvg(`<svg><path fill="#04122b"/></svg>`);
      if (color !== null) expect(hexToHsl(color).l).toBeGreaterThanOrEqual(0.3);
    });

    it("caps a colour too pale to see on a light card", () => {
      const color = brandColorOfSvg(`<svg><path fill="#bfe0ff"/></svg>`);
      if (color !== null) expect(hexToHsl(color).l).toBeLessThanOrEqual(0.63);
    });
  });
});

describe("tokenColor", () => {
  it("resolves a real listed market", () => {
    expect(tokenColor("BTC")).not.toBeNull();
  });

  it("resolves the k-prefixed unit as the same asset", () => {
    // `kPEPE` is 1,000 PEPE — the same token, so the same colour.
    expect(tokenColor("kPEPE")).toBe(tokenColor("PEPE"));
  });

  it("is null where no artwork can exist", () => {
    // A spot pair id and an outcome share are indices, not names.
    expect(tokenColor("@107")).toBeNull();
    expect(tokenColor("#12")).toBeNull();
  });

  it("is stable across calls, since rows re-read it every tick", () => {
    expect(tokenColor("BTC")).toBe(tokenColor("BTC"));
  });
});

describe("readableTextColor", () => {
  it("puts black on a bright brand and white on a dark one", () => {
    expect(readableTextColor("#f7931a")).toBe("#000000");
    expect(readableTextColor("#246dd3")).toBe("#ffffff");
  });

  it("weights green over blue, as perception does", () => {
    // Identical channel VALUES, opposite answers: green carries ~5x the
    // perceived brightness of blue, so the same numbers read light or dark
    // depending only on which channel is dominant. A naive average would give
    // both the same text colour and put white on a green that needs black.
    expect(readableTextColor("#66cc66")).toBe("#000000");
    expect(readableTextColor("#6666cc")).toBe("#ffffff");
  });
});

describe("withAlpha", () => {
  it("renders the rgba() a gradient stop needs", () => {
    expect(withAlpha("#f7931a", 0.2)).toBe("rgba(247, 147, 26, 0.2)");
  });
});
