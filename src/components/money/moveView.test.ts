/**
 * The direction mapping, and the states that gate the move.
 *
 * The first two cases are the reason this module is pure: inverting the buckets
 * moves the money the wrong way and **succeeds**. There is no error, and
 * nothing on screen looks different.
 */

import { amountForFraction } from "@/components/money/amountEntry";
import {
  moveCaption,
  blockersFor,
  flip,
  labelFor,
  routeFor,
  signerFor,
  movePreview,
} from "@/components/money/moveView";

describe("routeFor", () => {
  it("sends spot → perp for toPerp", () => {
    // "toPerp" names where the money ENDS, so it starts in spot.
    expect(routeFor("toPerp")).toEqual({
      from: { kind: "spot" },
      to: { kind: "perp", dex: null },
    });
  });

  it("sends perp → spot for toSpot", () => {
    expect(routeFor("toSpot")).toEqual({
      from: { kind: "perp", dex: null },
      to: { kind: "spot" },
    });
  });

  it("makes the two directions exact inverses", () => {
    // Catches a copy-paste that leaves both directions pointing the same way —
    // which would silently no-op one of them.
    const there = routeFor("toPerp");
    const back = routeFor("toSpot");

    expect(there.from).toEqual(back.to);
    expect(there.to).toEqual(back.from);
  });

  it("targets the DEFAULT perp dex, not a HIP-3 one", () => {
    // `dex: null` is the main USDC perp dex. A named dex here would move the
    // money to a builder venue the user never chose.
    expect(routeFor("toPerp").to).toEqual({ kind: "perp", dex: null });
  });
});

describe("labelFor", () => {
  it("names the source and destination the way the route runs", () => {
    // The labels come from one place so the screen cannot describe a move it
    // is not making.
    expect(labelFor("toPerp")).toEqual({ from: "Spot", to: "Perps" });
    expect(labelFor("toSpot")).toEqual({ from: "Perps", to: "Spot" });
  });

  it("flips with the direction", () => {
    expect(labelFor(flip("toPerp"))).toEqual(labelFor("toSpot"));
  });
});

describe("signerFor", () => {
  it("uses the agent, silently, when trading is enabled", () => {
    expect(signerFor(true)).toEqual({ kind: "agent", prompts: false });
  });

  it("falls back to the master, which prompts, without an agent", () => {
    // A read-only session has no agent — `exchangeClient()` throws — and the
    // Portfolio screen deliberately starts one. The control must know this
    // rather than discover it by throwing.
    expect(signerFor(false)).toEqual({ kind: "master", prompts: true });
  });
});

