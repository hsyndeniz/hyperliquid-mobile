/**
 * Destination and routing reads for the transfer path.
 *
 * `preTransferCheck` is the only signal about a destination that does not come
 * from us, and it is worth exactly as much as its verified behaviour — no more:
 *
 * - **`isSanctioned`** is a hard block. Never observed true across ~80 live
 *   calls, so the cost of treating it as absolute is nil.
 * - **`userExists === false`** is the strongest typo signal available. It caught
 *   14 of 14 single-character substitutions and 9 of 9 transpositions of a real
 *   address, plus 30 of 30 random ones.
 * - **`userExists === true` is NOT a safety signal**, and this module refuses to
 *   present it as one. It comes back green for `0x0`, `0x…dEaD`, `0x1111…`,
 *   `0xffff…`, the HyperCore system addresses, and the Ethereum USDC and WETH
 *   contracts. A green light here means only "someone has touched this address",
 *   which is true of every black hole on the network.
 *
 * The `source` field is **required to be a 42-character address** by the SDK's
 * schema — a descriptive label is rejected outright — while having no observable
 * effect on the answer: the same destination returns byte-identical results for
 * different sources. So the sender's own address is passed, which is both
 * schema-valid and semantically honest, and no caller is invited to believe the
 * value changes anything.
 *
 * The 1-unit charge on a new destination is an **account-activation fee**, not a
 * transfer fee, and its token varies (`"USDC"`, `"USDT0"` and `""` all seen). It
 * is surfaced as a flag, never summed into an amount.
 */

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { weightBudget, type WeightBudget } from "@/hyperliquid/api/weightBudget";
import type { DestinationProbeResult } from "@/hyperliquid/transfers/preflight";
import type { ValidatedAddress } from "@/hyperliquid/transfers/types";

const logger = log.child("api.transferMeta");

export interface TransferMetaProbe {
  preTransferCheck(params: { user: string; source: string }): Promise<unknown>;
  userRole(params: { user: string }): Promise<unknown>;
}

export interface DestinationCheck extends DestinationProbeResult {
  /** The destination-activation charge, when the account is new. Never a transfer fee. */
  activationFee: string;
}

export interface CheckResult<T> {
  value: T | null;
  /** True when the weight budget refused the call, so `value` is absent by choice. */
  deferred: boolean;
}

/**
 * Check a withdrawal or transfer destination.
 *
 * Returns `null` rather than throwing when the call fails: a preflight that
 * cannot reach the endpoint must still produce a quote, with the
 * `checks_incomplete` warning that absence generates. Failing hard here would
 * make a network blip indistinguishable from a dangerous destination.
 */
export async function checkDestination(params: {
  probe: TransferMetaProbe;
  destination: ValidatedAddress;
  /** The sending address. Schema-required; does not affect the answer. */
  source: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<CheckResult<DestinationCheck>> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  let raw: unknown;
  try {
    raw = await budget.tryRun(
      "preTransferCheck",
      () => params.probe.preTransferCheck({ user: params.destination, source: params.source }),
      { now: () => at }
    );
  } catch (error) {
    // Deliberately soft: a preflight that cannot reach the endpoint must still
    // produce a quote, carrying the `checks_incomplete` warning that absence
    // generates. Logged at warn so the reason is never merely swallowed —
    // that silence once hid a schema rejection behind a plausible `null`.
    logger.warn("destination.check_failed", { error });
    return { value: null, deferred: false };
  }
  if (raw === null) return { value: null, deferred: true };

  if (typeof raw !== "object" || raw === null) {
    throw new HlError("preTransferCheck did not return an object", { code: "validation_error" });
  }
  const record = raw as Record<string, unknown>;

  return {
    value: {
      // Defaults chosen so a missing field is the CAUTIOUS reading, not the
      // reassuring one: an absent `userExists` reports a new account, which
      // warns, rather than an established one, which would not.
      userExists: record.userExists === true,
      userHasSentTx: record.userHasSentTx === true,
      isSanctioned: record.isSanctioned === true,
      activationFee: typeof record.fee === "string" ? record.fee : "0",
    },
    deferred: false,
  };
}

/**
 * The signer's role on Hyperliquid.
 *
 * Read before a master-signed action so a sub-account or vault address cannot
 * sign a withdrawal that would silently act on a different account.
 */
export async function fetchUserRole(params: {
  probe: TransferMetaProbe;
  user: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<CheckResult<string>> {
  const budget = params.budget ?? weightBudget;
  const at = (params.now ?? Date.now)();

  const raw = await budget.tryRun("userRole", () => params.probe.userRole({ user: params.user }), {
    now: () => at,
  });
  if (raw === null) return { value: null, deferred: true };

  const role =
    typeof raw === "object" && raw !== null ? (raw as { role?: unknown }).role : undefined;
  return { value: typeof role === "string" ? role : null, deferred: false };
}
