/**
 * What a withdrawal confirmation shows, and the echo built from exactly that.
 *
 * ## The property this file exists to guarantee
 *
 * > **Every value in the echo is also a row the user was shown.**
 *
 * `confirmWithdrawal` compares the echo against the quote by exact string
 * equality, including `netDisplayed` — its own header says *"a caller that never
 * computed 'you will receive' cannot produce `netDisplayed`, which closes the
 * fee-direction hazard by construction."*
 *
 * But the type only proves the value was **computed**, not that it was
 * **displayed**. A handler can assemble a perfectly valid echo having rendered
 * nothing — `diagnostics.tsx` does exactly that. There is no type for "this
 * string reached a pixel" and there cannot be.
 *
 * So rows and echo are produced by **one expression**, and a test asserts they
 * agree. That is the enforceable half, and it catches the real regressions:
 * someone wrapping the net in `toFixed(2)` in the JSX, or displaying
 * `destination.wire` because it looked tidier than the checksummed form.
 *
 * ## Why `display` and not `wire`
 *
 * `wire` is lowercase — what gets signed. `display` is EIP-55 checksummed, and
 * the checksum **is** the typo check: it is the only form where a
 * single-character substitution is detectable by eye or by code. Showing the
 * lowercase form throws that away, and `confirmWithdrawal` compares
 * case-sensitively precisely so a screen cannot.
 */

import { MIN_WITHDRAW_USDC_UI_FLOOR, WITHDRAW_FEE_USDC } from "@/hyperliquid/config/constants";
import { maxWithdrawable } from "@/hyperliquid/transfers/amount";
import type { WireAmount } from "@/hyperliquid/transfers/types";
import type {
  WithdrawalBlockerCode,
  WithdrawalEcho,
  WithdrawalQuote,
  WithdrawalWarningCode,
} from "@/hyperliquid/transfers/preflight";

export interface WithdrawRow {
  label: string;
  /**
   * The exact string. For the echoed rows this is byte-identical to what gets
   * confirmed — never reformatted, never rounded.
   */
  value: string;
  /**
   * A readable rendering of the same string, when the raw one defeats reading.
   * Concatenating these back yields `value` exactly, which a test pins: an
   * address is 42 characters that nobody compares unless they are grouped.
   */
  chunks?: readonly string[];
  /** Shown under the value where the number alone would mislead. */
  caveat?: string;
  /** The row a user checks hardest. */
  emphasis?: boolean;
}

export interface WithdrawAdvisory {
  tone: "danger" | "warning";
  code: WithdrawalBlockerCode | WithdrawalWarningCode;
  detail: string;
  /**
   * What the user can actually do about it.
   *
   * A blocker that only says "no" leaves the user stuck; `sub_account_context`
   * in particular is fixable in one step and the preflight already knows which.
   */
  remedy?: string;
}

/**
 * The way out of a blocker, where there is one.
 *
 * Named, not performed: sweeping a sub-account moves real money, so this screen
 * tells the user what to do rather than doing it for them.
 */
const REMEDIES: Partial<Record<WithdrawalBlockerCode, string>> = {
  sub_account_context:
    "Withdrawals go from the master account. Switch back to it, or sweep this sub-account's balance across first.",
  insufficient_balance:
    "If your USDC is in the spot balance, move it to perps below — withdrawals debit perps.",
  amount_below_ui_floor: `Withdrawals start at ${MIN_WITHDRAW_USDC_UI_FLOOR} USDC.`,
  withdrawal_in_flight:
    "A withdrawal is still settling. Wait for it to arrive rather than sending a second one.",
};

export type WithdrawConfirmation =
  /** Cannot proceed. There is deliberately **no echo** on this branch. */
  | { kind: "blocked"; rows: WithdrawRow[]; advisories: WithdrawAdvisory[] }
  /** Ready. `echo` values are all present in `rows`. */
  | {
      kind: "ready";
      rows: WithdrawRow[];
      advisories: WithdrawAdvisory[];
      echo: Omit<WithdrawalEcho, "acknowledged">;
      /** Every warning code the user must tick before committing. */
      mustAcknowledge: readonly WithdrawalWarningCode[];
    };

/**
 * Rows and echo, from one expression.
 *
 * The four `const`s below are the echo AND the row values. Nothing is
 * re-derived, re-formatted or re-read between them.
 */
export function describeWithdrawal(quote: WithdrawalQuote): WithdrawConfirmation {
  // These four are the echo. Every one is also a row value below.
  const destinationDisplayed = quote.destination.display;
  const grossDisplayed = quote.amount.gross;
  const netDisplayed = quote.amount.net;
  const token = quote.token;

  const rows: WithdrawRow[] = [
    {
      label: "To",
      // The CHECKSUMMED form — see the header.
      value: destinationDisplayed,
      // Four-character groups of that same string. `destination.chunks` is
      // derived from `display`, so this is a rendering of the echoed value, not
      // a second value.
      chunks: quote.destination.chunks,
      caveat: quote.destination.isSelf ? "This is your own address." : undefined,
      emphasis: true,
    },
    { label: "Amount", value: grossDisplayed },
    {
      label: "Fee",
      value: quote.amount.feeUsdc,
      caveat: "Taken out of the amount, not added to it.",
    },
    {
      label: "You receive",
      value: netDisplayed,
      emphasis: true,
    },
    {
      label: "Arrives",
      // From the quote's own timing, never a hardcoded "4 minutes".
      value: `in about ${Math.round(quote.timing.expectedArrivalMs / 60_000)} minutes`,
    },
  ];

  const advisories: WithdrawAdvisory[] = [
    ...quote.blockers.map((b) => ({
      tone: "danger" as const,
      code: b.code,
      detail: b.detail,
      remedy: REMEDIES[b.code],
    })),
    ...quote.warnings.map((w) => ({ tone: "warning" as const, code: w.code, detail: w.detail })),
  ];

  if (quote.blockers.length > 0) {
    // No echo on this branch, structurally: a blocked quote cannot be confirmed,
    // so the screen must not be able to pass one on.
    return { kind: "blocked", rows, advisories };
  }

  return {
    kind: "ready",
    rows,
    advisories,
    echo: { token, destinationDisplayed, grossDisplayed, netDisplayed },
    mustAcknowledge: quote.warnings.map((w) => w.code),
  };
}

export type MaxState =
  /** The balance cannot cover a withdrawal at all. */
  { kind: "unusable"; reason: string } | { kind: "usable"; gross: WireAmount };

/**
 * What Max should offer, and whether offering it is honest.
 *
 * `maxWithdrawable` returns the **whole balance as the gross**, deliberately
 * not fee-adjusted — `transfers/amount.ts` records that pre-subtracting the fee
 * "is the mistake that strands a dollar in the account permanently".
 *
 * The trap that falls out: `maxWithdrawable("1.5", "1")` returns `"1.5"`, which
 * then trips the UI floor. So *"Max returned a value"* is not the same as
 * *"Max is withdrawable"*, and a button wired straight to it offers an amount
 * the quote will refuse.
 */
export function maxState(
  available: string,
  uiFloor: string = MIN_WITHDRAW_USDC_UI_FLOOR
): MaxState {
  const gross = maxWithdrawable(available, WITHDRAW_FEE_USDC);
  if (gross === null) {
    return { kind: "unusable", reason: `The ${WITHDRAW_FEE_USDC} USDC fee is more than you have.` };
  }
  if (Number(gross) < Number(uiFloor)) {
    return {
      kind: "unusable",
      reason: `Withdrawals start at ${uiFloor} USDC; you have ${available}.`,
    };
  }
  return { kind: "usable", gross };
}
