import {
  canSafelyRetry,
  interpretOrderStatus,
  isConclusive,
  isRejectedStatus,
  landedOids,
  matchesCloid,
  reconcileCloids,
  type CloidVerdict,
} from "@/hyperliquid/orders/reconcile";

const CLOID = "0xabcdef01234567890abcdef012345678" as const;
const OTHER = "0x11112222333344445555666677778888" as const;
const USER = "0xabcdef0123456789abcdef0123456789abcdef01";
const NOW = 1_800_000_000_000;

function probeReturning(response: unknown) {
  return { orderStatus: async () => response };
}

describe("isConclusive", () => {
  it("is false inside the expiry window — the order may still land", () => {
    expect(isConclusive(NOW + 1000, NOW)).toBe(false);
  });

  it("becomes true once the action can no longer be committed", () => {
    expect(isConclusive(NOW - 1, NOW)).toBe(true);
  });
});

describe("interpretOrderStatus", () => {
  it("reads unknownOid as not found", () => {
    expect(interpretOrderStatus({ status: "unknownOid" })).toEqual({ kind: "absent" });
  });

  it("reads a found order with its oid and status", () => {
    expect(
      interpretOrderStatus({ status: "order", order: { status: "open", order: { oid: 42 } } })
    ).toEqual({ kind: "found", oid: 42, status: "open" });
  });

  it("counts a terminal order as landed — filled still means it landed", () => {
    const parsed = interpretOrderStatus({
      status: "order",
      order: { status: "filled", order: { oid: 7 } },
    });
    expect(parsed).toMatchObject({ kind: "found", oid: 7, status: "filled" });
  });

  it("distinguishes an unreadable response from a genuine absence", () => {
    // Collapsing these would let a garbled reply read as proof the order never
    // landed, and a retry would place a duplicate.
    expect(interpretOrderStatus(null)).toEqual({ kind: "unrecognised" });
    expect(interpretOrderStatus({ unexpected: true })).toEqual({ kind: "unrecognised" });
  });
});

