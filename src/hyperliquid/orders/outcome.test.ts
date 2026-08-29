import {
  acceptedLegs,
  extractStatusesFromError,
  interpretOrderResponse,
  interpretOrderResult,
  readTopLevelError,
  restingOids,
} from "@/hyperliquid/orders/outcome";

const CLOID = "0xabcdef01234567890abcdef012345678";

function response(statuses: unknown[]) {
  return { status: "ok", response: { type: "order", data: { statuses } } };
}

/** Shape of a thrown ApiRequestError: body on `.response`, typed `unknown`. */
function apiError(statuses: unknown[]) {
  return Object.assign(new Error("Order failed"), {
    name: "ApiRequestError",
    response: response(statuses),
  });
}

describe("interpretOrderResponse", () => {
  it("reads a resting leg with its oid and cloid", () => {
    const result = interpretOrderResponse(response([{ resting: { oid: 123, cloid: CLOID } }]), 1);
    expect(result.legs[0]).toEqual({ kind: "resting", index: 0, oid: 123, cloid: CLOID });
    expect(result.anyAccepted).toBe(true);
  });

  it("reads a filled leg with size and average price", () => {
    const result = interpretOrderResponse(
      response([{ filled: { oid: 9, totalSz: "0.5", avgPx: "97000", cloid: CLOID } }]),
      1
    );
    expect(result.legs[0]).toMatchObject({
      kind: "filled",
      oid: 9,
      totalSz: "0.5",
      avgPx: "97000",
    });
  });

  it("normalises an echoed uppercase cloid so map lookups match", () => {
    const result = interpretOrderResponse(
      response([{ resting: { oid: 1, cloid: CLOID.toUpperCase().replace("0X", "0x") } }]),
      1
    );
    expect(result.legs[0]).toMatchObject({ cloid: CLOID });
  });

  it("treats an absent cloid as null rather than undefined", () => {
    const result = interpretOrderResponse(response([{ resting: { oid: 1 } }]), 1);
    expect(result.legs[0]).toMatchObject({ cloid: null });
  });

  it("reads the pending states used by trigger orders", () => {
    const result = interpretOrderResponse(response(["waitingForTrigger", "waitingForFill"]), 2);
    expect(result.legs.map((l) => l.kind)).toEqual(["pending", "pending"]);
    // A pending leg is LIVE on the exchange — counting it as unaccepted would
    // make a TP/SL-only batch read as "nothing happened" and invite a resubmit.
    expect(result.anyAccepted).toBe(true);
    expect(result.anyRejected).toBe(false);
  });

  it("preserves leg order, since correlation is by index alone", () => {
    const result = interpretOrderResponse(
      response([{ error: "bad" }, { resting: { oid: 2 } }, { error: "worse" }]),
      3
    );
    expect(result.legs.map((l) => l.index)).toEqual([0, 1, 2]);
    expect(result.legs[1]).toMatchObject({ kind: "resting", oid: 2 });
  });

  it("flags a truncated statuses array instead of assuming the tail succeeded", () => {
    // A pre-validation failure returns ONE error for the whole batch. Blindly
    // zipping would report the other legs as placed — the worst failure mode.
    const result = interpretOrderResponse(response([{ error: "Insufficient margin" }]), 5);
    expect(result.batchRejected).toBe(true);
    expect(result.anyAccepted).toBe(false);
    expect(result.legs).toHaveLength(1);
  });

  it("does not flag batchRejected when every leg is accounted for", () => {
    const result = interpretOrderResponse(
      response([{ resting: { oid: 1 } }, { resting: { oid: 2 } }]),
      2
    );
    expect(result.batchRejected).toBe(false);
  });

  it("degrades to an unknown outcome on an unrecognised body", () => {
    const result = interpretOrderResponse({ nonsense: true }, 2);
    expect(result.batchRejected).toBe(true);
    expect(result.anyAccepted).toBe(false);
  });

  it("reports an unknown status object as UNRECOGNISED, not as a rejection", () => {
    // It asserted "rejected" until 2026-08-29, and that was the wrong half of
    // the honesty rule. Every consumer reads a rejected leg as a DEFINITE,
    // retry-safe refusal — `usePlaceTicket` renders "rejected",
    // `settledCloseNote` throws — so the day Hyperliquid adds a status string
    // (it has: the `waitingFor*` family arrived this way) a live order would be
    // announced as refused and the user invited to place it again.
    const result = interpretOrderResponse(response([{ somethingNew: {} }]), 1);
    expect(result.legs[0].kind).toBe("unrecognised");
    // And it must NOT read as a clean refusal: `anyAccepted === false` is
    // exactly the signal callers treat as "nothing was placed".
    expect(result.anyAccepted).toBe(true);
    expect(result.anyRejected).toBe(false);
  });

  it("still reports an explicit error status as a rejection", () => {
    // The definite case keeps its definite answer — the change above must not
    // soften a refusal the exchange actually stated.
    const result = interpretOrderResponse(response([{ error: "Insufficient margin" }]), 1);
    expect(result.legs[0].kind).toBe("rejected");
    expect(result.anyAccepted).toBe(false);
    expect(result.anyRejected).toBe(true);
  });
});

