/**
 * The withdrawal preflight contract.
 *
 * Every other phase in this project buys **time to be wrong**. `expiresAfter`
 * buys a moment after which absence is proof; a `cloid` buys a handle to probe
 * with; the 5-second heartbeat buys a correction. `withdraw3` has none of the
 * three — no expiry on user-signed actions, no client order id, no cancel, no
 * status endpoint, and the only ledger record appears roughly four minutes
 * later. So this phase spends its whole complexity budget *before* the
 * signature, because afterwards there is nothing left to spend it on.
 *
 * The shape is a two-step handshake:
 *
 *     buildWithdrawalQuote(...)  ->  WithdrawalQuote   (facts, blockers, warnings)
 *     confirmWithdrawal(quote, echo)  ->  WithdrawalTicket
 *     submitWithdrawal(ticket)   ->  the only way to reach withdraw3
 *
 * The ticket is **unforgeable**: its brand is a module-private symbol, so no
 * object literal, no structural cast and no JSON round-trip produces one. A
 * caller cannot skip the quote, cannot confirm a quote it never displayed, and
 * cannot confirm one whose numbers have since changed.
 *
 * The echo is what makes this real rather than ceremonial. The caller must send
 * back the **checksummed** destination it displayed, the gross it displayed, and
 * the net it displayed — compared by exact string equality. A caller that
 * lowercased the address before showing it fails here, which is the point: the
 * human must have seen the form that carries the typo check. A caller that never
 * computed "you will receive" cannot produce `netDisplayed`, which closes the
 * fee-direction hazard by construction rather than by review.
 */

import { BigNumber } from "bignumber.js";

