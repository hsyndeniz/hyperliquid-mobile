/**
 * The transfer family.
 *
 * Deliberately **not** under `orders/`. That module states four invariants at
 * the top of its file and every function beneath obeys them; two are impossible
 * here. A user-signed transfer cannot carry `expiresAfter` — the SDK's request
 * options for these actions resolve to `{ signal? }` and nothing else — and
 * there is no cloid, so the `unknown` remedy `orders/` promises does not exist.
 * Putting a function whose rule is *never retry* under a header promising
 * *retry once the probe is conclusive* is how the wrong one gets called.
 *
 * **Which key signs what**, verified from the SDK's signing code rather than
 * inferred: `usdSend`, `spotSend`, `sendAsset` and `usdClassTransfer` all route
 * through `executeUserSignedAction`, which signs EIP-712 with no agent
 * indirection field anywhere in the payload — the account debited is whoever the
 * signature recovers to. Only `agentSendAsset` uses the L1 phantom-agent scheme.
 *
 * The consequence is that in-account movement should use `agentSendAsset`, not
 * `usdClassTransfer`: same effect, agent-signed, no wallet prompt, and its
 * ledger row carries the signing nonce so it can actually be reconciled. Live
 * accounts already work this way — 590 of 1,938 sampled `send` ledger rows are
 * exactly a self spot↔perp move.
 */

import { serverNow } from "@/hyperliquid/core/clock";
import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { sameAddress } from "@/hyperliquid/transfers/destination";
import type {
  AgentSignable,
  DexBucket,
  RequiresMasterWallet,
  TransferOutcome,
  ValidatedAddress,
  WireAmount,
  WireToken,
} from "@/hyperliquid/transfers/types";
import { dexBucketWire } from "@/hyperliquid/transfers/types";
import type { Hex, HlIdentity } from "@/hyperliquid/types/domain";

const logger = log.child("transfers");

/** The slice of `ExchangeClient` this module needs, so tests need no network. */
export interface TransferClient {
  usdSend(params: { destination: string; amount: string }): Promise<unknown>;
  spotSend(params: { destination: string; token: string; amount: string }): Promise<unknown>;
  sendAsset(params: {
    destination: string;
    sourceDex: string;
    destinationDex: string;
    token: string;
    amount: string;
    fromSubAccount?: string;
  }): Promise<unknown>;
  agentSendAsset(
    params: {
      destination: string;
      sourceDex: string;
      destinationDex: string;
      token: string;
      amount: string;
      fromSubAccount?: string;
    },
    // The options bag the structural type omitted, which is why the one member
    // of this family that CAN carry an expiry never sent one — the SDK method
    // takes it (`executeL1Action`), and nothing here could express it.
    opts?: { expiresAfter?: number }
  ): Promise<unknown>;
  usdClassTransfer(params: { amount: string; toPerp: boolean }): Promise<unknown>;
}

/** Reads `userRole`, so the signer's role can be checked before it signs. */
export interface RoleProbe {
  userRole(params: { user: string }): Promise<unknown>;
}

/**
 * Refuse to sign unless the wallet really is the account owner.
 *
 * `withdraw3` and the user-signed transfers carry **no `user` field** — the
 * account acted upon is whatever the signature recovers to. Signed by an agent,
 * a withdrawal therefore targets the *agent's own address*: at best it fails
 * with "Insufficient balance for withdrawal", at worst it drains an agent
 * address that happens to hold funds.
 *
 * All 22 real `withdraw3` signers sampled across both networks had
 * `userRole: "user"` — never `agent`, `subAccount` or `vault`.
 *
 * @throws {HlError} on any mismatch. Never returns a boolean: a caller that
 *   forgets to check a boolean signs anyway.
 */
export async function assertMasterSigner(params: {
  walletAddress: Hex;
  expectedOwner: Hex;
  probe?: RoleProbe;
}): Promise<void> {
  if (!sameAddress(params.walletAddress, params.expectedOwner)) {
    throw new HlError("This action must be signed by the account owner, not the agent key", {
      code: "not_authorized",
      context: { reason: "signer_mismatch" },
    });
  }
  if (!params.probe) return;

  const role = await params.probe.userRole({ user: params.walletAddress });
  const kind =
    typeof role === "object" && role !== null ? (role as { role?: unknown }).role : undefined;
  // Anything other than a plain user account means the signature would act on a
  // different account than the caller believes.
  if (typeof kind === "string" && kind !== "user" && kind !== "missing") {
    throw new HlError(`Signer has role "${kind}"; only an owner account may transfer`, {
      code: "not_authorized",
      context: { reason: "signer_role_not_user", role: kind },
    });
  }
}

