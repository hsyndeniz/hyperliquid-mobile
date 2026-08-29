/**
 * The perp⇄spot mover's outcome mapping.
 *
 * This file exists because the review found `transfer.ts` was the only one of
 * the four transfer hooks with no test — and the only one that dropped the
 * server's rejection reason on the floor.
 */

import { masterFallbackBlocker, settle, type MoveState } from "@/hyperliquid/hooks/transfer";
import type { TransferOutcome } from "@/hyperliquid/transfers/types";
import { HlError } from "@/hyperliquid/core/errors";

const PARAMS = { direction: "toPerp" as const, amount: "25" };

function run(outcome: TransferOutcome): { result: ReturnType<typeof settle>; state: MoveState } {
  let state: MoveState = { isBusy: true, lastError: null, lastNote: null };
  const result = settle(outcome, PARAMS, (next) => {
    state = next;
  });
  return { result, state };
}

describe("settle", () => {
  it("shows the exchange's OWN sentence when the server refuses", () => {
    // The bug: `rejected_by_server` carries `reason`, not `error`, so reading
    // `outcome.error ?? new Error(outcome.kind)` fabricated an error from the
    // variant's name and the caption read "unknown: rejected_by_server".
    const { result, state } = run({
      kind: "rejected_by_server",
      reason: "Insufficient spot balance for this transfer",
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.error.message).toBe("Insufficient spot balance for this transfer");
    expect(state.lastError?.message).toBe("Insufficient spot balance for this transfer");
  });

  it("never labels a definite server refusal with the code reserved for 'may have landed'", () => {
    // `unknown` is this module's word for "do not retry". Stamping it on a
    // branch where NOTHING moved tells the user not to do the one safe thing.
    const { result } = run({ kind: "rejected_by_server", reason: "Insufficient balance" });
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.error.code).not.toBe("unknown");
    expect(result.error.message).not.toContain("rejected_by_server");
  });

  it("passes a local rejection's error through unchanged", () => {
    const error = new HlError("Amount is not a number", { code: "validation_error" });
    const { result } = run({ kind: "rejected_locally", error });
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.error).toBe(error);
  });

  it("reports a settled move as done, naming the destination", () => {
    const { result, state } = run({ kind: "settled", nonce: 1 });
    expect(result).toEqual({ kind: "done", note: "Moved 25 to perps" });
    expect(state.lastError).toBeNull();
  });

  it("treats `unknown` as not-a-failure — it may have landed, and re-sending moves twice", () => {
    const { result, state } = run({
      kind: "unknown",
      error: new HlError("timeout", { code: "transport_error" }),
      nonce: null,
      window: { fromMs: 0, toMs: 1 },
    });
    expect(result.kind).toBe("done");
    // No error on screen: claiming failure here is the dishonesty the outcome
    // module forbids, and the note tells the user to look rather than retry.
    expect(state.lastError).toBeNull();
    expect(state.lastNote).toMatch(/check your balances/i);
  });
});

describe("masterFallbackBlocker", () => {
  it("refuses the master-signed fallback while a sub-account is acting", () => {
    // `usdClassTransfer` is user-signed and carries no `vaultAddress`, so the
    // fallback can only ever move the SIGNER's money. Proceeding moved the
    // master's USDC while the screen said it was acting as the sub-account.
    const blocked = masterFallbackBlocker("0xsub");
    expect(blocked).not.toBeNull();
    expect(blocked?.code).toBe("not_authorized");
    // The message has to name the way out, because there is one.
    expect(blocked?.message).toMatch(/trading approval/i);
  });

  it("lets the master through — it is the account that signs", () => {
    expect(masterFallbackBlocker(null)).toBeNull();
  });
});
