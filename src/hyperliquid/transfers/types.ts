/**
 * Shared types for the transfer family.
 *
 * Three of these are **branded**: a `WireAmount`, a `ValidatedAddress` and a
 * `WireToken` cannot be produced by a cast or a string literal, only by the one
 * module that validates them. That is heavier than the rest of this codebase and
 * it is deliberate — every other phase's mistakes are correctable, and these
 * three strings go inside a signed message that moves money irreversibly.
 *
 * The fourth marker pair, `RequiresMasterWallet` / `AgentSignable`, records
 * which key an action needs. It is on the type rather than in a comment because
 * signing a transfer with the agent key does not fail loudly — it moves the
 * agent's own (empty) balance, or returns an opaque "must deposit before
 * performing actions" naming an address the user has never seen.
 */

import type { Hex } from "@/hyperliquid/types/domain";
import type { HlError } from "@/hyperliquid/core/errors";

declare const AmountBrand: unique symbol;
/**
 * A decimal string that has been through `canonicalAmount`.
 *
 * Branded so neither a raw user string nor `String(someNumber)` can reach the
 * wire: `0.1 + 0.2` signs `"0.30000000000000004"`, and any JS number at or above
 * 1e21 serialises as `"1e+21"` — a value the user never saw and would not
 * recognise.
 */
export type WireAmount = string & { readonly [AmountBrand]: true };

declare const AddressBrand: unique symbol;
/**
 * A 42-character lowercase hex address that **passed EIP-55 validation**.
 *
 * Lowercase because that is what gets signed, but it may only be produced from a
 * string that survived the checksum — the SDK lowercases before validating, so
 * by the time it sees the address a single mistyped character is undetectable.
 */
export type ValidatedAddress = Hex & { readonly [AddressBrand]: true };

declare const MicroUsdBrand: unique symbol;
/**
 * An integer of micro-USD (`dollars × 1e6`).
 *
 * `subAccountTransfer` and `vaultTransfer` both take their amount this way,
 * while every sibling in `transfers/` takes a decimal string — including
 * `subAccountSpotTransfer`, which sits in the same file and uses whole token
 * units. The two conventions are one function apart.
 *
 * Branded because the failure is silent: passing `100` where `100_000_000` is
 * meant moves a hundredth of a cent and **validates cleanly**. And the naive
 * conversion is not safe either — `1058.68 * 1e6` is `1058680000.0000001` in
 * IEEE-754, which fails the wire's integer check. 2.39% of ordinary two-decimal
 * dollar amounts land on a non-safe integer that way, and 1058.68 is a real
 * observed ledger amount.
 */
export type MicroUsd = number & { readonly [MicroUsdBrand]: true };

declare const TokenBrand: unique symbol;
/**
 * `NAME:tokenId`, resolved from live `spotMeta` for the **active network**.
 *
 * Branded because the id differs per network and sits inside the signed message,
 * while the SDK types the field as a bare string. Every `spotSend` example in
 * the SDK's own doc comments uses the *testnet* USDC id, so the most obvious
 * way to write this code is silently wrong on mainnet.
 */
export type WireToken = string & { readonly [TokenBrand]: true };

/** A balance bucket, as `sendAsset` names them. */
export type DexBucket = { kind: "perp"; dex: string | null } | { kind: "spot" };

/** `""` is the default USDC perp dex; `"spot"` is spot; anything else is a HIP-3 dex. */
export function dexBucketWire(bucket: DexBucket): string {
  return bucket.kind === "spot" ? "spot" : (bucket.dex ?? "");
}

/**
 * Marks an action that pops the user's real wallet.
 *
 * Whether that is a visible interruption depends on how the master key is held —
 * an imported key in the Keychain signs silently, an external wallet round-trips
 * to another app — but the *key* required is the same either way.
 */
export interface RequiresMasterWallet {
  readonly signer: "master";
}

/** Marks an action a registered agent key may sign. */
export interface AgentSignable {
  readonly signer: "agent";
}

/**
 * How a master signature is obtained.
 *
 * Not cosmetic. An interactive signer adds failure modes a local key does not
 * have — the user rejects, the wallet app never returns, the session expires
 * mid-sign — and it makes any unattended operation impossible. For a withdrawal
 * it also widens the worst hazard in the phase: the signature stays valid while
 * the response is lost, and there is no idempotency key to make a retry safe.
 */
export type SignerKind = "silent" | "interactive";

export interface MasterSigner {
  readonly address: Hex;
  readonly kind: SignerKind;
}

/**
 * The outcome of a transfer.
 *
 * There is deliberately **no `retryable` field.** For an order, `unknown` is a
 * question the reconciler answers by cloid and a retry may then be correct.
 * Here there is no cloid, no `expiresAfter` and no cancel, so `unknown` is
 * terminal for decision-making: the only safe response is to watch, never to
 * re-send.
 */
export type TransferOutcome =
  | { kind: "settled"; nonce: number | null }
  | { kind: "rejected_locally"; error: HlError }
  | { kind: "rejected_by_server"; reason: string }
  | {
      /** Sent; outcome genuinely unknown. Reconcile by watching. Never retry. */
      kind: "unknown";
      error: HlError;
      nonce: number | null;
      window: { fromMs: number; toMs: number };
    };
