/**
 * The deposit contract.
 *
 * Quote, echo, unforgeable ticket — the third instance of the pattern, after
 * `transfers/preflight.ts` and `vaults/preflight.ts`. What it defends against is
 * different again, and worse than either:
 *
 * A withdrawal's hazard is a mistyped destination, and a vault deposit's is
 * picking the wrong row from a list. Both are Hyperliquid actions, so a wrong one
 * usually produces a refusal. **A deposit is not a Hyperliquid action at all** —
 * it is an ERC-20 transfer on Arbitrum, and every failure mode succeeds:
 *
 * | Mistake | What happens |
 * | --- | --- |
 * | Wrong chain | The transfer confirms. Nothing watches that address there. |
 * | Wrong token | Confirms. The bridge takes USDC and nothing else. |
 * | Below the floor | Confirms. Not credited, and nobody has shown it comes back. |
 * | Wrong decimals | Confirms, for a millionth of the intended amount. |
 *
 * None of those throws, reverts, or produces an error a caller could catch. So
 * the checks have to happen before the transaction is built, which is here.
 *
 * **The bridge address is never a parameter.** It comes from
 * {@link depositNetwork} and only from there. A deposit form with a destination
 * field is a phishing surface, and the address is not something a user should be
 * asked to get right.
 */

import { BigNumber } from "bignumber.js";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { canonicalAmount } from "@/hyperliquid/transfers/amount";
import { chunkAddress } from "@/hyperliquid/transfers/destination";
import type { WireAmount } from "@/hyperliquid/transfers/types";
import {
  depositNetwork,
  MIN_DEPOSIT_USDC,
  type DepositNetwork,
} from "@/hyperliquid/deposits/network";
import type { HlEnv } from "@/hyperliquid/types/domain";

const logger = log.child("deposits.preflight");

/** How long a quote's facts may be considered current. */
export const DEPOSIT_QUOTE_TTL_MS = 60_000;

export type DepositBlockerCode =
  /** Below the measured floor — very likely credited to nobody. */
  | "below_minimum"
  /** More USDC than the wallet holds on the deposit chain. */
  | "insufficient_usdc"
  /** No native token to pay gas with, so the transfer cannot be sent. */
  | "no_gas"
  /** The wallet is on a different chain. Sending anyway loses the money. */
  | "wrong_chain"
  /** This environment has no verified bridge address. */
  | "network_unavailable";

export type DepositWarningCode =
  /** Deposits credit the perp balance, not spot. */
  | "credits_perp_balance"
  /** Nothing can cancel or reverse an ERC-20 transfer. */
  | "irreversible"
  /** Balances were not supplied, so the sufficiency checks did not run. */
  | "balances_not_checked";

export interface DepositBlocker {
  code: DepositBlockerCode;
  detail: string;
}

export interface DepositWarning {
  code: DepositWarningCode;
  detail: string;
}

export interface DepositQuote {
  /** A correctness join over every field below, not a secret. */
  readonly token: string;
  readonly issuedAt: number;
  readonly expiresAt: number;

  readonly network: {
    readonly chainId: number;
    readonly chainName: string;
    /** The USDC contract the transfer is sent to. */
    readonly usdc: string;
    /** The bridge, from config and never from input. */
    readonly bridge: string;
    /** Four-character groups, because nobody compares 40 raw hex characters. */
    readonly bridgeChunks: readonly string[];
  } | null;

  /** Human decimal, exactly as it will be shown and converted. */
  readonly amount: WireAmount;
  /** Base units — what the token contract actually moves. */
  readonly baseUnits: string;
  /**
   * What arrives. Equal to `amount`: there is no deposit fee, measured.
   *
   * Present anyway so a screen never has to decide whether to subtract one, and
   * so the asymmetry with withdrawals is stated rather than assumed.
   */
  readonly credited: WireAmount;
  readonly blockers: readonly DepositBlocker[];
  readonly warnings: readonly DepositWarning[];
}

