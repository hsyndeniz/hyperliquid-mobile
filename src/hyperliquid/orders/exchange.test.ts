import { observeServerTime, resetClock } from "@/hyperliquid/core/clock";
import { HlError } from "@/hyperliquid/core/errors";
import {
  ORDER_EXPIRY_WINDOW_MS,
  SCHEDULE_CANCEL_MIN_LEAD_MS,
  batchModifyOrders,
  cancelOrders,
  cancelOrdersByCloid,
  cancelTwapOrder,
  modifyOrder,
  placeTwapOrder,
  scheduleCancel,
  SCHEDULE_CANCEL_REQUIRED_VOLUME_USDC,
  submitOrders,
  updateIsolatedMargin,
  updateLeverage,
} from "@/hyperliquid/orders/exchange";
import type { OrderLeg } from "@/hyperliquid/orders/build";

const CLOID = "0xabcdef01234567890abcdef012345678" as const;
const NOW = 1_800_000_000_000;

function leg(overrides: Partial<OrderLeg> = {}): OrderLeg {
  return {
    a: 0,
    b: true,
    p: "97000",
    s: "0.001",
    r: false,
    t: { limit: { tif: "Gtc" } },
    c: CLOID,
    ...overrides,
  };
}

function okResponse(statuses: unknown[]) {
  return { status: "ok", response: { type: "order", data: { statuses } } };
}

/** Minimal ExchangeClient stand-in — only `order` and `cancelByCloid` are used. */
function client(impl: {
  order?: unknown;
  cancelByCloid?: unknown;
  cancel?: unknown;
  modify?: unknown;
  batchModify?: unknown;
  scheduleCancel?: unknown;
  twapOrder?: unknown;
  twapCancel?: unknown;
  updateLeverage?: unknown;
  updateIsolatedMargin?: unknown;
}) {
  return impl as never;
}

