/**
 * Moving USDC between the perps and spot balances of one account.
 *
 * Pure, so the direction mapping is testable — that is the whole reason this
 * file exists separately. Swapping the two buckets moves the money the **wrong
 * way and succeeds**, with no error to notice and nothing in the UI that looks
 * different. It is the one decision here that cannot be caught by eye.
 *
 * ## Why this belongs on the deposit and withdraw screens
 *
 * The two bridge flows both touch **perp**: a deposit credits it, a withdrawal
 * debits it. USDC commonly sits in **spot** — a spot buy leaves change there,
 * and prediction and spot trading live there. So `insufficient_balance` on the
 * withdraw screen is usually not "you have no money", it is "your money is in
 * the other bucket", and this is the one-tap remedy.
 *
 * ## Agent-signed, so it does not prompt — but only with an agent
 *
 * `moveWithinAccount` uses `agentSendAsset`, the L1 phantom-agent scheme, so it
 * signs silently. That needs `session.exchangeClient()`, which **throws unless
 * the agent gate passed**. A read-only session — which the Portfolio screen
 * deliberately starts — has no agent, so the control must gate on `canTrade`
 * rather than discover this by throwing.
 *
 * The master-signed fallback is `classTransfer`, which prompts and cannot reach
 * a HIP-3 dex. This module reports which one applies; it does not choose to
 * prompt on the user's behalf.
 */

import { toBigNumber } from "@/hyperliquid/core/precision";
import type { DexBucket } from "@/hyperliquid/transfers/types";

/** Which way the money goes, in the user's words. */
export type MoveDirection = "toPerp" | "toSpot";

export interface MoveRoute {
  from: DexBucket;
  to: DexBucket;
}

/**
 * The buckets for a direction.
 *
 * `"toPerp"` means the money ENDS in perp, so it starts in spot. Getting this
 * inverted is silent — see the header.
 */
export function routeFor(direction: MoveDirection): MoveRoute {
  return direction === "toPerp"
    ? { from: { kind: "spot" }, to: { kind: "perp", dex: null } }
    : { from: { kind: "perp", dex: null }, to: { kind: "spot" } };
}

/** The opposite direction. */
export function flip(direction: MoveDirection): MoveDirection {
  return direction === "toPerp" ? "toSpot" : "toPerp";
}

/** Human labels, so the screen never re-derives them from the direction. */
export function labelFor(direction: MoveDirection): { from: string; to: string } {
  return direction === "toPerp" ? { from: "Spot", to: "Perps" } : { from: "Perps", to: "Spot" };
}

export type MoveSigner =
  /** `agentSendAsset` — silent. */
  | { kind: "agent"; prompts: false }
  /**
   * `classTransfer` — pops the master wallet, and cannot reach a HIP-3 dex.
   * Offered only when there is no usable agent.
   */
  | { kind: "master"; prompts: true };

export function signerFor(canTrade: boolean): MoveSigner {
  return canTrade ? { kind: "agent", prompts: false } : { kind: "master", prompts: true };
}

export type MoveBlocker =
  | { code: "same_bucket"; detail: string }
  | { code: "no_amount"; detail: string }
  | { code: "insufficient"; detail: string };

/**
 * Whether this move can be attempted, and why not.
 *
 * `available` is the balance of the SOURCE bucket, which the caller must read
 * from the right store — spot balances for `toPerp`, `summary.withdrawable` for
 * `toSpot`. Reading the wrong one offers a Max the account cannot honour.
 */
export function blockersFor(params: {
  direction: MoveDirection;
  amount: string;
  available: string | null;
}): MoveBlocker[] {
  const blockers: MoveBlocker[] = [];
  const route = routeFor(params.direction);

  // `moveWithinAccount` rejects this locally anyway; catching it here keeps the
  // button disabled rather than letting a press fail.
  if (route.from.kind === route.to.kind && route.from.kind !== "perp") {
    blockers.push({ code: "same_bucket", detail: "Pick two different balances." });
  }

  // BigNumber, not `Number()`: this comparison is the last gate before a
  // signature, and at a balance the size of a vault's the two disagree. A
  // double's ulp near 1e9 is ~2.4e-7, so `1000000000.0000009` and the strictly
  // larger `1000000000.000001` round to the SAME double — `>` reads false and
  // the overdraw is waved through to `canonicalAmount`. The empty and
  // non-finite guards stay: a half-typed amount must short-circuit before the
  // balance comparison, which says nothing about it.
  const amount = toBigNumber(params.amount);
  if (params.amount.trim() === "" || !amount.isFinite() || amount.isLessThanOrEqualTo(0)) {
    blockers.push({ code: "no_amount", detail: "Enter an amount." });
    // Without an amount the balance comparison says nothing.
    return blockers;
  }

  // `null` is "not read yet", not "zero" — blocking on it would disable the
  // control while the first frame is still in flight.
  if (params.available !== null && amount.isGreaterThan(toBigNumber(params.available))) {
    blockers.push({
      code: "insufficient",
      detail: `Only ${params.available} available in ${labelFor(params.direction).from}.`,
    });
  }
  return blockers;
}

