/**
 * Depositing into and withdrawing from a vault.
 *
 * The wire is a single `vaultTransfer` with an `isDeposit` boolean, and that
 * boolean is **never exposed** — the same rule `subaccounts/transfer.ts` follows,
 * for the same reason. Here the stakes are higher: a flipped boolean does not
 * move money between two accounts the user owns, it either commits funds to a
 * third party's vault under a lockup, or pulls them out and closes a position.
 * Two named functions cannot be flipped.
 *
 * **Units are micro-USD**, `SafeInteger`, minimum 1 — byte-identical to
 * `subAccountTransfer.usd`, so the existing `MicroUsd` brand and `toMicroUsd`
 * apply unchanged. Passing `100` where `100_000_000` is meant deposits a
 * hundredth of a cent and validates cleanly.
 *
 * **Agent-signable — settled by experiment.** Every read-only approach failed to
 * distinguish the two signers, because Hyperliquid's vault refusals name no
 * address and both the master and a fresh agent hold zero. So it was settled the
 * only way left: a real $5 deposit into testnet HLP, signed by the **agent**. The
 * master's perp balance went 11.0 -> 6.0 and the $5 position appeared on the
 * **master**, while the agent stayed at zero. The L1 phantom-agent scheme applies
 * here exactly as it does to sub-account actions.
 *
 * So these route through the agent client and cost **no wallet prompt**.
 * `bun run probe:vault-signer` reproduces the experiment.
 *
 * The lockup is enforced **here**, not only in the preflight, because
 * `maxWithdrawable` reports a follower's full equity while the funds are still
 * locked — so every other signal a caller might reach for says "go".
 */

import { serverNow } from "@/hyperliquid/core/clock";
import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import type { AgentSignable, MicroUsd, TransferOutcome } from "@/hyperliquid/transfers/types";
import { assertUnlocked, type LockupState } from "@/hyperliquid/vaults/lockup";
import type { VaultAddress } from "@/hyperliquid/vaults/types";

const logger = log.child("vaults.transfer");

/**
 * The follower deposit floor: **$5, measured**.
 *
 * Distinct from the 100 USDC vault *creation* minimum, and absent from every wire
 * response — but the exchange states it outright when refusing. Probed on live
 * testnet at $0.000001, $0.01, $1 and $4.99, all four answered
 * `"Vault deposits must be at least $5."`
 *
 * Still used to **warn rather than to gate**. The number is measured, but it is
 * Hyperliquid's to change, and the two failure directions are not symmetric: a
 * floor set too high blocks a deposit the exchange would have accepted, while one
 * set too low merely lets the server refuse — recoverable, and explainable to the
 * user in the exchange's own words.
 */
export const MIN_VAULT_DEPOSIT_USDC = "5";

/** The slice of `ExchangeClient` this module needs, so tests need no network. */
export interface VaultTransferClient {
  vaultTransfer(
    params: {
      vaultAddress: string;
      isDeposit: boolean;
      usd: number;
    },
    // The options bag the structural type omitted — which is the whole reason
    // an L1 action that CAN carry an expiry never sent one.
    opts?: { expiresAfter?: number }
  ): Promise<unknown>;
}

/** Never exposed. See the module note. */
/**
 * How long a signed vault transfer may still execute.
 *
 * The same 30 s the order and in-account-transfer paths use, and above the 15 s
 * HTTP timeout so a local timeout can be waited out rather than raced.
 */
const VAULT_EXPIRY_WINDOW_MS = 30_000;

const IS_DEPOSIT = { deposit: true, withdraw: false } as const;

