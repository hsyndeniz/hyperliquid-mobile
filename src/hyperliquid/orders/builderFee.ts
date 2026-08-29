/**
 * The builder fee — approving it, and refusing to charge it until approved.
 *
 * A builder fee is this app's revenue: a few tenths of a basis point added to
 * each order and paid to `config.builderAddress`. It cannot simply be attached.
 * Hyperliquid requires the **user** to approve a maximum rate for that specific
 * builder, once, with their own signature — and an order carrying a fee above
 * what they approved is rejected outright.
 *
 * Measured on a live mainnet account before any of this existed:
 * `approvedBuilders` returned `[]` and `maxBuilderFee` returned a bare `0`. So
 * with an address configured and no approval flow, **every order would have
 * failed** — the config alone is worse than no config.
 *
 * ## Two units for one number, and they are easy to swap
 *
 * | Where | Unit | 1 basis point looks like |
 * | --- | --- | --- |
 * | `HlConfig.maxBuilderFee`, `builder.f` on an order | tenths of a basis point | `10` |
 * | `approveBuilderFee`'s `maxFeeRate` | a **percent string** | `"0.01%"` |
 *
 * Passing `10` where `"0.01%"` belongs is a schema error and fails loudly.
 * Passing `"10%"` — a thousand times the intended rate — is *valid*, and asks
 * the user to approve a tenth of every trade. {@link config/env.ts}'s
 * `builderFeePercentString` is the only converter, and this module is the only
 * caller of it.
 *
 * ## It is USER-signed, not an L1 action
 *
 * Like `approveAgent`, `withdraw3` and `usdSend`, and unlike an order. It must be
 * signed by the **master wallet**; the agent cannot approve on the user's behalf,
 * and signing with the agent approves a builder for the agent's own address —
 * which is not an address that trades. Hence the `RequiresMasterWallet` marker,
 * the same one the withdrawal path carries.
 */