export interface MoveCaption {
  tone: "muted" | "danger" | "success";
  text: string;
}

/**
 * The dialog's ONE caption line — the simple design has exactly one slot of
 * small text, so everything that used to be its own line competes for it here,
 * by priority:
 *
 * 1. an error from the last attempt (the user must see why it failed);
 * 2. a success note (the move happened; say so);
 * 3. a blocker, only once an amount was typed — "Enter an amount." before
 *    typing is nagging, not information;
 * 4. the after-preview — the check against the one mistake that succeeds
 *    silently (wrong direction);
 * 5. the resting state: what the source holds, or that it is still loading —
 *    `null` reads as unknown, never as an empty account.
 *
 * The signing disclosure rides on the muted states rather than the button:
 * a control that silently prompts is worse than one that warns it will.
 */
export function moveCaption(params: {
  direction: MoveDirection;
  amount: string;
  sourceAvailable: string | null;
  destAvailable: string | null;
  /** From `signerFor`: the master-wallet fallback pops a signature prompt. */
  prompts: boolean;
  error: string | null;
  note: string | null;
}): MoveCaption {
  if (params.error !== null) return { tone: "danger", text: params.error };
  if (params.note !== null) return { tone: "success", text: params.note };

  const typed = params.amount.trim() !== "";
  const blockers = blockersFor({
    direction: params.direction,
    amount: params.amount,
    available: params.sourceAvailable,
  });
  if (typed && blockers.length > 0) {
    return { tone: "danger", text: blockers[0]?.detail ?? "Cannot move this." };
  }

  const labels = labelFor(params.direction);
  const signNote = params.prompts ? " · asks you to sign" : "";

  const preview = movePreview({
    sourceAvailable: params.sourceAvailable,
    destAvailable: params.destAvailable,
    amount: params.amount,
  });
  if (preview !== null) {
    return {
      tone: "muted",
      text: `After: ${labels.to.toLowerCase()} ${preview.destAfter} · ${labels.from.toLowerCase()} ${preview.sourceAfter}${signNote}`,
    };
  }

  if (params.sourceAvailable === null) return { tone: "muted", text: "Balance loading…" };
  return {
    tone: "muted",
    text: `${labels.from} holds ${params.sourceAvailable} USDC${signNote}`,
  };
}

/**
 * What both balances become if this move happens.
 *
 * The before→after preview is the honest version of a direction arrow: showing
 * `2.06 → 1.06` on one card and `0.50 → 1.50` on the other makes the direction
 * unmistakable without the user parsing "Perps → Spot" notation — and a wrong
 * direction is the one mistake here that succeeds silently.
 *
 * `null` when there is nothing meaningful to preview: no amount yet, a
 * half-typed one, an unknown balance, or an overdraw (the blocker says why; a
 * negative preview would just say it confusingly).
 */
export function movePreview(params: {
  sourceAvailable: string | null;
  destAvailable: string | null;
  amount: string;
}): { sourceAfter: string; destAfter: string } | null {
  if (params.sourceAvailable === null || params.destAvailable === null) return null;
  if (params.amount.trim().length === 0 || params.amount.endsWith(".")) return null;

  // `toBigNumber`, not the bare constructor: bignumber.js THROWS on a string it
  // cannot parse, and this runs on every keystroke. A malformed amount has to
  // become "nothing to preview", not an exception thrown out of render.
  const amount = toBigNumber(params.amount);
  const source = toBigNumber(params.sourceAvailable);
  const dest = toBigNumber(params.destAvailable);
  if (!amount.isFinite() || !source.isFinite() || !dest.isFinite()) return null;
  if (amount.isLessThanOrEqualTo(0) || amount.isGreaterThan(source)) return null;

  return {
    sourceAfter: source.minus(amount).toFixed(),
    destAfter: dest.plus(amount).toFixed(),
  };
}