async function run(
  direction: keyof typeof IS_DEPOSIT,
  params: { client: VaultTransferClient; vault: VaultAddress; usd: MicroUsd },
  nonceAt: number
): Promise<TransferOutcome> {
  try {
    await params.client.vaultTransfer(
      {
        vaultAddress: params.vault,
        isDeposit: IS_DEPOSIT[direction],
        usd: params.usd,
      },
      {
        // `vaultTransfer` is an L1 action and its request schema declares
        // `expiresAfter` — this simply never sent one, so a signed deposit or
        // withdrawal stayed valid indefinitely. That matters more here than
        // most places: the outcome carries a 15-minute "unknown" window that
        // was a guess about server behaviour rather than a bound anyone had
        // set, and a deposit landing late re-locks the whole balance.
        //
        // Not every member of this family can have one — a USER-signed action
        // (`approveBuilderFee`, `withdraw3`, `usdClassTransfer`) has no field
        // for it, which is checkable: their request schemas do not declare it.
        // Built on the exchange's clock, not the phone's: the exchange checks
        // this against block time, so a device running slow would sign an
        // action that is already expired. See `core/clock`.
        expiresAfter: serverNow(nonceAt) + VAULT_EXPIRY_WINDOW_MS,
      }
    );
    logger.info(`vault.${direction}`, { context: { vault: params.vault.slice(-6) } });
    return { kind: "settled", nonce: nonceAt };
  } catch (error) {
    const hl = toHlError(error, { stage: "vaultTransfer" });
    // A rejection the server articulated is a fact: nothing moved. Anything else
    // leaves a signed action that may still land, and there is no idempotency key
    // that would make a retry safe.
    // Raised while the payload was still being built — a schema rejection, a
    // formatting failure, or a wallet that could not sign. Nothing was sent, so
    // this is correctable rather than unresolved. Without this branch it fell
    // through to `unknown`, which tells a user their money may be in flight.
    //
    // `offline` is deliberately NOT here, and this path was already right when
    // the order and transfer paths were not: the offline code cannot prove the
    // request was never dispatched (`core/errors` documents why), so it belongs
    // with `unknown`. A review flagged the asymmetry as a bug in THIS file; it
    // was a bug in the other two, and they were changed to match this one
    // (2026-08-29).
    if (hl.code === "validation_error") {
      logger.warn(`vault.${direction}.rejected_locally`, { error: hl });
      return { kind: "rejected_locally", error: hl };
    }

    if (hl.code === "api_error") {
      logger.warn(`vault.${direction}.rejected`, { error: hl });
      return { kind: "rejected_by_server", reason: hl.message };
    }
    logger.warn(`vault.${direction}.unknown`, { error: hl });
    return {
      kind: "unknown",
      error: hl,
      nonce: nonceAt,
      // The same window the rest of the codebase uses, because the remedy is the
      // same: re-read the position, never re-send. A repeated deposit is not a
      // retry — it is a second deposit, and it restarts the lockup on the whole
      // balance.
      window: { fromMs: nonceAt, toMs: nonceAt + 900_000 },
    };
  }
}

export interface VaultDeposit extends AgentSignable {
  client: VaultTransferClient;
  /**
   * The vault, from `list.ts` or `details.ts`.
   *
   * Branded so a raw string cannot reach this call. `vaultDetails` answers `null`
   * with HTTP 200 for a non-vault address, so an unchecked one produces an empty
   * page rather than an error — and a deposit to it is irreversible.
   */
  vault: VaultAddress;
  /** Micro-USD. Build with `toMicroUsd`, never by multiplying at the call site. */
  usd: MicroUsd;
  now?: () => number;
}

/**
 * Deposit into a vault.
 *
 * **Irreversible for the lockup window**, and the clock restarts on *every*
 * deposit — so topping up an existing position re-locks the whole balance, not
 * just the new money. A caller must have told the user that before getting here;
 * `preflight.ts` is where that is enforced.
 */
export async function depositToVault(params: VaultDeposit): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  return run("deposit", params, at);
}

export interface VaultWithdrawal extends AgentSignable {
  client: VaultTransferClient;
  vault: VaultAddress;
  usd: MicroUsd;
  /**
   * The position's lockup, from `lockup.ts`.
   *
   * **Required, not optional.** `maxWithdrawable` ignores the lockup entirely and
   * reports full equity while the funds are locked, so every other signal a
   * caller might consult says "go". Making this a parameter means a caller cannot
   * reach the wire without having looked it up.
   */
  lockup: LockupState;
  now?: () => number;
}

/**
 * Withdraw from a vault.
 *
 * Refuses locally when the lockup has not expired — including when the lockup is
 * **unknown**, since a missing timestamp is not permission.
 *
 * Note `alwaysCloseOnWithdraw` on the vault: when set, a withdrawal closes
 * positions proportionally rather than drawing on free margin, so the amount that
 * arrives can differ from the amount requested by more than the profit share
 * alone. That is a disclosure the preflight owes the user; this function only
 * moves the money.
 */
export async function withdrawFromVault(params: VaultWithdrawal): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  try {
    assertUnlocked(params.lockup);
  } catch (error) {
    // A local refusal, so the caller can render the remaining time rather than
    // an opaque server string.
    return { kind: "rejected_locally", error: toHlError(error) };
  }
  return run("withdraw", params, at);
}

/**
 * Refuse a vault a caller has not confirmed is open to deposits.
 *
 * `isClosed` and `allowDeposits` are **independent axes** — `allowDeposits` stays
 * `true` on the large majority of closed vaults — so both must be checked, and
 * checking only the friendlier-sounding one passes a closed vault straight
 * through.
 */
export function assertAcceptsDeposits(vault: { isClosed: boolean; allowDeposits: boolean }): void {
  if (vault.isClosed) {
    throw new HlError("That vault is closed and cannot take deposits", {
      code: "not_authorized",
      context: { reason: "vault_closed" },
    });
  }
  if (!vault.allowDeposits) {
    throw new HlError("That vault is not accepting deposits", {
      code: "not_authorized",
      context: { reason: "vault_deposits_disabled" },
    });
  }
}
