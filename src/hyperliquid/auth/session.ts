/**
 * Agent readiness — the flow that turns "a user" into "an account that can trade".
 *
 * `auth/agent` holds the pieces (generate, store, load) and `auth/agentPolicy`
 * decides whether a held key is usable. Neither drives anything. This module is
 * the orchestration between them, and it is the only thing that produces the
 * `AgentStatus` the order path requires.
 *
 * The sequence:
 *
 * ```
 * load local key -> read on-chain agents -> judge -> (approve a new agent if needed)
 * ```
 *
 * Approving is the one step that prompts the user's real wallet. Everything
 * afterwards is signed locally by the agent, which is what makes one-tap
 * trading possible.
 */

import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { effectiveAddress } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { HlIdentity } from "@/hyperliquid/types/domain";
import type { IViemLocalAccount } from "@/hyperliquid/types/sdk";
import { createAndStoreAgent, loadAgentAccount } from "@/hyperliquid/auth/agent";
import {
  agentName,
  isAccountActivated,
  parseRegisteredAgents,
  resolveAgentStatus,
  type AgentStatus,
  type RegisteredAgent,
} from "@/hyperliquid/auth/agentPolicy";
import { deleteAgentKey } from "@/hyperliquid/auth/keychain";

const logger = log.child("auth.session");

// Re-exported for callers that already reach for them here; they live in
// `agentPolicy` so they stay free of native dependencies.
export { isAccountActivated, parseRegisteredAgents } from "@/hyperliquid/auth/agentPolicy";

/** The slices of the SDK clients this module needs, so tests need no network. */
export interface AgentInfoProbe {
  extraAgents(params: { user: string }): Promise<unknown>;
  userRole(params: { user: string }): Promise<unknown>;
}

export interface AgentApprover {
  approveAgent(params: { agentAddress: string; agentName?: string | null }): Promise<unknown>;
}

export interface AgentReadiness {
  status: AgentStatus<IViemLocalAccount>;
  /**
   * Whether the account is funded and able to approve anything.
   *
   * **`null` means the read failed**, and is deliberately distinct from `false`.
   * The two used to be collapsed, and the result was reproduced live: under a
   * shared-IP 429 every info read rejected, `activated` became `false`, and a
   * funded account was told to "deposit before trading" — a remedy that is both
   * impossible and irrelevant, masking a transient failure as a business one so
   * that no caller could sensibly retry it.
   *
   * This is the same unknown-versus-none rule the rest of the codebase treats as
   * cardinal: `SessionState.subAccounts` is `null` rather than `[]` for exactly
   * this reason.
   */
  activated: boolean | null;
  registeredAgents: RegisteredAgent[];
  /**
   * Whether `extraAgents` was actually read.
   *
   * Load-bearing, and the more dangerous half. A failed read yields an empty
   * agent list, which `resolveAgentStatus` turns into `approval_required` — so a
   * caller passing `approveAgent: true` would mint and approve a BRAND NEW agent
   * on chain because one HTTP request failed, burning one of the master's three
   * slots. `ensureAgentReady` refuses to approve unless this is true.
   */
  agentsRead: boolean;
}

/**
 * Inspect the current agent situation without changing anything.
 *
 * Read-only and cheap — safe to call on app start or an account switch.
 */
export async function inspectAgent(params: {
  identity: HlIdentity;
  info: AgentInfoProbe;
  now?: () => number;
}): Promise<AgentReadiness> {
  const now = params.now ?? Date.now;

  // The two reads want DIFFERENT addresses, and conflating them is what left
  // every sub-account permanently `approval_required`:
  //
  // - `userRole` asks "is THIS account activated and able to trade" — that is
  //   the sub-account when one is selected.
  // - `extraAgents` asks "which agents may act here" — and agents are only ever
  //   registered on the MASTER. `approveAgent` carries no `user` field, so it
  //   necessarily lands on whoever signed. Querying the sub-account returns an
  //   empty list forever, so the write and the read never agreed.
  const tradingAs = effectiveAddress(params.identity);
  const agentOwner = params.identity.address;

  const [rolesResult, agentsResult] = await Promise.allSettled([
    params.info.userRole({ user: tradingAs }),
    params.info.extraAgents({ user: agentOwner }),
  ]);

  // `null`, not `false`, when the read failed. See `AgentReadiness.activated`.
  const activated =
    rolesResult.status === "fulfilled" ? isAccountActivated(rolesResult.value) : null;
  const agentsRead = agentsResult.status === "fulfilled";
  const registeredAgents = agentsRead ? parseRegisteredAgents(agentsResult.value) : [];

  const localAccount = await loadAgentAccount(params.identity);
  const status = resolveAgentStatus({ registeredAgents, localAccount, now: now() });

  logger.info("agent.inspected", {
    context: {
      activated,
      agentsRead,
      registered: registeredAgents.length,
      status: status.kind,
    },
  });
  return { status, activated, registeredAgents, agentsRead };
}

