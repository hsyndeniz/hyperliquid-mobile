/**
 * Post-timeout reconciliation: "did that order actually land?"
 *
 * When a submit times out, the **response** was lost — not the order. The API
 * only replies once the action is in a committed block, so it may still land
 * afterwards. That makes the naive responses both wrong:
 *
 * - Retrying re-signs with a fresh nonce and places a **second real order**
 *   (replaying the original nonce is rejected outright, so there is no free
 *   idempotent retry).
 * - Reporting failure hides an order that is live and may fill.
 *
 * The only sound procedure is to wait until the action can no longer land, then
 * ask the exchange by client order id.
 */

import { log } from "@/hyperliquid/core/logger";
import { readCloid, type Cloid } from "@/hyperliquid/orders/cloid";

const logger = log.child("orders.reconcile");

/**
 * Statuses meaning the exchange saw the order and **refused it outright**.
 *
 * Verified against the SDK's `OrderProcessingStatus`. The distinction matters:
 * a rejected order was recorded (so `orderStatus` finds it by cloid) but never
 * reached the book. Treating it as landed would block a legitimate retry
 * forever — the user could never re-place an order that failed on margin.
 */
// Case-INSENSITIVE, and that is the whole point: the union's members are
// camelCase (`tickRejected`, `perpMarginRejected`, …) EXCEPT the bare
// `"rejected"` — "Order rejected by the system" — which a case-sensitive
// `/Rejected$/` silently missed. That miss classified a refused order as
// `landed`, which is the one outcome this module's docstring above says must
// never happen: it adopts a non-existent order and blocks the retry forever.
const REJECTED_STATUS = /rejected$/i;

/** True for a status meaning "seen, but never placed". */
export function isRejectedStatus(status: string): boolean {
  return REJECTED_STATUS.test(status);
}

export type CloidVerdict =
  /** The order exists on the exchange — resting, filled, or otherwise live. */
  | { cloid: Cloid; kind: "landed"; oid: number | null; status: string }
  /**
   * The exchange saw it and refused it. Nothing is on the book, so a corrected
   * resubmission is safe.
   */
  | { cloid: Cloid; kind: "rejected"; status: string }
  /** Conclusively absent: the expiry window has passed and it is unknown. */
  | { cloid: Cloid; kind: "not_landed" }
  /**
   * Still within the window — the order may yet land, so no conclusion is
   * possible. Never treat this as failure.
   */
  | { cloid: Cloid; kind: "indeterminate" }
  /** The probe itself failed; the outcome remains unknown. */
  | { cloid: Cloid; kind: "probe_failed"; error: unknown };

/** Just the slice of `InfoClient` this module needs, so tests need no network. */
export interface OrderStatusProbe {
  orderStatus(params: { user: string; oid: string | number }): Promise<unknown>;
}

/**
 * Whether the expiry window has elapsed.
 *
 * Before it does, a negative probe means nothing: the action may still be
 * committed. This is precisely what `expiresAfter` on the submit buys us —
 * without it there is no time at which absence becomes conclusive.
 */
export function isConclusive(expiresAt: number, now: number): boolean {
  return now > expiresAt;
}

/**
 * Interpret an `orderStatus` response.
 *
 * Three outcomes, deliberately distinct:
 * - **found** — the order exists. Terminal states count: one that filled and
 *   closed still landed.
 * - **absent** — `{ status: "unknownOid" }`, the *only* documented not-found
 *   signal.
 * - **unrecognised** — we could not read the body at all.
 *
 * Collapsing `unrecognised` into `absent` would be the worst possible bug in
 * this module: a garbled or schema-drifted response would read as proof the
 * order never landed, and a retry would place a duplicate.
 */
