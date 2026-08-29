/**
 * The copy a rejected order shows.
 *
 * Guards one specific failure of honesty: three exchange refusals are not about
 * the order at all, and two of them point at the device's clock — a fix that
 * lives in Settings. Rendered through the generic fallback they came out as raw
 * exchange jargon ("Invalid nonce: nonce too low 1776584283874 < …") and sent
 * the user hunting for a bad price.
 */

import { describeSubmitError } from "@/components/trade/submitErrors";

describe("describeSubmitError", () => {
  it("blames the device clock for a too-low nonce", () => {
    // Verbatim from a production gateway log; this string is in no docs.
    const note = describeSubmitError(
      new Error("Invalid nonce: nonce too low 1776584283874 < 1776584799101")
    );
    expect(note).toMatch(/device clock/i);
    // And never leaks the raw refusal to the user.
    expect(note).not.toMatch(/nonce/i);
  });

  it("blames the device clock for an expired action", () => {
    expect(describeSubmitError(new Error("Action already expired"))).toMatch(/device clock/i);
  });

  it("does NOT blame the clock for a duplicate nonce", () => {
    // Same-millisecond concurrency: it clears itself in seconds. Sending
    // someone to Settings for it is worse than saying nothing.
    const note = describeSubmitError(new Error("Invalid nonce: duplicate nonce 1754922717871"));
    expect(note).not.toMatch(/clock/i);
    expect(note).toMatch(/try again/i);
  });

  it("reads the refusal off a wrapped cause, which is how the SDK throws", () => {
    const inner = new Error("Action already expired");
    expect(describeSubmitError(new Error("request failed", { cause: inner }))).toMatch(
      /device clock/i
    );
  });

  it("still translates the ordinary order rejections", () => {
    expect(describeSubmitError(new Error("Insufficient margin"))).toMatch(/margin/i);
    expect(describeSubmitError(new Error("Order has invalid price: tick"))).toMatch(/tick grid/i);
  });
});