describe("reconcileCloids", () => {
  it("reports landed when the exchange knows the order", async () => {
    const verdicts = await reconcileCloids({
      probe: probeReturning({ status: "order", order: { status: "open", order: { oid: 99 } } }),
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(verdicts[0]).toMatchObject({ kind: "landed", oid: 99 });
  });

  it("reports not_landed only AFTER the expiry window", async () => {
    const verdicts = await reconcileCloids({
      probe: probeReturning({ status: "unknownOid" }),
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(verdicts[0].kind).toBe("not_landed");
  });

  it("reports indeterminate while the order could still land", async () => {
    // The dangerous case: absent now, but the action is still committable.
    const verdicts = await reconcileCloids({
      probe: probeReturning({ status: "unknownOid" }),
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW + 5_000,
      now: () => NOW,
    });
    expect(verdicts[0].kind).toBe("indeterminate");
  });

  it("never converts an unreadable response into a conclusive not_landed", async () => {
    const verdicts = await reconcileCloids({
      probe: probeReturning({ garbled: true }),
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(verdicts[0].kind).toBe("probe_failed");
    expect(canSafelyRetry(verdicts)).toBe(false);
  });

  it("reports probe_failed rather than assuming absence when the probe errors", async () => {
    const verdicts = await reconcileCloids({
      probe: {
        orderStatus: async () => {
          throw new Error("network");
        },
      },
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(verdicts[0].kind).toBe("probe_failed");
  });

  it("queries by cloid, passing it through untouched", async () => {
    let seen: unknown;
    await reconcileCloids({
      probe: {
        orderStatus: async (p: { user: string; oid: string | number }) => {
          seen = p;
          return { status: "unknownOid" };
        },
      },
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(seen).toEqual({ user: USER, oid: CLOID });
  });

  it("resolves every cloid in a multi-leg submit", async () => {
    const verdicts = await reconcileCloids({
      probe: probeReturning({ status: "unknownOid" }),
      user: USER,
      cloids: [CLOID, OTHER],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(verdicts).toHaveLength(2);
    expect(verdicts.map((v) => v.cloid)).toEqual([CLOID, OTHER]);
  });
});

describe("canSafelyRetry", () => {
  const notLanded: CloidVerdict = { cloid: CLOID, kind: "not_landed" };

  it("permits a retry only when every order is conclusively absent", () => {
    expect(canSafelyRetry([notLanded])).toBe(true);
  });

  it("refuses when any order landed — retrying would double the position", () => {
    expect(
      canSafelyRetry([notLanded, { cloid: OTHER, kind: "landed", oid: 1, status: "open" }])
    ).toBe(false);
  });

  it("refuses while any verdict is indeterminate", () => {
    expect(canSafelyRetry([notLanded, { cloid: OTHER, kind: "indeterminate" }])).toBe(false);
  });

  it("refuses when a probe failed", () => {
    expect(canSafelyRetry([{ cloid: CLOID, kind: "probe_failed", error: new Error("x") }])).toBe(
      false
    );
  });

  it("refuses on an empty verdict list rather than defaulting to permissive", () => {
    expect(canSafelyRetry([])).toBe(false);
  });
});

describe("landedOids", () => {
  it("returns only orders that reached the book", () => {
    expect(
      landedOids([
        { cloid: CLOID, kind: "landed", oid: 1, status: "open" },
        { cloid: OTHER, kind: "not_landed" },
      ])
    ).toEqual([1]);
  });

  it("skips a landed order with no oid", () => {
    expect(landedOids([{ cloid: CLOID, kind: "landed", oid: null, status: "open" }])).toEqual([]);
  });
});

describe("matchesCloid", () => {
  it("matches across both Hyperliquid order shapes and ignores casing", () => {
    expect(matchesCloid({ cloid: CLOID.toUpperCase().replace("0X", "0x") }, CLOID)).toBe(true);
    expect(matchesCloid({ cloid: null }, CLOID)).toBe(false);
    expect(matchesCloid({}, CLOID)).toBe(false);
  });
});

describe("rejected vs landed", () => {
  // Discovered against live testnet: a margin-rejected order IS recorded and
  // findable by cloid, with a terminal `*Rejected` status. Calling that
  // "landed" would block a legitimate retry forever.
  it("classifies a *Rejected status as rejected, not landed", async () => {
    const verdicts = await reconcileCloids({
      probe: probeReturning({
        status: "order",
        order: { status: "perpMarginRejected", order: { oid: 1 } },
      }),
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(verdicts[0].kind).toBe("rejected");
  });

  it("permits a corrected resubmit after a rejection — nothing is on the book", () => {
    expect(canSafelyRetry([{ cloid: CLOID, kind: "rejected", status: "perpMarginRejected" }])).toBe(
      true
    );
  });

  it("still refuses a retry for an order that is actually live", async () => {
    const verdicts = await reconcileCloids({
      probe: probeReturning({ status: "order", order: { status: "open", order: { oid: 1 } } }),
      user: USER,
      cloids: [CLOID],
      expiresAt: NOW - 1,
      now: () => NOW,
    });
    expect(canSafelyRetry(verdicts)).toBe(false);
  });

  it("recognises the documented rejection vocabulary", () => {
    for (const status of [
      // The bare form leads the list because it is the one that was MISSED:
      // every other member is camelCase, so a case-sensitive `/Rejected$/`
      // matched all five below and silently failed this one, classifying a
      // refused order as landed. A guard that enumerates only the composite
      // spellings guards nothing against exactly the spelling that breaks.
      "rejected",
      "perpMarginRejected",
      "minTradeNtlRejected",
      "tickRejected",
      "reduceOnlyRejected",
      "tooManyOpenOrdersRejected",
    ]) {
      expect(isRejectedStatus(status)).toBe(true);
    }
    for (const status of ["open", "filled", "canceled", "triggered", "reduceOnlyCanceled"]) {
      expect(isRejectedStatus(status)).toBe(false);
    }
  });
});