export function interpretOrderStatus(
  response: unknown
):
  | { kind: "found"; oid: number | null; status: string }
  | { kind: "absent" }
  | { kind: "unrecognised" } {
  if (typeof response !== "object" || response === null) return { kind: "unrecognised" };
  const status = (response as { status?: unknown }).status;
  if (status === "unknownOid") return { kind: "absent" };

  const order = (response as { order?: unknown }).order;
  if (typeof order === "object" && order !== null) {
    const inner = (order as { order?: unknown }).order ?? order;
    const oid = (inner as { oid?: unknown }).oid;
    const orderStatus = (order as { status?: unknown }).status;
    return {
      kind: "found",
      oid: typeof oid === "number" ? oid : null,
      status: typeof orderStatus === "string" ? orderStatus : "unknown",
    };
  }
  // Recognised as neither. Absence is not proven.
  return { kind: "unrecognised" };
}

export interface ReconcileParams {
  probe: OrderStatusProbe;
  /** The address the orders were placed for — the sub-account when one is active. */
  user: string;
  cloids: Cloid[];
  /** From the submit outcome. */
  expiresAt: number;
  now?: () => number;
}

/**
 * Resolve what became of each cloid from a submit whose outcome is unknown.
 *
 * Uses `orderStatus` per cloid rather than `historicalOrders`: the former costs
 * request weight 2, the latter 20 plus more per page, and a mobile client can
 * share an IP-based weight budget with other users behind carrier NAT.
 */
export async function reconcileCloids(params: ReconcileParams): Promise<CloidVerdict[]> {
  const now = params.now ?? Date.now;
  const conclusive = isConclusive(params.expiresAt, now());

  return Promise.all(
    params.cloids.map(async (cloid): Promise<CloidVerdict> => {
      try {
        const response = await params.probe.orderStatus({ user: params.user, oid: cloid });
        const parsed = interpretOrderStatus(response);
        if (parsed.kind === "found") {
          if (isRejectedStatus(parsed.status)) {
            // Recorded but never placed — safe to correct and resubmit.
            logger.info("reconcile.rejected", { context: { status: parsed.status } });
            return { cloid, kind: "rejected", status: parsed.status };
          }
          logger.info("reconcile.landed", { context: { oid: parsed.oid, status: parsed.status } });
          return { cloid, kind: "landed", oid: parsed.oid, status: parsed.status };
        }
        if (parsed.kind === "unrecognised") {
          // We learned nothing. Treating this as absence would green-light a
          // duplicate order.
          logger.warn("reconcile.unrecognised_response", {});
          return {
            cloid,
            kind: "probe_failed",
            error: new Error("Unrecognised orderStatus response"),
          };
        }
        // Absent — but only meaningful once the order can no longer land.
        if (!conclusive) {
          logger.info("reconcile.indeterminate", { context: { expiresAt: params.expiresAt } });
          return { cloid, kind: "indeterminate" };
        }
        logger.info("reconcile.not_landed", {});
        return { cloid, kind: "not_landed" };
      } catch (error) {
        logger.warn("reconcile.probe_failed", { error });
        return { cloid, kind: "probe_failed", error };
      }
    })
  );
}

/**
 * Whether it is safe to resubmit.
 *
 * Only when **every** cloid is conclusively absent. Any landed, indeterminate
 * or failed probe makes a retry a potential double-order — the exact hazard
 * this module exists to prevent.
 */
export function canSafelyRetry(verdicts: CloidVerdict[]): boolean {
  return (
    verdicts.length > 0 &&
    // "rejected" counts: the exchange refused it, so nothing is on the book.
    verdicts.every((verdict) => verdict.kind === "not_landed" || verdict.kind === "rejected")
  );
}

/** Orders that reached the book, e.g. to cancel or to adopt into local state. */
export function landedOids(verdicts: CloidVerdict[]): number[] {
  return verdicts.flatMap((verdict) =>
    verdict.kind === "landed" && verdict.oid !== null ? [verdict.oid] : []
  );
}

/** Match an order from any Hyperliquid shape back to a pending cloid. */
export function matchesCloid(order: { cloid?: string | null }, cloid: Cloid): boolean {
  return readCloid(order) === cloid;
}
