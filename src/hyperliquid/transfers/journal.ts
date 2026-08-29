/**
 * The withdrawal journal.
 *
 * Mirrors `orders/pending` in shape and differs in purpose. That journal exists
 * so an order whose outcome was never learned can be **probed and possibly
 * retried**. This one exists so a withdrawal whose outcome was never learned is
 * **never retried at all**.
 *
 * The distinction matters because a withdrawal has no idempotency key, no client
 * order id and no `expiresAfter`, so a stalled request stays valid across a wide
 * nonce window. The only defence is to remember that something was signed and
 * refuse to sign again until the settlement floor has passed — and that memory
 * has to survive the app being killed, which is exactly when a user would open
 * it again and try once more.
 *
 * So the write happens **before** the request, not after. A process that dies
 * mid-flight still leaves evidence.
 */

import { hlStringStorage } from "@/hyperliquid/storage/mmkv";
import { log } from "@/hyperliquid/core/logger";
import { WITHDRAW_TIMINGS } from "@/hyperliquid/config/constants";

const logger = log.child("transfers.journal");

const STORAGE_KEY = "hl:withdrawals";

/**
 * Bumped whenever the entry shape changes.
 *
 * Entries at any other version are dropped rather than migrated: a
 * half-understood withdrawal record is worse than none, because it feeds the
 * one guard standing between a user and a duplicate withdrawal.
 */
export const WITHDRAWAL_SCHEMA_VERSION = 1;

export interface WithdrawalRecord {
  schemaVersion: number;
  /** The nonce, which doubles as the transaction id — the response carries no handle. */
  nonce: number;
  /** Lowercase wire form, as signed. */
  destination: string;
  /** Gross, as signed. */
  amount: string;
  /** Identity that signed, so a switch cannot hide an in-flight withdrawal. */
  identityKey: string;
  at: number;
  /** Set once the ledger confirms arrival, or the server rejected it outright. */
  settledAt: number | null;
}

function readAll(): WithdrawalRecord[] {
  const raw = hlStringStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed as WithdrawalRecord[];
    const current = entries.filter((e) => e?.schemaVersion === WITHDRAWAL_SCHEMA_VERSION);
    if (current.length !== entries.length) {
      logger.warn("withdrawals.schema_dropped", {
        context: { dropped: entries.length - current.length },
      });
    }
    return current;
  } catch {
    // A corrupt journal must not crash startup. It degrades the in-flight
    // guard, which is why the corruption is logged rather than swallowed.
    logger.warn("withdrawals.corrupt");
    return [];
  }
}

function writeAll(entries: WithdrawalRecord[]): void {
  hlStringStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * Record a withdrawal **before** it is attempted.
 *
 * Synchronous by design: returning before the write lands would defeat the
 * purpose entirely, since the crash this protects against happens during the
 * request.
 */
export function recordWithdrawal(
  entry: Omit<WithdrawalRecord, "schemaVersion" | "settledAt">
): void {
  const entries = readAll();
  entries.push({ ...entry, schemaVersion: WITHDRAWAL_SCHEMA_VERSION, settledAt: null });
  writeAll(entries);
  logger.info("withdrawals.recorded", {
    context: {
      nonce: entry.nonce,
      // Only the tail: a full destination in a log is a privacy leak with no
      // diagnostic value the tail does not already give.
      destinationTail: entry.destination.slice(-6),
      amount: entry.amount,
    },
  });
}

/** Mark a withdrawal settled — the ledger confirmed it, or the server refused it. */
/**
 * Correct an entry's nonce to the one that was actually signed.
 *
 * The entry is written BEFORE the call, because the crash it guards against
 * happens during it — but the nonce the SDK signs is only known once the call
 * is under way. So the write uses the caller's best guess and this repairs it.
 *
 * The nonce is this record's identity: it is the key the ledger row carries and
 * the only thing that distinguishes two withdrawals of the same amount in the
 * same window. An entry left under a guess falls back to amount-and-window
 * matching, which settles the SECOND withdrawal against the FIRST one's row.
 *
 * A no-op when the guess was right, which is the common case.
 */
export function reviseWithdrawalNonce(from: number, to: number): void {
  if (from === to) return;
  const entries = readAll();
  const entry = entries.find((row) => row.nonce === from);
  if (!entry) return;
  writeAll(entries.map((row) => (row.nonce === from ? { ...row, nonce: to } : row)));
}

export function settleWithdrawal(nonce: number, at: number = Date.now()): void {
  const entries = readAll();
  const next = entries.map((e) => (e.nonce === nonce ? { ...e, settledAt: at } : e));
  writeAll(next);
}

/** Every withdrawal this device signed and never saw resolve. */
export function listUnsettled(identityKey?: string): WithdrawalRecord[] {
  return readAll().filter(
    (e) => e.settledAt === null && (identityKey === undefined || e.identityKey === identityKey)
  );
}

/**
 * When the most recent unresolved withdrawal was signed, or `null`.
 *
 * This is what the preflight's in-flight blocker reads. Scoped by identity
 * because an account switch must not conceal a withdrawal still in flight on the
 * account being left — but must equally not block a different account for it.
 */
export function lastUnsettledAt(identityKey?: string): number | null {
  const unsettled = listUnsettled(identityKey);
  if (unsettled.length === 0) return null;
  return unsettled.reduce((latest, e) => Math.max(latest, e.at), 0);
}

/**
 * Drop entries old enough that a duplicate is no longer the risk.
 *
 * Kept well past the settlement floor: the journal is also the only local record
 * that a withdrawal happened at all, and it costs nothing to retain.
 */
export function pruneWithdrawals(
  now: number = Date.now(),
  retainMs = 7 * 24 * 60 * 60 * 1000
): void {
  const entries = readAll();
  const kept = entries.filter((e) => {
    if (e.settledAt === null) {
      // Never prune an unsettled entry inside its floor — that is the entry the
      // duplicate guard depends on.
      return now - e.at < Math.max(retainMs, WITHDRAW_TIMINGS.settlementFloorMs);
    }
    return now - e.settledAt < retainMs;
  });
  if (kept.length !== entries.length) writeAll(kept);
}

/** Test-only reset. */
export function clearWithdrawals(): void {
  hlStringStorage.removeItem(STORAGE_KEY);
}
