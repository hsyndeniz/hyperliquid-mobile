import { createIdentity } from "@/hyperliquid/core/identity";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";
import type { Cloid } from "@/hyperliquid/orders/cloid";
import {
  clearPending,
  conclusivePending,
  listPending,
  pendingForIdentity,
  recordPending,
  resolvePending,
  type PendingSubmit,
} from "@/hyperliquid/orders/pending";

const A = "0xaaaaaaaa0000000000000000000000a1" as Cloid;
const B = "0xbbbbbbbb0000000000000000000000b2" as Cloid;
const ADDRESS = "0xabcdef0123456789abcdef0123456789abcdef01";
const NOW = 1_800_000_000_000;

const identity = createIdentity({ env: "testnet", accountId: "acc", address: ADDRESS });

function entry(overrides: Partial<PendingSubmit> = {}): PendingSubmit {
  return {
    cloids: [A],
    identityKey: "testnet|acc|" + ADDRESS + "|-|-",
    address: ADDRESS,
    schemaVersion: 2,
    expiresAt: NOW + 30_000,
    submittedAt: NOW,
    ...overrides,
  };
}

describe("pending journal", () => {
  beforeEach(() => {
    clearPending();
  });

  it("records and lists a submit", () => {
    recordPending(entry());
    expect(listPending()).toHaveLength(1);
    expect(listPending()[0].cloids).toEqual([A]);
  });

  it("persists synchronously, so a crash after the call cannot lose it", () => {
    // The whole point: the write must have landed before submit is awaited.
    recordPending(entry());
    expect(hlStringStorage.getItem("hl:orders:pending")).toContain(A);
  });

  it("keeps multiple in-flight submits", () => {
    recordPending(entry({ cloids: [A] }));
    recordPending(entry({ cloids: [B] }));
    expect(listPending()).toHaveLength(2);
  });

  it("clears an entry once its outcome is known", () => {
    recordPending(entry({ cloids: [A] }));
    recordPending(entry({ cloids: [B] }));
    resolvePending([A]);
    const remaining = listPending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].cloids).toEqual([B]);
  });

  it("does NOT drop a multi-leg submit on one cloid — see per-cloid resolution below", () => {
    recordPending(entry({ cloids: [A, B] }));
    resolvePending([B]);
    expect(listPending()[0].cloids).toEqual([A]);
  });

  it("ignores an empty resolve", () => {
    recordPending(entry());
    resolvePending([]);
    expect(listPending()).toHaveLength(1);
  });
});

describe("conclusivePending", () => {
  beforeEach(() => {
    clearPending();
  });

  it("excludes submits that could still land", () => {
    // Probing these would prove nothing — absence is not yet conclusive.
    recordPending(entry({ expiresAt: NOW + 10_000 }));
    expect(conclusivePending(NOW)).toHaveLength(0);
  });

  it("includes submits past their expiry window", () => {
    recordPending(entry({ expiresAt: NOW - 1 }));
    expect(conclusivePending(NOW)).toHaveLength(1);
  });
});

describe("pendingForIdentity", () => {
  beforeEach(() => {
    clearPending();
  });

  it("does not return another account's in-flight orders", () => {
    recordPending(entry({ identityKey: "someone-else" }));
    expect(pendingForIdentity(identity)).toHaveLength(0);
  });

  it("returns this identity's orders", () => {
    recordPending(entry({ identityKey: "testnet|acc|" + ADDRESS + "|-|-" }));
    expect(pendingForIdentity(identity)).toHaveLength(1);
  });
});

describe("corrupt journal", () => {
  it("degrades to empty rather than breaking the order path on startup", () => {
    hlStringStorage.setItem("hl:orders:pending", "{not json");
    expect(listPending()).toEqual([]);
    expect(() => recordPending(entry())).not.toThrow();
  });

  it("drops entries written under an older key schema", () => {
    // Their identityKey means something different, so probing them would query
    // the wrong network's orders.
    hlStringStorage.setItem(
      "hl:orders:pending",
      JSON.stringify([{ cloids: [A], identityKey: "acc|x|-|-", expiresAt: NOW, submittedAt: NOW }])
    );
    expect(listPending()).toEqual([]);
  });

  it("recovers from a non-array payload", () => {
    hlStringStorage.setItem("hl:orders:pending", '{"unexpected":true}');
    expect(listPending()).toEqual([]);
  });
});

describe("per-cloid resolution", () => {
  beforeEach(() => {
    clearPending();
  });

  it("keeps a multi-leg entry alive until every leg is accounted for", () => {
    // An orderUpdates event names ONE cloid. Dropping the whole entry would
    // abandon its siblings, whose outcome is still unknown.
    recordPending(entry({ cloids: [A, B] }));
    resolvePending([A]);

    const remaining = listPending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].cloids).toEqual([B]);
  });

  it("removes the entry once the last leg resolves", () => {
    recordPending(entry({ cloids: [A, B] }));
    resolvePending([A]);
    resolvePending([B]);
    expect(listPending()).toHaveLength(0);
  });

  it("leaves untouched entries alone", () => {
    recordPending(entry({ cloids: [A] }));
    resolvePending([B]);
    expect(listPending()).toHaveLength(1);
  });
});