import { HlError, toHlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import { builderFeePercentString, type HlConfig } from "@/hyperliquid/config/env";
import type { BuilderFee } from "@/hyperliquid/orders/build";
import type { RequiresMasterWallet } from "@/hyperliquid/transfers/types";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("orders.builderFee");

/**
 * What the user has approved for one builder.
 *
 * `approved` is in **tenths of a basis point**, matching `HlConfig`. `null`
 * means the read failed — deliberately distinct from `0`, which means "asked,
 * and they have approved nothing". Charging on a failed read would reject every
 * order; refusing on one merely forgoes revenue until the next read.
 */
export interface BuilderApproval {
  builder: Hex;
  approved: number | null;
  /** False when `approved` is 0 **or** unknown. Never optimistic. */
  isApproved: boolean;
}

export interface BuilderFeeProbe {
  maxBuilderFee(params: { user: Hex; builder: Hex }): Promise<unknown>;
}

/**
 * Read what this user has approved for this builder.
 *
 * Never throws: a builder fee is revenue, not correctness, and a failed read
 * must degrade to "charge nothing" rather than take down an order.
 */
export async function readBuilderApproval(params: {
  probe: BuilderFeeProbe;
  user: Hex;
  builder: Hex;
}): Promise<BuilderApproval> {
  try {
    const raw = await params.probe.maxBuilderFee({ user: params.user, builder: params.builder });
    // The endpoint answers a bare number, not an object. `0` is a real answer.
    const approved = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    return { builder: params.builder, approved, isApproved: approved !== null && approved > 0 };
  } catch (error) {
    logger.warn("builder.approval_unreadable", { error: toHlError(error) });
    return { builder: params.builder, approved: null, isApproved: false };
  }
}

/**
 * The builder object to attach to an order, or `undefined`.
 *
 * The gate. `orders/build.ts`'s `buildBuilderFee` validates the configured rate
 * against the protocol ceiling; this validates it against what the **user**
 * actually approved, which is the check that decides whether the order is
 * accepted at all.
 *
 * Returns `undefined` — never a reduced fee — when the approval is short. A fee
 * silently lowered to fit is revenue the user never agreed to at a rate nobody
 * chose, and it hides the missing approval instead of surfacing it.
 */
export function builderFeeFor(
  config: Pick<HlConfig, "builderAddress" | "maxBuilderFee">,
  approval: BuilderApproval | null
): BuilderFee | undefined {
  if (!config.builderAddress || config.maxBuilderFee <= 0) return undefined;
  if (!approval || approval.approved === null) return undefined;

  // Case-insensitive: the wire is lowercase and config may be checksummed. A
  // case-sensitive compare would silently disable the fee forever.
  if (approval.builder.toLowerCase() !== config.builderAddress.toLowerCase()) {
    logger.warn("builder.approval_for_other_builder", {
      context: { approvedFor: approval.builder.slice(-6) },
    });
    return undefined;
  }

  if (approval.approved < config.maxBuilderFee) {
    logger.info("builder.fee_skipped", {
      context: { approved: approval.approved, wanted: config.maxBuilderFee },
    });
    return undefined;
  }

  return { b: config.builderAddress, f: config.maxBuilderFee };
}

/** Whether the user must be asked to approve before the fee can be charged. */
export function needsBuilderApproval(
  config: Pick<HlConfig, "builderAddress" | "maxBuilderFee">,
  approval: BuilderApproval | null
): boolean {
  if (!config.builderAddress || config.maxBuilderFee <= 0) return false;
  return builderFeeFor(config, approval) === undefined;
}

export interface ApproveBuilderClient {
  approveBuilderFee(params: { builder: Hex; maxFeeRate: string }): Promise<unknown>;
}

export type ApproveBuilderOutcome =
  | { kind: "approved"; rate: string; tenthsOfBasisPoint: number }
  /** The user declined, or the exchange refused. Nothing changed. */
  | { kind: "rejected"; error: HlError }
  /**
   * Sent, outcome unknown. **Re-read rather than re-sign** — a second approval
   * is not idempotent bookkeeping, it is a second signature prompt, and if the
   * first landed the user is asked to approve something already approved.
   */
  | { kind: "unknown"; error: HlError };

/**
 * Ask the user to approve this app's builder fee.
 *
 * The rate approved is exactly `config.maxBuilderFee` — no headroom. Approving
 * more than is charged means the dialog shows the user a number larger than what
 * they will pay, and the cost of that is trust; the cost of no headroom is that
 * raising the fee later needs every user to approve again. That trade was made
 * deliberately in favour of the honest dialog.
 *
 * @throws {HlError} when no builder is configured — a programmer error, not a
 *   runtime condition, and silently succeeding would leave a caller believing an
 *   approval exists.
 */
export async function approveBuilder(
  params: RequiresMasterWallet & {
    client: ApproveBuilderClient;
    config: Pick<HlConfig, "builderAddress" | "maxBuilderFee">;
  }
): Promise<ApproveBuilderOutcome> {
  const { builderAddress, maxBuilderFee } = params.config;
  if (!builderAddress) {
    throw new HlError("No builder is configured, so there is nothing to approve", {
      code: "invalid_config",
    });
  }

  // The one conversion, through the one converter. `maxBuilderFee` is tenths of
  // a basis point; the wire wants a percent string.
  const maxFeeRate = builderFeePercentString(maxBuilderFee);

  try {
    await params.client.approveBuilderFee({ builder: builderAddress, maxFeeRate });
    logger.info("builder.approved", { context: { maxFeeRate } });
    return { kind: "approved", rate: maxFeeRate, tenthsOfBasisPoint: maxBuilderFee };
  } catch (error) {
    const hl = toHlError(error, { stage: "approveBuilderFee" });
    // A refusal the server articulated, or a wallet that never signed: nothing
    // changed either way, and both are safe to present as "not approved".
    if (hl.code === "api_error" || hl.code === "validation_error") {
      logger.warn("builder.approval_rejected", { error: hl });
      return { kind: "rejected", error: hl };
    }
    logger.warn("builder.approval_unknown", { error: hl });
    return { kind: "unknown", error: hl };
  }
}
