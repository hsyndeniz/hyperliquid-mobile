/**
 * Moving funds between a master and its sub-accounts.
 *
 * **Agent-signable**, like the rest of `subaccounts/` and unlike everything in
 * `transfers/`. Measured: `subAccountTransfer` signed by a freshly approved
 * agent was refused with `"Invalid sub-account transfer from 0x5bf8…4347 to
 * 0x…dead"` — the *master's* address as the source, byte-identical to the
 * master-signed attempt. So funding a sub-account never prompts a wallet.
 *
 * Four constraints that shape the API, none of them obvious from the SDK:
 *
 * 1. **The two functions disagree about units, and they sit next to each other.**
 *    `subAccountTransfer.usd` is an *integer of micro-USD*;
 *    `subAccountSpotTransfer.amount` is a *decimal string of whole tokens*.
 *    Passing `100` where `100_000_000` is meant moves a hundredth of a cent and
 *    validates cleanly. That is why the perp side takes `MicroUsd` and the spot
 *    side takes `WireAmount`, and neither can be produced by a literal.
 * 2. **Direction is a boolean called `isDeposit`, from the master's point of
 *    view.** `true` moves master → sub. A caller that reads it as "deposit into
 *    my account" gets the exact opposite, so it is never exposed: `fund` and
 *    `sweep` are separate functions with no shared boolean between them.
 * 3. **Only the master↔sub edge exists.** The action carries one address and a
 *    direction, so a sibling-to-sibling move is two hops through the master and
 *    must be presented as such rather than as one transfer that can half-fail.
 * 4. **Perp transfers reach the main dex only.** There is no `dex` field.
 *    Funding a sub-account's HIP-3 balance is fund-then-`agentSendAsset`, with
 *    `fromSubAccount` set — see `transfers/`.
 *
 * `subAccountSpotTransfer` also leaves **no ledger row of its own** — zero
 * across ~9,300 sampled entries; it surfaces as an ordinary `spotTransfer`. Use
 * `isInternalCounterparty` to tell it from a real send.
 */

import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { sameAddress } from "@/hyperliquid/transfers/destination";
import type {
  MicroUsd,
  TransferOutcome,
  WireAmount,
  WireToken,
} from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("subaccounts.transfer");

/** The slice of `ExchangeClient` this module needs, so tests need no network. */
export interface SubAccountTransferClient {
  subAccountTransfer(params: {
    subAccountUser: string;
    isDeposit: boolean;
    usd: number;
  }): Promise<unknown>;
  subAccountSpotTransfer(params: {
    subAccountUser: string;
    isDeposit: boolean;
    token: string;
    amount: string;
  }): Promise<unknown>;
}

/**
 * Which way the money goes, named from the **user's** point of view rather than
 * the wire's.
 *
 * The wire says `isDeposit`, meaning "into the sub-account". Half the people
 * reading that will picture a deposit into the account they are looking at,
 * which is the opposite. Nothing outside this file touches that boolean.
 */
type Direction = "fund" | "sweep";

const IS_DEPOSIT: Record<Direction, boolean> = { fund: true, sweep: false };

/**
 * The sub-account must not be the master.
 *
 * The server refuses it, but only after a signature exists, and the refusal
 * ("Invalid sub-account transfer from X to X") reads like a bug in the app.
 */
function assertDistinct(master: Hex, subAccount: Hex): void {
  if (sameAddress(master, subAccount)) {
    throw new HlError("A sub-account transfer needs a sub-account, not the master itself", {
      code: "validation_error",
      context: { reason: "same_address" },
    });
  }
}

