/**
 * The vault deposit and withdrawal contract.
 *
 * Mirrors `transfers/preflight.ts` — quote, echo, unforgeable ticket — because
 * the shape of the risk is the same: a signature that cannot be recalled. What
 * differs is *which* mistake it defends against.
 *
 * A withdrawal's hazard is a **mistyped address**, so that preflight enforces
 * EIP-55 on user input. A vault deposit's hazard is the opposite: the address is
 * never typed, it is **picked from a list** — and the list contains an
 * impersonator. `"Hyperliquidity Provider(HLP)"` sits beside the real
 * `"Hyperliquidity Provider (HLP)"` on mainnet today, one space apart, and
 * Hyperliquid's global name-uniqueness rule makes a name *look* like an identity.
 * A user who recognises a vault by name can fund the wrong one, irreversibly and
 * with a 24-hour lockup.
 *
 * So the echo demands both the **checksummed address** and the **name as
 * displayed**, and a colliding name raises a warning the caller must explicitly
 * acknowledge — it cannot be skipped silently.
 *
 * It is a warning rather than a blocker, and that was a correction: blocking was
 * the first implementation, and measuring it showed **222 of 9,467 mainnet vaults
 * (2.3%) share a name with another**, almost all of them innocent —
 * `"DeFiVoyager"` beside `"DeFi Voyager"`, `"Down Only"` beside `"DownOnly"`.
 * Blocking makes every one of them undepositable through this client, which is a
 * functional regression, while the address echo already guarantees the user was
 * shown the distinguishing information. The warning is what makes them *look* at
 * it.
 *
 * Two disclosures the wire will not make for you:
 *
 * - **A deposit restarts the lockup on the whole balance**, not just the new
 *   money. Topping up $10 on a $10,000 position re-locks all of it — and the
 *   window is not a single number: ordinary vaults lock for 24 h, HLP for 96 h,
 *   both measured. The disclosure quotes the longer one, because it cannot be
 *   known which applies until the deposit lands.
 * - **The withdrawal net is an estimate.** A profit share is charged at
 *   withdrawal on the profit portion, and `alwaysCloseOnWithdraw` can close
 *   positions proportionally, so the amount that arrives can differ from the
 *   amount requested. This project has not measured the arithmetic, so nothing
 *   here promises a figure.
 */

import { getAddress } from "viem";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { chunkAddress, sameAddress } from "@/hyperliquid/transfers/destination";
import type { WireAmount } from "@/hyperliquid/transfers/types";
import { withinBalance } from "@/hyperliquid/transfers/amount";
import { lockupState, VAULT_LOCKUP_MS, type LockupState } from "@/hyperliquid/vaults/lockup";
import { normaliseVaultName } from "@/hyperliquid/vaults/list";
import type { VaultAddress, VaultSummary } from "@/hyperliquid/vaults/types";

const logger = log.child("vaults.preflight");

/** How long a quote's facts may be considered current. */
export const VAULT_QUOTE_TTL_MS = 60_000;

export type VaultBlockerCode =
  /** The vault is closed, or has deposits switched off. */
  | "vault_not_accepting_deposits"
  /** The funds are still locked, or the lockup could not be determined. */
  | "vault_locked"
  | "amount_not_positive"
  | "insufficient_balance"
  /** Withdrawing more than the position holds. */
  | "exceeds_position"
  /**
   * A sub-account is selected, and a vault transfer cannot be routed to one.
   *
   * `vaultTransfer` carries no `vaultAddress` field, so the agent signs on
   * behalf of the MASTER — measured, not inferred: a $5 agent-signed deposit
   * moved the master's perp balance 11.0 -> 6.0 and put the position on the
   * master (`vaults/transfer.ts`). The screen meanwhile quotes against the
   * sub-account's balance and refreshes the sub-account's equities afterwards,
   * where nothing appears.
   *
   * A blocker rather than predictions' acknowledged warning, because the
   * QUOTE itself is computed against the wrong balance: the amount can exceed
   * what the master holds, or be refused while the master has plenty. Letting
   * someone confirm a figure derived from the wrong account is worse than
   * asking them to switch. `transfers/preflight.ts` blocks the same hazard for
   * the same reason.
   */
  | "vault_acts_on_master_account";

