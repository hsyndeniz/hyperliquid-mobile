/**
 * The vault deposit lockup — the only correct answer to "can I withdraw now?".
 *
 * **`maxWithdrawable` is not that answer.** It reports a follower's full equity
 * while the funds are still locked, so a UI that derives an "available" figure
 * from it enables a button the server will refuse, or worse, lets a user plan
 * around money they cannot move. It is also `0` on every response fetched
 * without a `user` parameter, which is most of them.
 *
 * The gate is the absolute timestamp, and the wire exposes it on two independent
 * endpoints: `userVaultEquities[].lockedUntilTimestamp` and
 * `vaultDetails.followers[].lockupUntil`. Both are server-computed, so no clock
 * arithmetic is needed and none is done here — this module compares a timestamp
 * to `now` and nothing else.
 *
 * **The window is not one number.** Two measurements, both direct:
 *
 * - **User vaults: 24 h.** Across 1,677 follower rows over 28 open mainnet
 *   vaults, 9 had a locked follower and the largest remaining lockup was
 *   **23.77 h** — nothing above 24 h anywhere in the sample.
 * - **HLP: 96 h.** Settled exactly, by making a real $5 deposit into testnet HLP
 *   and reading the `lockedUntilTimestamp` it came back with: **95.993 h**, four
 *   days to the second.
 *
 * The clock restarts on each deposit, so it is per-deposit, not per-depositor.
 */

import { HlError } from "@/hyperliquid/core/errors";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The observed lockup windows, for **pre-deposit disclosure only**.
 *
 * Deliberately not used by any gate in this module. The wire always sends an
 * absolute unlock timestamp, so a gate never needs a duration — and a duration
 * constant in reach is an invitation to compute `entryTime + LOCKUP` instead of
 * reading the server's own answer, which would be wrong the moment Hyperliquid
 * changes it or treats a vault specially.
 *
 * Their one legitimate use is telling a user what they are agreeing to *before*
 * they deposit, when no timestamp exists yet — and **the figure to show them is
 * `maximum`**. Which window applies is not knowable before the deposit lands, and
 * the two failure directions are not symmetric: quoting 24 h on a vault that
 * locks for 96 h tells the user they can have their money back three days before
 * they can, which is the version they will be angry about.
 */
export const VAULT_LOCKUP_MS = {
  /** Every ordinary vault measured. */
  typical: 24 * HOUR_MS,
  /** HLP, measured exactly from a real deposit: 95.993 h. */
  maximum: 96 * HOUR_MS,
} as const;

export type LockupState =
  | { kind: "unlocked" }
  | { kind: "locked"; untilMs: number; remainingMs: number }
  /**
   * The wire sent no usable timestamp.
   *
   * Distinct from `unlocked` on purpose: an absent lockup and a passed one look
   * identical if both map to "you can withdraw", and only one of them is a fact.
   * A caller may treat this as unlocked, but it has to say so explicitly.
   */
  | { kind: "unknown" };

/** Classify a server-supplied unlock timestamp. */
export function lockupState(untilMs: unknown, now: number = Date.now()): LockupState {
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs) || untilMs <= 0) {
    return { kind: "unknown" };
  }
  if (untilMs <= now) return { kind: "unlocked" };
  return { kind: "locked", untilMs, remainingMs: untilMs - now };
}

/** Whether funds may be withdrawn right now. `unknown` is **not** treated as free. */
export function isUnlocked(state: LockupState): boolean {
  return state.kind === "unlocked";
}

/**
 * Refuse a withdrawal that the lockup forbids.
 *
 * Throws rather than returning a boolean, for the same reason
 * `assertMasterSigner` does: a caller that forgets to check a boolean proceeds
 * anyway, and here proceeding means a signature the server will reject.
 *
 * `unknown` throws too. The alternative — treating a missing timestamp as
 * permission — turns a wire change into a stream of failed withdrawals with no
 * explanation for the user.
 */
export function assertUnlocked(state: LockupState): void {
  if (state.kind === "unlocked") return;
  if (state.kind === "locked") {
    throw new HlError("These funds are still locked in the vault", {
      code: "not_authorized",
      context: { reason: "vault_locked", untilMs: state.untilMs, remainingMs: state.remainingMs },
    });
  }
  throw new HlError("The lockup on these funds could not be determined", {
    code: "validation_error",
    context: { reason: "vault_lockup_unknown" },
  });
}

/**
 * The soonest a set of positions becomes withdrawable.
 *
 * `null` when something is already unlocked (there is nothing to wait for) or
 * when nothing has a usable timestamp. A portfolio view wanting "next unlock"
 * should read this rather than sorting positions itself, so the `unknown` case is
 * handled in one place.
 */
export function earliestUnlockMs(
  positions: readonly { lockedUntilMs: number }[],
  now: number = Date.now()
): number | null {
  let soonest: number | null = null;
  for (const position of positions) {
    const state = lockupState(position.lockedUntilMs, now);
    if (state.kind === "unlocked") return null;
    if (state.kind !== "locked") continue;
    if (soonest === null || state.untilMs < soonest) soonest = state.untilMs;
  }
  return soonest;
}
