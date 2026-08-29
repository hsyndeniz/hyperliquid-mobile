/**
 * The ticket's submit path — the money path, behind the user's go-ahead.
 *
 * One entry point for seven of the eight types (`placeOrders` — the only
 * road to the agent gate, the budget check, cloid minting and the pre-send
 * journal) and a second for TWAP (`placeTwapOrder`), which has none of that
 * machinery: no cloid exists for a TWAP, so nothing can be journaled and
 * nothing reconciled.
 *
 * ## The outcome rules, verbatim from the order module
 *
 * - `settled` — confirmed. Partial settlement is the NORMAL case for a scale
 *   ladder, so the note counts legs rather than claiming one success.
 * - `rejected_locally` — the exchange refused before anything rested. Safe
 *   to fix the ticket and retry.
 * - `unknown` — the request timed out mid-flight. The order MAY HAVE LANDED
 *   and may still land until its expiry. The UI must not say "failed" and
 *   must not offer a retry — the journal holds the cloids and the startup
 *   reconciler owns the resolution. For a TWAP the same state is worse
 *   (nothing to reconcile by), so the note says to check the TWAP tab.
 *
 * Haptics ride the terminal states (pulsar presets): success pop on settled,
 * error thud on rejection. Nothing fires on `unknown` — neither feeling is
 * true.
 */

import { useCallback, useState } from "react";
import { Presets } from "react-native-pulsar";

import { describeSubmitError } from "@/components/trade/submitErrors";
import { actionBudget } from "@/hyperliquid/api/rateLimit";
import { resolveAssetSpec } from "@/hyperliquid/assets";
import { toHlError } from "@/hyperliquid/core/errors";
import { actingRoute } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import { assetIndex } from "@/hyperliquid/hooks/assets";
import { placeTwapOrder } from "@/hyperliquid/orders/exchange";
import { placeOrders } from "@/hyperliquid/orders/place";
import type { HyperliquidSession } from "@/hyperliquid/session";
import type { TicketContext, TicketState } from "@/components/trade/orderForm";
import { ticketToLegs, twapPayload } from "@/components/trade/ticketSubmit";

const logger = log.child("trade.submit");

/** What the foot line renders after a submit. Cleared by the next edit. */
export type SubmitPhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "settled"; note: string }
  | { kind: "rejected"; note: string }
  | { kind: "unknown"; note: string };

export function usePlaceTicket(session: HyperliquidSession): {
  phase: SubmitPhase;
  /** Back to idle — called when the user edits the ticket after a result. */
  reset: () => void;
  /** Requires a VALID ticket (orderBlockers empty) — callers gate first. */
  submit: (ticket: TicketState, ctx: TicketContext, wireCoin: string) => Promise<void>;
} {
  const [phase, setPhase] = useState<SubmitPhase>({ kind: "idle" });

  const submit = useCallback(
    async (ticket: TicketState, ctx: TicketContext, wireCoin: string) => {
      setPhase({ kind: "submitting" });
      try {
        const current = session.state();
        if (!current) throw new Error("no session");
        const asset = resolveAssetSpec(await assetIndex(), wireCoin);

        if (ticket.type === "twap") {
          const twap = await placeTwapOrder({
            client: session.exchangeClient(),
            input: twapPayload(ticket, ctx, asset),
            ...actingRoute(current.identity),
            onSpend: (n) => actionBudget.spend(current.identity, "other", n),
          });
          if (twap.kind === "placed") {
            Presets.System.notificationSuccess();
            setPhase({ kind: "settled", note: `TWAP #${twap.twapId} running` });
            return;
          }
          if (twap.kind === "rejected") {
            Presets.System.notificationError();
            setPhase({ kind: "rejected", note: describeSubmitError(twap.error) });
            return;
          }
          // `unknown` — the same rule as below, and stricter, because there is
          // no cloid to journal and no reconciler to hand it to: only the next
          // `twapStates` frame can say whether a TWAP is running. A resubmit
          // would not replace it, it would ADD one, and the account would work
          // the size twice for up to 24 hours. No haptic, no failure claim; the
          // sheet's `frozen` blocks the button on this phase.
          setPhase({
            kind: "unknown",
            note: "Submitted — confirmation pending. Check the TWAP tab; do not resubmit.",
          });
          return;
        }

        const { legs, grouping } = ticketToLegs(ticket, ctx, asset);
        const outcome = await placeOrders({
          client: session.exchangeClient(),
          identity: current.identity,
          agentStatus: current.agent.status,
          budget: actionBudget,
          orders: [...legs],
          grouping,
        });

        if (outcome.kind === "settled") {
          // "Settled" means the exchange ANSWERED, not that anything rests.
          // Three settled shapes place zero orders — a top-level refusal
          // (serverError), every leg rejected per-leg (the SDK throws while
          // carrying the statuses, so these never reach rejected_locally),
          // and a truncated batch — and announcing "Order placed" with a
          // success haptic for any of them is the exact dishonesty the
          // outcome module's docs forbid. A definite refusal is also
          // retry-SAFE, unlike `unknown`, so saying "rejected" here is
          // correct in both directions. (Reviewed 2026-08-18 — this bug
          // shipped with the money path and survived until the adversarial
          // pass caught it.)
          if (!outcome.result.anyAccepted) {
            const reason =
              outcome.result.serverError ?? firstLegError(outcome.result.legs) ?? "Order rejected.";
            Presets.System.notificationError();
            setPhase({ kind: "rejected", note: describeSubmitError(new Error(reason)) });
            return;
          }
          Presets.System.notificationSuccess();
          setPhase({
            kind: "settled",
            note: outcome.result.isPartial
              ? // A scale ladder's NORMAL case — some legs rest, some refused.
                "Placed — some legs were refused; check Open Orders"
              : legs.length > 1
                ? `Placed ${legs.length} orders`
                : "Order placed",
          });
          return;
        }
        if (outcome.kind === "rejected_locally") {
          Presets.System.notificationError();
          setPhase({ kind: "rejected", note: describeSubmitError(outcome.error) });
          return;
        }
        // `unknown` — the journal rule. No retry offer, no failure claim, no
        // haptic: the order may land until expiry and the reconciler owns it.
        setPhase({
          kind: "unknown",
          note: "Submitted — confirmation pending. Check Open Orders; do not resubmit.",
        });
      } catch (caught) {
        const error = toHlError(caught);
        logger.warn("trade.submit_failed", { context: { type: ticket.type }, error });
        Presets.System.notificationError();
        setPhase({ kind: "rejected", note: describeSubmitError(error) });
      }
    },
    [session]
  );

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);
  return { phase, reset, submit };
}

/** The first per-leg rejection string — the server's own words for the note. */
function firstLegError(legs: readonly { kind: string; error?: string }[]): string | null {
  for (const leg of legs) {
    if (leg.kind === "rejected" && typeof leg.error === "string") return leg.error;
  }
  return null;
}
