/**
 * Order submission.
 *
 * Everything that reaches the exchange goes through here so four invariants
 * hold on every path:
 *
 * 1. **A batch costs N actions, not one.** Hyperliquid counts a batched request
 *    as one request for IP limits but **n requests for the address limit**.
 *    Charging 1 would let the local budget drift far above the server's and
 *    strand a user mid-trade.
 * 2. **Every action that can REST an order carries `expiresAfter`** — submits and
 *    amends alike. Without it, an order that stalls in the network can land
 *    minutes later at a price the user never agreed to, and no probe can prove a
 *    timed-out request is dead. Amends were missed at first: `batchModify`
 *    *places* orders, so the hazard is identical, and only `order` was stamped.
 * 3. **A thrown error never means "nothing happened".** The SDK rejects the
 *    promise when *any* leg errors, while the other legs are live. Outcomes are
 *    always read through {@link interpretOrderResult}.
 * 4. **Failure kinds are routed, not collapsed.** Validation failures never
 *    left the device and are safe to retry; transport failures leave the
 *    outcome unknown and must be reconciled by cloid.
 */

import { BigNumber } from "bignumber.js";

import type { ExchangeClient } from "@nktkas/hyperliquid";

import { serverNow } from "@/hyperliquid/core/clock";
import { classifySdkError, HlError } from "@/hyperliquid/core/errors";
import { toBigNumber } from "@/hyperliquid/core/precision";
import { log } from "@/hyperliquid/core/logger";
import type { Cloid } from "@/hyperliquid/orders/cloid";
import {
  MIN_ORDER_NOTIONAL_USDC,
  notionalOf,
  type BuilderFee,
  type Grouping,
  type OrderLeg,
} from "@/hyperliquid/orders/build";
import {
  interpretOrderResult,
  readSingleStatusError,
  readTopLevelError,
  type OrderResult,
} from "@/hyperliquid/orders/outcome";

const logger = log.child("orders");

/**
 * How long after submission an action may still execute.
 *
 * Must exceed the HTTP timeout, so a submit that times out locally can still be
 * waited out and then probed conclusively: after this window the action can no
 * longer land, which is the only thing that makes a retry safe. Hyperliquid's
 * own frontend uses 15s; this is deliberately longer than our 15s request
 * timeout so the two do not race.
 */
export const ORDER_EXPIRY_WINDOW_MS = 30_000;

/**
 * Routes an action to a sub-account (or vault) instead of the signer's account.
 *
 * On **every** mutating action, not just submission. Hyperliquid's own wording is
 * that "subaccounts and vaults do not have private keys… signing should be done
 * by the master account and the vaultAddress field should be set". So an order
 * placed with it set is an order the master cannot see: a cancel or amend without
 * it is issued against the master's own account, where that oid does not exist,
 * and the order stays resting with no way to reach it.
 *
 * Optional so the master path is unchanged, and spelled the same everywhere so a
 * new action is obviously missing it.
 */
export interface VaultRouted {
  /** The sub-account or vault to act on behalf of. Omit for the signer's own account. */
  vaultAddress?: string;
}

/** `{ vaultAddress }` or nothing — never `{ vaultAddress: undefined }`, which the schema rejects. */
function routeTo(params: VaultRouted): { vaultAddress?: string } {
  return params.vaultAddress ? { vaultAddress: params.vaultAddress } : {};
}

/** What happened to a submit, including the "we genuinely do not know" case. */
export type SubmitOutcome =
  | { kind: "settled"; result: OrderResult }
  /**
   * The request never left the device (schema rejection). Nothing was placed;
   * safe to fix and retry with the same cloids.
   */
  | { kind: "rejected_locally"; error: HlError }
  /**
   * The request was sent and the outcome is **unknown** — timeout, dropped
   * connection. The order may still land. Do not retry: reconcile by cloid.
   */
  | { kind: "unknown"; error: HlError; cloids: Cloid[]; expiresAt: number };

export interface SubmitOrdersParams extends VaultRouted {
  client: ExchangeClient;
  orders: OrderLeg[];
  grouping?: Grouping;
  builder?: BuilderFee;
  /** Charged against the action budget; caller supplies its own accounting hook. */
  onSpend?: (actionCount: number) => void;
  /** Overridable for tests. */
  now?: () => number;
}

