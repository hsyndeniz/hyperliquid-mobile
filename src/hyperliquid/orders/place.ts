/**
 * The composed order entry point.
 *
 * `submitOrders` is deliberately mechanism-only — it takes a client and legs and
 * knows nothing about accounts or budgets. This module is where the Phase 1–3
 * pieces are actually joined, in the one order that is safe:
 *
 * ```
 * agent gate  ->  budget check  ->  mint cloids  ->  JOURNAL  ->  submit  ->  settle journal
 * ```
 *
 * The journal write sits **before** the request and is synchronous. That
 * ordering is the whole point: if the app is killed between sending and
 * replying — routine on mobile, and likeliest during exactly the network stall
 * that loses a response — the cloid is the only remaining handle on an order
 * that may be live, and it has to already be on disk.
 *
 * Nothing else in the codebase should call `submitOrders` directly.
 */

import { HlError } from "@/hyperliquid/core/errors";
import { actingRoute, effectiveAddress, identityKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import type { ActionBudget } from "@/hyperliquid/api/rateLimit";
import type { HlIdentity } from "@/hyperliquid/types/domain";
import type { AgentStatus } from "@/hyperliquid/auth/agentPolicy";
import type { BuilderFee, Grouping, OrderLeg } from "@/hyperliquid/orders/build";
import { generateCloid, type Cloid } from "@/hyperliquid/orders/cloid";
import { recordPending, resolvePending } from "@/hyperliquid/orders/pending";
import {
  ORDER_EXPIRY_WINDOW_MS,
  submitOrders,
  type SubmitOutcome,
} from "@/hyperliquid/orders/exchange";

import type { ExchangeClient } from "@nktkas/hyperliquid";

const logger = log.child("orders.place");

export interface PlaceOrdersParams {
  client: ExchangeClient;
  identity: HlIdentity;
  /** From `resolveAgentStatus` — trading is refused unless an agent is usable. */
  agentStatus: AgentStatus<{ address: string }>;
  budget: ActionBudget;
  /** Legs **without** cloids; this module mints and journals them. */
  orders: OrderLeg[];
  grouping?: Grouping;
  builder?: BuilderFee;
  label?: string;
  now?: () => number;
}

/**
 * Attach a freshly minted cloid to each leg.
 *
 * Minted here rather than by the caller so no leg can reach the wire without a
 * handle — `submitOrders` refuses a leg lacking one.
 */
function withCloids(orders: OrderLeg[]): { orders: OrderLeg[]; cloids: Cloid[] } {
  const cloids: Cloid[] = [];
  const withIds = orders.map((order) => {
    const cloid = order.c ?? generateCloid();
    cloids.push(cloid);
    return { ...order, c: cloid };
  });
  return { orders: withIds, cloids };
}

/**
 * Place orders with every guard applied.
 *
 * @throws {HlError} when the agent gate or the action budget refuses — both
 *   before anything is sent, so neither costs budget nor leaves a journal entry.
 */
export async function placeOrders(params: PlaceOrdersParams): Promise<SubmitOutcome> {
  const now = params.now ?? Date.now;

  // 1. Agent gate. `rotation_due` is still usable — rotation happens in the
  //    background rather than interrupting a trade.
  if (params.agentStatus.kind === "approval_required") {
    throw new HlError("Trading requires an approved agent", {
      code: "not_authorized",
      context: { reason: params.agentStatus.reason },
    });
  }

  // 2. Budget. A batch costs one action per leg against the address limit, so
  //    the whole batch is checked up front rather than leg by leg.
  if (!params.budget.canSpend(params.identity, "other", params.orders.length)) {
    const snapshot = params.budget.snapshot(params.identity);
    throw new HlError("Action rate limit exhausted for this account", {
      code: "rate_limited",
      context: {
        needed: params.orders.length,
        remaining: snapshot.remaining,
        retryInMs: params.budget.retryDelayMs(params.identity, "other"),
      },
    });
  }

  // 3. Mint handles.
  const { orders, cloids } = withCloids(params.orders);

  // 4. Journal BEFORE sending — synchronous, so it has landed by the time the
  //    request goes out.
  const expiresAt = now() + ORDER_EXPIRY_WINDOW_MS;
  recordPending({
    cloids,
    identityKey: identityKey(params.identity),
    address: effectiveAddress(params.identity),
    expiresAt,
    submittedAt: now(),
    ...(params.label ? { label: params.label } : {}),
  });

  // 5. Submit.
  const outcome = await submitOrders({
    client: params.client,
    orders,
    grouping: params.grouping,
    builder: params.builder,
    // Route to the sub-account when one is selected.
    ...actingRoute(params.identity),
    onSpend: (count) => params.budget.spend(params.identity, "other", count),
    now,
  });

  // 6. Settle the journal only when the outcome is actually known. An `unknown`
  //    outcome deliberately leaves the entry in place — that is what the
  //    startup reconciler picks up.
  if (outcome.kind === "settled" || outcome.kind === "rejected_locally") {
    resolvePending(cloids);
  } else {
    logger.warn("place.left_pending", { context: { cloids: cloids.length, expiresAt } });
  }

  return outcome;
}
