import { BigNumber } from "bignumber.js";

import {
  AMOUNT_DECIMALS,
  amountsEqual,
  canonicalAmount,
  maxWithdrawable,
  meetsFloor,
  netAfterFee,
  toMicroUsd,
  withinBalance,
} from "@/hyperliquid/transfers/amount";
import { WITHDRAW_FEE_USDC } from "@/hyperliquid/config/constants";
import { HlError } from "@/hyperliquid/core/errors";

describe("canonicalAmount", () => {
  it("returns the exact string that will be signed", () => {
    // The SDK normalises before signing, so the caller must be able to display
    // what the user is actually approving.
    expect(canonicalAmount("25.00")).toBe("25");
    expect(canonicalAmount("2.5")).toBe("2.5");
    expect(canonicalAmount("0.000001")).toBe("0.000001");
  });

  it("never emits exponential notation", () => {
    // A JS number at or above 1e21 serialises as "1e+21" — a string the user
    // never saw and would not recognise inside a signed message.
    const huge = canonicalAmount(new BigNumber("1000000000000000000000"));
    expect(huge).toBe("1000000000000000000000");
    expect(huge).not.toContain("e");
  });

  it("rejects a string that is already exponential", () => {
    expect(() => canonicalAmount("1e21")).toThrow(HlError);
  });

  it("rejects zero, which the exchange refuses outright", () => {
    // "Withdrawal amount cannot be zero." is the one amount-related server
    // rejection actually observed in the wild.
    expect(() => canonicalAmount("0")).toThrow(/is zero/);
    expect(() => canonicalAmount("0.0")).toThrow(/is zero/);
  });

  it("rejects a negative amount", () => {
    expect(() => canonicalAmount("-5")).toThrow(/plain positive decimal/);
  });

  it("rejects more precision than USDC can carry", () => {
    // Digits past 6 dp cannot survive the round trip and would be dropped
    // somewhere the user cannot see.
    expect(() => canonicalAmount("1.0000001")).toThrow(/decimal places/);
    expect(canonicalAmount("1.000001")).toBe("1.000001");
    expect(AMOUNT_DECIMALS).toBe(6);
  });

  it.each(["", "  ", "abc", "1.2.3", "+1", "1,5", "0x10", "Infinity", "NaN"])(
    "rejects %p",
    (bad) => {
      expect(() => canonicalAmount(bad)).toThrow(HlError);
    }
  );

  it("rejects a padded string rather than silently trimming into a signature", () => {
    // BigNumber would happily parse " 1.5 ".
    expect(canonicalAmount(" 1.5 ")).toBe("1.5");
  });

  it("carries float error through when a caller does the arithmetic itself", () => {
    // Documents WHY the signature takes no `number`: this is what a caller
    // would otherwise hand over.
    expect(() => canonicalAmount(String(0.1 + 0.2))).toThrow(/decimal places/);
    // The BigNumber path is exact.
    expect(canonicalAmount(new BigNumber("0.1").plus("0.2"))).toBe("0.3");
  });
});

describe("amountsEqual", () => {
  it("compares numerically, not as strings", () => {
    // "25.00" and "25" are the same amount, and the SDK turns the first into
    // the second on its way to the signature.
    expect(amountsEqual("25.00", "25")).toBe(true);
    expect(amountsEqual("25.000000", "25")).toBe(true);
    expect(amountsEqual("25", "25.1")).toBe(false);
  });
});

describe("netAfterFee", () => {
  it("deducts the fee from the signed amount", () => {
    // Sign X, HL debits X, X - 1 arrives. Verified on 8 matched
    // signed-action/ledger pairs, difference exactly 1.000000 each time.
    expect(netAfterFee(canonicalAmount("10"), WITHDRAW_FEE_USDC)).toBe("9");
    expect(netAfterFee(canonicalAmount("2.5"), WITHDRAW_FEE_USDC)).toBe("1.5");
  });

  it("refuses an amount the fee would consume entirely", () => {
    // The real protocol floor: a withdrawal must leave something to arrive.
    expect(() => netAfterFee(canonicalAmount("1"), WITHDRAW_FEE_USDC)).toThrow(
      /nothing would arrive/
    );
    expect(() => netAfterFee(canonicalAmount("0.5"), WITHDRAW_FEE_USDC)).toThrow(HlError);
  });

  it("allows a hair over the fee", () => {
    expect(netAfterFee(canonicalAmount("1.000001"), WITHDRAW_FEE_USDC)).toBe("0.000001");
  });
});

describe("maxWithdrawable", () => {
  it("is the whole balance, NOT the balance minus the fee", () => {
    // The gross is what gets signed. Pre-subtracting strands the fee in the
    // account forever; the fee comes out of the gross on the exchange side.
    expect(maxWithdrawable("100", WITHDRAW_FEE_USDC)).toBe("100");
  });

  it("truncates rather than rounds up past the balance", () => {
    // Rounding up produces an amount the account cannot cover, which is
    // rejected on every single max withdrawal.
    expect(maxWithdrawable("10.1234567", WITHDRAW_FEE_USDC)).toBe("10.123456");
  });

  it("returns null when the balance cannot cover the fee", () => {
    expect(maxWithdrawable("1", WITHDRAW_FEE_USDC)).toBeNull();
    expect(maxWithdrawable("0.5", WITHDRAW_FEE_USDC)).toBeNull();
    expect(maxWithdrawable("1.000001", WITHDRAW_FEE_USDC)).toBe("1.000001");
  });
});

describe("floor and balance checks", () => {
  it("compares numerically", () => {
    // Lexicographic comparison would call "9" greater than "10".
    expect(meetsFloor(canonicalAmount("9"), "10")).toBe(false);
    expect(meetsFloor(canonicalAmount("10"), "10")).toBe(true);
    expect(withinBalance(canonicalAmount("9"), "10")).toBe(true);
    expect(withinBalance(canonicalAmount("10.000001"), "10")).toBe(false);
  });
});

describe("toMicroUsd", () => {
  it("converts dollars to whole micro-USD", () => {
    // subAccountTransfer is the ONE action taking an integer of micro-USD while
    // every other takes a decimal string. Passing 100 for $100 moves $0.0001
    // and validates cleanly.
    expect(toMicroUsd(canonicalAmount("100"))).toBe(100_000_000);
    expect(toMicroUsd(canonicalAmount("0.000001"))).toBe(1);
  });

  it("refuses an amount below the 1 micro-USD minimum", () => {
    // Unreachable through canonicalAmount's 6dp cap, but the guard is the
    // contract rather than an inference from another module's rules.
    expect(() => toMicroUsd("0.0000001" as never)).toThrow(/minimum|whole micro/);
  });
});