/**
 * Refuse an action that leaves the account while a sub-account is selected.
 *
 * `withdraw3` and the user-signed sends carry no sub-account field — Hyperliquid's
 * `WithdrawAction3` is `{signatureChainId, hyperliquidChain, destination, amount,
 * time}` with `deny_unknown_fields` — and a sub-account has no key to sign with.
 * The master therefore signs, and **the master's balance is what leaves**, while
 * the screen shows the sub-account's.
 *
 * The preflight raises this as a blocker so it can be rendered; this is the
 * backstop for the paths that have no preflight.
 *
 * @throws {HlError} when a sub-account is selected.
 */
export function assertNotSubAccount(identity: Pick<HlIdentity, "subAccount">): void {
  if (identity.subAccount) {
    throw new HlError("Move the funds to your main account before sending them out", {
      code: "not_authorized",
      context: { reason: "sub_account_context" },
    });
  }
}

/** Wrap a signed call so a throw becomes a typed outcome rather than an escape. */
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
    // A rejection the server articulated is a fact: nothing moved. A network
    // failure is not — the action may well have landed, and there is no
    // idempotency key that would make a retry safe.
    // Raised while the payload was still being built — a schema rejection, a
    // formatting failure, or a wallet that could not sign. Nothing was sent, so
    // this is correctable rather than unresolved. Without this branch it fell
    // through to `unknown`, which tells a user their money may be in flight.
    //
    // `offline` used to share this branch and no longer does (2026-08-29). It
    // cannot prove the connection never opened — RN raises the same
    // `TypeError: Network request failed` for a request that was transmitted
    // in full before the connection reset (see `core/errors`'s note on the
    // code). These are irreversible sends with no idempotency key, so a
    // definite "not sent" that is wrong costs the user the whole amount twice.
    // It falls through to `unknown`, whose window the ledger reconciler already
    // knows how to settle.
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
      window: { fromMs: nonceAt, toMs: nonceAt + 900_000 },
    };
  }
}

// ---------------------------------------------------------------------------
// In-account movement — the agent CAN sign these
// ---------------------------------------------------------------------------

export interface InAccountMove extends AgentSignable {
  client: TransferClient;
  /** Must be the account's own address: this action is self-only. */
  owner: ValidatedAddress;
  /**
   * Move the **sub-account's** balance instead of the master's.
   *
   * Hyperliquid's own encoding is explicit about the semantics: `sendAsset` takes
   * `(destination, subAccount, sourceDex, destinationDex, token, wei)` and "if
   * subAccount is not the zero address, then transfer from subAccount". So this
   * is the *source*, and it moves the destination with it — a self-move inside a
   * sub-account's buckets must land back on the sub-account, not on the master.
   *
   * This is the only way to reach a sub-account's HIP-3 balance:
   * `subAccountTransfer` has no `dex` field at all.
   */
  fromSubAccount?: Hex;
  from: DexBucket;
  to: DexBucket;
  token: WireToken;
  amount: WireAmount;
  now?: () => number;
}

/**
 * How long after signing an agent-signed transfer may still execute.
 *
 * The same 30 s the order path uses and for the same reason: it must exceed the
 * 15 s HTTP timeout so a request that times out locally can be waited out
 * rather than raced. Only `moveWithinAccount` can carry one — the user-signed
 * members of this family have no field for it.
 */
const TRANSFER_EXPIRY_WINDOW_MS = 30_000;

/**
 * Move funds between your own buckets — spot, the default perp dex, or a HIP-3 dex.
 *
 * Preferred over `classTransfer` for every in-account move: it is agent-signed
 * (so no wallet prompt), it is the only member of the family that accepts
 * `expiresAfter`, and its ledger row carries the signing nonce, which is the
 * only thing that makes settlement observable.
 *
 * The destination is forced to the owner's own address. The SDK does not check
 * it and a mismatch fails server-side only, so the guard is here.
 */
