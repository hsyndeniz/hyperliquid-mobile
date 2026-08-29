/**
 * Order-response interpretation, including partial batch failure.
 *
 * The single most dangerous behaviour in the SDK:
 *
 * > If **any** leg of a bulk order carries an `error` status, the whole promise
 * > **rejects** with `ApiRequestError` — while the legs that succeeded are
 * > **live on the book**. The success type even excludes the error variant, so
 * > TypeScript suggests a mixed outcome is impossible. It is not.
 *
 * A handler that treats the rejection as "nothing was placed" leaves orphan
 * resting orders and, on retry, doubles the position. So every submit funnels
 * through {@link interpretOrderResult}, which produces the same per-leg outcome
 * list whether the call resolved or threw.
 *
 * Two further traps this module encodes:
 * - Legs correlate to statuses **by array index**; nothing echoes back a
 *   submitted identifier that can be relied on for correlation.
 * - The statuses array is **not guaranteed to match the request length** — a
 *   pre-validation failure returns a single error for the whole batch. Blind
 *   index-zipping would then report N-1 legs as succeeded.
 */

import { readCloid, type Cloid } from "@/hyperliquid/orders/cloid";

/** What became of one submitted leg. */
export type LegOutcome =
  | { kind: "resting"; index: number; oid: number; cloid: Cloid | null }
  | {
      kind: "filled";
      index: number;
      oid: number;
      cloid: Cloid | null;
      totalSz: string;
      avgPx: string;
    }
  /** Accepted and waiting — trigger orders and some TP/SL legs report this. */
  | { kind: "pending"; index: number; state: "waitingForFill" | "waitingForTrigger" }
  | { kind: "rejected"; index: number; error: string }
  /**
   * A status shape this build does not recognise.
   *
   * NOT a rejection. Every consumer treats a rejected leg as a definite,
   * retry-safe refusal, so mapping an unfamiliar status there would announce
   * "your order was refused" about a leg that may be live on the book — the
   * mirror image of the rule the rest of this module enforces, and reachable
   * the day Hyperliquid adds a status string (it has: the `waitingFor*` family
   * appeared this way).
   */
  | { kind: "unrecognised"; index: number; raw: string };

export interface OrderResult {
  /** Per-leg outcomes, in submission order. */
  legs: LegOutcome[];
  /** True when at least one leg rested, filled, or is waiting to trigger/fill. */
  anyAccepted: boolean;
  /** True when at least one leg was rejected. */
  anyRejected: boolean;
  /**
   * True when the batch both placed and rejected legs. The case a UI must never
   * collapse into a single success or failure message.
   */
  isPartial: boolean;
  /**
   * Set when the statuses array was shorter than the batch — meaning the whole
   * batch was rejected before per-leg evaluation, and the unlisted legs did
   * **not** rest. Never assume the tail succeeded.
   */
  batchRejected: boolean;
  /** Set when the server refused the whole action with a top-level error. */
  serverError?: string;
}

type RawStatus =
  | { resting: { oid: number; cloid?: string | null } }
  | { filled: { oid: number; cloid?: string | null; totalSz: string; avgPx: string } }
  | { error: string }
  | "waitingForFill"
  | "waitingForTrigger";

function parseStatus(status: RawStatus, index: number): LegOutcome {
  if (status === "waitingForFill" || status === "waitingForTrigger") {
    return { kind: "pending", index, state: status };
  }
  if (typeof status === "object" && status !== null) {
    if ("resting" in status) {
      return {
        kind: "resting",
        index,
        oid: status.resting.oid,
        cloid: readCloid(status.resting),
      };
    }
    if ("filled" in status) {
      return {
        kind: "filled",
        index,
        oid: status.filled.oid,
        cloid: readCloid(status.filled),
        totalSz: status.filled.totalSz,
        avgPx: status.filled.avgPx,
      };
    }
    if ("error" in status) {
      return { kind: "rejected", index, error: status.error };
    }
  }
  return { kind: "unrecognised", index, raw: JSON.stringify(status) };
}

/**
 * Pull the statuses array out of a response body of either shape.
 *
 * The same structure arrives two ways: as a resolved value, and buried inside
 * `ApiRequestError.response`, which is typed `unknown`. Narrowed defensively —
 * a shape change must degrade to "unknown outcome", never to a false success.
 */