/**
 * Every leg's cloid, or a hard error.
 *
 * A leg without a cloid has **no handle** if the response is lost: it cannot be
 * probed by `orderStatus`, so its outcome can never be resolved and a retry
 * would risk duplicating it. Rather than silently reconciling only the subset
 * that happens to carry one, this refuses the submit outright — before any
 * budget is spent.
 */
function cloidsOf(orders: OrderLeg[]): Cloid[] {
  const cloids = orders.flatMap((order) => (order.c ? [order.c] : []));
  if (cloids.length !== orders.length) {
    throw new HlError(
      "Every order leg must carry a cloid — a leg without one cannot be reconciled after a timeout",
      { code: "invalid_config", context: { legs: orders.length, withCloid: cloids.length } }
    );
  }
  return cloids;
}

/**
 * Submit a batch of orders.
 *
 * Never throws for an exchange-side outcome — the result is always a
 * {@link SubmitOutcome} the caller must branch on. It throws only for
 * programmer error (an empty batch).
 */
export async function submitOrders(params: SubmitOrdersParams): Promise<SubmitOutcome> {
  const { client, orders } = params;
  if (orders.length === 0) {
    throw new HlError("Cannot submit an empty order batch", { code: "invalid_config" });
  }

  const now = params.now ?? Date.now;
  // Two clocks, deliberately. `expiresAfter` is checked by the exchange against
  // block time, so it is built on the *server's* clock; `expiresAt` is read back
  // by `reconcileCloids` against a local `Date.now()`, so it stays on *ours*.
  // These were one number until a skewed phone made that a bug — a device
  // running a minute slow signed actions that were born expired. See
  // `core/clock`.
  const issuedAt = now();
  const expiresAt = issuedAt + ORDER_EXPIRY_WINDOW_MS;
  const expiresAfter = serverNow(issuedAt) + ORDER_EXPIRY_WINDOW_MS;
  const cloids = cloidsOf(orders);

  // Charged before the call, and by leg count: the address limit counts each
  // order in a batch separately.
  params.onSpend?.(orders.length);

  const startedAt = now();
  try {
    const response = await client.order(
      {
        orders,
        grouping: params.grouping ?? "na",
        // `undefined`, never `null` — the field is optional and null is a hard
        // validation error.
        ...(params.builder ? { builder: params.builder } : {}),
      },
      {
        expiresAfter,
        ...routeTo(params),
      }
    );

    const result = interpretOrderResult({ ok: true, response }, orders.length);
    logger.info("submit.settled", {
      context: { legs: orders.length, partial: result?.isPartial ?? false },
      durationMs: now() - startedAt,
    });
    return { kind: "settled", result: result ?? emptyResult() };
  } catch (error) {
    const code = classifySdkError(error);

    // The server evaluated the batch and told us what happened per leg — even
    // though it rejected the promise. Some legs may be live on the book.
    const recovered = interpretOrderResult({ ok: false, error }, orders.length);
    if (recovered) {
      logger.warn("submit.partial_or_rejected", {
        context: {
          legs: orders.length,
          accepted: recovered.anyAccepted,
          partial: recovered.isPartial,
        },
        error,
        durationMs: now() - startedAt,
      });
      return { kind: "settled", result: recovered };
    }

    if (code === "validation_error") {
      // Nothing left the device.
      logger.warn("submit.rejected_locally", { error });
      return {
        kind: "rejected_locally",
        error: new HlError("Order rejected before sending", {
          code: "validation_error",
          cause: error,
        }),
      };
    }

    // `offline` is deliberately NOT short-circuited to `rejected_locally`, and
    // that is the correction of a real defect rather than caution.
    //
    // The branch that used to sit here returned "No connection — the order was
    // not sent", reasoning that an offline failure proves the connection was
    // never opened. It does not. The whole discriminator is a substring match
    // on React Native's `TypeError: Network request failed` (see
    // `core/errors.OFFLINE_MESSAGES`), and RN raises that identical message
    // from `xhr.onerror` for ANY network-layer failure — including a
    // connection that opened, transmitted the signed order in full, and then
    // reset before the reply. That is routine on a Wi-Fi -> cellular handover
    // (iOS `NSURLErrorNetworkConnectionLost`), and it arrives promptly rather
    // than as a stall, so the transport timeout never sees it.
    //
    // Calling that "not sent" told the user a definite, retry-safe lie AND had
    // `placeOrders` resolve the journal entry, which is the only handle the
    // reconciler has. Retrying then places a SECOND order — a doubled position
    // with the evidence deleted.
    //
    // The cost is accepted deliberately: in genuine airplane mode the user is
    // now told the outcome is unknown rather than "not sent", which is less
    // helpful and more honest. Nothing here can distinguish the two cases —
    // only a reachability probe taken BEFORE dispatch could, and there is no
    // such dependency in the app today. If one is ever added, the provable
    // case belongs at the call site as a pre-flight refusal (nothing sent
    // because nothing was attempted), never as a reading of the failure.
    // A top-level `{status:"err"}` is the server refusing the whole action —
    // definite, not unknown. Reporting it as unknown would send the caller into
    // a reconciliation it does not need.
    const topLevelError = readTopLevelError(error);
    if (topLevelError) {
      logger.warn("submit.rejected_by_server", { context: { reason: topLevelError }, error });
      return { kind: "settled", result: { ...emptyResult(), serverError: topLevelError } };
    }

    // Sent, outcome unknown. The order may still land until `expiresAt`.
    logger.error("submit.unknown", {
      context: { legs: orders.length, cloids: cloids.length, expiresAt },
      error,
      durationMs: now() - startedAt,
    });
    return {
      kind: "unknown",
      error: new HlError("Order outcome unknown — reconcile before retrying", {
        code,
        cause: error,
        context: { expiresAt },
      }),
      cloids,
      expiresAt,
    };
  }
}

