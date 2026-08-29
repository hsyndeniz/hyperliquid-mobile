/**
 * The display helpers, and the one that exists purely to stop an animation
 * running for nothing.
 */

import {
  displayNumber,
  formatWirePrice,
  quantizeToDigits,
  shortTime,
} from "@/components/common/display";

describe("quantizeToDigits", () => {
  it("collapses jitter below the rendered precision to one value", () => {
    // The actual failure: `allMids` moves a BTC mid by fractions of a cent
    // while the hero renders one decimal. Unquantised, each of these was a
    // distinct value to NumberFlow, which rebuilt 174 `Text` + 84 `StripDigit`
    // to animate a digit that did not change.
    const jitter = [79418.021, 79418.024, 79418.0, 79417.998].map((v) => quantizeToDigits(v, 1));
    expect(new Set(jitter).size).toBe(1);
    expect(jitter[0]).toBe(79418);
  });

  it("still moves when a rendered digit actually changes", () => {
    // The animation must not be optimised away — only the invisible work is.
    expect(quantizeToDigits(79418.04, 1)).not.toBe(quantizeToDigits(79418.06, 1));
  });

  it("formats identically to the unquantised value, which is why it is safe", () => {
    const format = (v: number, digits: number) =>
      v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    // The halves are the point: `Math.round` disagrees with the formatter on
    // 1.005 (1.00 vs 1.01) and 8.575 (8.57 vs 8.58), and `toFixed` disagrees on
    // more. Either would move the last digit of a price by one.
    for (const [raw, digits] of [
      [79418.0249, 1],
      [0.6244, 3],
      [50, 0],
      [1.005, 2],
      [8.575, 2],
      [2.675, 2],
      [1.045, 2],
      [0.125, 2],
    ] as const) {
      expect(format(quantizeToDigits(raw, digits), digits)).toBe(format(raw, digits));
    }
  });

  it("keeps full precision when every digit is rendered", () => {
    expect(quantizeToDigits(0.62449, 5)).toBe(0.62449);
  });

  it("handles zero digits and passes non-finite values through", () => {
    expect(quantizeToDigits(79418.6, 0)).toBe(79419);
    expect(Number.isNaN(quantizeToDigits(Number.NaN, 2))).toBe(true);
  });

  it("does not change what the plain-text branch renders", () => {
    // Both FlashPrice branches format to the same `digits`, so quantising is
    // free for the text one — the guard against this becoming a display change.
    const digits = 1;
    const value = displayNumber("79418.0249");
    expect(quantizeToDigits(value, digits).toFixed(digits)).toBe(value.toFixed(digits));
  });
});

describe("shortTime takes 'now' rather than reading the clock", () => {
  const NOON = new Date(2026, 7, 29, 12, 0, 0).getTime();

  it("formats a same-day instant as a time and another day as a date", () => {
    const yesterday = new Date(2026, 7, 28, 12, 0, 0).getTime();
    // Only the SHAPE is asserted — the exact rendering is locale-dependent and
    // the point here is which branch was taken.
    expect(shortTime(NOON, NOON)).toMatch(/\d/);
    expect(shortTime(NOON, NOON)).not.toBe(shortTime(yesterday, NOON));
  });

  it("re-decides the day when 'now' moves, which a frozen clock could not", () => {
    // The bug it guards: `shortTime` used to call an argless `new Date()`, so
    // under React Compiler a call memoised on its single argument froze the
    // clock reading forever — a timestamp rendered before midnight kept
    // claiming to be today's, because its own `ms` never changes again.
    const tomorrow = new Date(2026, 7, 30, 12, 0, 0).getTime();
    expect(shortTime(NOON, NOON)).not.toBe(shortTime(NOON, tomorrow));
  });

  it("still refuses an unusable timestamp", () => {
    expect(shortTime(0, NOON)).toBe("--");
    expect(shortTime(Number.NaN, NOON)).toBe("--");
  });
});

describe("formatWirePrice", () => {
  it("keeps a sub-dollar price instead of rounding it away", () => {
    // The bug it exists for: a one-digit fraction cap turned a real
    // liquidation price of 0.1534 into "0.2", and 0.04 into "0" — which on a
    // position row reads as no liquidation risk at all.
    expect(formatWirePrice("0.1534")).toBe("0.1534");
    expect(formatWirePrice("0.04")).toBe("0.04");
    expect(formatWirePrice("0.00008123456")).toBe("0.000081235");
  });

  it("trims a server-computed price to five significant figures", () => {
    // The other direction: rendering the wire string verbatim showed
    // "66879.2151898734" on the same row.
    expect(formatWirePrice("66879.2151898734")).toBe("66879");
    expect(formatWirePrice("3.14159265")).toBe("3.1416");
  });

  it("leaves a clean price alone and drops trailing zeros", () => {
    expect(formatWirePrice("63645.0")).toBe("63645");
    expect(formatWirePrice("12.5")).toBe("12.5");
  });

  it("returns an unreadable value as itself rather than 0 or NaN", () => {
    expect(formatWirePrice("--")).toBe("--");
    expect(formatWirePrice("")).toBe("");
  });
});
