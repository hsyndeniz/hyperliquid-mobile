/**
 * Startup reconciliation — closing the loop on submits the app never saw resolve.
 *
 * Phase 3 journals every submit before sending and leaves the entry in place
 * when the outcome is unknown. This is what consumes those entries: on launch,
 * anything still in the journal is a submit whose fate was never learned,
 * usually because the app was killed or the network dropped between sending and
 * replying.
 *
 * Two rules govern it, both inherited from why the journal exists:
 *
 * - **Only conclusive entries are probed.** Before its expiry window elapses an
 *   order may still land, so a negative probe proves nothing and would invite a
 *   duplicate.
 * - **Only conclusive legs are forgotten.** Landed, absent and rejected all
 *   leave the journal; only indeterminate legs and failed probes stay for the
 *   next attempt. A rejected cloid is the one worth naming: `orderStatus` keeps
 *   answering for it forever, so leaving it journalled re-probes a settled
 *   question on every launch.
 */

import { log } from "@/hyperliquid/core/logger";
import type { HlIdentity } from "@/hyperliquid/types/domain";
import type { Cloid } from "@/hyperliquid/orders/cloid";
import {
  listPending,
  pendingForIdentity,
  resolvePending,
  type PendingSubmit,
} from "@/hyperliquid/orders/pending";
import {
  reconcileCloids,
  type CloidVerdict,
  type OrderStatusProbe,
} from "@/hyperliquid/orders/reconcile";

const logger = log.child("orders.startup");

export interface StartupReconcileResult {
  /** Orders found live on the exchange — adopt these into state. */
  landed: CloidVerdict[];
  /** Confirmed never placed; cleared from the journal. */
  notLanded: Cloid[];
  /**
   * The exchange saw it and refused it. Nothing is on the book, so a corrected
   * resubmission is safe — and it is cleared from the journal, because
   * `orderStatus` keeps answering for a rejected cloid indefinitely and
   * re-probing a settled question on every launch achieves nothing.
   *
   * Separate from `notLanded` because the two differ where it matters: one
   * never reached the exchange, the other carries a reason worth surfacing.
   */
  rejected: CloidVerdict[];
  /** Still unresolved — left journalled for a later attempt. */
  unresolved: Cloid[];
  /** Entries skipped because their window has not elapsed. */
  deferred: number;
}

export interface StartupReconcileParams {
  probe: OrderStatusProbe;
  /** Restrict to one account; omit to sweep every journalled entry. */
  identity?: HlIdentity;
  now?: () => number;
}

/**
 * Resolve journalled submits.
 *
 * Safe to call on every launch and after reconnecting — it is idempotent, and
 * probes only what can be answered definitively.
 */
export async function reconcilePendingSubmits(
  params: StartupReconcileParams
): Promise<StartupReconcileResult> {
  const now = params.now ?? Date.now;
  const timestamp = now();

  // Everything in scope, then the subset whose expiry window has elapsed.
  // The difference is what must wait — probing it now would prove nothing.
  const inScope = params.identity ? pendingForIdentity(params.identity) : listPending();
  const entries: PendingSubmit[] = inScope.filter((entry) => timestamp > entry.expiresAt);
  const deferred = inScope.length - entries.length;

  if (entries.length === 0) {
    return { landed: [], notLanded: [], rejected: [], unresolved: [], deferred };
  }

  logger.info("reconcile.start", { context: { entries: entries.length, deferred } });

  const landed: CloidVerdict[] = [];
  const notLanded: Cloid[] = [];
  const rejected: CloidVerdict[] = [];
  const unresolved: Cloid[] = [];

  for (const entry of entries) {
    const verdicts = await reconcileCloids({
      probe: params.probe,
      user: entry.address,
      cloids: entry.cloids,
      expiresAt: entry.expiresAt,
      now,
    });

    for (const verdict of verdicts) {
      if (verdict.kind === "landed") landed.push(verdict);
      else if (verdict.kind === "not_landed") notLanded.push(verdict.cloid);
      else if (verdict.kind === "rejected") rejected.push(verdict);
      else unresolved.push(verdict.cloid);
    }

    // Three of the four verdicts are conclusive and leave the journal.
    //
    // `landed` because its fate is known and it belongs to live state.
    // `not_landed` because the window closed with nothing on the book.
    // `rejected` because the exchange said so — and this one is the trap: the
    // exchange keeps answering `orderStatus` for a rejected cloid forever, so
    // leaving it journalled re-probes the same conclusive answer on every single
    // launch, burning weight budget for a question already settled. It is
    // reported separately from `not_landed` because the two mean different
    // things to a caller: never reached the exchange, versus refused by it.
    const resolved = verdicts
      .filter((v) => v.kind === "landed" || v.kind === "not_landed" || v.kind === "rejected")
      .map((v) => v.cloid);
    resolvePending(resolved);
  }

  logger.info("reconcile.done", {
    context: {
      landed: landed.length,
      notLanded: notLanded.length,
      rejected: rejected.length,
      unresolved: unresolved.length,
      deferred,
    },
  });

  return { landed, notLanded, rejected, unresolved, deferred };
}