function extractStatuses(payload: unknown): RawStatus[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const response = (payload as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return null;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const statuses = (data as { statuses?: unknown }).statuses;
  return Array.isArray(statuses) ? (statuses as RawStatus[]) : null;
}

/**
 * Recover the per-leg outcome from a thrown `ApiRequestError`.
 *
 * `ApiRequestError.response` is typed `unknown`, and the error may nest the
 * body one level deeper. Returns `null` when nothing interpretable is present —
 * the caller must then treat the outcome as **unknown** and reconcile, not as
 * a failure.
 */
export function extractStatusesFromError(error: unknown): RawStatus[] | null {
  // Walk the cause chain: once an ApiRequestError has been wrapped by
  // `toHlError`, the payload sits on `.cause.response`, and a handler that only
  // checks the top level would silently lose the oids of legs that are live on
  // the book.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const response = (current as { response?: unknown }).response;
    const found = extractStatuses(response) ?? extractStatuses({ response });
    if (found) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function build(statuses: RawStatus[], submittedCount: number): OrderResult {
  const legs = statuses.map(parseStatus);
  // A pending leg is **live on the exchange** — `waitingForTrigger` is how a
  // TP/SL reports success. Excluding it would make a TP/SL-only batch read as
  // "nothing happened", and would leave `isPartial` false for a batch that
  // genuinely both placed and rejected legs.
  const anyAccepted = legs.some(
    (leg) => leg.kind === "resting" || leg.kind === "filled" || leg.kind === "pending"
  );
  const anyRejected = legs.some((leg) => leg.kind === "rejected");
  // An unreadable leg blocks the "definite refusal" conclusion. `anyAccepted`
  // false is what every caller reads as "nothing was placed, safe to retry";
  // a leg nobody could parse is not evidence for that, so it counts as
  // accepted-unknown rather than letting the batch claim a clean refusal.
  const anyUnrecognised = legs.some((leg) => leg.kind === "unrecognised");
  return {
    legs,
    anyAccepted: anyAccepted || anyUnrecognised,
    anyRejected,
    isPartial: (anyAccepted || anyUnrecognised) && anyRejected,
    // A short statuses array means the batch failed as a whole; the missing
    // legs did NOT rest and must not be reported as successes.
    batchRejected: statuses.length < submittedCount,
  };
}

/**
 * Interpret a resolved order response.
 *
 * @param submittedCount how many legs were sent, so a truncated statuses array
 *   is detected rather than silently index-zipped.
 */
export function interpretOrderResponse(response: unknown, submittedCount: number): OrderResult {
  const statuses = extractStatuses(response);
  if (!statuses) {
    return {
      legs: [],
      anyAccepted: false,
      anyRejected: false,
      isPartial: false,
      batchRejected: true,
    };
  }
  return build(statuses, submittedCount);
}

/**
 * Interpret whichever way the SDK reported the outcome.
 *
 * Returns `null` when the error carried no interpretable body — the outcome is
 * then genuinely **unknown** (transport failure, timeout) and the caller must
 * reconcile by cloid rather than assume anything.
 */
export function interpretOrderResult(
  outcome: { ok: true; response: unknown } | { ok: false; error: unknown },
  submittedCount: number
): OrderResult | null {
  if (outcome.ok) return interpretOrderResponse(outcome.response, submittedCount);
  const statuses = extractStatusesFromError(outcome.error);
  return statuses ? build(statuses, submittedCount) : null;
}

/**
 * Read a top-level `{ status: "err", response: "<message>" }` rejection.
 *
 * This shape means the **whole action** was refused and nothing was placed — a
 * definite outcome, not an unknown one. Distinguishing it saves a pointless
 * reconciliation round-trip and lets a caller retry immediately once the cause
 * is fixed.
 */
export function readTopLevelError(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const body = (current as { response?: unknown }).response;
    if (typeof body === "object" && body !== null) {
      const { status, response } = body as { status?: unknown; response?: unknown };
      if (status === "err" && typeof response === "string") return response;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Read a refusal delivered as `{ response: { data: { status: { error } } } }`.
 *
 * This is the **single-status** shape — what an action carrying one result
 * (a TWAP, not a batch) returns when the exchange refuses it. Two things make
 * it easy to miss. It arrives inside a `{status:"ok"}` envelope, so
 * {@link readTopLevelError} does not match it; and the SDK's
 * `assertSuccessResponse` treats it as an error and THROWS, so it never
 * reaches a caller's success branch either. What lands is an
 * `ApiRequestError` whose `.response` holds the raw body.
 *
 * Like a top-level `err`, it means the whole action was refused and nothing
 * is running — definite, and therefore retry-safe once the cause is fixed.
 * Reading it is what separates "the exchange said no" from "we never found
 * out", which for a TWAP is the difference between a fixable ticket and a
 * frozen one.
 */
export function readSingleStatusError(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const message = (
      current as { response?: { response?: { data?: { status?: { error?: unknown } } } } }
    ).response?.response?.data?.status?.error;
    if (typeof message === "string" && message.length > 0) return message;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Every leg that reached the book, for cancellation or tracking. */
export function acceptedLegs(result: OrderResult): LegOutcome[] {
  return result.legs.filter((leg) => leg.kind === "resting" || leg.kind === "filled");
}

/** Order ids that reached the book — what a rollback would need to cancel. */
export function restingOids(result: OrderResult): number[] {
  return result.legs.flatMap((leg) => (leg.kind === "resting" ? [leg.oid] : []));
}