export type VaultWarningCode =
  /** Another vault displays a name a user could not tell apart from this one. */
  | "name_shared_with_other_vaults"
  /** The directory was unavailable, so the name could not be checked at all. */
  | "name_not_checked"
  /** A deposit restarts the lockup on the ENTIRE balance. */
  | "lockup_restarts_on_whole_balance"
  /** First deposit into this vault; the lockup begins now. */
  | "funds_lock_after_deposit"
  /** The amount that arrives is not the amount requested. */
  | "net_is_an_estimate"
  /** Withdrawal closes positions proportionally rather than using free margin. */
  | "closes_positions_on_withdraw"
  /** Below the advisory follower minimum; the server may refuse. */
  | "below_advisory_minimum";

export interface VaultBlocker {
  code: VaultBlockerCode;
  detail: string;
}

export interface VaultWarning {
  code: VaultWarningCode;
  detail: string;
}

export interface VaultQuote {
  /** A correctness join over every field below, not a secret. */
  readonly token: string;
  readonly kind: "deposit" | "withdraw";
  readonly issuedAt: number;
  readonly expiresAt: number;

  readonly vault: {
    readonly wire: VaultAddress;
    /** EIP-55 checksummed — what a human verifies, and what the echo must match. */
    readonly display: string;
    /** Four-character groups, because nobody compares 40 raw hex characters. */
    readonly chunks: readonly string[];
    /** Verbatim from the wire, untrimmed. */
    readonly name: string;
  };

  /** The amount, as a decimal string. Converted to micro-USD only at the wire. */
  readonly amount: WireAmount;
  readonly lockup: LockupState;
  readonly blockers: readonly VaultBlocker[];
  readonly warnings: readonly VaultWarning[];
}

/** What the caller must send back to proceed. Every field is re-derived. */
export interface VaultEcho {
  readonly token: string;
  /**
   * The address the caller **displayed**, compared by exact string equality
   * against the checksummed form.
   *
   * This is the whole defence against the impersonator. A caller that showed only
   * the name cannot produce this, and a caller that lowercased it fails here —
   * which is the point: the human must have been shown the address.
   */
  readonly vaultAddressDisplayed: string;
  /** The name the caller displayed, so a swapped row cannot pass. */
  readonly vaultNameDisplayed: string;
  readonly amountDisplayed: string;
  /** Must contain every code in `quote.warnings`. A superset is fine. */
  readonly acknowledged: readonly VaultWarningCode[];
}

declare const VaultTicketBrand: unique symbol;

/** Proof that a quote was built, displayed and confirmed. */
export interface VaultTicket {
  readonly [VaultTicketBrand]: true;
  readonly quote: VaultQuote;
  readonly confirmedAt: number;
}

function checksum(address: string): string {
  // The vault address comes from our own list, always lowercase, so this is a
  // rendering step rather than a validation one — unlike a withdrawal
  // destination, where the casing carries the typo check.
  return getAddress(address);
}

/**
 * The address as the user will see it.
 *
 * The chunks are cut from the **checksummed** form, not the lowercase wire form.
 * Chunking exists so a human can actually compare 40 hex characters — groups
 * whose casing differs from the address printed beside them defeat that, and the
 * mismatch is invisible on an all-digit address.
 */
function vaultFacts(vault: { address: VaultAddress; name: string }): VaultQuote["vault"] {
  const display = checksum(vault.address);
  return {
    wire: vault.address,
    display,
    chunks: chunkAddress(display),
    name: vault.name,
  };
}