async function run(
  label: string,
  nonceAt: number,
  call: () => Promise<unknown>
): Promise<TransferOutcome> {
  try {
    await call();
    return { kind: "settled", nonce: nonceAt };
  } catch (error) {
    const hl = toHlError(error, { stage: label });
    // A rejection the server articulated is a fact: nothing moved. Anything else
    // leaves a signed action that may still land, and there is no idempotency
    // key that would make a retry safe.
    // Raised while the payload was still being built — a schema rejection, a
    // formatting failure, or a wallet that could not sign. Nothing was sent, so
    // this is correctable rather than unresolved. Without this branch it fell
    // through to `unknown`, which tells a user their money may be in flight.
    if (hl.code === "validation_error") {
      logger.warn(`${label}.rejected_locally`, { error: hl });
      return { kind: "rejected_locally", error: hl };
    }

    if (hl.code === "api_error") {
      logger.warn(`${label}.rejected`, { error: hl });
      return { kind: "rejected_by_server", reason: hl.message };
    }
    logger.warn(`${label}.unknown`, { error: hl });
    return {
      kind: "unknown",
      error: hl,
      nonce: nonceAt,
      // Wide on purpose: the same window `transfers/` uses, because the way to
      // resolve it is the same — watch the balances, never re-send.
      window: { fromMs: nonceAt, toMs: nonceAt + 900_000 },
    };
  }
}

export interface PerpMove {
  client: SubAccountTransferClient;
  /** The signing account's master address, for the self-transfer guard. */
  master: Hex;
  subAccount: Hex;
  /** Micro-USD. Build it with `toMicroUsd`, never by multiplying here. */
  usd: MicroUsd;
  now?: () => number;
}

export interface SpotMove {
  client: SubAccountTransferClient;
  master: Hex;
  subAccount: Hex;
  /** `NAME:tokenId` for the **active network** — the ids differ between them. */
  token: WireToken;
  /** Whole token units as a decimal string. Not wei, and not micro-anything. */
  amount: WireAmount;
  now?: () => number;
}

async function perpMove(direction: Direction, params: PerpMove): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  try {
    assertDistinct(params.master, params.subAccount);
  } catch (error) {
    return { kind: "rejected_locally", error: toHlError(error) };
  }

  return run("subAccountTransfer", at, () =>
    params.client.subAccountTransfer({
      subAccountUser: params.subAccount,
      isDeposit: IS_DEPOSIT[direction],
      usd: params.usd,
    })
  );
}

async function spotMove(direction: Direction, params: SpotMove): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  try {
    assertDistinct(params.master, params.subAccount);
  } catch (error) {
    return { kind: "rejected_locally", error: toHlError(error) };
  }

  return run("subAccountSpotTransfer", at, () =>
    params.client.subAccountSpotTransfer({
      subAccountUser: params.subAccount,
      isDeposit: IS_DEPOSIT[direction],
      token: params.token,
      amount: params.amount,
    })
  );
}

/** Master perp USDC → sub-account. Main dex only; see the header. */
export function fundSubAccount(params: PerpMove): Promise<TransferOutcome> {
  return perpMove("fund", params);
}

/** Sub-account perp USDC → master. */
export function sweepSubAccount(params: PerpMove): Promise<TransferOutcome> {
  return perpMove("sweep", params);
}

/** Master spot token → sub-account. */
export function fundSubAccountSpot(params: SpotMove): Promise<TransferOutcome> {
  return spotMove("fund", params);
}

/** Sub-account spot token → master. */
export function sweepSubAccountSpot(params: SpotMove): Promise<TransferOutcome> {
  return spotMove("sweep", params);
}

/**
 * The two hops a sibling-to-sibling move actually takes.
 *
 * There is no direct sub → sub action. Returned as a plan rather than executed
 * as one call, because the second hop can fail on its own and the funds then sit
 * in the master — a state the user must be told about, not one to paper over
 * with a retry loop that could double the first hop.
 */
export function planSiblingMove(params: {
  from: Hex;
  to: Hex;
}): [{ step: "sweep"; subAccount: Hex }, { step: "fund"; subAccount: Hex }] {
  if (sameAddress(params.from, params.to)) {
    throw new HlError("Source and destination sub-accounts are the same", {
      code: "validation_error",
      context: { reason: "same_address" },
    });
  }
  return [
    { step: "sweep", subAccount: params.from },
    { step: "fund", subAccount: params.to },
  ];
}
