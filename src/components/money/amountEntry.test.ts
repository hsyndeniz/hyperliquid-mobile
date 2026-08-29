/**
 * What a number pad is allowed to put in a money field.
 *
 * The pad appends blindly, so these rules are the only thing between a tap and
 * a string `canonicalAmount` would throw on at signing time.
 */

import {
  acceptEdit,
  amountForFraction,
  fractionOf,
  heroFontSize,
  heroText,
} from "@/components/money/amountEntry";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";

describe("acceptEdit", () => {
  it("accepts plain digits", () => {
    expect(acceptEdit("2")).toBe("2");
    expect(acceptEdit("25")).toBe("25");
  });

  it("accepts a decimal point mid-number", () => {
    // `"2."` is not yet a valid amount, but it is a valid thing to have typed.
    expect(acceptEdit("2.")).toBe("2.");
    expect(acceptEdit("2.5")).toBe("2.5");
  });

  it("turns a leading dot into a leading zero", () => {
    // Tapping "." first plainly means "nought point". Refusing it would be
    // pedantic; silently dropping it would lose the keystroke.
    expect(acceptEdit(".")).toBe("0.");
    expect(acceptEdit(".5")).toBe("0.5");
  });

  it("REJECTS a second decimal point", () => {
    // The rejection is the whole point: the caller keeps the old value, so the
    // key is simply inert rather than producing "1.2.3".
    expect(acceptEdit("1.2.")).toBeNull();
  });

  it("REJECTS more than six decimals", () => {
    // `canonicalAmount` throws past `AMOUNT_DECIMALS`; refusing the seventh
    // keystroke moves that failure to where it costs nothing.
    expect(acceptEdit("1.123456")).toBe("1.123456");
    expect(acceptEdit("1.1234567")).toBeNull();
  });

  it("strips leading zeros without eating the one that matters", () => {
    expect(acceptEdit("007")).toBe("7");
    expect(acceptEdit("0")).toBe("0");
    // The zero has to survive long enough to become "0.5".
    expect(acceptEdit("0.")).toBe("0.");
  });

  it("REJECTS anything that is not a digit or a dot", () => {
    expect(acceptEdit("1e5")).toBeNull();
    expect(acceptEdit("-1")).toBeNull();
    expect(acceptEdit("1 000")).toBeNull();
  });

  it("allows clearing back to empty", () => {
    expect(acceptEdit("")).toBe("");
  });

  it("REJECTS an absurdly long entry", () => {
    expect(acceptEdit("1".repeat(21))).toBeNull();
  });

  it("only ever produces something canonicalAmount accepts, once complete", () => {
    // The contract that makes the whole filter worth having. A trailing dot is
    // the one incomplete state, and the screen blocks on it via the quote.
    for (const typed of ["2", "25", "0.5", "1.123456", "007"]) {
      const accepted = acceptEdit(typed);
      if (accepted === null) throw new Error(`unexpectedly rejected ${typed}`);
      expect(() => canonicalAmount(accepted)).not.toThrow();
    }
  });
  it("accepts the LOCALE comma as a decimal separator", () => {
    // Same fix as `acceptDecimalEdit`: a comma-locale decimal pad offers only
    // "," and every press used to be a silent no-op, so no fractional amount
    // could be typed on the perp/spot move or the vault transfer sheets.
    expect(acceptEdit("0,5")).toBe("0.5");
    expect(acceptEdit(",5")).toBe("0.5");
    expect(acceptEdit("12,345678")).toBe("12.345678");
  });

  it("does not let normalising make an invalid string valid", () => {
    expect(acceptEdit("1,5,5")).toBeNull();
    // Past the USDC fraction cap after normalising.
    expect(acceptEdit("1,1234567")).toBeNull();
  });
});

describe("fractionOf", () => {
  it("reports the share of the balance", () => {
    expect(fractionOf("5", "10")).toBe(0.5);
  });

  it("clamps above the balance rather than overflowing the track", () => {
    expect(fractionOf("30", "10")).toBe(1);
  });

  it("is zero while the balance is unknown", () => {
    // `null` is "not read yet", never zero — but a bar cannot render "unknown",
    // so it renders empty.
    expect(fractionOf("5", null)).toBe(0);
  });

  it("is zero for a half-typed amount rather than NaN", () => {
    expect(fractionOf("", "10")).toBe(0);
    expect(fractionOf(".", "10")).toBe(0);
  });

  it("is zero when the balance is zero, rather than infinite", () => {
    expect(fractionOf("5", "0")).toBe(0);
  });
});

describe("amountForFraction", () => {
  it("turns a thumb position into a wire-legal string", () => {
    expect(amountForFraction("10", 0.5)).toBe("5");
    expect(() => canonicalAmount(amountForFraction("10", 0.5))).not.toThrow();
  });

  it("returns the WHOLE balance at full drag, byte-identical to Max", () => {
    // The right edge must mean exactly what Max means — a float multiply that
    // lands on 3.9259999 would strand dust and differ from the Max path.
    expect(amountForFraction("3.926", 1)).toBe("3.926");
  });

  it("rounds DOWN to six decimals, never past the wire's precision", () => {
    // 1/3 of 10 is unrepresentable; the wire takes six decimals and the signed
    // amount must never exceed what the drag showed.
    const third = amountForFraction("10", 1 / 3);
    expect(third).toBe("3.333333");
    expect(() => canonicalAmount(third)).not.toThrow();
  });

  it("returns the empty field at zero rather than the illegal amount 0", () => {
    // `canonicalAmount` rejects "0" outright; empty is the honest idle state.
    expect(amountForFraction("10", 0)).toBe("");
  });

  it("clamps a runaway fraction to the balance", () => {
    expect(amountForFraction("10", 1.2)).toBe("10");
  });

  it("is empty while the balance is unknown", () => {
    expect(amountForFraction(null, 0.5)).toBe("");
  });

  it("round-trips with fractionOf closely enough for a stable thumb", () => {
    // Drag → amount → fraction must land where the thumb was left, or the
    // controlled slider snaps visibly after every gesture.
    const amount = amountForFraction("7.31", 0.4);
    expect(Math.abs(fractionOf(amount, "7.31") - 0.4)).toBeLessThan(0.001);
  });
});

describe("heroText", () => {
  it("shows a placeholder zero for an empty field", () => {
    expect(heroText("")).toBe("0");
  });

  it("steps the size down so a long amount still fits one line", () => {
    // Measured sizing (`adjustsFontSizeToFit`) needs a bounded width; given a
    // flex row it collapses straight to its floor, rendering the display figure
    // at body size — the exact layout this screen exists to avoid.
    expect(heroFontSize("0")).toBe(64);
    expect(heroFontSize("1234.567")).toBe(64);
    expect(heroFontSize("123456.789012")).toBeLessThan(64);
    expect(heroFontSize("12345678.901234")).toBeLessThan(48);
  });

  it("never reformats what was typed", () => {
    // A thousands separator here is a character the user did not type, shown
    // inside the number they are about to approve.
    expect(heroText("1234567")).toBe("1234567");
    expect(heroText("2.50")).toBe("2.50");
  });
});
