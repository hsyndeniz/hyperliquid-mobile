/**
 * Agent policy — pure decisions about agent validity.
 *
 * Deliberately free of native dependencies: no Keychain, no viem, no SDK
 * imports. Deciding whether an agent is usable is the part most worth testing,
 * and it should not require a device or a bundler to run. The side-effectful
 * half (key generation, Keychain I/O) lives in `@/hyperliquid/auth/agent`.
 */

import { AGENT_ROTATION_THRESHOLD_MS } from "@/hyperliquid/config/constants";
import { normalizeAddress } from "@/hyperliquid/core/identity";
import type { Hex } from "@/hyperliquid/types/domain";

/** An on-chain agent as Hyperliquid reports it via `extraAgents`. */
export interface RegisteredAgent {
  address: Hex;
  name: string;
  /** Expiry in ms since epoch. **`null` means the agent never expires.** */
  validUntil: number | null;
}

/**
 * The minimum a signer must expose for a policy decision.
 *
 * Structural rather than the SDK's account type, so this module stays
 * dependency-free; callers keep their concrete signer type through the generic.
 */
export interface AgentIdentifiable {
  address: string;
}

export type AgentUnavailableReason =
  "no_agents_registered" | "no_local_key" | "key_address_mismatch" | "expired";

export type AgentStatus<TAccount extends AgentIdentifiable> =
  | { kind: "ready"; account: TAccount }
  /** No agent on chain, or none we hold a key for — approval required. */
  | { kind: "approval_required"; reason: AgentUnavailableReason }
  /** On chain and valid, but close enough to expiry to rotate proactively. */
  | { kind: "rotation_due"; account: TAccount; validUntil: number };

/**
 * Whether an agent is close enough to expiry to rotate now.
 *
 * `validUntil === null` means **no expiry** — such an agent is never due for
 * rotation. The reference gets this wrong: it compares `validUntil <= threshold`
 * directly, and because `null` coerces to `0`, a never-expiring agent is treated
 * as expiring and re-approved on every check.
 */
export function isRotationDue(validUntil: number | null, now: number): boolean {
  if (validUntil === null) return false;
  return validUntil <= now + AGENT_ROTATION_THRESHOLD_MS;
}

export function isExpired(validUntil: number | null, now: number): boolean {
  if (validUntil === null) return false;
  return validUntil <= now;
}

/**
 * Decide whether we can trade, need to rotate, or need a fresh approval.
 *
 * Addresses are compared lowercased: viem returns checksummed addresses while
 * Hyperliquid returns lowercase, so a direct comparison always fails.
 */
export function resolveAgentStatus<TAccount extends AgentIdentifiable>(params: {
  registeredAgents: readonly RegisteredAgent[];
  localAccount: TAccount | null;
  now: number;
}): AgentStatus<TAccount> {
  const { registeredAgents, localAccount, now } = params;

  if (registeredAgents.length === 0) {
    return { kind: "approval_required", reason: "no_agents_registered" };
  }
  if (!localAccount) {
    return { kind: "approval_required", reason: "no_local_key" };
  }

  const localAddress = normalizeAddress(localAccount.address);
  const match = registeredAgents.find((agent) => normalizeAddress(agent.address) === localAddress);

  if (!match) {
    // We hold a key, but the chain does not recognise it — it was revoked or
    // replaced elsewhere. Trading with it would fail at submit time.
    return { kind: "approval_required", reason: "key_address_mismatch" };
  }
  if (isExpired(match.validUntil, now)) {
    return { kind: "approval_required", reason: "expired" };
  }
  if (isRotationDue(match.validUntil, now)) {
    // Still usable — rotate in the background rather than interrupting a trade.
    return { kind: "rotation_due", account: localAccount, validUntil: match.validUntil! };
  }
  return { kind: "ready", account: localAccount };
}

/**
 * Agent name for `approveAgent`.
 *
 * Hyperliquid caps the name at 16 characters *after* stripping a
 * ` valid_until <digits>` suffix, which the SDK recognises by exact regex.
 */
export function agentName(label: string): string {
  return label.slice(0, 16);
}

/**
 * Normalise the `extraAgents` response.
 *
 * `validUntil` is `number | null` — **null means never expires**. Preserved
 * exactly rather than defaulted, because coercing it to a number is the bug the
 * reference implementation has: `null` becomes `0` and a permanent agent reads
 * as expired on every check.
 */
export function parseRegisteredAgents(response: unknown): RegisteredAgent[] {
  if (!Array.isArray(response)) return [];
  return response.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { address, name, validUntil } = entry as Record<string, unknown>;
    if (typeof address !== "string") return [];
    return [
      {
        address: address as `0x${string}`,
        name: typeof name === "string" ? name : "",
        validUntil: typeof validUntil === "number" ? validUntil : null,
      },
    ];
  });
}

/**
 * Whether the account exists on Hyperliquid at all.
 *
 * `userRole` reports `missing` for an address that has never been funded. Such
 * an account cannot approve an agent, so the caller must deposit first — a
 * distinct state from "needs approval".
 */
export function isAccountActivated(userRoleResponse: unknown): boolean {
  if (typeof userRoleResponse !== "object" || userRoleResponse === null) return false;
  return (userRoleResponse as { role?: unknown }).role !== "missing";
}
