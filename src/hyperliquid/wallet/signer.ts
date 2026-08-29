/**
 * The master signer, and the gate in front of it.
 *
 * Phase 2 promised one wallet prompt at agent approval and silent signing
 * thereafter. Phase 7 established that is true for orders and **false for money
 * movement**: `withdraw3`, `usdSend`, `spotSend`, `sendAsset` and
 * `usdClassTransfer` all sign EIP-712 with no agent indirection, so the account
 * debited is whoever the signature recovers to.
 *
 * How much that hurts depends entirely on where the key lives, which is why
 * `SignerKind` exists:
 *
 * - **`silent`** — an imported key in the vault. Signing is a local function
 *   call; the user sees nothing. The agent pattern remains worthwhile for
 *   *security* (the master key is not touched per order) but not for UX.
 * - **`interactive`** — an external wallet. Every master signature is a
 *   round-trip to another app, with failure modes a local key does not have:
 *   the user rejects, the wallet never returns, the session expires mid-sign.
 *
 * That distinction is modelled rather than assumed because it changes real
 * behaviour. An interactive signer cannot be used unattended, so no background
 * reconciliation may depend on one — and for a withdrawal it widens the worst
 * hazard in the project, since the signature stays valid while the response is
 * lost and there is no idempotency key to make a retry safe.
 *
 * **The biometric gate lives here, not on the vault's master key.** Gating the
 * master key would put Face ID in front of app launch, because that key is read
 * once and then decrypts everything. Gating here puts it in front of the
 * operations that actually move money, which is where a prompt means something.
 */

import * as Keychain from "react-native-keychain";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import type { Hex } from "@/hyperliquid/types/domain";
import type { IViemLocalAccount } from "@/hyperliquid/types/sdk";
import type { SignerKind } from "@/hyperliquid/transfers/types";

const logger = log.child("wallet.signer");

export type { SignerKind };

/**
 * A signer for the account owner.
 *
 * Structurally satisfies what the SDK wants (`{ signTypedData, address }`) so it
 * can be handed straight to an `ExchangeClient`, with the metadata a caller
 * needs to decide whether an operation is even possible right now.
 */
export interface MasterSigner {
  readonly address: Hex;
  readonly kind: SignerKind;
  /** The viem-shaped account the SDK signs with. */
  readonly account: IViemLocalAccount;
  /** A label for the UI — "This device" or the wallet's name. */
  readonly label: string;
}

/**
 * Wrap a locally-held key.
 *
 * `silent` because the key is in the vault: no prompt, no round-trip, no way for
 * the user to reject.
 */
export function localSigner(account: IViemLocalAccount, label = "This device"): MasterSigner {
  return { address: account.address as Hex, kind: "silent", account, label };
}

/**
 * Wrap an external wallet.
 *
 * `interactive`, so every call site that cares can branch. The account must
 * still satisfy the SDK's shape — how it obtains a signature (WalletConnect, a
 * browser extension bridge, a hardware device) is not this module's business.
 */
export function externalSigner(account: IViemLocalAccount, label: string): MasterSigner {
  return { address: account.address as Hex, kind: "interactive", account, label };
}

/** True when signing will not interrupt the user. */
export function isSilent(signer: MasterSigner): boolean {
  return signer.kind === "silent";
}

/**
 * Whether an operation may run without the user present.
 *
 * Startup reconciliation and any timer-driven work must check this: an
 * interactive signer cannot produce a signature with the app backgrounded, and
 * a request that hangs waiting for one is indistinguishable from a network
 * stall — which, for a withdrawal, is the case with no safe retry.
 */
export function canSignUnattended(signer: MasterSigner): boolean {
  return signer.kind === "silent";
}

// ---------------------------------------------------------------------------
// The user-presence gate
// ---------------------------------------------------------------------------

/** Operations worth interrupting someone for. */
export type GatedOperation = "withdraw" | "transfer" | "export_recovery_phrase" | "remove_wallet";

export interface PresenceOptions {
  /** Shown in the system prompt. Should name the operation, not the app. */
  reason: string;
  /** Skip the gate — for a device with no biometry and no passcode. */
  allowWithoutBiometry?: boolean;
}

/**
 * The biometry the device offers, or `null` when it offers none.
 *
 * Read before gating so a device without biometry gets a coherent answer rather
 * than a prompt that can never succeed.
 */
export async function availableBiometry(): Promise<string | null> {
  try {
    return (await Keychain.getSupportedBiometryType()) ?? null;
  } catch (error) {
    logger.warn("signer.biometry_probe_failed", { error });
    return null;
  }
}

/**
 * Is the guarded write failing because the DEVICE has no protection, rather
 * than because the keychain is unavailable?
 *
 * Answered by testing the hypothesis instead of assuming it: the same item,
 * written with no access control. A success proves the keychain works and
 * isolates the failure to the access control the device cannot satisfy; a
 * second failure proves nothing about the device and must not be read as
 * "unprotected" (see the caller). The probe item is removed either way —
 * it holds no secret, only a timestamp, but leaving litter in the keychain
 * under a service name that implies a security property is its own trap.
 */
