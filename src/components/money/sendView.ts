/**
 * What a spot send is, decided before any markup exists.
 *
 * ## A send is not a withdrawal, and the differences are the design
 *
 * `spotSend` moves a token **between two Hyperliquid accounts** and never leaves
 * the chain's custody: no bridge, no fee, no four-minute wait, and — unlike
 * `withdraw3` — a `token` field, so it can carry anything the spot balance
 * holds. What it *shares* with a withdrawal is finality: there is no cancel and
 * no undo, so the confirm step renders exactly what will be signed.
 *
 * ## The token list comes from the balances, not the catalogue
 *
 * The catalogue knows every token the network lists; the balances know what this
 * account actually holds. Offering the full catalogue invites picking a token
 * with a zero balance and reading the refusal as a bug. Outcome-market rows
 * (`kind: "outcome"`) are excluded outright — an outcome share is a position,
 * not a transferable token, and `spotSend` has no spelling for one.
 *
 * ## `available`, never `total`
 *
 * A spot balance's `hold` is money already committed to resting orders.
 * `total` includes it; `available` is what a send can actually move. Offering
 * `total` produces a server rejection for an amount the screen itself displayed.
 *
 * This module is deliberately shallower than the withdrawal preflight — no
 * destination probe, no in-flight journal, no branded ticket. That machinery is
 * `transfers/sendPreflight.ts`, a recorded follow-up. What ships now still
 * refuses the malformed, the blacklisted, the overdrawn and the sub-account
 * context, and still confirms from rendered values.
 */

import { BigNumber } from "bignumber.js";

import { validateDestination, sameAddress } from "@/hyperliquid/transfers/destination";
import type { SpotBalance } from "@/hyperliquid/types/domain";

export interface SendableToken {
  /** The balance-row coin name, which is also the catalogue lookup key. */
  name: string;
  /** What a send can move — `total - hold`, computed upstream via BigNumber. */
  available: string;
}

/**
 * The tokens this account can actually send, largest holding first.
 *
 * Zero-balance rows are dropped: they cannot fund a send, and a picker full of
 * zeros buries the one row that matters.
 */
export function sendableTokens(balances: readonly SpotBalance[] | null): SendableToken[] {
  if (balances === null) return [];
  return balances
    .filter((b) => b.kind === "token" && new BigNumber(b.available).isGreaterThan(0))
    .map((b) => ({ name: b.coin, available: b.available }))
    .sort((a, b) => new BigNumber(b.available).comparedTo(a.available) ?? 0);
}

export type SendBlocker =
  | { code: "no_token"; detail: string }
  | { code: "self_transfer"; detail: string }
  | { code: "destination_missing"; detail: string }
  | { code: "destination_invalid"; detail: string }
  | { code: "amount_missing"; detail: string }
  | { code: "amount_incomplete"; detail: string }
  | { code: "insufficient_balance"; detail: string }
  | { code: "sub_account_context"; detail: string };

export interface SendPlan {
  blockers: SendBlocker[];
  /** Set when the destination is this account. Legitimate, but worth a caveat. */
  isSelf: boolean;
  /** The checksummed display form, present only when the destination is valid. */
  destinationDisplay: string | null;
  destinationChunks: readonly string[] | null;
}

/**
 * Everything that stops this send, in the order a user should fix it.
 *
 * Returns a plan even when blocked — the blockers are the render, exactly as
 * `buildWithdrawalQuote` returns an unusable quote rather than throwing.
 */
export function planSend(params: {
  token: SendableToken | null;
  amount: string;
  destinationInput: string;
  selfAddress: string;
  /** A sub-account context blocks: `spotSend` is master-signed and debits the master. */
  subAccount: string | null;
}): SendPlan {
  const blockers: SendBlocker[] = [];

  if (params.subAccount !== null) {
    blockers.push({
      code: "sub_account_context",
      detail:
        "Sends go from the master account. Switch back to it, or sweep this sub-account first.",
    });
  }

  if (params.token === null) {
    blockers.push({ code: "no_token", detail: "Choose a token to send." });
  }

  const destination = validateDestination(params.destinationInput);
  if (params.destinationInput.trim().length === 0) {
    blockers.push({ code: "destination_missing", detail: "Choose who this goes to." });
  } else if (!destination.ok) {
    blockers.push({
      code: "destination_invalid",
      detail:
        destination.reason === "blacklisted"
          ? "Nothing sent to this address can ever be recovered."
          : "The destination address is not valid.",
    });
  }

  if (params.amount.trim().length === 0) {
    blockers.push({ code: "amount_missing", detail: "Enter an amount." });
  } else if (params.amount.endsWith(".")) {
    // "2." is a legitimate keystroke state and an illegitimate wire amount.
    blockers.push({ code: "amount_incomplete", detail: "Finish the amount." });
  } else if (params.token !== null) {
    const amount = new BigNumber(params.amount);
    const available = new BigNumber(params.token.available);
    if (!amount.isFinite() || amount.isLessThanOrEqualTo(0)) {
      blockers.push({ code: "amount_missing", detail: "Enter an amount." });
    } else if (amount.isGreaterThan(available)) {
      blockers.push({
        code: "insufficient_balance",
        detail: `Only ${params.token.available} ${params.token.name} is available to send.`,
      });
    }
  }

  const isSelf = destination.ok && sameAddress(destination.value.wire, params.selfAddress);
  if (isSelf) {
    // Measured, not assumed: the exchange rejects `spotSend` to the sender's
    // own address with "Cannot self-transfer." (live, 2026-08-14). Blocking
    // before the wallet prompt beats signing a message the server will refuse —
    // and the thing a self-send usually MEANS has a real home already.
    blockers.push({
      code: "self_transfer",
      detail:
        "Hyperliquid rejects sends to your own address. To move between your own balances, use Move instead.",
    });
  }

  return {
    blockers,
    isSelf,
    destinationDisplay: destination.ok ? destination.value.display : null,
    destinationChunks: destination.ok ? destination.value.chunks : null,
  };
}