function emptyResult(): OrderResult {
  return {
    legs: [],
    anyAccepted: false,
    anyRejected: false,
    isPartial: false,
    batchRejected: true,
  };
}

export interface CancelParams extends VaultRouted {
  client: ExchangeClient;
  /** `{ assetId, oid }` pairs. */
  cancels: { assetId: number; oid: number }[];
  onSpend?: (actionCount: number) => void;
}

/**
 * Cancel by order id.
 *
 * Same bulk semantics as submission: if one oid is already filled the call
 * throws, but **the other cancels still took effect**. Never blind-retry a
 * cancel batch on throw — re-read open orders first.
 */
export async function cancelOrders(
  params: CancelParams
): Promise<{ ok: boolean; error?: unknown }> {
  if (params.cancels.length === 0) return { ok: true };
  params.onSpend?.(params.cancels.length);
  try {
    await params.client.cancel(
      { cancels: params.cancels.map(({ assetId, oid }) => ({ a: assetId, o: oid })) },
      routeTo(params)
    );
    return { ok: true };
  } catch (error) {
    logger.warn("cancel.failed", { context: { count: params.cancels.length }, error });
    return { ok: false, error };
  }
}

export interface CancelByCloidParams extends VaultRouted {
  client: ExchangeClient;
  cancels: { assetId: number; cloid: Cloid }[];
  onSpend?: (actionCount: number) => void;
}

/**
 * Cancel by client order id.
 *
 * Note the wire field names differ from `cancel`: `{ asset, cloid }` spelled
 * out, not `{ a, o }`. Reusing the terse shape fails validation before send.
 */