describe("blockersFor", () => {
  const base = { direction: "toPerp" as const, available: "10" };

  it("blocks an empty amount", () => {
    expect(blockersFor({ ...base, amount: "" }).map((b) => b.code)).toEqual(["no_amount"]);
  });

  it("blocks zero and negative amounts", () => {
    expect(blockersFor({ ...base, amount: "0" })[0].code).toBe("no_amount");
    expect(blockersFor({ ...base, amount: "-5" })[0].code).toBe("no_amount");
  });

  it("blocks more than the SOURCE bucket holds", () => {
    const blockers = blockersFor({ ...base, amount: "11" });

    expect(blockers[0].code).toBe("insufficient");
    // Names the bucket the money is coming from, not the one it goes to.
    expect(blockers[0].detail).toContain("Spot");
  });

  it("names the perps balance when moving the other way", () => {
    expect(blockersFor({ direction: "toSpot", amount: "11", available: "10" })[0].detail).toContain(
      "Perps"
    );
  });

  it("allows exactly the available balance", () => {
    expect(blockersFor({ ...base, amount: "10" })).toEqual([]);
  });

  it("does not block on a balance that has not been read yet", () => {
    // `null` is "unknown", not "zero". Blocking would disable the control
    // while the first frame is still in flight.
    expect(blockersFor({ direction: "toPerp", amount: "5", available: null })).toEqual([]);
  });

  it("reports no balance blocker when there is no amount to compare", () => {
    // Otherwise an empty field shows two errors at once.
    expect(blockersFor({ direction: "toPerp", amount: "", available: "0" })).toHaveLength(1);
  });

  it("catches an overdraw the float comparison collapses to equal", () => {
    // A 7-decimal balance at this magnitude sits where a double's ulp is
    // ~2.4e-7, so the balance and an amount one ten-millionth ABOVE it round
    // to the SAME double: `Number(amount) > Number(available)` is false and
    // the overdraw is waved through to the signature.
    const available = "1000000000.0000009";
    const amount = "1000000000.000001";
    expect(Number(amount) > Number(available)).toBe(false);

    expect(blockersFor({ direction: "toPerp", amount, available })[0].code).toBe("insufficient");
  });

  it("still allows exactly the balance at that precision", () => {
    // The mirror of the case above: the fix must not start blocking a legal
    // Max, which hands back the balance string verbatim.
    const available = "1000000000.0000009";
    expect(blockersFor({ direction: "toPerp", amount: available, available })).toEqual([]);
    expect(blockersFor({ direction: "toPerp", amount: "1000000000.0000008", available })).toEqual(
      []
    );
  });

  it("still short-circuits on a half-typed amount", () => {
    // The `.trim() === ""` and non-finite guards survive the BigNumber switch:
    // `toBigNumber` returns NaN for these rather than throwing, and NaN
    // compares false against every balance, which would silently allow them.
    expect(blockersFor({ direction: "toPerp", amount: "", available: "10" })[0].code).toBe(
      "no_amount"
    );
    expect(blockersFor({ direction: "toPerp", amount: "  ", available: "10" })[0].code).toBe(
      "no_amount"
    );
    expect(blockersFor({ direction: "toPerp", amount: ".", available: "10" })[0].code).toBe(
      "no_amount"
    );
    expect(blockersFor({ direction: "toPerp", amount: "abc", available: "10" })[0].code).toBe(
      "no_amount"
    );
  });
});

describe("the slider and the Max button", () => {
  // The sheet's two ways to spend the whole balance meet at exactly one
  // function — Max is `amountForFraction(source, 1)` and so is the slider's
  // right edge — so "they agree" is testable here without rendering anything.
  // What has to hold is that BOTH produce the balance itself, byte for byte:
  // a float multiply landing on 3.9259999 would strand dust and make the two
  // paths disagree even though they call the same code.

  it("writes the balance verbatim at the right edge, which is what Max means", () => {
    for (const available of ["10", "3.926", "0.5", "1234.000001"]) {
      const fullDrag = amountForFraction(available, 1);

      expect(fullDrag).toBe(available);
      expect(blockersFor({ direction: "toPerp", amount: fullDrag, available })).toEqual([]);
      // And it leaves nothing behind — the preview the caption shows reads 0.
      expect(
        movePreview({ sourceAvailable: available, destAvailable: "0", amount: fullDrag })
          ?.sourceAfter
      ).toBe("0");
    }
  });

  it("truncates a balance the wire cannot carry, a hair DOWN and never up", () => {
    // Seven decimals: the wire takes six, so the right edge is the balance
    // rounded down. Rounding the other way would offer a Max the account
    // cannot honour — and would be an `insufficient` at press time.
    const available = "0.1234567";

    expect(amountForFraction(available, 1)).toBe("0.123456");
    expect(
      blockersFor({ direction: "toPerp", amount: amountForFraction(available, 1), available })
    ).toEqual([]);
  });

  it("never lets a thumb position overdraw the source", () => {
    // Every stop the `step={0.01}` slider can land on, against a balance whose
    // 7th decimal the wire cannot carry — `amountForFraction` rounds DOWN to
    // six, so no position may produce an `insufficient`.
    const available = "0.1234567";
    for (let step = 1; step <= 100; step += 1) {
      const amount = amountForFraction(available, step / 100);
      const codes = blockersFor({ direction: "toPerp", amount, available }).map((b) => b.code);

      expect(codes).not.toContain("insufficient");
    }
  });

  it("leaves the field empty at the left edge rather than the illegal amount 0", () => {
    // `canonicalAmount` rejects "0"; empty is the honest idle state, and the
    // caption goes back to resting rather than showing a danger tone.
    expect(amountForFraction("10", 0)).toBe("");
    expect(
      moveCaption({
        direction: "toPerp",
        amount: amountForFraction("10", 0),
        sourceAvailable: "10",
        destAvailable: "0",
        prompts: false,
        error: null,
        note: null,
      }).tone
    ).toBe("muted");
  });
});

