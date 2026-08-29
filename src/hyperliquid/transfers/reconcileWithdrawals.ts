/**
 * The caller `judgeSettlement` never had.
 *
 * `transfers/` shipped a journal that records every signed withdrawal, a ledger
 * reader, and a settlement judge — and **nothing that put the three together**.
 * `markSettled` fired only on the server-refusal branch of `submitWithdrawal`, so
 * a withdrawal that actually succeeded stayed open in the journal forever.
 *
 * That is the same "correct module, no caller" shape that hid the Phase 8
 * `vaultAddress` bug, and it was found the same way: by an end-to-end test asking
 * who consumes what. The symptoms it leaves are small but real —
 * `listUnsettled` grows without bound, a history built from it shows a permanent
 * "in progress" row for money that arrived, and `lastUnsettledAt` keeps
 * reporting an in-flight withdrawal that finished.
 *
 * Deliberately its own module rather than a method on the journal: the journal is
 * synchronous MMKV and has no business making network calls, and `ledger.ts` is a
 * parser that has no business knowing about durable storage.
 */

import { WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";
import { log } from "@/hyperliquid/core/logger";
import type { WeightBudget } from "@/hyperliquid/api/weightBudget";
import { fetchLedger, judgeSettlement, type LedgerProbe } from "@/hyperliquid/transfers/ledger";
import {
  listUnsettled,
  settleWithdrawal,
  type WithdrawalRecord,
} from "@/hyperliquid/transfers/journal";

const logger = log.child("transfers.reconcile");

export interface WithdrawalReconciliation {
  /** Journal entries a matching ledger row confirmed. Now settled. */
  settled: WithdrawalRecord[];
  /** Signed, no row yet, still inside the settlement floor. Keep watching. */
  pending: WithdrawalRecord[];
  /**
   * Past the observed maximum with no matching row.
   *
   * **Never "failed", and never settled.** A withdrawal has no cancel and no
   * status endpoint, so absence past the floor is grounds for telling the user to
   * check the destination chain — never grounds for re-sending, and never grounds
   * for clearing the journal entry that blocks a duplicate.
   */
  unresolved: WithdrawalRecord[];
  /** True when the weight budget refused the ledger read; nothing was judged. */
  deferred: boolean;
}

/**
 * Settle journalled withdrawals against the on-chain ledger.
 *
 * Safe to call on a timer or at session start. Reads once and judges every
 * outstanding entry against that one snapshot, rather than a call per entry —
 * `userNonFundingLedgerUpdates` is weighted 20 and the common case is zero or one
 * outstanding withdrawal.
 *
 * Scoped by `identityKey` so a session switch cannot settle another account's
 * entry against this account's ledger.
 */
export async function reconcileWithdrawals(params: {
  probe: LedgerProbe;
  user: string;
  /** Only entries signed by this identity. Omit at your peril — see above. */
  identityKey?: string;
  budget?: WeightBudget;
  now?: () => number;
}): Promise<WithdrawalReconciliation> {
  const now = (params.now ?? Date.now)();
  const outstanding = listUnsettled(params.identityKey);

  const empty: WithdrawalReconciliation = {
    settled: [],
    pending: [],
    unresolved: [],
    deferred: false,
  };
  if (outstanding.length === 0) return empty;

  // From the OLDEST outstanding signature, not from `now` minus a window: a
  // withdrawal signed before the app was last closed is exactly the case this
  // exists to resolve, and a fixed lookback would miss it.
  const earliest = Math.min(...outstanding.map((entry) => entry.at));

  const { rows, deferred } = await fetchLedger({
    probe: params.probe,
    user: params.user,
    // A small margin: the ledger stamps its own time, which can sit fractionally
    // before the nonce we recorded.
    startTime: earliest - 60_000,
    budget: params.budget,
    now: () => now,
  });
  if (deferred) return { ...empty, deferred: true };

  const result: WithdrawalReconciliation = { ...empty, settled: [], pending: [], unresolved: [] };

  for (const entry of outstanding) {
    const verdict = judgeSettlement({
      rows,
      signedAt: entry.at,
      grossAmount: entry.amount,
      // The exact key: the ledger's microsecond nonce divided by 1000 is this
      // millisecond one. Without it, two withdrawals of the same size in the
      // same window are indistinguishable.
      nonce: entry.nonce,
      now,
      settlementFloorMs: WITHDRAW_TIMINGS.settlementFloorMs,
    });

    if (verdict.kind === "settled") {
      // The write that was missing. Everything else here is read-only.
      settleWithdrawal(entry.nonce, now);
      result.settled.push(entry);
    } else if (verdict.kind === "pending") {
      result.pending.push(entry);
    } else {
      result.unresolved.push(entry);
    }
  }

  logger.info("withdrawals.reconciled", {
    context: {
      settled: result.settled.length,
      pending: result.pending.length,
      unresolved: result.unresolved.length,
    },
  });
  return result;
}