describe("submitOrders", () => {
  it("rejects an empty batch as programmer error", async () => {
    await expect(submitOrders({ client: client({}), orders: [], now: () => NOW })).rejects.toThrow(
      HlError
    );
  });

  it("returns settled with per-leg outcomes on success", async () => {
    const outcome = await submitOrders({
      client: client({ order: async () => okResponse([{ resting: { oid: 42, cloid: CLOID } }]) }),
      orders: [leg()],
      now: () => NOW,
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") throw new Error("unreachable");
    expect(outcome.result.legs[0]).toMatchObject({ kind: "resting", oid: 42 });
  });

  it("charges the budget by LEG COUNT, not one per request", async () => {
    // Hyperliquid counts a batch as n requests against the address limit.
    const spends: number[] = [];
    await submitOrders({
      client: client({
        order: async () => okResponse([1, 2, 3].map(() => ({ resting: { oid: 1 } }))),
      }),
      orders: [leg(), leg(), leg()],
      onSpend: (n) => spends.push(n),
      now: () => NOW,
    });
    expect(spends).toEqual([3]);
  });

  it("charges the budget even when the submit fails", async () => {
    const spends: number[] = [];
    await submitOrders({
      client: client({
        order: async () => {
          throw new Error("boom");
        },
      }),
      orders: [leg(), leg()],
      onSpend: (n) => spends.push(n),
      now: () => NOW,
    });
    expect(spends).toEqual([2]);
  });

  it("always sends expiresAfter, so a timed-out submit can be proven dead", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    await submitOrders({
      client: client({
        order: async (_p: unknown, opts: Record<string, unknown>) => {
          seenOpts = opts;
          return okResponse([{ resting: { oid: 1 } }]);
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });
    expect(seenOpts?.expiresAfter).toBe(NOW + ORDER_EXPIRY_WINDOW_MS);
  });

  it("omits builder entirely rather than sending null", async () => {
    // `builder: null` is a hard validation error; the field must be absent.
    let seenParams: Record<string, unknown> | undefined;
    await submitOrders({
      client: client({
        order: async (p: Record<string, unknown>) => {
          seenParams = p;
          return okResponse([{ resting: { oid: 1 } }]);
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });
    expect("builder" in (seenParams ?? {})).toBe(false);
    expect(seenParams?.grouping).toBe("na");
  });

  it("passes vaultAddress through for sub-account trading", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    await submitOrders({
      client: client({
        order: async (_p: unknown, opts: Record<string, unknown>) => {
          seenOpts = opts;
          return okResponse([{ resting: { oid: 1 } }]);
        },
      }),
      orders: [leg()],
      vaultAddress: "0x1111111111111111111111111111111111111111",
      now: () => NOW,
    });
    expect(seenOpts?.vaultAddress).toBe("0x1111111111111111111111111111111111111111");
  });

  it("recovers live legs from a THROWN partial failure", async () => {
    // The critical case: the promise rejects while real orders sit on the book.
    const error = Object.assign(new Error("rejected"), {
      name: "ApiRequestError",
      response: okResponse([
        { resting: { oid: 777, cloid: CLOID } },
        { error: "Insufficient margin" },
      ]),
    });
    const outcome = await submitOrders({
      client: client({
        order: async () => {
          throw error;
        },
      }),
      orders: [leg(), leg()],
      now: () => NOW,
    });

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") throw new Error("unreachable");
    expect(outcome.result.isPartial).toBe(true);
    expect(outcome.result.legs[0]).toMatchObject({ kind: "resting", oid: 777 });
  });

  it("classifies a pre-send validation failure as locally rejected", async () => {
    const outcome = await submitOrders({
      client: client({
        order: async () => {
          throw Object.assign(new Error("bad price"), { name: "ValidationError" });
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });
    expect(outcome.kind).toBe("rejected_locally");
  });

  it("classifies a transport failure as UNKNOWN and surfaces the cloids to reconcile", async () => {
    // Must not be reported as a failure: the order may still land.
    const outcome = await submitOrders({
      client: client({
        order: async () => {
          throw Object.assign(new Error("timeout"), { name: "HttpRequestError" });
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind !== "unknown") throw new Error("unreachable");
    expect(outcome.cloids).toEqual([CLOID]);
    expect(outcome.expiresAt).toBe(NOW + ORDER_EXPIRY_WINDOW_MS);
  });

  it("reports unknown for a bare network error with no body", async () => {
    const outcome = await submitOrders({
      client: client({
        order: async () => {
          throw new Error("network down");
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });
    expect(outcome.kind).toBe("unknown");
  });

  it("reports an OFFLINE-shaped failure as unknown, keeping the cloids", async () => {
    // The regression guard for the worst bug this module has had. RN's fetch
    // raises exactly this `TypeError: Network request failed` from
    // `xhr.onerror` for ANY network-layer failure — the socket never opening
    // AND a connection that transmitted the signed order in full before
    // resetting (a Wi-Fi -> cellular handover). A branch here used to read
    // that message as proof nothing was sent and return `rejected_locally`,
    // which made `placeOrders` resolve the journal entry and invited a retry
    // that placed a SECOND order, with the recovery handle already deleted.
    //
    // Both cloids and expiresAt are asserted because they are what makes an
    // `unknown` resolvable: without them the reconciler has nothing to probe.
    const outcome = await submitOrders({
      client: client({
        order: async () => {
          // The production shape: the SDK wraps RN's bare TypeError.
          throw Object.assign(new Error("Request failed"), {
            name: "HttpRequestError",
            cause: new TypeError("Network request failed"),
          });
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind !== "unknown") throw new Error("unreachable");
    expect(outcome.error.code).toBe("offline");
    expect(outcome.cloids).toEqual([CLOID]);
    expect(outcome.expiresAt).toBe(NOW + ORDER_EXPIRY_WINDOW_MS);
  });
});

describe("cancelOrdersByCloid", () => {
  it("uses the spelled-out wire field names, not the terse cancel ones", async () => {
    let seen: Record<string, unknown> | undefined;
    await cancelOrdersByCloid({
      client: client({
        cancelByCloid: async (p: Record<string, unknown>) => {
          seen = p;
          return { status: "ok" };
        },
      }),
      cancels: [{ assetId: 0, cloid: CLOID }],
    });
    expect(seen).toEqual({ cancels: [{ asset: 0, cloid: CLOID }] });
  });

  it("is a no-op for an empty list and does not spend budget", async () => {
    const spends: number[] = [];
    const result = await cancelOrdersByCloid({
      client: client({}),
      cancels: [],
      onSpend: (n) => spends.push(n),
    });
    expect(result.ok).toBe(true);
    expect(spends).toEqual([]);
  });

  it("reports failure without throwing, so callers re-read open orders", async () => {
    const result = await cancelOrdersByCloid({
      client: client({
        cancelByCloid: async () => {
          throw new Error("already filled");
        },
      }),
      cancels: [{ assetId: 0, cloid: CLOID }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("batchModifyOrders", () => {
  it("hands back the cloids and the REAL expiry on an unknown outcome", async () => {
    // The two fields that make an `unknown` resolvable, and both were blank:
    // `cloids: []` gave the reconciler nothing to probe by, and `expiresAt: 0`
    // is a timestamp in 1970 — so a consumer testing `now > expiresAt`
    // concludes the action can never land, the instant it is handed one, while
    // the request that was just signed stays executable for the full window.
    const outcome = await batchModifyOrders({
      client: client({
        batchModify: async () => {
          throw Object.assign(new Error("timeout"), { name: "HttpRequestError" });
        },
      }),
      modifies: [{ oid: 1, order: leg() }],
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind !== "unknown") throw new Error("unreachable");
    expect(outcome.cloids).toEqual([CLOID]);
    expect(outcome.expiresAt).toBe(NOW + ORDER_EXPIRY_WINDOW_MS);
  });

  const target = { oid: 1, order: leg() };

  it("rejects an empty batch", async () => {
    await expect(batchModifyOrders({ client: client({}), modifies: [] })).rejects.toThrow(HlError);
  });

  it("charges one action per amendment", async () => {
    const spends: number[] = [];
    await batchModifyOrders({
      client: client({ batchModify: async () => okResponse([{ resting: { oid: 1 } }]) }),
      modifies: [target, target],
      onSpend: (n) => spends.push(n),
    });
    expect(spends).toEqual([2]);
  });

  it("recovers live legs from a partial amendment failure", async () => {
    // One amendment failing throws while the others took effect.
    const outcome = await batchModifyOrders({
      client: client({
        batchModify: async () => {
          throw Object.assign(new Error("x"), {
            name: "ApiRequestError",
            response: okResponse([{ resting: { oid: 5 } }, { error: "Order was never placed" }]),
          });
        },
      }),
      modifies: [target, target],
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") throw new Error("unreachable");
    expect(outcome.result.isPartial).toBe(true);
  });

  it("reports unknown when the outcome cannot be read", async () => {
    const outcome = await batchModifyOrders({
      client: client({
        batchModify: async () => {
          throw new Error("timeout");
        },
      }),
      modifies: [target],
    });
    expect(outcome.kind).toBe("unknown");
  });
});

describe("modifyOrder", () => {
  it("amends by oid or by cloid — the schema accepts either", async () => {
    const seen: unknown[] = [];
    const c = client({
      modify: async (p: unknown) => {
        seen.push(p);
        return { status: "ok" };
      },
    });
    await modifyOrder({ client: c, target: { oid: 7, order: leg() } });
    await modifyOrder({ client: c, target: { oid: CLOID, order: leg() } });
    expect((seen[0] as { oid: unknown }).oid).toBe(7);
    expect((seen[1] as { oid: unknown }).oid).toBe(CLOID);
  });

  it("reports failure without throwing", async () => {
    const result = await modifyOrder({
      client: client({
        modify: async () => {
          throw new Error("already filled");
        },
      }),
      target: { oid: 1, order: leg() },
    });
    expect(result.ok).toBe(false);
  });
});

describe("scheduleCancel", () => {
  it("rejects a deadline under the 5s minimum, which the exchange refuses", async () => {
    // A tighter heartbeat is rejected every tick, leaving the account unprotected.
    await expect(
      scheduleCancel({ client: client({}), time: NOW + 3_000, now: () => NOW })
    ).rejects.toThrow(/5000ms/);
  });

  it("arms at or beyond the minimum lead", async () => {
    let seen: unknown;
    const result = await scheduleCancel({
      client: client({
        scheduleCancel: async (p: unknown) => {
          seen = p;
          return { status: "ok" };
        },
      }),
      time: NOW + SCHEDULE_CANCEL_MIN_LEAD_MS,
      now: () => NOW,
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ time: NOW + SCHEDULE_CANCEL_MIN_LEAD_MS });
  });

  it("clears a scheduled cancel when no time is given", async () => {
    let seen: unknown;
    await scheduleCancel({
      client: client({
        scheduleCancel: async (p: unknown) => {
          seen = p;
          return { status: "ok" };
        },
      }),
      now: () => NOW,
    });
    expect(seen).toEqual({});
  });
});

describe("sub-account routing", () => {
  const SUB = "0x2222222222222222222222222222222222222222";

  /** Records the `opts` argument each action passes as its second parameter. */
  function opts(): { client: never; seen: unknown[] } {
    const seen: unknown[] = [];
    const capture = async (_params: unknown, o: unknown) => {
      seen.push(o);
      return { status: "ok", response: { type: "default" } };
    };
    return {
      seen,
      client: client({
        order: async (_p: unknown, o: unknown) => {
          seen.push(o);
          return okResponse([{ resting: { oid: 1, cloid: CLOID } }]);
        },
        cancel: capture,
        cancelByCloid: capture,
        modify: capture,
        batchModify: capture,
        scheduleCancel: capture,
        twapOrder: async (_p: unknown, o: unknown) => {
          seen.push(o);
          return { status: "ok", response: { data: { status: { running: { twapId: 3 } } } } };
        },
        twapCancel: capture,
        updateLeverage: capture,
        updateIsolatedMargin: capture,
      } as Parameters<typeof client>[0]),
    };
  }

  it("routes EVERY mutating action, not just submission", async () => {
    // An order placed with `vaultAddress` is invisible to the master. A cancel
    // without it is issued against the master's account, where that oid does not
    // exist — so the order stays resting with no way to reach it. Submission was
    // the only action that carried it before Phase 8.
    const { client: c, seen } = opts();

    await submitOrders({ client: c, orders: [leg()], vaultAddress: SUB, now: () => NOW });
    await cancelOrders({ client: c, cancels: [{ assetId: 0, oid: 1 }], vaultAddress: SUB });
    await cancelOrdersByCloid({
      client: c,
      cancels: [{ assetId: 0, cloid: CLOID }],
      vaultAddress: SUB,
    });
    await modifyOrder({ client: c, target: { oid: 1, order: leg() }, vaultAddress: SUB });
    await batchModifyOrders({
      client: c,
      modifies: [{ oid: 1, order: leg() }],
      vaultAddress: SUB,
    });
    await scheduleCancel({ client: c, time: NOW + 10_000, vaultAddress: SUB, now: () => NOW });
    await placeTwapOrder({
      client: c,
      input: { assetId: 0, isBuy: true, size: "1", durationMinutes: 5 },
      vaultAddress: SUB,
    });
    await cancelTwapOrder({ client: c, assetId: 0, twapId: 3, vaultAddress: SUB });
    await updateLeverage({ client: c, assetId: 0, leverage: 5, isCross: true, vaultAddress: SUB });
    await updateIsolatedMargin({
      client: c,
      assetId: 0,
      isLong: true,
      amountUsd: "1",
      vaultAddress: SUB,
    });

    expect(seen).toHaveLength(10);
    for (const o of seen) expect(o).toMatchObject({ vaultAddress: SUB });
  });

  it("omits the key entirely on the master path", async () => {
    // `{ vaultAddress: undefined }` is a hard schema rejection, not a no-op.
    const { client: c, seen } = opts();
    await cancelOrders({ client: c, cancels: [{ assetId: 0, oid: 1 }] });
    await modifyOrder({ client: c, target: { oid: 1, order: leg() } });

    for (const o of seen) expect("vaultAddress" in (o as object)).toBe(false);
  });
});

describe("gates the exchange enforces but does not document", () => {
  it("refuses a TWAP below the $100 floor, before spending an action", async () => {
    // MEASURED: a reduce-only 5-minute TWAP of ~$11 notional — clear of the $10
    // MIN_ORDER_NOTIONAL_USDC the module encodes — was refused live with
    // "TWAP order value too small. Min is $100." The refusal arrives as HTTP 200
    // with the message at `response.data.status.error`, so it is easy to swallow
    // into a generic failure. The action is spent from a budget earned only by
    // traded volume, so an order form validating against $10 burns one every time.
    let spent = 0;
    await expect(
      placeTwapOrder({
        client: client({}),
        input: {
          assetId: 0,
          isBuy: true,
          size: "0.001",
          durationMinutes: 5,
          referencePrice: "50000", // $50 notional
        },
        onSpend: (n) => (spent += n),
      })
    ).rejects.toThrow(/below the 100 USDC minimum/);
    expect(spent).toBe(0);
  });

  it("allows one at or above the floor", async () => {
    let seen: unknown;
    const result = await placeTwapOrder({
      client: client({
        twapOrder: async (p: unknown) => {
          seen = p;
          return { status: "ok", response: { data: { status: { running: { twapId: 7 } } } } };
        },
      }),
      input: {
        assetId: 0,
        isBuy: true,
        size: "0.002",
        durationMinutes: 5,
        referencePrice: "50000", // $100 notional, exactly at the floor
      },
    });
    expect(result).toEqual({ kind: "placed", twapId: 7 });
    // `referencePrice` is a local guard only — a TWAP carries no price, so it
    // must never reach the wire.
    expect(JSON.stringify(seen)).not.toContain("referencePrice");
  });

  it("cannot check the floor without a reference price, and says so by not throwing", async () => {
    // A TWAP has no price of its own. Omitting the reference disables the guard
    // rather than guessing one — the exchange's refusal is then the only gate.
    const result = await placeTwapOrder({
      client: client({
        twapOrder: async () => ({
          status: "ok",
          response: { data: { status: { running: { twapId: 1 } } } },
        }),
      }),
      input: { assetId: 0, isBuy: true, size: "0.0001", durationMinutes: 5 },
    });
    expect(result).toMatchObject({ kind: "placed" });
  });

  describe("outcome classification", () => {
    // A TWAP is the ONE order type with no cloid, so a lost reply cannot be
    // journalled and the startup reconciler has no key for it. That makes the
    // rejected/unknown split matter more here than anywhere else: reporting an
    // unknown as rejected re-arms the button, and the resubmit does not replace
    // the first TWAP — it adds a second running alongside it.
    const twapClient = (impl: () => Promise<unknown>) => client({ twapOrder: impl });
    const input = { assetId: 0, isBuy: true, size: "1", durationMinutes: 5 } as const;

    it("stamps an expiry — the one order action that had none, and needed it most", async () => {
      // A TWAP carries NO cloid, so an `unknown` outcome cannot be reconciled
      // by key; the next `twapStates` frame is the only truth. Unbounded, a
      // request that stalled and landed late started a 24-hour algo the user
      // had already given up on, with nothing to match it to their attempt.
      let seen: unknown;
      await placeTwapOrder({
        client: client({
          twapOrder: async (_p: unknown, opts: unknown) => {
            seen = opts;
            return { status: "ok", response: { data: { status: { running: { twapId: 9 } } } } };
          },
        }),
        input: { assetId: 0, isBuy: true, size: "1", durationMinutes: 5 },
        now: () => NOW,
      });
      expect(seen).toMatchObject({ expiresAfter: NOW + ORDER_EXPIRY_WINDOW_MS });
    });

    it("reports a mid-flight timeout as UNKNOWN, not rejected", async () => {
      // The transport aborts at 15s; an aborted request may already have reached
      // the exchange. This is the case the sheet must freeze on.
      const outcome = await placeTwapOrder({
        client: twapClient(async () => {
          throw Object.assign(new Error("timeout"), { name: "HttpRequestError" });
        }),
        input,
      });
      expect(outcome.kind).toBe("unknown");
    });

    it("reads the single-status refusal the exchange actually sends, and keeps its words", async () => {
      // MEASURED on mainnet (`__e2e__/order-variants.e2e.ts`): the refusal is a
      // 200 whose body is `{status:"ok"}` with the error two levels down, which
      // the SDK converts to a throw. It matches NEITHER the top-level
      // `{status:"err"}` shape nor any per-leg status, so without a reader for
      // it this lands in `unknown` and freezes a fixable ticket.
      const outcome = await placeTwapOrder({
        client: twapClient(async () => {
          throw Object.assign(new Error("TWAP order value too small. Min is $100."), {
            name: "ApiRequestError",
            response: {
              status: "ok",
              response: { data: { status: { error: "TWAP order value too small. Min is $100." } } },
            },
          });
        }),
        input,
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("unreachable");
      // The server's own sentence, not a generic one written here.
      expect(outcome.error.message).toBe("TWAP order value too small. Min is $100.");
    });

    it("reports a top-level err status as rejected", async () => {
      const outcome = await placeTwapOrder({
        client: twapClient(async () => {
          throw Object.assign(new Error("refused"), {
            name: "ApiRequestError",
            response: { status: "err", response: "Insufficient margin" },
          });
        }),
        input,
      });
      expect(outcome).toMatchObject({ kind: "rejected" });
      if (outcome.kind !== "rejected") throw new Error("unreachable");
      expect(outcome.error.message).toBe("Insufficient margin");
    });

    it("reports a pre-send schema rejection as rejected — nothing left the device", async () => {
      const outcome = await placeTwapOrder({
        client: twapClient(async () => {
          throw Object.assign(new Error("bad size"), { name: "ValidationError" });
        }),
        input,
      });
      expect(outcome.kind).toBe("rejected");
    });

    it("reports an offline failure as UNKNOWN — the message cannot prove nothing was sent", async () => {
      // This asserted the opposite until 2026-08-29. RN raises the identical
      // `TypeError: Network request failed` whether the socket never opened OR
      // the connection dropped after the TWAP was transmitted, so "rejected"
      // was a definite, retry-safe claim the code had no basis for — and a
      // TWAP has no cloid, so a duplicate schedule has nothing to reconcile
      // against. Airplane mode now reads as unknown: less helpful, honest.
      const outcome = await placeTwapOrder({
        client: twapClient(async () => {
          throw new TypeError("Network request failed");
        }),
        input,
      });
      expect(outcome.kind).toBe("unknown");
      if (outcome.kind !== "unknown") throw new Error("unreachable");
      expect(outcome.error.code).toBe("offline");
    });

    it("reports an answer it cannot read as UNKNOWN — an id may exist that we missed", async () => {
      const outcome = await placeTwapOrder({
        client: twapClient(async () => ({
          status: "ok",
          response: { data: { status: { somethingNew: {} } } },
        })),
        input,
      });
      expect(outcome.kind).toBe("unknown");
    });
  });

  it("records the scheduleCancel volume gate without enforcing it", () => {
    // MEASURED: both arm and clear are refused with "Cannot set scheduled cancel
    // time until enough volume traded. Required: $1000000. Traded: $0." — a
    // requirement absent from the exchange-endpoint docs.
    //
    // NOT enforced locally: this client cannot read lifetime volume (`userFees`
    // returns 15 days, not a cumulative figure), so a local gate would be a guess.
    // The constant exists so a caller can explain the refusal.
    expect(SCHEDULE_CANCEL_REQUIRED_VOLUME_USDC).toBe(1_000_000);
  });
});

describe("updateLeverage", () => {
  it("sends the pair and stamps expiresAfter — a late-landing regime change is the same hazard as a late order", async () => {
    const seen: unknown[][] = [];
    const c = client({
      updateLeverage: async (params: unknown, opts: unknown) => {
        seen.push([params, opts]);
        return { status: "ok", response: { type: "default" } };
      },
    });

    const result = await updateLeverage({
      client: c,
      assetId: 3,
      leverage: 7,
      isCross: false,
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(seen[0]?.[0]).toEqual({ asset: 3, isCross: false, leverage: 7 });
    expect(seen[0]?.[1]).toMatchObject({ expiresAfter: NOW + ORDER_EXPIRY_WINDOW_MS });
  });

  it("relays a top-level err status as a failure instead of claiming success", async () => {
    const c = client({
      updateLeverage: async () => ({ status: "err", response: "Cannot switch margin mode" }),
    });
    const result = await updateLeverage({ client: c, assetId: 0, leverage: 2, isCross: true });
    expect(result.ok).toBe(false);
  });

  it("refuses a fractional or sub-1 leverage before spending the action", async () => {
    let spent = 0;
    const c = client({ updateLeverage: async () => ({ status: "ok" }) });
    await expect(
      updateLeverage({
        client: c,
        assetId: 0,
        leverage: 2.5,
        isCross: true,
        onSpend: () => spent++,
      })
    ).rejects.toThrow(HlError);
    await expect(
      updateLeverage({ client: c, assetId: 0, leverage: 0, isCross: true, onSpend: () => spent++ })
    ).rejects.toThrow(HlError);
    expect(spent).toBe(0);
  });

  it("returns ok:false on a thrown transport error — the caller re-reads, never assumes", async () => {
    const c = client({
      updateLeverage: async () => {
        throw new Error("socket hang up");
      },
    });
    const result = await updateLeverage({ client: c, assetId: 0, leverage: 2, isCross: true });
    expect(result.ok).toBe(false);
  });
});

describe("updateIsolatedMargin", () => {
  it("sends micro-USDC and the POSITION's side, stamped with an expiry", async () => {
    const seen: unknown[][] = [];
    const c = client({
      updateIsolatedMargin: async (params: unknown, opts: unknown) => {
        seen.push([params, opts]);
        return { status: "ok", response: { type: "default" } };
      },
    });

    const result = await updateIsolatedMargin({
      client: c,
      assetId: 4,
      isLong: true,
      amountUsd: "12.5",
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    // 12.5 USDC → 12_500_000 micro-USDC; isBuy is the position's side.
    expect(seen[0]?.[0]).toEqual({ asset: 4, isBuy: true, ntli: 12_500_000 });
    expect(seen[0]?.[1]).toMatchObject({ expiresAfter: NOW + ORDER_EXPIRY_WINDOW_MS });
  });

  it("carries a REMOVAL as a negative ntli — the sign is the verb", async () => {
    const seen: unknown[][] = [];
    const c = client({
      updateIsolatedMargin: async (params: unknown) => {
        seen.push([params]);
        return { status: "ok" };
      },
    });

    await updateIsolatedMargin({ client: c, assetId: 1, isLong: false, amountUsd: "-3.25" });
    expect(seen[0]?.[0]).toEqual({ asset: 1, isBuy: false, ntli: -3_250_000 });
  });

  it("truncates toward zero so neither direction overshoots", async () => {
    const seen: unknown[][] = [];
    const c = client({
      updateIsolatedMargin: async (params: unknown) => {
        seen.push([params]);
        return { status: "ok" };
      },
    });

    // Sub-micro-USDC dust cannot survive an integer field; truncating toward
    // zero moves a hair LESS in both directions, never more.
    await updateIsolatedMargin({ client: c, assetId: 0, isLong: true, amountUsd: "1.0000005" });
    expect(seen[0]?.[0]).toMatchObject({ ntli: 1_000_000 });
    await updateIsolatedMargin({ client: c, assetId: 0, isLong: true, amountUsd: "-1.0000005" });
    expect(seen[1]?.[0]).toMatchObject({ ntli: -1_000_000 });
  });

  it("refuses a zero or unparseable amount before spending the action", async () => {
    let spent = 0;
    const c = client({ updateIsolatedMargin: async () => ({ status: "ok" }) });
    for (const amountUsd of ["0", "", "abc"]) {
      await expect(
        updateIsolatedMargin({
          client: c,
          assetId: 0,
          isLong: true,
          amountUsd,
          onSpend: () => spent++,
        })
      ).rejects.toThrow(HlError);
    }
    // Dust below one micro-USDC truncates to a no-op action — also refused.
    await expect(
      updateIsolatedMargin({
        client: c,
        assetId: 0,
        isLong: true,
        amountUsd: "0.0000001",
        onSpend: () => spent++,
      })
    ).rejects.toThrow(HlError);
    expect(spent).toBe(0);
  });

  it("relays the exchange's own sentence, not the bare word 'err'", async () => {
    // `status` is the literal "err"; the message the user needs is in
    // `response`. Reading the wrong field showed them "err".
    const c = client({
      updateIsolatedMargin: async () => ({
        status: "err",
        response: "Cannot add margin to a cross position",
      }),
    });
    const result = await updateIsolatedMargin({
      client: c,
      assetId: 0,
      isLong: true,
      amountUsd: "1",
    });
    expect(result.ok).toBe(false);
    expect((result.error as Error).message).toBe("Cannot add margin to a cross position");
  });
});

describe("expiresAfter under a skewed device clock", () => {
  afterEach(resetClock);

  /** Teach the clock that this device runs a minute behind the exchange. */
  function learnSkew(): void {
    for (let i = 0; i < 5; i += 1) observeServerTime(NOW + 60_000 + i, NOW + i);
  }

  it("builds expiresAfter on the exchange's clock, not the phone's", async () => {
    // The exchange checks this against block time. Stamped from a phone running
    // a minute slow, every action it signs arrives already expired — the whole
    // app rejects every order with nothing on screen to explain why.
    learnSkew();
    let seenOpts: Record<string, unknown> | undefined;
    await submitOrders({
      client: client({
        order: async (_p: unknown, opts: Record<string, unknown>) => {
          seenOpts = opts;
          return okResponse([{ resting: { oid: 1 } }]);
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });
    expect(seenOpts?.expiresAfter).toBe(NOW + 60_000 + ORDER_EXPIRY_WINDOW_MS);
  });

  it("leaves the outcome's expiresAt on the device clock, where reconcile reads it", async () => {
    // The same window, expressed on the other clock. `reconcileCloids` compares
    // it against a local `Date.now()`, so shifting it too would move the moment
    // absence becomes conclusive — in the wrong direction, by a full minute.
    learnSkew();
    const outcome = await submitOrders({
      client: client({
        order: async () => {
          throw Object.assign(new Error("timeout"), { name: "HttpRequestError" });
        },
      }),
      orders: [leg()],
      now: () => NOW,
    });

    expect(outcome.kind).toBe("unknown");
    if (outcome.kind !== "unknown") throw new Error("unreachable");
    expect(outcome.expiresAt).toBe(NOW + ORDER_EXPIRY_WINDOW_MS);
  });
});
