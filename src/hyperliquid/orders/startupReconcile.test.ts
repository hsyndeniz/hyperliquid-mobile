import { createIdentity, identityKey } from "@/hyperliquid/core/identity";
import type { Cloid } from "@/hyperliquid/orders/cloid";
import { clearPending, listPending, recordPending } from "@/hyperliquid/orders/pending";
import { reconcilePendingSubmits } from "@/hyperliquid/orders/startupReconcile";

const A = "0xaaaaaaaa0000000000000000000000a1" as Cloid;
const B = "0xbbbbbbbb0000000000000000000000b2" as Cloid;
const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const NOW = 1_800_000_000_000;
const identity = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });

function journal(cloids: Cloid[], expiresAt: number) {
  recordPending({
    cloids,
    identityKey: identityKey(identity),
    address: ADDRESS,
    expiresAt,
    submittedAt: NOW - 60_000,
  });
}

const found = {
  orderStatus: async () => ({ status: "order", order: { status: "open", order: { oid: 7 } } }),
};
const absent = { orderStatus: async () => ({ status: "unknownOid" }) };
const garbled = { orderStatus: async () => ({ nonsense: true }) };
/** The exchange saw it and refused it — a conclusive answer it keeps repeating. */
const refused = {
  orderStatus: async () => ({
    status: "order",
    order: { status: "insufficientMarginRejected", order: { oid: 9 } },
  }),
};

describe("reconcilePendingSubmits", () => {
  beforeEach(() => {
    clearPending();
  });

  it("does nothing with an empty journal", async () => {
    const result = await reconcilePendingSubmits({ probe: absent, now: () => NOW });
    expect(result).toMatchObject({ landed: [], notLanded: [], unresolved: [] });
  });

  it("adopts an order that landed and clears it from the journal", async () => {
    journal([A], NOW - 1);
    const result = await reconcilePendingSubmits({ probe: found, now: () => NOW });

    expect(result.landed).toHaveLength(1);
    expect(result.landed[0]).toMatchObject({ kind: "landed", oid: 7 });
    expect(listPending()).toHaveLength(0);
  });

  it("clears an order confirmed never to have been placed", async () => {
    journal([A], NOW - 1);
    const result = await reconcilePendingSubmits({ probe: absent, now: () => NOW });

    expect(result.notLanded).toEqual([A]);
    expect(listPending()).toHaveLength(0);
  });

  it("defers an entry whose window has not elapsed — the order may still land", async () => {
    journal([A], NOW + 30_000);
    const result = await reconcilePendingSubmits({ probe: absent, now: () => NOW });

    expect(result.notLanded).toEqual([]);
    expect(result.deferred).toBe(1);
    // Must stay journalled: probing now would prove nothing.
    expect(listPending()).toHaveLength(1);
  });

  it("keeps an entry journalled when the probe cannot be read", async () => {
    // Treating a garbled response as absence would green-light a duplicate.
    journal([A], NOW - 1);
    const result = await reconcilePendingSubmits({ probe: garbled, now: () => NOW });

    expect(result.unresolved).toEqual([A]);
    expect(listPending()).toHaveLength(1);
  });

  it("keeps an entry journalled when the probe throws", async () => {
    journal([A], NOW - 1);
    const result = await reconcilePendingSubmits({
      probe: {
        orderStatus: async () => {
          throw new Error("offline");
        },
      },
      now: () => NOW,
    });
    expect(result.unresolved).toEqual([A]);
    expect(listPending()).toHaveLength(1);
  });

  it("resolves a multi-leg entry leg by leg", async () => {
    journal([A, B], NOW - 1);
    let call = 0;
    const mixed = {
      orderStatus: async () => {
        call += 1;
        return call === 1 ? { status: "unknownOid" } : { nonsense: true };
      },
    };

    const result = await reconcilePendingSubmits({ probe: mixed, now: () => NOW });

    expect(result.notLanded).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
    // The unresolved leg must survive; the resolved one must not be re-probed.
    expect(listPending()[0].cloids).toHaveLength(1);
  });

  it("is idempotent across repeated launches", async () => {
    journal([A], NOW - 1);
    await reconcilePendingSubmits({ probe: absent, now: () => NOW });
    const second = await reconcilePendingSubmits({ probe: absent, now: () => NOW });
    expect(second.notLanded).toEqual([]);
  });

  it("only touches the requested identity's entries", async () => {
    const otherIdentity = createIdentity({
      env: "testnet",
      accountId: "other",
      address: "0x2222222222222222222222222222222222222222",
    });
    recordPending({
      cloids: [B],
      identityKey: identityKey(otherIdentity),
      address: otherIdentity.address,
      expiresAt: NOW - 1,
      submittedAt: NOW,
    });
    journal([A], NOW - 1);

    await reconcilePendingSubmits({ probe: absent, identity, now: () => NOW });

    // The other account's entry is untouched.
    expect(listPending().map((e) => e.cloids[0])).toEqual([B]);
  });
});

describe("a rejected order leaves the journal", () => {
  beforeEach(() => clearPending());

  it("is reported separately from never-placed, and cleared", async () => {
    // The trap: `orderStatus` keeps answering for a rejected cloid forever, so
    // leaving it journalled re-probes a settled question on every single launch,
    // burning weight budget for an answer that will never change.
    journal([A], NOW - 1);
    const result = await reconcilePendingSubmits({ probe: refused, now: () => NOW });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ kind: "rejected", cloid: A });
    // Not conflated with `notLanded` — one never reached the exchange, the
    // other carries a reason worth surfacing.
    expect(result.notLanded).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(listPending()).toHaveLength(0);
  });

  it("is not re-probed on a later launch", async () => {
    journal([A], NOW - 1);
    const probe = jest.fn(refused.orderStatus);

    await reconcilePendingSubmits({ probe: { orderStatus: probe }, now: () => NOW });
    const callsAfterFirst = probe.mock.calls.length;
    await reconcilePendingSubmits({ probe: { orderStatus: probe }, now: () => NOW + 86_400_000 });

    expect(probe.mock.calls.length).toBe(callsAfterFirst);
  });
});