describe("movePreview", () => {
  it("shows both balances after the move", () => {
    expect(movePreview({ sourceAvailable: "2.06", destAvailable: "0.5", amount: "1" })).toEqual({
      sourceAfter: "1.06",
      destAfter: "1.5",
    });
  });

  it("is exact where floats are not", () => {
    // 0.1 + 0.2 — the classic. A float preview would show 0.30000000000000004.
    expect(movePreview({ sourceAvailable: "1", destAvailable: "0.1", amount: "0.2" })).toEqual({
      sourceAfter: "0.8",
      destAfter: "0.3",
    });
  });

  it("previews nothing for an overdraw — the blocker explains, a negative cannot", () => {
    expect(movePreview({ sourceAvailable: "1", destAvailable: "0", amount: "2" })).toBeNull();
  });

  it("previews nothing for a half-typed amount", () => {
    expect(movePreview({ sourceAvailable: "1", destAvailable: "0", amount: "1." })).toBeNull();
    expect(movePreview({ sourceAvailable: "1", destAvailable: "0", amount: "" })).toBeNull();
  });

  it("previews nothing while a balance is unread — null is not zero", () => {
    expect(movePreview({ sourceAvailable: null, destAvailable: "1", amount: "1" })).toBeNull();
  });
});

describe("moveCaption", () => {
  const BASE = {
    direction: "toPerp" as const,
    amount: "",
    sourceAvailable: "0.50",
    destAvailable: "2.64",
    prompts: false,
    error: null,
    note: null,
  };

  it("rests on what the source holds, and discloses a coming prompt", () => {
    expect(moveCaption(BASE)).toEqual({ tone: "muted", text: "Spot holds 0.50 USDC" });
    expect(moveCaption({ ...BASE, prompts: true }).text).toBe(
      "Spot holds 0.50 USDC · asks you to sign"
    );
  });

  it("reads an unread balance as loading, never as an empty account", () => {
    expect(moveCaption({ ...BASE, sourceAvailable: null })).toEqual({
      tone: "muted",
      text: "Balance loading…",
    });
  });

  it("previews both resulting balances once an amount is valid", () => {
    expect(moveCaption({ ...BASE, amount: "0.25" })).toEqual({
      tone: "muted",
      text: "After: perps 2.89 · spot 0.25",
    });
  });

  it("does not nag before typing, but names the blocker after", () => {
    // No amount yet: resting line, not "Enter an amount."
    expect(moveCaption(BASE).tone).toBe("muted");
    expect(moveCaption({ ...BASE, amount: "9" })).toEqual({
      tone: "danger",
      text: "Only 0.50 available in Spot.",
    });
  });

  it("lets an error outrank everything, then a note", () => {
    const failed = moveCaption({ ...BASE, amount: "0.25", error: "boom", note: "yay" });
    expect(failed).toEqual({ tone: "danger", text: "boom" });
    const noted = moveCaption({ ...BASE, amount: "0.25", note: "Moved." });
    expect(noted).toEqual({ tone: "success", text: "Moved." });
  });
});
