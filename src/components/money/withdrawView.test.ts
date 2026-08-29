/**
 * The confirmation the user sees, and the echo signed from it.
 *
 * The first test is the important one: it is the only enforceable statement of
 * "what was signed is what was shown". `confirmWithdrawal` proves the echo was
 * *computed*; nothing in the type system can prove it was *displayed*.
 */

import { describeWithdrawal, maxState } from "@/components/money/withdrawView";
import { chunkAddress } from "@/hyperliquid/transfers/destination";
import type { WithdrawalQuote } from "@/hyperliquid/transfers/preflight";

function quote(overrides: Partial<WithdrawalQuote> = {}): WithdrawalQuote {
  return {
    token: "tok-1",
    issuedAt: 0,
    expiresAt: 60_000,
    env: "testnet",
    identityKey: "k",
    source: { address: "0xaaa", available: "10", confidence: "authoritative" },
    destination: {
      wire: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      // EIP-55 checksummed — mixed case is the whole point.
      display: "0xBbBBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
      // From the real splitter, so the fixture cannot disagree with production.
      chunks: chunkAddress("0xBbBBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"),
      isSelf: false,
    },
    amount: { gross: "10", feeUsdc: "1", net: "9" },
    destinationChecks: { probed: true, userExists: true, userHasSentTx: true, isSanctioned: false },
    timing: { expectedArrivalMs: 240_000, failureFloorMs: 900_000 },
    blockers: [],
    warnings: [],
    ...overrides,
  } as unknown as WithdrawalQuote;
}

describe("the echo is what was shown", () => {
  it("puts every echo value in a row the user sees", () => {
    // The one enforceable half of "displayed === signed". Fails the moment
    // someone formats a value in the JSX instead of using the row.
    const result = describeWithdrawal(quote());
    if (result.kind !== "ready") throw new Error("expected ready");

    const shown = result.rows.map((row) => row.value);
    for (const value of Object.values(result.echo)) {
      if (value === result.echo.token) continue; // the token is an id, not a row
      expect(shown).toContain(value);
    }
  });

  it("echoes the CHECKSUMMED destination, never the wire form", () => {
    // `confirmWithdrawal` compares case-sensitively on purpose: the checksum is
    // the only form where a one-character typo is detectable.
    const q = quote();
    const result = describeWithdrawal(q);
    if (result.kind !== "ready") throw new Error("expected ready");

    expect(result.echo.destinationDisplayed).toBe(q.destination.display);
    expect(result.echo.destinationDisplayed).not.toBe(q.destination.wire);
  });

  it("groups the address for reading without changing the string", () => {
    // The sheet shows chunks; the echo carries the raw value. Joining the
    // chunks must reproduce the echoed string exactly, or the user verified a
    // different address from the one being signed.
    const result = describeWithdrawal(quote());
    if (result.kind !== "ready") throw new Error("expected ready");

    const to = result.rows.find((row) => row.label === "To");
    expect(to?.chunks?.length).toBeGreaterThan(1);
    expect(`0x${to?.chunks?.join("")}`).toBe(result.echo.destinationDisplayed);
  });

  it("echoes the quote's own net, not a recomputed one", () => {
    // Recomputing invites `gross - fee` with the fee direction flipped.
    const result = describeWithdrawal(
      quote({ amount: { gross: "10", feeUsdc: "1", net: "9" } } as never)
    );
    if (result.kind !== "ready") throw new Error("expected ready");

    expect(result.echo.netDisplayed).toBe("9");
    expect(result.echo.grossDisplayed).toBe("10");
  });

  it("does not round or reformat the amounts", () => {
    // `"25"` typed as `"25.00"` must echo canonically, and a six-decimal value
    // must survive intact — `toFixed(2)` here signs a different number.
    const result = describeWithdrawal(
      quote({ amount: { gross: "25.000001", feeUsdc: "1", net: "24.000001" } } as never)
    );
    if (result.kind !== "ready") throw new Error("expected ready");

    expect(result.echo.grossDisplayed).toBe("25.000001");
    expect(result.echo.netDisplayed).toBe("24.000001");
  });
});

describe("blocked quotes", () => {
  it("produce NO echo at all", () => {
    // Structural: the screen cannot pass on an echo it was never given.
    const result = describeWithdrawal(
      quote({ blockers: [{ code: "insufficient_balance", detail: "not enough" }] } as never)
    );

    expect(result.kind).toBe("blocked");
    expect(result).not.toHaveProperty("echo");
  });

  it("still show the rows, so the user can see WHY", () => {
    const result = describeWithdrawal(
      quote({ blockers: [{ code: "insufficient_balance", detail: "not enough" }] } as never)
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.advisories[0]).toMatchObject({ tone: "danger", code: "insufficient_balance" });
  });
});

describe("the rows", () => {
  it("says the fee comes OUT of the amount", () => {
    // The fee-direction hazard in words as well as in the net figure.
    const fee = describeWithdrawal(quote()).rows.find((r) => r.label === "Fee");

    expect(fee?.caveat).toMatch(/out of the amount/i);
  });

  it("takes the arrival time from the quote, not a literal", () => {
    const rows = describeWithdrawal(
      quote({ timing: { expectedArrivalMs: 600_000 } as never })
    ).rows;

    expect(rows.find((r) => r.label === "Arrives")?.value).toContain("10");
  });

  it("flags a self-send rather than blocking it", () => {
    // A self-withdrawal is legitimate — it is how this project tests the path.
    const q = quote({ destination: { ...quote().destination, isSelf: true } as never });

    expect(describeWithdrawal(q).rows.find((r) => r.label === "To")?.caveat).toMatch(/your own/i);
  });

  it("requires every warning to be acknowledged", () => {
    const result = describeWithdrawal(
      quote({ warnings: [{ code: "third_party_destination", detail: "x" }] } as never)
    );
    if (result.kind !== "ready") throw new Error("expected ready");

    expect(result.mustAcknowledge).toEqual(["third_party_destination"]);
  });
});

describe("maxState", () => {
  it("offers the WHOLE balance as the gross, not the balance minus the fee", () => {
    // Pre-subtracting strands a dollar in the account permanently.
    expect(maxState("10", "2")).toEqual({ kind: "usable", gross: "10" });
  });

  it("reports unusable when Max returns a value the floor rejects", () => {
    // The trap: `maxWithdrawable("1.5", "1")` returns "1.5", which then trips
    // the UI floor. "Max returned a value" is not "Max is withdrawable".
    expect(maxState("1.5", "2")).toMatchObject({ kind: "unusable" });
  });

  it("reports unusable when the fee exceeds the balance", () => {
    expect(maxState("0.5", "2")).toMatchObject({ kind: "unusable" });
  });

  it("explains why rather than just disabling", () => {
    const state = maxState("1.5", "2");
    if (state.kind !== "unusable") throw new Error("expected unusable");

    expect(state.reason).toContain("1.5");
  });
});
