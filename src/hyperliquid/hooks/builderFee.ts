/**
 * The builder-fee approval, as a UI needs it.
 *
 * Headless, like the account hooks: it takes its dependencies explicitly rather
 * than reaching for a session singleton, so it is testable without React context
 * and the app decides where the clients live.
 *
 * The whole surface a prompt needs is four things — whether to ask, what the
 * user is agreeing to, a function to ask, and what happened. Everything harder
 * lives in `orders/builderFee.ts`.
 *
 * **The re-read after approving is not optional.** `approveBuilder` resolving
 * means the exchange accepted the signature, not that the approval is readable
 * yet. Trusting the resolve and attaching a fee immediately would send orders
 * against an approval the exchange has not published, and those orders are
 * rejected. So the hook re-reads and only then reports `approved`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { builderFeePercentString, type HlConfig } from "@/hyperliquid/config/env";
import { log } from "@/hyperliquid/core/logger";
import {
  approveBuilder,
  builderFeeFor,
  needsBuilderApproval,
  readBuilderApproval,
  type ApproveBuilderClient,
  type BuilderApproval,
  type BuilderFeeProbe,
} from "@/hyperliquid/orders/builderFee";
import type { Hex } from "@/hyperliquid/types/domain";

const logger = log.child("hooks.builderFee");

export type BuilderFeeStatus =
  /** Reading the current approval. */
  | "loading"
  /** No builder configured, or the fee is zero — there is nothing to ask for. */
  | "disabled"
  /** The user has not approved enough. A prompt belongs on screen. */
  | "needed"
  /** Waiting on the user's signature. */
  | "approving"
  /** Approved and readable. Orders will carry the fee. */
  | "approved"
  /** The user declined, or the exchange refused. Safe to offer again. */
  | "declined"
  /**
   * Sent, outcome unknown. **Do not offer to sign again** — re-read instead, or
   * the user is asked to approve something that may already be approved.
   */
  | "unknown";

export interface BuilderFeeState {
  status: BuilderFeeStatus;
  /** What the user is being asked to agree to, e.g. `"0.01%"`. */
  rate: string;
  builder: Hex | null;
  approval: BuilderApproval | null;
  /** Prompt the user. A no-op unless the status is `needed` or `declined`. */
  approve: () => Promise<void>;
  /** Re-read without prompting. The correct response to `unknown`. */
  refresh: () => Promise<void>;
}

export interface UseBuilderFeeParams {
  config: Pick<HlConfig, "builderAddress" | "maxBuilderFee">;
  /** The account that would pay the fee. `null` before a session starts. */
  user: Hex | null;
  probe: BuilderFeeProbe;
  /**
   * Signs the approval. **The master wallet** — this is a user-signed action,
   * so an agent client would approve a builder for an address that never trades.
   */
  client: ApproveBuilderClient;
}

export function useBuilderFee(params: UseBuilderFeeParams): BuilderFeeState {
  const { config, user, probe, client } = params;
  const [approval, setApproval] = useState<BuilderApproval | null>(null);
  const [status, setStatus] = useState<BuilderFeeStatus>("loading");
  // Guards a resolve arriving after the account changed or the screen closed.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const enabled = Boolean(config.builderAddress) && config.maxBuilderFee > 0;
  // `user` is null until a session starts. Combined with `enabled` this is
  // DERIVED rather than pushed into state — setting "disabled" from inside the
  // mount effect is a synchronous setState in an effect, which cascades a render
  // for a value that was already knowable.
  const ready = enabled && user !== null;

  const refresh = useCallback(async () => {
    if (!ready) return;
    const next = await readBuilderApproval({
      probe,
      user,
      builder: config.builderAddress as Hex,
    });
    if (!live.current) return;
    setApproval(next);
    setStatus(needsBuilderApproval(config, next) ? "needed" : "approved");
  }, [ready, user, probe, config]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = useCallback(async () => {
    if (!ready) return;
    setStatus("approving");
    const outcome = await approveBuilder({ signer: "master", client, config });
    if (!live.current) return;

    if (outcome.kind === "rejected") {
      setStatus("declined");
      return;
    }
    if (outcome.kind === "unknown") {
      // Never offer to sign again from here. A re-read is the only safe move.
      logger.warn("builder.approval_unknown", { error: outcome.error });
      setStatus("unknown");
      return;
    }
    // Accepted the signature — which is not the same as published. Re-read.
    await refresh();
  }, [ready, client, config, refresh]);

  const rate = useMemo(
    () => (enabled ? builderFeePercentString(config.maxBuilderFee) : "0%"),
    [enabled, config.maxBuilderFee]
  );

  return {
    status: ready ? status : "disabled",
    rate,
    builder: config.builderAddress ?? null,
    approval,
    approve,
    refresh,
  };
}

/** The fee to attach to an order right now, or `undefined`. */
export function useBuilderFeeForOrder(
  state: BuilderFeeState,
  config: UseBuilderFeeParams["config"]
) {
  return useMemo(() => builderFeeFor(config, state.approval), [config, state.approval]);
}
