import { reconcileWithdrawals } from "@/hyperliquid/transfers/reconcileWithdrawals";
import { clearWithdrawals, listUnsettled, recordWithdrawal } from "@/hyperliquid/transfers/journal";
import { WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";
import { WeightBudget } from "@/hyperliquid/api/weightBudget";

const USER = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347";
const DEST = "0x5bf8287baeda8de01c88b3016d64f3875b0b4347";
const IDENTITY = "testnet|acc|0x5bf8";
const SIGNED_AT = 1_770_000_000_000;

/**
 * A real `withdraw` delta, as recorded live.
 *
 * `usdc` is the **NET** and `fee` is what came out of it, so this row is a
 * withdrawal whose signed GROSS was 2 — the shape of all three withdrawals this
 * project has made. The nonce is in MICROSECONDS: exactly 1000× the millisecond
 * nonce the journal recorded.
 */
function withdrawRow(overrides: Record<string, unknown> = {}) {
  return {
    time: SIGNED_AT + 240_000,
    hash: "0xabc",
    delta: { type: "withdraw", usdc: "1.0", fee: "1.0", nonce: SIGNED_AT * 1000 },
    ...overrides,
  };
}

function probeOf(rows: unknown[]) {
  return { userNonFundingLedgerUpdates: async () => rows };
}

beforeEach(() => {
  clearWithdrawals();
});

describe("the caller judgeSettlement never had", () => {
  it("settles a journalled withdrawal that the ledger confirms", async () => {
    // The whole point. Before this module existed, `markSettled` fired only on
    // the server-refusal branch, so a withdrawal that actually SUCCEEDED stayed
    // open in the journal forever — a permanent "in progress" row for money that
    // had already arrived.
    recordWithdrawal({
      nonce: SIGNED_AT,
      destination: DEST,
      amount: "2",
      identityKey: IDENTITY,
      at: SIGNED_AT,
    });
    expect(listUnsettled(IDENTITY)).toHaveLength(1);

    const result = await reconcileWithdrawals({
      probe: probeOf([withdrawRow()]),
      user: USER,
      identityKey: IDENTITY,
      now: () => SIGNED_AT + 300_000,
    });

    expect(result.settled).toHaveLength(1);
    expect(listUnsettled(IDENTITY)).toHaveLength(0);
  });

  it("matches on the NET plus the fee, numerically, with no nonce to help", async () => {
    // The row's `usdc` is what arrived; the gross we signed is `usdc + fee`.
    // Comparing `usdc` to the gross — which this module used to do — can never
    // match a live withdrawal. Numeric comparison matters too: we sign "2" and
    // the ledger reports "1.0" + "1.0".
    recordWithdrawal({
      nonce: SIGNED_AT,
      destination: DEST,
      amount: "2",
      identityKey: IDENTITY,
      at: SIGNED_AT,
    });

    const result = await reconcileWithdrawals({
      // No nonce on the row, so only the amount path can settle it.
      probe: probeOf([withdrawRow({ delta: { type: "withdraw", usdc: "1.0", fee: "1.0" } })]),
      user: USER,
      identityKey: IDENTITY,
      now: () => SIGNED_AT + 300_000,
    });
    expect(result.settled).toHaveLength(1);
  });

  it("leaves an unmatched entry PENDING inside the settlement floor", async () => {
    recordWithdrawal({
      nonce: SIGNED_AT,
      destination: DEST,
      amount: "2",
      identityKey: IDENTITY,
      at: SIGNED_AT,
    });

    const result = await reconcileWithdrawals({
      probe: probeOf([]),
      user: USER,
      identityKey: IDENTITY,
      now: () => SIGNED_AT + 60_000,
    });

    expect(result.pending).toHaveLength(1);
    // Still journalled: the duplicate guard depends on it.
    expect(listUnsettled(IDENTITY)).toHaveLength(1);
  });

  it("reports UNRESOLVED past the floor — and still does not settle it", async () => {
    // "Unresolved" is not "failed" and not "arrived". A withdrawal has no cancel
    // and no status endpoint, so clearing the entry here would remove the only
    // thing standing between the user and a second, equally final withdrawal.
    recordWithdrawal({
      nonce: SIGNED_AT,
      destination: DEST,
      amount: "2",
      identityKey: IDENTITY,
      at: SIGNED_AT,
    });

    const result = await reconcileWithdrawals({
      probe: probeOf([]),
      user: USER,
      identityKey: IDENTITY,
      now: () => SIGNED_AT + WITHDRAW_TIMINGS.settlementFloorMs + 1,
    });

    expect(result.unresolved).toHaveLength(1);
    expect(result.settled).toHaveLength(0);
    expect(listUnsettled(IDENTITY)).toHaveLength(1);
  });

  it("does not settle another identity's entry against this account's ledger", async () => {
    recordWithdrawal({
      nonce: SIGNED_AT,
      destination: DEST,
      amount: "2",
      identityKey: "some-other-identity",
      at: SIGNED_AT,
    });

    const result = await reconcileWithdrawals({
      probe: probeOf([withdrawRow()]),
      user: USER,
      identityKey: IDENTITY,
      now: () => SIGNED_AT + 300_000,
    });

    expect(result.settled).toHaveLength(0);
    expect(listUnsettled("some-other-identity")).toHaveLength(1);
  });

  it("reads the ledger ONCE for many outstanding entries", async () => {
    // `userNonFundingLedgerUpdates` is weighted 20; a call per entry would burn
    // the budget for no benefit, since one snapshot answers all of them.
    let calls = 0;
    for (const nonce of [SIGNED_AT, SIGNED_AT + 1, SIGNED_AT + 2]) {
      recordWithdrawal({
        nonce,
        destination: DEST,
        amount: "2",
        identityKey: IDENTITY,
        at: nonce,
      });
    }

    await reconcileWithdrawals({
      probe: {
        userNonFundingLedgerUpdates: async () => {
          calls += 1;
          return [];
        },
      },
      user: USER,
      identityKey: IDENTITY,
      now: () => SIGNED_AT + 60_000,
    });
    expect(calls).toBe(1);
  });

  it("looks back from the OLDEST signature, not a fixed window", async () => {
    // A withdrawal signed before the app was last closed is exactly the case this
    // exists to resolve; a fixed lookback would never see its ledger row.
    const old = SIGNED_AT - 86_400_000;
    recordWithdrawal({
      nonce: old,
      destination: DEST,
      amount: "2",
      identityKey: IDENTITY,
      at: old,
    });

    let startTime = 0;
    await reconcileWithdrawals({
      probe: {
        userNonFundingLedgerUpdates: async (p: { startTime: number }) => {
          startTime = p.startTime;
          return [];
        },
      },
      user: USER,
      identityKey: IDENTITY,
      now: () => SIGNED_AT,
    });
    expect(startTime).toBeLessThanOrEqual(old);
  });

  it("does nothing at all when there is nothing outstanding", async () => {
    let called = false;
    const result = await reconcileWithdrawals({
      probe: {
        userNonFundingLedgerUpdates: async () => {
          called = true;
          return [];
        },
      },
      user: USER,
      identityKey: IDENTITY,
    });
    expect(called).toBe(false);
    expect(result).toEqual({ settled: [], pending: [], unresolved: [], deferred: false });
  });

  it("reports deferred rather than judging on a refused read", async () => {
    // Judging against an empty row set would call every outstanding withdrawal
    // pending — or, past the floor, unresolved — purely because we were rate
    // limited. Same unknown-versus-none rule the rest of the module follows.
    recordWithdrawal({
      nonce: SIGNED_AT,
      destination: DEST,
      amount: "2",
      identityKey: IDENTITY,
      at: SIGNED_AT,
    });

    const result = await reconcileWithdrawals({
      probe: probeOf([withdrawRow()]),
      user: USER,
      identityKey: IDENTITY,
      budget: new WeightBudget(0),
      now: () => SIGNED_AT + 300_000,
    });

    expect(result.deferred).toBe(true);
    expect(result.settled).toHaveLength(0);
    expect(listUnsettled(IDENTITY)).toHaveLength(1);
  });
});
