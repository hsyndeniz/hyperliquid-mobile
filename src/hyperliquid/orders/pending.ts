/**
 * Durable record of in-flight submits.
 *
 * The cloid is the only handle on an order whose response was lost — but a
 * handle held only in memory is lost too if the app is killed between sending
 * the request and receiving the reply. On mobile that is not a rare case: the
 * OS terminates backgrounded apps routinely, and a submit during a network
 * stall is exactly when the user switches away.
 *
 * So every submit is journalled to disk **before** it is awaited, and cleared
 * only once its outcome is known. On next launch, whatever remains is a submit
 * whose fate the app never learned — the input to reconciliation.
 *
 * MMKV is synchronous, which is what makes a genuine write-before-send possible;
 * an async store could not guarantee the record survived the crash.
 */

import { identityKey } from "@/hyperliquid/core/identity";
import { log } from "@/hyperliquid/core/logger";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";
import type { HlIdentity } from "@/hyperliquid/types/domain";
import type { Cloid } from "@/hyperliquid/orders/cloid";

const STORAGE_KEY = "hl:orders:pending";
const logger = log.child("orders.pending");

/**
 * Journal schema version.
 *
 * Bumped when `identityKey`'s shape changes. An entry written under an older
 * key cannot be safely reconciled — its scope string means something different
 * — so stale entries are dropped rather than probed against the wrong network.
 */
export const PENDING_SCHEMA_VERSION = 2;

/** A submit whose outcome is not yet known. */
export interface PendingSubmit {
  schemaVersion?: number;
  cloids: Cloid[];
  /** Scope, so reconciliation probes the right user and DEX. */
  identityKey: string;
  address: string;
  /** After this, the action can no longer land — absence becomes conclusive. */
  expiresAt: number;
  submittedAt: number;
  /** Free-form, for surfacing "your BTC order may have gone through". */
  label?: string;
}

function readAll(): PendingSubmit[] {
  const raw = hlStringStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries = parsed as PendingSubmit[];
    const current = entries.filter((e) => e?.schemaVersion === PENDING_SCHEMA_VERSION);
    if (current.length !== entries.length) {
      logger.warn("journal.schema_dropped", {
        context: { dropped: entries.length - current.length },
      });
    }
    return current;
  } catch {
    // Corrupt journal: better to drop it than to crash the order path on
    // startup. Reconciliation degrades, it does not break.
    logger.warn("journal.corrupt");
    return [];
  }
}

function writeAll(entries: PendingSubmit[]): void {
  hlStringStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * Journal a submit. **Must be called before awaiting the request.**
 *
 * Synchronous by design — returning before the write lands would defeat the
 * purpose.
 */
export function recordPending(entry: PendingSubmit): void {
  const entries = readAll();
  entries.push({ ...entry, schemaVersion: PENDING_SCHEMA_VERSION });
  writeAll(entries);
  logger.info("journal.recorded", {
    context: { cloids: entry.cloids.length, expiresAt: entry.expiresAt },
  });
}

/**
 * Clear resolved cloids from the journal.
 *
 * Per-**cloid**, not per-entry: a multi-leg submit can be resolved one leg at a
 * time (an `orderUpdates` event names a single cloid), and dropping the whole
 * entry on the first match would abandon its siblings — whose outcome is still
 * unknown — and lose the only handle to orders that may be live.
 *
 * An entry is removed only once every one of its cloids is accounted for.
 */
export function resolvePending(cloids: readonly Cloid[]): void {
  if (cloids.length === 0) return;
  const drop = new Set(cloids);
  const remaining = readAll().flatMap((entry) => {
    const unresolved = entry.cloids.filter((cloid) => !drop.has(cloid));
    if (unresolved.length === 0) return [];
    if (unresolved.length === entry.cloids.length) return [entry];
    return [{ ...entry, cloids: unresolved }];
  });
  writeAll(remaining);
}

/** Every submit whose outcome the app never learned. */
export function listPending(): PendingSubmit[] {
  return readAll();
}

/**
 * Pending submits that can now be probed conclusively.
 *
 * Before `expiresAt` the order may still land, so a negative probe proves
 * nothing — those entries are deliberately excluded.
 */
export function conclusivePending(now: number): PendingSubmit[] {
  return readAll().filter((entry) => now > entry.expiresAt);
}

/** Restrict to one account, so a switch does not reconcile another's orders. */
export function pendingForIdentity(identity: HlIdentity): PendingSubmit[] {
  const key = identityKey(identity);
  return readAll().filter((entry) => entry.identityKey === key);
}

/** Test/maintenance helper. */
export function clearPending(): void {
  hlStringStorage.removeItem(STORAGE_KEY);
}
