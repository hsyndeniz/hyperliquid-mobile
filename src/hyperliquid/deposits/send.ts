/**
 * Building and sending the deposit transaction.
 *
 * Split from the wallet on purpose. {@link buildDepositCall} is pure — it turns a
 * ticket into the exact call to make — and {@link sendDeposit} hands that to
 * whatever can sign on Arbitrum. Today that is the local key; WalletConnect drops
 * into the same seam without touching anything here, because the interface is
 * three fields wide.
 *
 * Two rules the shape enforces rather than documents:
 *
 * 1. **A ticket is the only input.** There is no overload taking an address and
 *    an amount, so nothing can reach the chain without having been quoted,
 *    displayed and confirmed. `preflight.ts` is the only producer of one.
 * 2. **The chain is re-read from the wallet immediately before signing.** An
 *    earlier version of this file passed `chainId` into `writeContract` and
 *    claimed viem would refuse a mismatched chain. **It does not.** viem asserts
 *    against `client.chain`, configured when the wallet client is built; the
 *    `chainId` field falls into `...rest` and is used only by the nonce manager
 *    (`viem/_esm/actions/wallet/sendTransaction.js:167`). So a wallet client built
 *    without `chain: arbitrum` would have signed on whatever network it happened
 *    to be on. {@link DepositWallet} therefore requires `getChainId()`, and
 *    {@link sendDeposit} checks it against the ticket at the moment of signing —
 *    a guard that belongs to this module rather than to a library's internals.
 *
 * **There is no retry helper, deliberately** — the same rule the withdrawal path
 * follows. A transfer has no idempotency key: re-sending is not a retry, it is a
 * second deposit. When a send's outcome is unknown, the resolution is to look for
 * the transaction, never to send again.
 */

import { log } from "@/hyperliquid/core/logger";
import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { toBaseUnits, type DepositTicket } from "@/hyperliquid/deposits/preflight";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("deposits.send");

/** The minimal ERC-20 fragment this path needs. Inlined so no ABI file can drift. */
export const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * The exact transaction a deposit is.
 *
 * `to` is the **USDC contract**, not the bridge — a point worth stating because
 * it reads backwards: the bridge is an *argument*, because moving an ERC-20 means
 * calling the token and telling it who to credit. Sending native ETH to the
 * bridge address instead is a different transaction entirely, and one this shape
 * cannot express.
 */
export interface DepositCall {
  readonly chainId: number;
  /** The USDC contract. */
  readonly to: Hex;
  readonly abi: typeof ERC20_TRANSFER_ABI;
  readonly functionName: "transfer";
  /** `[bridge, baseUnits]`. */
  readonly args: readonly [Hex, bigint];
  /** Always zero: this moves a token, not the chain's native coin. */
  readonly value: 0n;
}

/**
 * Turn a confirmed ticket into the call to make. Pure.
 *
 * The transferred integer is **re-derived from `quote.amount`**, the string the
 * user read and echoed back, rather than read from `quote.baseUnits`.
 * `confirmDeposit` verifies `amountDisplayed` against `amount`; it never verifies
 * `baseUnits`, so trusting that field would let a quote whose two amount
 * representations disagree confirm cleanly and transfer a different number than
 * the one displayed. `baseUnits` on the quote is now a display aid, and this is
 * the only value that reaches the chain.
 */
export function buildDepositCall(ticket: DepositTicket): DepositCall {
  return {
    chainId: ticket.network.chainId,
    to: ticket.network.usdc,
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [
      ticket.network.bridge,
      BigInt(toBaseUnits(ticket.quote.amount, ticket.network.usdcDecimals)),
    ],
    value: 0n,
  };
}

/**
 * The slice of a viem wallet client this needs.
 *
 * `getChainId` is **not optional**, and that is the whole point: viem does not
 * enforce the `chainId` passed to `writeContract` (see the module note), so
 * without asking the wallet directly there is no signing-time chain guard at all.
 * A viem `WalletClient` satisfies this as-is; so does a WalletConnect signer and
 * a test double.
 */
export interface DepositWallet {
  getChainId(): Promise<number>;
  writeContract(call: {
    chainId: number;
    address: Hex;
    abi: typeof ERC20_TRANSFER_ABI;
    functionName: "transfer";
    args: readonly [Hex, bigint];
  }): Promise<Hex>;
}

/**
 * What happened to a send.
 *
 * `unknown` is not a failure. The transaction may be in the mempool and may
 * confirm — so the resolution is to look for it by hash or by watching the
 * account, never to send again.
 */
export type DepositSendOutcome =
  | { kind: "sent"; hash: Hex; at: number }
  | { kind: "rejected"; error: HlError }
  | { kind: "unknown"; error: HlError; at: number };