async function isDeviceUnprotected(service: string): Promise<boolean> {
  const probeService = `${service}.probe`;
  try {
    await Keychain.setGenericPassword("probe", String(Date.now()), { service: probeService });
    return true;
  } catch (error) {
    logger.warn("signer.presence_probe_failed", { error });
    return false;
  } finally {
    try {
      await Keychain.resetGenericPassword({ service: probeService });
    } catch {
      // Nothing to clean up, or the keychain is gone. Neither changes the answer.
    }
  }
}

/**
 * Require the user to prove presence before a sensitive operation.
 *
 * Implemented by writing and reading back a throwaway Keychain item guarded by
 * `ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE` — the read triggers the
 * platform prompt. Deliberately **not** applied to the vault's master key: that
 * is read once per session and would move the prompt to app launch.
 *
 * @throws {HlError} `not_authorized` when the user cancels or fails.
 */
export async function requireUserPresence(
  operation: GatedOperation,
  options: PresenceOptions
): Promise<void> {
  // No pre-flight biometry check. `getSupportedBiometryType()` reports null
  // when biometry is not ENROLLED, but the access control below is
  // `BIOMETRY_ANY_OR_DEVICE_PASSCODE` — a passcode-only device authenticates
  // perfectly well and would have been hard-blocked by asking first. The
  // honest test is whether the item can be written at all: that fails only
  // when the device has no passcode either, which is the one case there is
  // genuinely nothing to prove presence with.
  const service = `com.hl.presence.${operation}`;
  try {
    try {
      await Keychain.setGenericPassword("presence", String(Date.now()), {
        service,
        accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      });
    } catch (error) {
      // A failed write is the SUSPECTED "unprotected device", never the proven
      // one — and the difference decides whether a withdrawal is signed with
      // no prompt at all.
      //
      // Every rejection used to be read as "no passcode", so with
      // `allowWithoutBiometry` (which all six production call sites pass, the
      // money paths among them) ONE transient Keystore exception on a fully
      // protected phone silently skipped the gate, leaving a warning in the
      // log as the only trace. The gate is only meaningful if it fails CLOSED.
      //
      // So the hypothesis gets tested rather than assumed: write the same item
      // WITHOUT the access control. If that succeeds, the Keychain is working
      // and the guarded write failed specifically because the device cannot
      // satisfy `BIOMETRY_ANY_OR_DEVICE_PASSCODE` — genuinely unprotected, and
      // the caller's opt-out applies. If it fails too, the Keychain itself is
      // unavailable, which says nothing about the device's protection and must
      // never wave a money path through.
      const unprotected = await isDeviceUnprotected(service);
      if (unprotected && options.allowWithoutBiometry) {
        logger.warn("signer.presence_skipped", { context: { operation }, error });
        return;
      }
      if (unprotected) {
        throw new HlError("This device has no biometric or passcode protection configured", {
          code: "not_authorized",
          context: { operation, reason: "no_device_protection" },
        });
      }
      logger.error("signer.presence_unavailable", { context: { operation }, error });
      throw new HlError("Could not confirm it is you — the secure keychain is unavailable", {
        code: "not_authorized",
        context: { operation, reason: "keychain_unavailable" },
      });
    }
    // The read is what prompts. A write alone does not.
    const confirmed = await Keychain.getGenericPassword({
      service,
      authenticationPrompt: { title: options.reason },
    });
    if (!confirmed) {
      throw new HlError("Confirmation was cancelled", {
        code: "not_authorized",
        context: { operation, reason: "cancelled" },
      });
    }
    logger.info("signer.presence_confirmed", { context: { operation } });
  } catch (error) {
    if (error instanceof HlError) throw error;
    throw new HlError("Could not confirm it is you", {
      code: "not_authorized",
      context: { operation, reason: "biometry_failed" },
      cause: error,
    });
  } finally {
    // Never leave the probe behind: it is meaningless state, and a stale one
    // could be read without a prompt on some platforms.
    await Keychain.resetGenericPassword({ service }).catch(() => undefined);
  }
}

/**
 * Classify a failure from an interactive signer.
 *
 * A local key cannot produce these, so they have no representation in the
 * existing error taxonomy — and telling "the user tapped cancel" apart from
 * "the wallet app never came back" decides whether a retry is even sensible.
 */
export function classifySignerFailure(error: unknown): HlError {
  if (error instanceof HlError) return error;

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // Matching on message text is normally banned in this codebase, and is
  // tolerated here only because these strings come from wallet SDKs rather than
  // from Hyperliquid, and there is no code to match on instead. Every branch
  // falls through to the same safe default.
  if (message.includes("reject") || message.includes("denied") || message.includes("cancel")) {
    return new HlError("You declined the signature request", {
      code: "not_authorized",
      context: { reason: "user_rejected" },
      cause: error,
    });
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return new HlError("The wallet did not respond", {
      code: "transport_error",
      context: { reason: "wallet_timeout" },
      cause: error,
    });
  }
  if (message.includes("session") || message.includes("disconnect")) {
    return new HlError("The wallet connection expired", {
      code: "transport_error",
      context: { reason: "session_expired" },
      cause: error,
    });
  }
  return new HlError("The wallet could not sign", {
    code: "transport_error",
    context: { reason: "unknown" },
    cause: error,
  });
}