export interface EnsureAgentParams {
  identity: HlIdentity;
  info: AgentInfoProbe;
  /**
   * Signs `approveAgent` with the user's real wallet. Supplying it authorises a
   * wallet prompt; omitting it makes this inspection-only, so a caller can
   * refuse to prompt at an inconvenient moment.
   */
  approver?: AgentApprover;
  /** Shown in the user's wallet and on Hyperliquid; capped at 16 characters. */
  label?: string;
  now?: () => number;
}

/**
 * Make the account ready to trade, approving a fresh agent if required.
 *
 * A `rotation_due` agent is returned as-is rather than rotated inline: it is
 * still valid, and prompting mid-trade is exactly what the agent pattern exists
 * to avoid. Rotate it from a quiet moment instead.
 *
 * **Without an `approver` this never throws for an unusable account** — it
 * reports `approval_required` and lets the caller decide. Only the approving
 * path refuses, because only it needs the account to be funded and the agent
 * list to have been read.
 *
 * @throws {HlError} only when an `approver` was supplied: if the account is
 *   unfunded, if its status could not be read, or if approval fails.
 */
export async function ensureAgentReady(params: EnsureAgentParams): Promise<AgentReadiness> {
  const current = await inspectAgent(params);

  if (current.status.kind !== "approval_required") {
    return current;
  }

  // Inspection-only: report the need rather than prompting unbidden — and
  // BEFORE the two refusals below, which are both conditions on *approving*,
  // not on looking.
  //
  // This ordering is load-bearing, and having it the other way round deadlocked
  // every new user. A freshly created wallet is unfunded, so `activated` is
  // false, so a read-only `session.start()` threw "deposit before trading" and
  // no session existed at all — while the deposit screen that would fix it is
  // itself behind a session. Found on the first run of the module on a device.
  //
  // Refusing here also contradicted this module's own contract:
  // `StartSessionParams.approveAgent` promises that omitting it still starts the
  // session and reports `approval_required`, because read-only surfaces need no
  // agent. They still do not: `canTrade()` is false, and every write path gates
  // on it separately.
  if (!params.approver) {
    return current;
  }

  // Unknown first, and with a DIFFERENT code. Reaching the message below on a
  // failed read tells a funded user to deposit money they already have, and
  // `not_authorized` invites no retry — so a rate limit or a flaky network
  // presents as a permanent refusal.
  //
  // `agentsRead` is the more dangerous half: a failed read yields an empty agent
  // list, which resolves to `approval_required`, so proceeding would mint and
  // approve a BRAND NEW agent on chain because one HTTP request failed —
  // burning one of the master's three slots. That hazard exists only on this
  // path, which is why the check sits here rather than above.
  if (current.activated === null || !current.agentsRead) {
    throw new HlError("Could not read this account's status — check the connection and retry", {
      code: "transport_error",
      context: { reason: "account_status_unreadable", agentsRead: current.agentsRead },
    });
  }
  if (!current.activated) {
    throw new HlError("Account is not activated on Hyperliquid — deposit before trading", {
      code: "not_authorized",
      context: { reason: "account_not_activated" },
    });
  }

  const { account, agentAddress } = await createAndStoreAgent(params.identity);
  try {
    await params.approver.approveAgent({
      agentAddress,
      agentName: agentName(params.label ?? "hl"),
    });
  } catch (error) {
    const hl = toHlError(error, { stage: "approveAgent" });

    // Only discard the key when the server ARTICULATED a refusal. Then the
    // chain genuinely did not accept the agent, the key is dead weight, and
    // leaving it would make the next `inspectAgent` report a mismatch forever.
    //
    // A transport failure means the opposite: `approveAgent` is an HTTP POST,
    // so a timeout or an aborted fetch may well have landed on-chain. Deleting
    // the local key there destroys the ONLY thing that can turn that approval
    // into a usable session — the on-chain agent would be registered to an
    // address whose private key no longer exists anywhere, and the user would
    // have to approve a second agent to recover.
    if (hl.code === "api_error") {
      await deleteAgentKey(params.identity).catch(() => undefined);
      logger.warn("agent.approval_rejected", { error: hl });
    } else {
      logger.warn("agent.approval_unknown", { error: hl });
    }
    throw hl;
  }

  logger.info("agent.approved", { context: { agentAddress } });
  return {
    ...current,
    status: { kind: "ready", account },
    registeredAgents: [
      ...current.registeredAgents,
      { address: agentAddress, name: agentName(params.label ?? "hl"), validUntil: null },
    ],
  };
}