describe("pending legs count as placed", () => {
  it("flags a genuinely partial batch when the placed leg is pending", () => {
    // TP accepted, SL rejected by the open-order cap: reporting this as a total
    // failure would hide a live protective order.
    const result = interpretOrderResponse(
      response(["waitingForTrigger", { error: "Open orders limit exceeded" }]),
      2
    );
    expect(result.anyAccepted).toBe(true);
    expect(result.anyRejected).toBe(true);
    expect(result.isPartial).toBe(true);
  });

  it("still excludes pending legs from oid-bearing helpers, since they carry none", () => {
    const result = interpretOrderResponse(response(["waitingForTrigger"]), 1);
    expect(restingOids(result)).toEqual([]);
  });
});

describe("readTopLevelError", () => {
  it("reads a whole-action rejection", () => {
    const error = Object.assign(new Error("x"), {
      response: { status: "err", response: "Insufficient margin" },
    });
    expect(readTopLevelError(error)).toBe("Insufficient margin");
  });

  it("finds it through a cause chain", () => {
    const inner = Object.assign(new Error("x"), {
      response: { status: "err", response: "nope" },
    });
    expect(readTopLevelError(new Error("wrapper", { cause: inner }))).toBe("nope");
  });

  it("returns null for a per-leg failure, which is not a whole-action rejection", () => {
    const error = Object.assign(new Error("x"), { response: response([{ error: "leg" }]) });
    expect(readTopLevelError(error)).toBeNull();
  });
});

describe("interpretOrderResult — partial batch failure", () => {
  it("recovers accepted legs from a THROWN error", () => {
    // The crux: the SDK rejects the promise while real orders are on the book.
    const result = interpretOrderResult(
      {
        ok: false,
        error: apiError([
          { resting: { oid: 111, cloid: CLOID } },
          { error: "Post only order would have immediately matched" },
        ]),
      },
      2
    );
    expect(result).not.toBeNull();
    expect(result!.isPartial).toBe(true);
    expect(result!.anyAccepted).toBe(true);
    expect(result!.anyRejected).toBe(true);
    expect(restingOids(result!)).toEqual([111]);
  });

  it("marks a wholly rejected batch as not partial", () => {
    const result = interpretOrderResult(
      { ok: false, error: apiError([{ error: "a" }, { error: "b" }]) },
      2
    );
    expect(result!.isPartial).toBe(false);
    expect(result!.anyAccepted).toBe(false);
  });

  it("returns null when the error carries no interpretable body", () => {
    // Outcome is genuinely UNKNOWN — the caller must reconcile by cloid, not
    // assume the order failed and resubmit.
    expect(interpretOrderResult({ ok: false, error: new Error("network down") }, 1)).toBeNull();
    expect(interpretOrderResult({ ok: false, error: undefined }, 1)).toBeNull();
  });

  it("handles a body nested one level deeper", () => {
    const nested = Object.assign(new Error("x"), {
      name: "ApiRequestError",
      response: { type: "order", data: { statuses: [{ resting: { oid: 5 } }] } },
    });
    const result = interpretOrderResult({ ok: false, error: nested }, 1);
    expect(result).not.toBeNull();
    expect(restingOids(result!)).toEqual([5]);
  });

  it("handles the resolved path identically", () => {
    const result = interpretOrderResult(
      { ok: true, response: response([{ resting: { oid: 7 } }]) },
      1
    );
    expect(restingOids(result!)).toEqual([7]);
  });
});

describe("extractStatusesFromError", () => {
  it("returns null for non-objects", () => {
    expect(extractStatusesFromError(null)).toBeNull();
    expect(extractStatusesFromError("boom")).toBeNull();
  });
});

describe("acceptedLegs", () => {
  it("includes resting and filled but not rejected or pending", () => {
    const result = interpretOrderResponse(
      response([
        { resting: { oid: 1 } },
        { filled: { oid: 2, totalSz: "1", avgPx: "10" } },
        { error: "no" },
        "waitingForTrigger",
      ]),
      4
    );
    expect(acceptedLegs(result).map((l) => l.kind)).toEqual(["resting", "filled"]);
  });
});
