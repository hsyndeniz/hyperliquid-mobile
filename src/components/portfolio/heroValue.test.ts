/**
 * The two ways a dim-cents hero lies.
 *
 * The carry: `"1.999"` is $2.00, and a split that rounds the halves separately
 * renders it as `$1` + `.100` — a figure that is wrong in the bright half, the
 * one the eye actually reads.
 *
 * The symbol: a hard-coded `"$"` is right in en-US and wrong everywhere else,
 * and in fr-FR it is on the wrong END of the number. Both are pinned by name so
 * a future "just prepend a dollar sign" regression fails loudly.
 */

import { currencyAffixes, heroFigure, splitEquity } from "@/components/portfolio/heroValue";

describe("splitEquity", () => {
  it("carries out of the cents instead of splitting first", () => {
    // The whole reason this module exists: "1" + "100" is the naive answer.
    expect(splitEquity("1.999")).toEqual({ whole: "2", cents: "00" });
  });

  it("rounds cents without touching the units when there is no carry", () => {
    expect(splitEquity("1.994")).toEqual({ whole: "1", cents: "99" });
  });

  it("leaves the units ungrouped — grouping belongs to the locale", () => {
    expect(splitEquity("1234567.891")).toEqual({ whole: "1234567", cents: "89" });
  });

  it("pads a whole balance to two cent digits", () => {
    expect(splitEquity("42")).toEqual({ whole: "42", cents: "00" });
  });

  it("is null for a non-finite wire — a failed read is not a zero balance", () => {
    expect(splitEquity("abc")).toBeNull();
    expect(splitEquity("")).toBeNull();
    expect(splitEquity("Infinity")).toBeNull();
  });

  it("drops the sign when the rounded figure is zero", () => {
    // "-0.00" would render as "-$0.00", a debt of nothing.
    expect(splitEquity("-0.004")).toEqual({ whole: "0", cents: "00" });
  });

  it("keeps the sign on a genuinely negative sub-unit balance", () => {
    expect(splitEquity("-0.5")).toEqual({ whole: "-0", cents: "50" });
  });
});

describe("currencyAffixes", () => {
  it("reads the symbol as a prefix in en-US", () => {
    const affixes = currencyAffixes("en-US", "USD");
    expect(affixes).not.toBeNull();
    expect(affixes?.prefix).toBe("$");
    expect(affixes?.suffix).toBe("");
    expect(affixes?.decimal).toBe(".");
  });

  it("reads the symbol as a SUFFIX in fr-FR, where a hard-coded '$' would be doubly wrong", () => {
    const affixes = currencyAffixes("fr-FR", "EUR");
    expect(affixes).not.toBeNull();
    expect(affixes?.prefix).toBe("");
    // The literal between number and symbol is a non-breaking space, so the
    // assertion is on the symbol's presence and side, not on the exact spacing.
    expect(affixes?.suffix.endsWith("€")).toBe(true);
    expect(affixes?.decimal).toBe(",");
  });

  it("is null for a currency with no minor unit — JPY has no cents to dim", () => {
    expect(currencyAffixes("ja-JP", "JPY")).toBeNull();
  });
});

describe("heroFigure", () => {
  it("groups the bright half and dims only the cents", () => {
    expect(heroFigure("1234567.891", { locale: "en-US" })).toEqual({
      major: "$1,234,567",
      minor: ".89",
    });
  });

  it("shows the carried figure, never '$1' over '.100'", () => {
    expect(heroFigure("1.999", { locale: "en-US" })).toEqual({ major: "$2", minor: ".00" });
  });

  it("puts a fr-FR symbol in the DIM half, where that locale prints it", () => {
    const figure = heroFigure("1234.5", { locale: "fr-FR", currency: "EUR" });
    expect(figure).not.toBeNull();
    expect(figure?.major).not.toContain("€");
    expect(figure?.minor.startsWith(",50")).toBe(true);
    expect(figure?.minor.endsWith("€")).toBe(true);
  });

  it("groups by the locale's own rule, not by threes", () => {
    // hi-IN lakh grouping: 1,23,45,678 — no fixed interval produces it.
    expect(heroFigure("12345678.5", { locale: "hi-IN", currency: "INR" })?.major).toBe(
      "₹1,23,45,678"
    );
  });

  it("renders one undivided figure when the currency has no minor unit", () => {
    const figure = heroFigure("1234.5", { locale: "ja-JP", currency: "JPY" });
    expect(figure?.minor).toBe("");
    expect(figure?.major).toContain("1,235");
  });

  it("leads a negative with the sign, ahead of the symbol", () => {
    expect(heroFigure("-1234.5", { locale: "en-US" })).toEqual({
      major: "-$1,234",
      minor: ".50",
    });
  });

  it("is null for a non-finite wire, so the caller can render a Skeleton", () => {
    expect(heroFigure("--", { locale: "en-US" })).toBeNull();
  });
});