/** What the caller must send back to proceed. Every field is re-derived. */
export interface DepositEcho {
  readonly token: string;
  /**
   * The chain the wallet is actually on, read at confirm time.
   *
   * Not the chain the caller intends — the one it is connected to. This is the
   * check that a UI cannot fake by rendering the right label.
   */
  readonly walletChainId: number;
  /** The bridge address the caller **displayed**, compared exactly. */
  readonly bridgeDisplayed: string;
  readonly amountDisplayed: string;
  /** Must contain every code in `quote.warnings`. A superset is fine. */
  readonly acknowledged: readonly DepositWarningCode[];
}

declare const DepositTicketBrand: unique symbol;

/** Proof that a quote was built, displayed and confirmed. The only key to the wire. */
export interface DepositTicket {
  readonly [DepositTicketBrand]: true;
  readonly quote: DepositQuote;
  readonly network: DepositNetwork;
  readonly confirmedAt: number;
}

function token(quote: Omit<DepositQuote, "token">): string {
  const material = JSON.stringify([
    quote.issuedAt,
    quote.network,
    quote.amount,
    quote.baseUnits,
    quote.blockers.map((b) => b.code),
    quote.warnings.map((w) => w.code),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `dq_${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Convert a decimal amount to token base units, exactly.
 *
 * Deliberately not `viem`'s `parseUnits`: this refuses rather than truncating. A
 * user typing seven decimals of USDC has asked for something the token cannot
 * represent, and silently dropping the last digit signs a different number than
 * the one they read.
 */
export function toBaseUnits(amount: WireAmount, decimals: number): string {
  const scaled = new BigNumber(amount).shiftedBy(decimals);
  if (!scaled.isInteger()) {
    throw new HlError(`Deposit amount ${amount} has more precision than USDC can represent`, {
      code: "validation_error",
      context: { amount, decimals },
    });
  }
  return scaled.toFixed();
}

export interface DepositQuoteParams {
  env: HlEnv;
  /** The user's typed amount. */
  amount: string | BigNumber;
  /**
   * USDC held on the deposit chain, as a decimal string.
   *
   * Omit and the sufficiency check does not run — which is surfaced as a warning
   * rather than passing silently.
   */
  availableUsdc?: string;
  /** Native gas balance, as a decimal string. Omit to skip the check. */
  availableGas?: string;
  now?: () => number;
}

/**
 * Quote a deposit.
 *
 * Returns a quote even when it is unusable — the blockers are the useful output
 * in that case, and throwing would leave a caller nothing to render.
 */
export function buildDepositQuote(params: DepositQuoteParams): DepositQuote {
  const now = (params.now ?? Date.now)();
  const blockers: DepositBlocker[] = [];
  const warnings: DepositWarning[] = [];

  const amount = canonicalAmount(params.amount, "deposit amount");

  let network: DepositNetwork | null = null;
  try {
    network = depositNetwork(params.env);
  } catch {
    blockers.push({
      code: "network_unavailable",
      detail: "Deposits are not available on this network yet.",
    });
  }

  // A block, not a warning. Nobody has shown that a sub-minimum deposit comes
  // back, and 1,371 observed deposits contain none — so this is not a risk to
  // hand to the user's judgement.
  if (new BigNumber(amount).lt(MIN_DEPOSIT_USDC)) {
    blockers.push({
      code: "below_minimum",
      detail: `Deposits start at ${MIN_DEPOSIT_USDC} USDC. Less may not be credited, and may not come back.`,
    });
  }

  if (params.availableUsdc === undefined || params.availableGas === undefined) {
    warnings.push({
      code: "balances_not_checked",
      detail: "Wallet balances were unavailable, so this was not checked against what you hold.",
    });
  }
  if (params.availableUsdc !== undefined && new BigNumber(amount).gt(params.availableUsdc)) {
    blockers.push({
      code: "insufficient_usdc",
      detail: `Only ${params.availableUsdc} USDC is available on ${network?.chainName ?? "the deposit chain"}.`,
    });
  }
  if (params.availableGas !== undefined && new BigNumber(params.availableGas).lte(0)) {
    // Distinct from having no USDC: the user has the money and still cannot move
    // it, which is a different thing to tell them.
    blockers.push({
      code: "no_gas",
      detail: `Sending needs a little ETH on ${network?.chainName ?? "the deposit chain"} for gas.`,
    });
  }

  warnings.push({
    code: "credits_perp_balance",
    detail: "Deposited USDC arrives in your perps balance, not spot.",
  });
  warnings.push({
    code: "irreversible",
    detail: "This is an on-chain transfer. It cannot be cancelled or reversed once sent.",
  });

  const quote: Omit<DepositQuote, "token"> = {
    issuedAt: now,
    expiresAt: now + DEPOSIT_QUOTE_TTL_MS,
    network: network
      ? {
          chainId: network.chainId,
          chainName: network.chainName,
          usdc: network.usdc,
          bridge: network.bridge,
          bridgeChunks: chunkAddress(network.bridge),
        }
      : null,
    amount,
    baseUnits: network ? toBaseUnits(amount, network.usdcDecimals) : "0",
    // No fee. Measured: 262.001324 sent, "262.001324" credited.
    credited: amount,
    blockers,
    warnings,
  };
  return { ...quote, token: token(quote) };
}

function refuse(code: DepositBlockerCode | "echo_mismatch", detail: string): never {
  throw new HlError(`Refused: ${detail}`, { code: "not_authorized", context: { reason: code } });
}

/**
 * Turn a displayed quote into a ticket.
 *
 * The only producer of `DepositTicket`, and `send.ts` accepts nothing else — so
 * no transaction can be built without having passed through here. Throws rather
 * than returning a result: a caller that ignores a returned error still holds a
 * quote and might proceed.
 */
export function confirmDeposit(
  quote: DepositQuote,
  echo: DepositEcho,
  env: HlEnv,
  now: number = Date.now()
): DepositTicket {
  if (quote.blockers.length > 0) {
    refuse(quote.blockers[0].code, quote.blockers.map((b) => b.detail).join(" "));
  }
  if (now > quote.expiresAt) {
    refuse("echo_mismatch", "the quote has expired; re-read your balances and try again.");
  }
  if (echo.token !== quote.token) {
    refuse("echo_mismatch", "the confirmation does not match the quote it was built from.");
  }

  const network = depositNetwork(env);

  // The wallet's ACTUAL chain, not the one the screen claimed. Sending USDC to
  // the bridge address on any other chain confirms successfully and is
  // unrecoverable, and it is the single most likely way to lose a deposit.
  if (echo.walletChainId !== network.chainId) {
    refuse(
      "wrong_chain",
      `your wallet is on chain ${echo.walletChainId}, and this must be sent on ${network.chainName} (${network.chainId}).`
    );
  }
  if (echo.bridgeDisplayed !== network.bridge) {
    refuse("echo_mismatch", "the displayed deposit address does not match the real one.");
  }
  if (echo.amountDisplayed !== quote.amount) {
    refuse("echo_mismatch", "the displayed amount does not match the quoted one.");
  }

  const acknowledged = new Set(echo.acknowledged);
  const missing = quote.warnings.filter((w) => !acknowledged.has(w.code));
  if (missing.length > 0) {
    refuse("echo_mismatch", `unacknowledged warnings: ${missing.map((w) => w.code).join(", ")}.`);
  }

  logger.info("deposit.confirmed", {
    context: { chainId: network.chainId, amount: quote.amount, warnings: quote.warnings.length },
  });

  return { quote, network, confirmedAt: now } as DepositTicket;
}

/** Whether a quote could be confirmed as it stands. */
export function isConfirmable(quote: DepositQuote, now: number = Date.now()): boolean {
  return quote.blockers.length === 0 && now <= quote.expiresAt;
}
