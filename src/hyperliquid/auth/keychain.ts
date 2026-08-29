/**
 * Agent private key storage, in the device Keychain / Keystore.
 *
 * Never MMKV: that is unencrypted, and this is the key that can place orders.
 *
 * The critical constraint: **react-native-keychain scopes by `service` only —
 * one credential per service.** `username` is a payload field, not a key; on
 * iOS `setGenericPassword` deletes every item matching the service before
 * inserting. Storing several agent keys under one service with different
 * usernames would silently keep only the last. So each identity gets its own
 * `service` string.
 */

import * as Keychain from "react-native-keychain";

import { agentScopeKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Hex, HlIdentity } from "@/hyperliquid/types/domain";

const SERVICE_PREFIX = "hyperliquid.agent";
const logger = log.child("auth.keychain");

/**
 * One service per identity — the only scoping key Keychain offers.
 *
 * Scoped by `agentScopeKey`, **not** `identityKey`: one agent serves the master
 * and every one of its sub-accounts and dexes. A sub-account cannot hold an
 * agent of its own — it has no private key — so keying by the full identity
 * demanded a credential that can never exist, and left every sub-account
 * permanently unable to trade.
 */
function serviceFor(identity: HlIdentity): string {
  return `${SERVICE_PREFIX}.${agentScopeKey(identity)}`;
}

/**
 * Storage options.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` rather than the library default of
 * `AFTER_FIRST_UNLOCK`: the default permits background reads after first unlock
 * and, more importantly, lets the item migrate to a restored or new device. An
 * agent key that can place orders should not travel in a backup.
 *
 * Biometric access control is deliberately not set here — it would force a
 * prompt on every signature, which defeats the point of an agent wallet. Gate
 * the *approval* flow instead, not each order.
 */
const SET_OPTIONS: Keychain.SetOptions = {
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function storeAgentKey(identity: HlIdentity, privateKey: Hex): Promise<void> {
  const service = serviceFor(identity);
  // `username` is not a lookup key, but Android rejects an empty one.
  const result = await Keychain.setGenericPassword(identity.address, privateKey, {
    ...SET_OPTIONS,
    service,
  });
  if (!result) {
    throw new Error(`Failed to store agent key for ${identity.address}`);
  }
  logger.info("agent_key.stored", { context: { address: identity.address } });
}

/**
 * Read a stored agent key, or `null` when none exists.
 *
 * `getGenericPassword` resolves `false` for not-found; it *rejects* for real
 * errors (user cancel, keystore corruption). Those are surfaced rather than
 * swallowed — treating a keystore failure as "no key" would silently push the
 * user back through agent approval and mint a second agent.
 */
export async function readAgentKey(identity: HlIdentity): Promise<Hex | null> {
  const credentials = await Keychain.getGenericPassword({ service: serviceFor(identity) });
  if (!credentials) return null;
  return credentials.password as Hex;
}

/** Remove a stored agent key. Idempotent. */
export async function deleteAgentKey(identity: HlIdentity): Promise<void> {
  // Resolves `true` even when nothing was stored, so it is not a "did I delete
  // something" signal — only a "nothing remains" guarantee.
  await Keychain.resetGenericPassword({ service: serviceFor(identity) });
  logger.info("agent_key.deleted", { context: { address: identity.address } });
}

export async function hasAgentKey(identity: HlIdentity): Promise<boolean> {
  return Keychain.hasGenericPassword({ service: serviceFor(identity) });
}

/**
 * Identities with a stored agent key.
 *
 * `skipUIAuth` avoids an auth prompt while enumerating on iOS. Returns the raw
 * service strings; callers match them against known identities rather than
 * parsing, since an identity component could itself contain the separator.
 */
export async function listAgentKeyServices(): Promise<string[]> {
  const services = await Keychain.getAllGenericPasswordServices({ skipUIAuth: true });
  return services.filter((service) => service.startsWith(`${SERVICE_PREFIX}.`));
}

/**
 * Delete EVERY stored agent key, whatever identity it belongs to.
 *
 * `deleteAgentKey` needs an identity to build its service string, and the one
 * moment this matters most is the moment that identity is being destroyed:
 * `forgetWallet` wipes the vault, and the vault is what names the identities.
 * Sweeping by service is the only order that works — enumerate first, delete
 * second, and never depend on knowing who they were.
 *
 * Returns how many were removed, so a caller can say "nothing remains" as a
 * fact rather than a hope.
 */
export async function deleteAllAgentKeys(): Promise<number> {
  const services = await listAgentKeyServices();
  for (const service of services) {
    await Keychain.resetGenericPassword({ service });
  }
  if (services.length > 0) {
    logger.info("agent_key.swept", { context: { count: services.length } });
  }
  return services.length;
}

/** Test seam: the service string a given identity maps to. */
export const __serviceFor = serviceFor;