function token(quote: Omit<VaultQuote, "token">): string {
  const material = JSON.stringify([
    quote.kind,
    quote.issuedAt,
    quote.vault.wire,
    quote.vault.name,
    quote.amount,
    quote.lockup,
    quote.blockers.map((b) => b.code),
    quote.warnings.map((w) => w.code),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `vq_${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Vaults whose displayed name is indistinguishable from this one's.
 *
 * Compared with `normaliseVaultName`, which strips whitespace rather than
 * collapsing it — the live impersonator differs by a *missing* space, which
 * collapsing does not catch.
 */
function ambiguousWith(
  vault: { address: VaultAddress; name: string },
  known: readonly VaultSummary[]
): VaultSummary[] {
  const key = normaliseVaultName(vault.name);
  return known.filter(
    (other) => !sameAddress(other.address, vault.address) && normaliseVaultName(other.name) === key
  );
}

export interface DepositQuoteParams {
  vault: {
    address: VaultAddress;
    name: string;
    isClosed: boolean;
    allowDeposits: boolean;
  };
  amount: WireAmount;
  /** The user's spendable perp USDC. */
  available: WireAmount;
  /**
   * The sub-account being acted as, or `null` for the main account.
   *
   * Required, not optional: a caller that forgets it would silently reproduce
   * the bug this blocker exists for.
   */
  actingSubAccount: string | null;
  /**
   * The user's existing position in this vault, if any.
   *
   * Present means the deposit **re-locks an existing balance**, which is a
   * different disclosure from locking new money.
   */
  existingPosition?: { equity: string; lockedUntilMs: number } | null;
  /**
   * The vault directory, for the impersonation check.
   *
   * Omitted, the check cannot run and the quote says so by blocking — a name
   * that has not been checked against anything is not a name that has been
   * cleared.
   */
  known?: readonly VaultSummary[];
  /** The deposit floor to warn below. `MIN_VAULT_DEPOSIT_USDC` is the measured one. */
  minimumDeposit?: string;
  now?: () => number;
}

/**
 * Quote a deposit.
 *
 * Returns a quote even when it is unusable: the blockers are the useful output in
 * that case, and throwing would leave the caller nothing to render.
 */
export function buildDepositQuote(params: DepositQuoteParams): VaultQuote {
  const now = (params.now ?? Date.now)();
  const blockers: VaultBlocker[] = [];
  const warnings: VaultWarning[] = [];

  if (params.actingSubAccount !== null) {
    blockers.push({
      code: "vault_acts_on_master_account",
      detail: "Vault transfers act on your main account. Switch to it first.",
    });
  }

  if (params.vault.isClosed || !params.vault.allowDeposits) {
    // Two independent axes — `allowDeposits` stays true on most closed vaults —
    // so one message covers both rather than implying either is decisive.
    blockers.push({
      code: "vault_not_accepting_deposits",
      detail: params.vault.isClosed
        ? "This vault is closed."
        : "This vault is not accepting deposits.",
    });
  }

  if (params.known === undefined) {
    // "We could not check" must never render as "checked and clean", so it is
    // still surfaced and still has to be acknowledged.
    warnings.push({
      code: "name_not_checked",
      detail:
        "The vault list was not available, so this name could not be checked. Verify the address.",
    });
  } else {
    const clashes = ambiguousWith(params.vault, params.known);
    if (clashes.length > 0) {
      warnings.push({
        code: "name_shared_with_other_vaults",
        detail:
          clashes.length === 1
            ? "Another vault displays the same name. Check the address."
            : `${clashes.length} other vaults display the same name. Check the address.`,
      });
    }
  }

  if (!withinBalance(params.amount, params.available)) {
    blockers.push({
      code: "insufficient_balance",
      detail: `Only ${params.available} USDC is available.`,
    });
  }

  const existing = params.existingPosition;
  if (existing) {
    warnings.push({
      code: "lockup_restarts_on_whole_balance",
      detail: `This restarts the lockup on your whole position, not just the new deposit.`,
    });
  } else {
    warnings.push({
      code: "funds_lock_after_deposit",
      // The MAXIMUM, not the typical. Which window applies is not knowable before
      // the deposit lands, and telling a user 24 h on a vault that locks for 96 h
      // promises their money back three days early.
      detail: `Deposited funds are locked, for up to ${Math.round(VAULT_LOCKUP_MS.maximum / 3_600_000)} hours.`,
    });
  }

  if (params.minimumDeposit && !withinBalance(params.minimumDeposit as WireAmount, params.amount)) {
    warnings.push({
      code: "below_advisory_minimum",
      detail: `Vault deposits start at ${params.minimumDeposit} USDC; the exchange will refuse this.`,
    });
  }

  return finish({
    kind: "deposit",
    issuedAt: now,
    expiresAt: now + VAULT_QUOTE_TTL_MS,
    vault: vaultFacts(params.vault),
    amount: params.amount,
    // The lockup that will apply AFTER this deposit is not knowable client-side;
    // the disclosure above carries that. What is quoted is the state right now.
    lockup: lockupState(existing?.lockedUntilMs, now),
    blockers,
    warnings,
  });
}

export interface WithdrawQuoteParams {
  vault: {
    address: VaultAddress;
    name: string;
    alwaysCloseOnWithdraw: boolean;
  };
  amount: WireAmount;
  position: { equity: string; lockedUntilMs: number };
  /** As on {@link DepositQuoteParams} — required for the same reason. */
  actingSubAccount: string | null;
  now?: () => number;
}

/** Quote a withdrawal. */
export function buildWithdrawQuote(params: WithdrawQuoteParams): VaultQuote {
  const now = (params.now ?? Date.now)();
  const blockers: VaultBlocker[] = [];
  const warnings: VaultWarning[] = [];

  if (params.actingSubAccount !== null) {
    blockers.push({
      code: "vault_acts_on_master_account",
      detail: "Vault transfers act on your main account. Switch to it first.",
    });
  }

  const lockup = lockupState(params.position.lockedUntilMs, now);
  if (lockup.kind === "locked") {
    blockers.push({
      code: "vault_locked",
      detail: "These funds are still locked.",
    });
  } else if (lockup.kind === "unknown") {
    // A missing timestamp is not permission. Blocking here means a wire change
    // surfaces as an explainable refusal rather than as failed signatures.
    blockers.push({
      code: "vault_locked",
      detail: "The lockup on these funds could not be determined.",
    });
  }

  if (!withinBalance(params.amount, params.position.equity)) {
    blockers.push({
      code: "exceeds_position",
      detail: `Your position holds ${params.position.equity} USDC.`,
    });
  }

  // Always. A profit share is charged at withdrawal on the profit portion, and
  // this project has not measured the arithmetic — so no figure is promised.
  warnings.push({
    code: "net_is_an_estimate",
    detail: "A performance fee is taken on profit, so the amount that arrives may be lower.",
  });

  if (params.vault.alwaysCloseOnWithdraw) {
    warnings.push({
      code: "closes_positions_on_withdraw",
      detail: "This vault closes positions to fund withdrawals, which can move the final amount.",
    });
  }

  return finish({
    kind: "withdraw",
    issuedAt: now,
    expiresAt: now + VAULT_QUOTE_TTL_MS,
    vault: vaultFacts(params.vault),
    amount: params.amount,
    lockup,
    blockers,
    warnings,
  });
}

function finish(quote: Omit<VaultQuote, "token">): VaultQuote {
  return { ...quote, token: token(quote) };
}

function refuse(code: VaultBlockerCode | "echo_mismatch", detail: string): never {
  throw new HlError(`Refused: ${detail}`, {
    code: "not_authorized",
    context: { reason: code },
  });
}

/**
 * Turn a displayed quote into a ticket.
 *
 * The only producer of `VaultTicket`. Throws rather than returning a result: a
 * caller that ignores a returned error still holds a quote and might proceed.
 */
export function confirmVaultTransfer(
  quote: VaultQuote,
  echo: VaultEcho,
  now: number = Date.now()
): VaultTicket {
  if (quote.blockers.length > 0) {
    refuse(quote.blockers[0].code, quote.blockers.map((b) => b.detail).join(" "));
  }
  if (now > quote.expiresAt) {
    refuse("echo_mismatch", "the quote has expired; re-read the position and try again.");
  }
  if (echo.token !== quote.token) {
    refuse("echo_mismatch", "the confirmation does not match the quote it was built from.");
  }

  // Exact equality against the CHECKSUMMED form. A caller that displayed only the
  // name, or lowercased the address, fails here — which is the whole defence
  // against funding an impersonator.
  if (echo.vaultAddressDisplayed !== quote.vault.display) {
    refuse("echo_mismatch", "the displayed vault address does not match the quoted one.");
  }
  if (echo.vaultNameDisplayed !== quote.vault.name) {
    refuse("echo_mismatch", "the displayed vault name does not match the quoted one.");
  }
  if (echo.amountDisplayed !== quote.amount) {
    refuse("echo_mismatch", "the displayed amount does not match the quoted one.");
  }

  const acknowledged = new Set(echo.acknowledged);
  const missing = quote.warnings.filter((w) => !acknowledged.has(w.code));
  if (missing.length > 0) {
    refuse("echo_mismatch", `unacknowledged warnings: ${missing.map((w) => w.code).join(", ")}.`);
  }

  logger.info("vault.confirmed", {
    context: {
      kind: quote.kind,
      // Deliberately not the full address.
      vaultTail: quote.vault.display.slice(-6),
      amount: quote.amount,
      warnings: quote.warnings.length,
    },
  });

  return { quote, confirmedAt: now } as VaultTicket;
}

/** Whether a quote could be confirmed as it stands. */
export function isConfirmable(quote: VaultQuote, now: number = Date.now()): boolean {
  return quote.blockers.length === 0 && now <= quote.expiresAt;
}