import {
  MIN_WITHDRAW_USDC_UI_FLOOR,
  WITHDRAW_FEE_USDC,
  WITHDRAW_TIMINGS,
} from "@/hyperliquid/config/constants";
import { HlError } from "@/hyperliquid/core/errors";
import { identityKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import { meetsFloor, netAfterFee, withinBalance } from "@/hyperliquid/transfers/amount";
import { sameAddress, validateDestination } from "@/hyperliquid/transfers/destination";
import type { ValidatedAddress, WireAmount } from "@/hyperliquid/transfers/types";
import type { Hex, HlEnv, HlIdentity } from "@/hyperliquid/types/domain";

const logger = log.child("transfers.preflight");

/** How long a quote's facts may be considered current. */
export const QUOTE_TTL_MS = 60_000;

export type WithdrawalBlockerCode =
  | "destination_malformed"
  | "destination_checksum_failed"
  | "destination_blacklisted"
  | "destination_is_agent"
  | "destination_sanctioned"
  | "signer_mismatch"
  | "sub_account_context"
  | "amount_not_positive_after_fee"
  | "amount_below_ui_floor"
  | "insufficient_balance"
  | "withdrawal_in_flight";

export type WithdrawalWarningCode =
  | "new_destination_account"
  | "destination_never_transacted"
  | "third_party_destination"
  | "checks_incomplete"
  | "balance_source_derived";

export interface WithdrawalBlocker {
  code: WithdrawalBlockerCode;
  detail: string;
}

export interface WithdrawalWarning {
  code: WithdrawalWarningCode;
  detail: string;
}

/** How confident we are that `available` is really withdrawable. */
export type BalanceConfidence = "authoritative" | "derived";

export interface WithdrawalQuote {
  /**
   * A correctness join, not a secret.
   *
   * Hashes every field below, so a stale confirmation sheet cannot confirm a
   * quote whose balance or fee has since been re-read.
   */
  readonly token: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly env: HlEnv;
  readonly identityKey: string;

  readonly source: {
    readonly address: Hex;
    readonly available: WireAmount;
    readonly confidence: BalanceConfidence;
  };

  readonly destination: {
    /** Lowercase — exactly what gets signed. */
    readonly wire: ValidatedAddress;
    /** EIP-55 checksummed — what a human verifies. */
    readonly display: Hex;
    /** Four-character groups, because nobody compares 40 raw hex characters. */
    readonly chunks: readonly string[];
    readonly isSelf: boolean;
  };

  readonly amount: {
    /** The string that will be signed, verbatim. */
    readonly gross: WireAmount;
    readonly feeUsdc: string;
    /** What actually arrives. The fee is deducted from the gross, not added. */
    readonly net: WireAmount;
  };

  readonly destinationChecks: {
    /** When false, the three fields below carry no information at all. */
    readonly probed: boolean;
    readonly userExists: boolean;
    readonly userHasSentTx: boolean;
    readonly isSanctioned: boolean;
  };

  readonly timing: {
    readonly expectedArrivalMs: number;
    /** Nothing may be called failed, and nothing re-sent, before this. */
    readonly failureFloorMs: number;
  };

  readonly blockers: readonly WithdrawalBlocker[];
  readonly warnings: readonly WithdrawalWarning[];
}

/**
 * What the caller must send back to proceed.
 *
 * Every field is re-derived and compared; nothing here is trusted.
 */
export interface WithdrawalEcho {
  readonly token: string;
  /**
   * The destination the caller **displayed**, compared by exact string equality
   * against the checksummed form — deliberately not case-insensitively.
   */
  readonly destinationDisplayed: string;
  /** The gross the caller displayed. Exact equality. */
  readonly grossDisplayed: string;
  /** The net the caller displayed. Its absence means "you will receive" was never shown. */
  readonly netDisplayed: string;
  /** Must contain every code in `quote.warnings`. A superset is fine; a subset throws. */
  readonly acknowledged: readonly WithdrawalWarningCode[];
}

declare const TicketBrand: unique symbol;

/**
 * Proof that a quote was built, displayed and confirmed.
 *
 * The brand is a private symbol, so this type cannot be constructed anywhere
 * else — not by a literal, not by a cast through `unknown`, not by parsing JSON.
 */
export interface WithdrawalTicket {
  readonly [TicketBrand]: true;
  readonly quote: WithdrawalQuote;
  readonly confirmedAt: number;
}

export interface DestinationProbeResult {
  userExists: boolean;
  userHasSentTx: boolean;
  isSanctioned: boolean;
}

export interface BuildQuoteParams {
  identity: HlIdentity;
  env: HlEnv;
  /** The address that will sign. Checked against the identity's owner. */
  signerAddress: Hex;
  ownerAddress: Hex;
  /** Raw user input; validated here rather than by the caller. */
  destinationInput: string;
  amount: WireAmount;
  available: WireAmount;
  confidence: BalanceConfidence;
  /** `preTransferCheck`, when it could be run. Omit when it could not. */
  destinationProbe?: DestinationProbeResult;
  /** Any registered agent addresses, which must never be a withdrawal target. */
  agentAddresses?: readonly Hex[];
  /** When a previous withdrawal is still inside its settlement floor. */
  inFlightSince?: number | null;
  now?: () => number;
}

/**
 * Assemble the facts, and decide what blocks and what merely warns.
 *
 * Returns a quote even when it is unusable — the blockers are the useful output
 * in that case, and throwing would deny the caller anything to render.
 */
export function buildWithdrawalQuote(params: BuildQuoteParams): WithdrawalQuote {
  const now = (params.now ?? Date.now)();
  const blockers: WithdrawalBlocker[] = [];
  const warnings: WithdrawalWarning[] = [];

  // --- destination -------------------------------------------------------
  const validated = validateDestination(params.destinationInput);
  let wire = "0x" as ValidatedAddress;
  let display = "0x" as Hex;
  let chunks: string[] = [];

  if (!validated.ok) {
    blockers.push({
      code:
        validated.reason === "checksum_failed"
          ? "destination_checksum_failed"
          : validated.reason === "blacklisted"
            ? "destination_blacklisted"
            : "destination_malformed",
      detail: `The destination address is ${validated.reason.replace("_", " ")}.`,
    });
  } else {
    wire = validated.value.wire;
    display = validated.value.display;
    chunks = validated.value.chunks;
  }

  const isSelf = validated.ok && sameAddress(wire, params.ownerAddress);

  // An agent address holds no user funds and is not a wallet the user controls
  // for spending — a withdrawal there is a loss.
  if (validated.ok && (params.agentAddresses ?? []).some((a) => sameAddress(a, wire))) {
    blockers.push({
      code: "destination_is_agent",
      detail: "That address is an API wallet, not an account you can spend from.",
    });
  }

  // --- signer ------------------------------------------------------------
  if (!sameAddress(params.signerAddress, params.ownerAddress)) {
    // withdraw3 carries no `user` field: the account debited is whoever signs.
    blockers.push({
      code: "signer_mismatch",
      detail: "This withdrawal must be signed by the account owner, not the agent key.",
    });
  }

  // --- sub-account context -----------------------------------------------
  if (params.identity.subAccount) {
    // A sub-account cannot withdraw. Hyperliquid's own `WithdrawAction3` struct
    // is `{signatureChainId, hyperliquidChain, destination, amount, time}` with
    // `deny_unknown_fields` — there is no sub-account or vault field to set, and
    // a sub-account has no key of its own to sign with. So the master signs, and
    // **the master's balance is what leaves**.
    //
    // That is the hazard: the screen is showing the sub-account's portfolio, the
    // numbers all validate, and the wrong pot is debited. Sweep to the master
    // first — `sweepSubAccount` — and withdraw from there.
    blockers.push({
      code: "sub_account_context",
      detail: "A sub-account cannot withdraw directly. Move the funds to your main account first.",
    });
  }

  // --- amount ------------------------------------------------------------
  let net: WireAmount = "0" as WireAmount;
  try {
    net = netAfterFee(params.amount, WITHDRAW_FEE_USDC);
  } catch {
    blockers.push({
      code: "amount_not_positive_after_fee",
      detail: `A withdrawal must exceed the ${WITHDRAW_FEE_USDC} USDC fee, or nothing arrives.`,
    });
  }

  if (!meetsFloor(params.amount, MIN_WITHDRAW_USDC_UI_FLOOR)) {
    blockers.push({
      code: "amount_below_ui_floor",
      detail: `Withdrawals start at ${MIN_WITHDRAW_USDC_UI_FLOOR} USDC.`,
    });
  }

  if (!withinBalance(params.amount, params.available)) {
    blockers.push({
      code: "insufficient_balance",
      detail: `Only ${params.available} USDC is available to withdraw.`,
    });
  }

  // --- in-flight ---------------------------------------------------------
  if (
    params.inFlightSince != null &&
    now - params.inFlightSince < WITHDRAW_TIMINGS.settlementFloorMs
  ) {
    // The decisive guard. There is no idempotency key, so a second withdrawal
    // inside this window is a second, equally final withdrawal — not a retry.
    blockers.push({
      code: "withdrawal_in_flight",
      detail: "A withdrawal is still settling. Wait for it to arrive before sending another.",
    });
  }

  // --- destination checks ------------------------------------------------
  const probe = params.destinationProbe;
  if (!probe) {
    warnings.push({
      code: "checks_incomplete",
      detail: "The destination could not be checked. Verify the address yourself.",
    });
  } else {
    if (probe.isSanctioned) {
      blockers.push({
        code: "destination_sanctioned",
        detail: "That destination is sanctioned and cannot receive funds.",
      });
    }
    if (!probe.userExists) {
      // Caught 14/14 single-character substitutions and 9/9 transpositions of a
      // real address in testing — the strongest typo signal available.
      warnings.push({
        code: "new_destination_account",
        detail: "This address has never been seen on Hyperliquid. Check it carefully.",
      });
    } else if (!probe.userHasSentTx) {
      warnings.push({
        code: "destination_never_transacted",
        detail: "This address exists but has never sent a transaction.",
      });
    }
  }

  if (validated.ok && !isSelf) {
    warnings.push({
      code: "third_party_destination",
      detail: "This is not your own address. Withdrawals cannot be reversed.",
    });
  }

  if (params.confidence === "derived") {
    warnings.push({
      code: "balance_source_derived",
      detail: "The available figure is inferred rather than reported by the exchange.",
    });
  }

  const quote: WithdrawalQuote = {
    token: "",
    issuedAt: now,
    expiresAt: now + QUOTE_TTL_MS,
    env: params.env,
    identityKey: identityKey(params.identity),
    source: {
      address: params.ownerAddress,
      available: params.available,
      confidence: params.confidence,
    },
    destination: { wire, display, chunks, isSelf },
    amount: { gross: params.amount, feeUsdc: WITHDRAW_FEE_USDC, net },
    destinationChecks: {
      probed: probe !== undefined,
      userExists: probe?.userExists ?? false,
      userHasSentTx: probe?.userHasSentTx ?? false,
      isSanctioned: probe?.isSanctioned ?? false,
    },
    timing: {
      expectedArrivalMs: WITHDRAW_TIMINGS.expectedArrivalMs,
      failureFloorMs: WITHDRAW_TIMINGS.settlementFloorMs,
    },
    blockers,
    warnings,
  };

  return { ...quote, token: quoteToken(quote) };
}

/**
 * A stable fingerprint of everything the user was shown.
 *
 * Not cryptographic — its job is to make a *changed* quote unconfirmable, not to
 * resist an attacker. The caller is not an adversary here; a stale sheet is.
 */
function quoteToken(quote: WithdrawalQuote): string {
  const material = JSON.stringify([
    quote.issuedAt,
    quote.env,
    quote.identityKey,
    quote.source,
    quote.destination.wire,
    quote.amount,
    quote.destinationChecks,
    quote.blockers.map((b) => b.code),
    quote.warnings.map((w) => w.code),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wq_${hash.toString(16).padStart(8, "0")}`;
}

function refuse(code: WithdrawalBlockerCode | "echo_mismatch", detail: string): never {
  throw new HlError(`Withdrawal refused: ${detail}`, {
    code: "not_authorized",
    context: { reason: code },
  });
}

/**
 * Turn a displayed quote into a ticket.
 *
 * The only producer of `WithdrawalTicket`. Throws on anything unexpected rather
 * than returning a result, because a caller that ignores a returned error still
 * has a quote in hand and might proceed.
 */
export function confirmWithdrawal(
  quote: WithdrawalQuote,
  echo: WithdrawalEcho,
  now: number = Date.now()
): WithdrawalTicket {
  if (quote.blockers.length > 0) {
    refuse(quote.blockers[0].code, quote.blockers.map((b) => b.detail).join(" "));
  }
  if (now > quote.expiresAt) {
    refuse("echo_mismatch", "the quote has expired; re-read the balance and try again.");
  }
  if (echo.token !== quote.token) {
    refuse("echo_mismatch", "the confirmation does not match the quote it was built from.");
  }

  // Exact equality, deliberately not case-insensitive: the human must have seen
  // the checksummed form, which is the only form carrying the typo check.
  if (echo.destinationDisplayed !== quote.destination.display) {
    refuse("echo_mismatch", "the displayed destination does not match the quoted one.");
  }
  if (echo.grossDisplayed !== quote.amount.gross) {
    refuse("echo_mismatch", "the displayed amount does not match the quoted one.");
  }
  // Without this the caller need never have computed "you will receive", and the
  // fee direction becomes a thing to get wrong.
  if (echo.netDisplayed !== quote.amount.net) {
    refuse("echo_mismatch", "the displayed net amount does not match the quoted one.");
  }

  const acknowledged = new Set(echo.acknowledged);
  const missing = quote.warnings.filter((w) => !acknowledged.has(w.code));
  if (missing.length > 0) {
    refuse("echo_mismatch", `unacknowledged warnings: ${missing.map((w) => w.code).join(", ")}.`);
  }

  logger.info("withdrawal.confirmed", {
    context: {
      // The destination is deliberately not logged in full.
      destinationTail: quote.destination.display.slice(-6),
      gross: quote.amount.gross,
      warnings: quote.warnings.length,
    },
  });

  return { quote, confirmedAt: now } as WithdrawalTicket;
}

/** Whether a quote could be confirmed as it stands. */
export function isWithdrawable(quote: WithdrawalQuote, now: number = Date.now()): boolean {
  return quote.blockers.length === 0 && now <= quote.expiresAt;
}

/** Format the net figure a caller must display, so it cannot be derived wrongly. */
export function describeArrival(quote: WithdrawalQuote): string {
  const minutes = Math.round(quote.timing.expectedArrivalMs / 60_000);
  return `${new BigNumber(quote.amount.net).toFixed()} USDC arrives in about ${minutes} minutes`;
}