export async function moveWithinAccount(params: InAccountMove): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  const source = dexBucketWire(params.from);
  const destination = dexBucketWire(params.to);

  if (source === destination) {
    return {
      kind: "rejected_locally",
      error: new HlError("Source and destination buckets are the same", {
        code: "validation_error",
        context: { bucket: source },
      }),
    };
  }

  return run("agentSendAsset", at, () =>
    params.client.agentSendAsset(
      {
        // Self-only, and "self" follows the source: with `fromSubAccount` set the
        // funds leave the sub-account, so they must land there too. Sending them to
        // the master would be a withdrawal from the sub-account dressed as an
        // internal move. The SDK does not enforce either; the server rejects a
        // mismatch only after the signature exists.
        destination: params.fromSubAccount ?? params.owner,
        sourceDex: source,
        destinationDex: destination,
        token: params.token,
        amount: params.amount,
        ...(params.fromSubAccount ? { fromSubAccount: params.fromSubAccount } : {}),
      },
      {
        // The expiry this function's own docstring calls its advantage — "it is
        // the only member of the family that accepts `expiresAfter`" — and never
        // actually sent. `agentSendAsset` goes through the SDK's
        // `executeL1Action`, which takes it; the call simply passed no options.
        //
        // It is the half of the `unknown` remedy this family CAN have. There is
        // still no cloid to probe by, so a lost response cannot be resolved
        // positively — but a BOUNDED action becomes safe to give up on: past the
        // window the exchange refuses it, so it cannot land later against a
        // balance the user has already moved on the strength of it not having.
        // Built on the exchange's clock, not the phone's: the exchange checks
        // this against block time, so a device running slow would sign an
        // action that is already expired. See `core/clock`.
        expiresAfter: serverNow(at) + TRANSFER_EXPIRY_WINDOW_MS,
      }
    )
  );
}

/**
 * Spot ↔ perp, signed by the **master** wallet.
 *
 * Retained as the fallback for when no agent is approved, not as the default —
 * `moveWithinAccount` does the same job without a wallet prompt. It also cannot
 * reach a builder dex: `usdClassTransfer` has no `dex` field at all.
 *
 * Its ledger row carries no nonce and no destination, so two transfers of the
 * same size in the same second are literally indistinguishable afterwards.
 */
export async function classTransfer(
  params: RequiresMasterWallet & {
    client: TransferClient;
    amount: WireAmount;
    /** `true` moves spot → perp. */
    toPerp: boolean;
    now?: () => number;
  }
): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  return run("usdClassTransfer", at, () =>
    // `toPerp` must be a real boolean — the schema rejects "true" and 1.
    params.client.usdClassTransfer({ amount: params.amount, toPerp: params.toPerp })
  );
}

// ---------------------------------------------------------------------------
// Leaving the account — the MASTER wallet must sign
// ---------------------------------------------------------------------------

/**
 * Send perp USDC to another Hyperliquid account.
 *
 * **This is not a withdrawal.** It never touches the bridge: the funds stay on
 * HyperCore and land in another Hyperliquid account. Sending to an exchange
 * deposit address loses them — Hyperliquid's own support material carries the
 * same warning. The separate entry point is the guard.
 */
export async function sendUsdToAccount(
  params: RequiresMasterWallet & {
    client: TransferClient;
    destination: ValidatedAddress;
    amount: WireAmount;
    now?: () => number;
  }
): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  return run("usdSend", at, () =>
    params.client.usdSend({ destination: params.destination, amount: params.amount })
  );
}

/** Send a spot token to another Hyperliquid account. Also not a withdrawal. */
export async function sendSpotToAccount(
  params: RequiresMasterWallet & {
    client: TransferClient;
    destination: ValidatedAddress;
    token: WireToken;
    amount: WireAmount;
    now?: () => number;
  }
): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  return run("spotSend", at, () =>
    params.client.spotSend({
      destination: params.destination,
      token: params.token,
      amount: params.amount,
    })
  );
}

/**
 * The general mover: any bucket to any bucket, any destination.
 *
 * Master-signed. For a move to your own address prefer `moveWithinAccount`,
 * which is identical in effect and needs no prompt — the two produce
 * byte-identical `send` ledger rows, so history cannot tell them apart anyway.
 */
export async function sendAssetToAccount(
  params: RequiresMasterWallet & {
    client: TransferClient;
    destination: ValidatedAddress;
    /**
     * Debit the sub-account rather than the master. See `InAccountMove`.
     *
     * Unlike the in-account move, the destination is **not** forced to follow:
     * moving a sub-account's funds to a third party is a legitimate thing to
     * want, and the caller has already named where they go.
     */
    fromSubAccount?: Hex;
    from: DexBucket;
    to: DexBucket;
    token: WireToken;
    amount: WireAmount;
    now?: () => number;
  }
): Promise<TransferOutcome> {
  const at = (params.now ?? Date.now)();
  return run("sendAsset", at, () =>
    params.client.sendAsset({
      destination: params.destination,
      sourceDex: dexBucketWire(params.from),
      destinationDex: dexBucketWire(params.to),
      token: params.token,
      amount: params.amount,
      ...(params.fromSubAccount ? { fromSubAccount: params.fromSubAccount } : {}),
    })
  );
}