export async function cancelOrdersByCloid(
  params: CancelByCloidParams
): Promise<{ ok: boolean; error?: unknown }> {
  if (params.cancels.length === 0) return { ok: true };
  params.onSpend?.(params.cancels.length);
  try {
    await params.client.cancelByCloid(
      { cancels: params.cancels.map(({ assetId, cloid }) => ({ asset: assetId, cloid })) },
      routeTo(params)
    );
    return { ok: true };
  } catch (error) {
    logger.warn("cancel_by_cloid.failed", { context: { count: params.cancels.length }, error });
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------

export interface ModifyTarget {
  /** Order id, or the cloid it was placed with — the schema accepts either. */
  oid: number | Cloid;
  order: OrderLeg;
}

/**
 * Amend a single resting order.
 *
 * The response carries **no oid and no per-order data** — only a bare
 * `{type:"default"}` — so the amended order must be re-read from open orders if
 * its identity matters. Amending by cloid keeps the same handle across the
 * change, which is why that overload exists.
 */
export async function modifyOrder(
  params: VaultRouted & {
    client: ExchangeClient;
    target: ModifyTarget;
    onSpend?: (actionCount: number) => void;
    now?: () => number;
  }
): Promise<{ ok: boolean; error?: unknown }> {
  const now = params.now ?? Date.now;
  params.onSpend?.(1);
  try {
    await params.client.modify(
      { oid: params.target.oid, order: params.target.order },
      { expiresAfter: serverNow(now()) + ORDER_EXPIRY_WINDOW_MS, ...routeTo(params) }
    );
    return { ok: true };
  } catch (error) {
    logger.warn("modify.failed", { error });
    return { ok: false, error };
  }
}

/**
 * Amend several resting orders in one action.
 *
 * Same bulk semantics as submission: one failing amendment throws while the
 * others took effect, so the outcome is read through the same interpreter
 * rather than assumed to be all-or-nothing.
 */
export async function batchModifyOrders(
  params: VaultRouted & {
    client: ExchangeClient;
    modifies: ModifyTarget[];
    onSpend?: (actionCount: number) => void;
    now?: () => number;
  }
): Promise<SubmitOutcome> {
  const now = params.now ?? Date.now;
  if (params.modifies.length === 0) {
    throw new HlError("Cannot submit an empty modify batch", { code: "invalid_config" });
  }
  // Counted per amendment against the address limit, like any batch.
  params.onSpend?.(params.modifies.length);
  // Server clock on the wire, device clock in the outcome — see `submitOrders`.
  const issuedAt = now();
  const expiresAt = issuedAt + ORDER_EXPIRY_WINDOW_MS;
  try {
    const response = await params.client.batchModify(
      { modifies: params.modifies },
      { expiresAfter: serverNow(issuedAt) + ORDER_EXPIRY_WINDOW_MS, ...routeTo(params) }
    );
    return {
      kind: "settled",
      result: interpretOrderResult({ ok: true, response }, params.modifies.length) ?? emptyResult(),
    };
  } catch (error) {
    const recovered = interpretOrderResult({ ok: false, error }, params.modifies.length);
    if (recovered) return { kind: "settled", result: recovered };
    logger.error("batch_modify.unknown", { error });
    return {
      kind: "unknown",
      error: new HlError("Modify outcome unknown", { code: classifySdkError(error), cause: error }),
      // The two fields that MAKE an `unknown` resolvable, and both were blank.
      //
      // `cloids: []` handed the reconciler nothing to probe by, on the one
      // outcome whose entire purpose is "watch, do not retry — here is how to
      // find out". Each amendment carries the replacement leg's cloid, which is
      // what the order will rest under if it lands.
      //
      // `expiresAt: 0` was worse than empty: it is a timestamp in 1970, so a
      // consumer testing `now > expiresAt` concludes the action can no longer
      // land the instant it is handed one — while the request it just signed
      // stays executable for the full window stamped above. Reporting the real
      // expiry is what makes the eventual retry safe rather than a guess.
      cloids: params.modifies.flatMap((modify) => (modify.order.c ? [modify.order.c] : [])),
      expiresAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Dead-man switch
// ---------------------------------------------------------------------------

/** Hyperliquid rejects a scheduled cancel less than this far ahead. */
export const SCHEDULE_CANCEL_MIN_LEAD_MS = 5_000;

/**
 * Arm the dead-man switch: cancel every open order at `time` unless re-armed.
 *
 * Protects a user whose client dies while holding resting orders. Two hard
 * edges: the deadline must be **at least 5 seconds out** (a tighter heartbeat is
 * rejected every tick, leaving the account unprotected), and the exchange caps
 * how many times it may actually fire per day — so a heartbeat should re-arm
 * well before expiry rather than letting it trigger.
 */
export async function scheduleCancel(
  params: VaultRouted & {
    client: ExchangeClient;
    /** Absolute ms since epoch. Omit to **clear** any scheduled cancel. */
    time?: number;
    now?: () => number;
    onSpend?: (actionCount: number) => void;
  }
): Promise<{ ok: boolean; error?: unknown }> {
  const now = params.now ?? Date.now;
  if (params.time !== undefined && params.time - now() < SCHEDULE_CANCEL_MIN_LEAD_MS) {
    throw new HlError(
      `Scheduled cancel must be at least ${SCHEDULE_CANCEL_MIN_LEAD_MS}ms in the future`,
      { code: "invalid_config", context: { time: params.time, now: now() } }
    );
  }
  params.onSpend?.(1);
  try {
    // `{ time: params.time }` ALWAYS — including when clearing, where `time` is
    // `undefined`. The key's PRESENCE is what disambiguates, and it has to
    // survive two hops: `ExchangeClient.scheduleCancel` normalises
    // `(paramsOrOpts, maybeOpts)` with `"time" in paramsOrOpts`, then calls the
    // method-level `scheduleCancel`, which runs the SAME check again. Passing
    // `{}` for a clear therefore loses the options TWICE — the wrapper moves
    // them into the third position, and the method then reads the empty second
    // argument as the options and discards them.
    //
    // Measured against a recording transport: arming carried `vaultAddress`,
    // clearing did not. The symptom is the Phase 8 failure mode again — a user
    // who arms the dead-man switch on a sub-account can never disarm it, because
    // the clear lands on the master and silently disarms the master's own
    // protection instead.
    await params.client.scheduleCancel({ time: params.time }, routeTo(params));
    logger.info(params.time === undefined ? "schedule_cancel.cleared" : "schedule_cancel.armed", {
      context: { time: params.time ?? null },
    });
    return { ok: true };
  } catch (error) {
    logger.warn("schedule_cancel.failed", { error });
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// TWAP
// ---------------------------------------------------------------------------

/** TWAP duration bounds, in minutes, from the action schema. */
export const TWAP_MIN_MINUTES = 5;
export const TWAP_MAX_MINUTES = 1440;

/**
 * A TWAP's minimum notional: **$100, ten times the ordinary order floor.**
 *
 * Measured, because nothing documents it: a reduce-only 5-minute TWAP of ~$11
 * notional — comfortably clear of `MIN_ORDER_NOTIONAL_USDC` — was refused with
 * `"TWAP order value too small. Min is $100."` And the refusal arrives as **HTTP
 * 200** with the message two levels deep at `response.data.status.error`, so it
 * is easy to swallow into a generic failure.
 *
 * Checked locally rather than left to the exchange, because the action is spent
 * from a budget earned only by traded volume: an order form validating against
 * the $10 constant tells the user their TWAP is fine and then burns an action on
 * a refusal, every single time.
 */
export const TWAP_MIN_NOTIONAL_USDC = 100;

/**
 * Traded volume required before `scheduleCancel` is permitted: **$1,000,000.**
 *
 * Measured. Hyperliquid's exchange-endpoint docs mention only the 5-second lead
 * and the ten-triggers-per-day cap; the volume gate is not in them. Live, both
 * arming and clearing are refused with `"Cannot set scheduled cancel time until
 * enough volume traded. Required: $1000000. Traded: $0."`
 *
 * Not enforced client-side — this client cannot read lifetime volume (`userFees`
 * returns 15 days, not a cumulative figure), so a local gate would be a guess. It
 * is here so a caller can explain the refusal instead of showing a generic error,
 * and so nobody re-derives the number from a support thread.
 *
 * The consequence matters more than the number: `scheduleCancel` returns
 * `{ok:false}` rather than throwing, so a client that fires it on connect and
 * ignores the boolean shows a "protected" badge over an account with **no
 * dead-man switch at all** — and the user finds out during the outage it was
 * meant to cover.
 */
export const SCHEDULE_CANCEL_REQUIRED_VOLUME_USDC = 1_000_000;

export interface TwapOrderInput {
  assetId: number;
  isBuy: boolean;
  /** Total size to work, already formatted. */
  size: string;
  /**
   * A price to size the notional against, for the $100 minimum check.
   *
   * A TWAP carries no price of its own, so this is the caller's mark or mid —
   * used ONLY to refuse an order the exchange would refuse anyway, never sent.
   * Omit and the check cannot run.
   */
  referencePrice?: string;
  /** Duration in **minutes** — not milliseconds. */
  durationMinutes: number;
  /** Randomise slice timing to reduce predictability. */
  randomize?: boolean;
  reduceOnly?: boolean;
}

/**
 * What happened to a TWAP submit.
 *
 * Deliberately the same three-way shape as {@link SubmitOutcome}, minus the
 * reconciliation handles — and the missing handles are the whole reason the
 * distinction matters more here, not less. An ordinary batch that times out
 * leaves cloids in the journal for the startup reconciler to resolve. A TWAP
 * carries no cloid, so an `unknown` one can be resolved by exactly one thing:
 * the next `twapStates` frame. Until it arrives, a resubmit does not replace
 * the first TWAP, it ADDS a second — and the account then works the size twice
 * over, for as long as 24 hours.
 */
export type TwapOutcome =
  | { kind: "placed"; twapId: number }
  /** Definitely refused — nothing is running. Safe to fix the ticket and submit again. */
  | { kind: "rejected"; error: HlError }
  /** Sent; a TWAP MAY be running. Never retry — watch the TWAP tab. */
  | { kind: "unknown"; error: HlError };

/**
 * Place a native TWAP order.
 *
 * A TWAP is **not** a limit order: it carries no price and no time-in-force,
 * and it is not an ordinary open order — it cannot be cancelled by oid, only by
 * the `twapId` this returns. It can also underfill, so its slice fills must be
 * presented distinctly from a single manual order.
 *
 * Never throws for an exchange-side outcome — like {@link submitOrders} the
 * result is a {@link TwapOutcome} the caller must branch on. It throws only
 * for a ticket that cannot be sent at all (duration out of range, notional
 * under the floor), before any budget is spent.
 */
export async function placeTwapOrder(
  params: VaultRouted & {
    client: ExchangeClient;
    input: TwapOrderInput;
    onSpend?: (actionCount: number) => void;
    /** Overridable for tests, like every other action here. */
    now?: () => number;
  }
): Promise<TwapOutcome> {
  const { input } = params;
  const now = params.now ?? Date.now;
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < TWAP_MIN_MINUTES ||
    input.durationMinutes > TWAP_MAX_MINUTES
  ) {
    throw new HlError(
      `TWAP duration must be a whole number of minutes between ${TWAP_MIN_MINUTES} and ${TWAP_MAX_MINUTES}`,
      { code: "invalid_config", context: { durationMinutes: input.durationMinutes } }
    );
  }

  // The $100 floor, checked before the action is spent. A TWAP carries no price,
  // so the notional needs one from the caller; without it the check cannot run
  // and the exchange's own refusal is the only guard left.
  if (input.referencePrice !== undefined) {
    const notional = notionalOf(input.referencePrice, input.size);
    if (notional.lt(TWAP_MIN_NOTIONAL_USDC)) {
      throw new HlError(
        `TWAP notional ${notional.toFixed()} is below the ${TWAP_MIN_NOTIONAL_USDC} USDC minimum — ` +
          `ten times the ${MIN_ORDER_NOTIONAL_USDC} USDC floor an ordinary order has`,
        {
          code: "invalid_config",
          context: { notional: notional.toFixed(), minimum: TWAP_MIN_NOTIONAL_USDC },
        }
      );
    }
  }

  params.onSpend?.(1);
  try {
    const response = await params.client.twapOrder(
      {
        twap: {
          a: input.assetId,
          b: input.isBuy,
          s: input.size,
          r: input.reduceOnly ?? false,
          m: input.durationMinutes,
          t: input.randomize ?? false,
        },
      },
      {
        // The same expiry every other order action carries, and the one this
        // action needed most. A TWAP has NO cloid, so an `unknown` outcome
        // cannot be reconciled by key — the next `twapStates` frame is the only
        // truth. Unbounded, a request that stalled and landed late started a
        // 24-hour algo the user had already given up on and could not have
        // matched to their attempt; bounded, a frame that arrives after the
        // window is refused by the exchange rather than executed.
        expiresAfter: serverNow(now()) + ORDER_EXPIRY_WINDOW_MS,
        ...routeTo(params),
      }
    );
    const status = (response as { response?: { data?: { status?: unknown } } })?.response?.data
      ?.status;
    const twapId = (status as { running?: { twapId?: unknown } })?.running?.twapId;
    if (typeof twapId === "number") {
      logger.info("twap.placed", { context: { twapId } });
      return { kind: "placed", twapId };
    }

    // Answered, in a shape with no id in it. The refusal arm of this same
    // field never lands here — the SDK's `assertSuccessResponse` throws on it
    // (see the catch) — so what remains is a response we cannot read, and a
    // TWAP may be running under an id we failed to find. Unknown, not
    // rejected: the safe direction is the one that does not invite a resubmit.
    logger.warn("twap.unreadable_response", { context: { status } });
    return {
      kind: "unknown",
      error: new HlError("TWAP submitted — the exchange's reply could not be read", {
        code: "api_error",
      }),
    };
  } catch (error) {
    const code = classifySdkError(error);

    // Nothing left the device: a schema rejection never went out. That is the
    // ONLY definite, retry-safe failure here.
    //
    // `offline` used to share this branch on the reasoning that it never
    // opened a connection. It cannot prove that — see the long note in
    // `submitOrders` — and the consequence is worse for a TWAP than for an
    // order: a TWAP carries no cloid, so there is no handle to reconcile by,
    // and a resubmit runs a SECOND schedule that only `twapStates` will ever
    // reveal. It falls through to `unknown` with the rest.
    if (code === "validation_error") {
      logger.warn("twap.rejected_locally", { context: { code }, error });
      return {
        kind: "rejected",
        error: new HlError("TWAP rejected before sending", { code, cause: error }),
      };
    }

    // The exchange refused the whole action and said why. Two shapes carry
    // that: the top-level `{status:"err"}`, and — the one a TWAP actually
    // returns — a single status error buried inside a `{status:"ok"}`
    // envelope. MEASURED on mainnet: "TWAP order value too small. Min is
    // $100." arrives as the latter. Both are definite, and the server's own
    // words are better copy than anything written here.
    const refusal = readTopLevelError(error) ?? readSingleStatusError(error);
    if (refusal) {
      logger.warn("twap.rejected_by_server", { context: { reason: refusal }, error });
      return { kind: "rejected", error: new HlError(refusal, { code: "api_error", cause: error }) };
    }

    // Sent, outcome unknown — a timeout is exactly this case. The shared
    // transport aborts at 15 s (`api/clients.ts`), and an aborted request may
    // already have reached the exchange and had its reply lost. Reporting it
    // as a rejection re-arms the button, and the resubmit runs a SECOND TWAP.
    logger.warn("twap.unknown", { context: { code }, error });
    return {
      kind: "unknown",
      error: new HlError("TWAP outcome unknown", { code, cause: error }),
    };
  }
}

/**
 * Cancel a running TWAP.
 *
 * By `twapId` and asset — an ordinary oid cancel does not apply.
 */
export async function cancelTwapOrder(
  params: VaultRouted & {
    client: ExchangeClient;
    assetId: number;
    twapId: number;
    onSpend?: (actionCount: number) => void;
  }
): Promise<{ ok: boolean; error?: unknown }> {
  params.onSpend?.(1);
  try {
    await params.client.twapCancel({ a: params.assetId, t: params.twapId }, routeTo(params));
    return { ok: true };
  } catch (error) {
    logger.warn("twap.cancel_failed", { context: { twapId: params.twapId }, error });
    return { ok: false, error };
  }
}

/**
 * The server's own sentence from a top-level `{status:"err", response:"..."}`.
 *
 * The message lives in `response`; `status` is the bare literal `"err"`.
 * Reading `status` puts the word "err" in front of a user where the exchange
 * had written "Cannot switch leverage type with open position." — which is
 * exactly the sentence that tells them what to do next.
 *
 * Returns null when the action succeeded, so a caller can branch on it.
 */
function topLevelRefusal(response: unknown): string | null {
  const body = response as { status?: unknown; response?: unknown } | null | undefined;
  const status = body?.status;
  if (status === undefined || status === "ok") return null;
  return typeof body?.response === "string" && body.response.trim() !== ""
    ? body.response
    : `The exchange refused the action (${String(status)})`;
}

// ---------------------------------------------------------------------------
// Leverage and margin mode
// ---------------------------------------------------------------------------

/**
 * Set an asset's leverage — and its margin MODE, which is the same action.
 *
 * `isCross` is not a separate switch: the exchange stores one
 * `{ isCross, leverage }` pair per asset per account, and this single action
 * writes both. A "margin mode" sheet therefore submits the CURRENT leverage
 * with the flipped flag, and a leverage sheet submits the current flag with
 * the new number.
 *
 * Two server-side refusals worth relaying verbatim rather than retrying:
 * lowering leverage below what the open position's margin allows, and
 * switching mode while a position or open orders exist. Both come back as a
 * top-level `{status:"err"}` string.
 *
 * The result must never be applied optimistically — the caller re-reads
 * `activeAssetData` and shows what the server confirms, because a refused
 * change that the UI already displayed would mis-state the margin regime every
 * later order is sized against.
 */
export async function updateLeverage(
  params: VaultRouted & {
    client: ExchangeClient;
    assetId: number;
    /** Whole number, 1..the asset's cap. The exchange validates the cap. */
    leverage: number;
    /** `true` for cross, `false` for isolated. */
    isCross: boolean;
    onSpend?: (actionCount: number) => void;
    now?: () => number;
  }
): Promise<{ ok: boolean; error?: unknown }> {
  if (!Number.isInteger(params.leverage) || params.leverage < 1) {
    throw new HlError("Leverage must be a whole number of at least 1", {
      code: "invalid_config",
      context: { leverage: params.leverage },
    });
  }
  const now = params.now ?? Date.now;
  params.onSpend?.(1);
  try {
    const response = await params.client.updateLeverage(
      { asset: params.assetId, isCross: params.isCross, leverage: params.leverage },
      { expiresAfter: serverNow(now()) + ORDER_EXPIRY_WINDOW_MS, ...routeTo(params) }
    );
    const refusal = topLevelRefusal(response);
    if (refusal !== null) {
      return { ok: false, error: new HlError(refusal, { code: "api_error" }) };
    }
    logger.info("leverage.updated", {
      context: { assetId: params.assetId, leverage: params.leverage, isCross: params.isCross },
    });
    return { ok: true };
  } catch (error) {
    logger.warn("leverage.update_failed", {
      context: { assetId: params.assetId, leverage: params.leverage, isCross: params.isCross },
      error,
    });
    return { ok: false, error };
  }
}

/**
 * Add or remove margin on an ISOLATED position.
 *
 * Three things the wire gets wrong if copied loosely:
 *
 * - **`isBuy` is the POSITION's side, not a trade direction.** `true` means
 *   "the long position on this asset". Passing the direction of the margin
 *   movement instead addresses a position that may not exist.
 * - **`ntli` is micro-USDC** — USD x 1e6, and a *signed safe integer*. A
 *   fractional value fails schema validation before it leaves the device.
 * - **The sign is the verb.** Positive adds margin, negative removes it;
 *   there is no separate direction field.
 *
 * Cross positions have no isolated margin to move — the exchange refuses, and
 * the refusal is relayed rather than pre-empted here, since only the server
 * knows the position's current mode at the moment the action lands.
 *
 * Never optimistic: the caller re-reads and shows what the server confirms.
 */
export async function updateIsolatedMargin(
  params: VaultRouted & {
    client: ExchangeClient;
    assetId: number;
    /** The POSITION's side — `true` for a long. Not the margin's direction. */
    isLong: boolean;
    /** USDC to add (positive) or remove (negative). Never zero. */
    amountUsd: BigNumber.Value;
    onSpend?: (actionCount: number) => void;
    now?: () => number;
  }
): Promise<{ ok: boolean; error?: unknown }> {
  const amount = toBigNumber(params.amountUsd);
  if (!amount.isFinite() || amount.isZero()) {
    throw new HlError("Isolated margin adjustment must be a non-zero amount", {
      code: "invalid_config",
      context: { amountUsd: String(params.amountUsd) },
    });
  }
  // Truncate toward zero: the conservative direction for BOTH signs — an add
  // moves a hair less in, a removal a hair less out. USDC carries 6 decimals,
  // so a well-formed amount loses nothing here.
  const ntli = amount.times(1e6).integerValue(BigNumber.ROUND_DOWN).toNumber();
  if (!Number.isSafeInteger(ntli) || ntli === 0) {
    throw new HlError("Isolated margin adjustment is out of range", {
      code: "invalid_config",
      context: { amountUsd: amount.toFixed(), ntli },
    });
  }

  const now = params.now ?? Date.now;
  params.onSpend?.(1);
  try {
    const response = await params.client.updateIsolatedMargin(
      { asset: params.assetId, isBuy: params.isLong, ntli },
      { expiresAfter: serverNow(now()) + ORDER_EXPIRY_WINDOW_MS, ...routeTo(params) }
    );
    const refusal = topLevelRefusal(response);
    if (refusal !== null) {
      return { ok: false, error: new HlError(refusal, { code: "api_error" }) };
    }
    logger.info("isolated_margin.updated", {
      context: { assetId: params.assetId, isLong: params.isLong, ntli },
    });
    return { ok: true };
  } catch (error) {
    logger.warn("isolated_margin.update_failed", {
      context: { assetId: params.assetId, isLong: params.isLong, ntli },
      error,
    });
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Spot <-> perp transfer