/**
 * Send the deposit.
 *
 * Only a **provably pre-broadcast** refusal is `rejected` — the user declining
 * the prompt, a chain mismatch, or a reverting simulation. Everything else is
 * `unknown`, including anything unrecognised, because the cost of the two
 * mistakes is not symmetric: a needless "check for the transaction" prompt
 * against a second irreversible deposit.
 */
export async function sendDeposit(params: {
  wallet: DepositWallet;
  ticket: DepositTicket;
  now?: () => number;
}): Promise<DepositSendOutcome> {
  const at = (params.now ?? Date.now)();
  const call = buildDepositCall(params.ticket);

  // Asked of the wallet itself, at the last possible moment. The preflight
  // checked a chain id the caller reported, which was true whenever it was read;
  // this one cannot be stale, and viem will not do it for us.
  try {
    const walletChain = await params.wallet.getChainId();
    if (walletChain !== call.chainId) {
      const error = new HlError(
        `Wallet is on chain ${walletChain}; this deposit must be sent on chain ${call.chainId}`,
        { code: "not_authorized", context: { walletChain, expected: call.chainId } }
      );
      logger.warn("deposit.wrong_chain", { error });
      return { kind: "rejected", error };
    }
  } catch (error) {
    // Could not establish the chain. Nothing has been sent, so this is
    // correctable — but it must not proceed on an unknown chain.
    const hl = toHlError(error, { stage: "depositChainCheck" });
    logger.warn("deposit.chain_unreadable", { error: hl });
    return { kind: "rejected", error: hl };
  }

  try {
    const hash = await params.wallet.writeContract({
      chainId: call.chainId,
      address: call.to,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    });
    logger.info("deposit.sent", {
      context: { chainId: call.chainId, amount: params.ticket.quote.amount, hash },
    });
    return { kind: "sent", hash, at };
  } catch (error) {
    const hl = toHlError(error, { stage: "depositTransfer" });
    // Proof that nothing was broadcast — a declined prompt, a chain mismatch, a
    // reverting simulation. Anything short of proof falls through to `unknown`.
    if (isDeclined(error)) {
      logger.info("deposit.declined", { error: hl });
      return { kind: "rejected", error: hl };
    }
    logger.warn("deposit.unknown", { error: hl });
    return { kind: "unknown", error: hl, at };
  }
}

/**
 * Errors that can **only** be raised before a transaction is broadcast.
 *
 * Deliberately short. Each one is a refusal that happens while the request is
 * still local — the user declining the prompt, the wallet noticing it is on the
 * wrong chain, or a simulation reverting. None of them can follow a transaction
 * that reached the mempool.
 *
 * `ContractFunctionExecutionError` and `TransactionExecutionError` are **not**
 * here, and an earlier version's inclusion of them was the worst defect in this
 * phase — see {@link isDeclined}.
 */
const PRE_BROADCAST_ERRORS = new Set([
  "UserRejectedRequestError",
  "ChainMismatchError",
  "ChainNotFoundError",
  "ContractFunctionRevertedError",
]);

/** EIP-1193's "user rejected request", for providers that report a code and no name. */
const USER_REJECTED_CODE = 4001;

/**
 * Whether the wallet provably refused **before broadcasting**.
 *
 * This function decides whether a user is told "nothing was sent, try again", and
 * getting it wrong in that direction produces a second irreversible deposit. So
 * it answers `true` only on positive proof, and `false` — meaning `unknown` — for
 * everything else, including anything it does not recognise.
 *
 * **It walks the cause chain, and must.** viem's `writeContract` wraps *every*
 * failure from `sendTransaction` in a `ContractFunctionExecutionError`
 * (`viem/_esm/actions/wallet/writeContract.js:78-88` calls `getContractError`,
 * which ends `return new ContractFunctionExecutionError(cause, …)` for every
 * input). Matching the outer `name` therefore matches everything: an earlier
 * version accepted that class, which made `unknown` unreachable for a real viem
 * wallet and classified a broadcast-then-timeout as "safe to retry". A 250 USDC
 * deposit that stalled after reaching the mempool would have been re-sent, and
 * both transactions would have confirmed.
 *
 * The real signal is nested. A declined prompt arrives as
 * `ContractFunctionExecutionError -> TransactionExecutionError -> UserRejectedRequestError`;
 * a lost response arrives as the same wrapper over a `TimeoutError` or
 * `HttpRequestError`. Only the leaf distinguishes them.
 */
function isDeclined(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const node = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof node.name === "string" && PRE_BROADCAST_ERRORS.has(node.name)) return true;
    if (node.code === USER_REJECTED_CODE) return true;
    current = node.cause;
  }
  return false;
}
