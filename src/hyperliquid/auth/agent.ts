/**
 * Agent (API wallet) key management.
 *
 * Hyperliquid lets a user authorise an "agent" key once; every subsequent order
 * is signed locally by that key with no wallet prompt. That is what makes
 * one-tap trading possible, and it is the single most valuable pattern in the
 * reference implementation.
 *
 * The flow:
 *   1. generate an agent keypair locally
 *   2. user signs `approveAgent` with their real wallet (one prompt)
 *   3. agent key → Keychain
 *   4. all later actions are signed by the agent
 *
 * This module owns the side effects — key generation and Keychain I/O. The
 * validity decisions are in `@/hyperliquid/auth/agentPolicy`, which is pure and has no native
 * dependencies.
 *
 * Key generation needs `crypto.getRandomValues`, which React Native does not
 * provide — `src/polyfills.ts` must have run first. Signing itself needs no
 * randomness.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { HlError } from "@/hyperliquid/core/errors";
import { normalizeAddress } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { Hex, HlIdentity } from "@/hyperliquid/types/domain";
import type { IViemLocalAccount } from "@/hyperliquid/types/sdk";
import { readAgentKey, storeAgentKey } from "@/hyperliquid/auth/keychain";

export {
  agentName,
  isExpired,
  isRotationDue,
  resolveAgentStatus,
  type AgentStatus,
  type AgentUnavailableReason,
  type RegisteredAgent,
} from "@/hyperliquid/auth/agentPolicy";

const logger = log.child("auth.agent");

/**
 * Generate an agent keypair.
 *
 * @throws {HlError} when no CSPRNG is available, rather than producing a
 *   predictable key. `globalThis.crypto.getRandomValues` comes from the
 *   quick-crypto shim installed at app entry.
 */
export function generateAgent(): { privateKey: Hex; account: IViemLocalAccount } {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new HlError(
      "No CSPRNG available — src/polyfills.ts must be imported before generating an agent key",
      { code: "not_authorized" }
    );
  }
  const privateKey = generatePrivateKey();
  return { privateKey, account: privateKeyToAccount(privateKey) };
}

/** Load a stored agent key as a signer. */
export async function loadAgentAccount(identity: HlIdentity): Promise<IViemLocalAccount | null> {
  const privateKey = await readAgentKey(identity);
  if (!privateKey) return null;
  return privateKeyToAccount(privateKey);
}

/**
 * Create and persist a new agent key.
 *
 * Stores **before** returning, so a crash between approval and storage cannot
 * leave an agent authorised on chain whose key we no longer hold.
 */
export async function createAndStoreAgent(
  identity: HlIdentity
): Promise<{ account: IViemLocalAccount; agentAddress: Hex }> {
  const { privateKey, account } = generateAgent();
  await storeAgentKey(identity, privateKey);
  const agentAddress = normalizeAddress(account.address);
  logger.info("agent.created", { context: { agentAddress } });
  return { account, agentAddress };
}
