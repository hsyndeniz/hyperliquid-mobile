/**
 * Polled mid prices — the price column of the Markets list.
 *
 * `allMids` is a REST poll (15 s while the list is focused), not a
 * subscription: the map is ~45 KB with ~2,700 keys (211 perp + 1,767 `@N` spot
 * + 724 `#N` outcome spellings, measured), and a websocket push at that size
 * costs a Hermes parse per tick for a screen that only needs 15 s freshness.
 *
 * Rules:
 *
 * - **An identical poll must not notify.** Quiet markets return payloads whose
 *   every value is unchanged; notifying would re-render every visible row every
 *   15 s for zero pixel change. `set` diffs before it swaps, and on no change
 *   keeps the previously held references so snapshots stay `Object.is`-equal.
 * - **An unknown coin reads `null`, not `"0"`.** A missing mid is an absence;
 *   the row falls back to `markPx`, never to a fabricated zero.
 * - **`ageMs` is `null` before the first poll.** "Never polled" is not "polled
 *   0 ms ago" — the stale chip must not treat cold start as fresh.
 * - A no-change poll still **refreshes the age**: the poll succeeded, so the
 *   data is confirmed current — a quiet market is not a stale one.
 *
 * Per-row consumption is `useStoreValue(store, (s) => s.mid(coin))` — a string
 * primitive, so `Object.is` bails unchanged rows out of a changed poll and only
 * rows whose mid actually moved re-render.
 */

import { log } from "@/hyperliquid/core/logger";

const logger = log.child("state.mids");

type Listener = () => void;

/** The wire map, verbatim: coin spelling (`BTC`, `@107`, `#102170`) → mid string. */
export type MidsMap = Readonly<Record<string, string>>;

/** Whether every key/value of `incoming` already matches `held`, and none were removed. */
function sameMids(held: Record<string, string>, incoming: Record<string, string>): boolean {
  const keys = Object.keys(incoming);
  if (keys.length !== Object.keys(held).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(held, key) || held[key] !== incoming[key]) return false;
  }
  return true;
}

export class MidsStore {
  /** `null` until the first poll lands — distinct from an empty map. */
  private mids: Record<string, string> | null = null;
  private setAtMs: number | null = null;
  private versionCount = 0;
  private readonly listeners = new Set<Listener>();

  /**
   * Store a poll result.
   *
   * Notifies (and bumps `version`) only when something actually changed; an
   * identical payload updates the poll time and nothing else.
   */
  set(mids: Record<string, string>, now: number): void {
    const changed = this.mids === null || !sameMids(this.mids, mids);
    this.setAtMs = now;
    if (!changed) return;
    this.mids = mids;
    this.versionCount += 1;
    this.emit();
  }

  /**
   * The mid for a wire coin, or `null` when unknown or not yet polled.
   *
   * `Object.hasOwn` so a coin spelled like a prototype key can never read a
   * function off `Object.prototype` as a price.
   */
  mid(coin: string): string | null {
    if (this.mids === null || !Object.hasOwn(this.mids, coin)) return null;
    return this.mids[coin];
  }

  /**
   * The whole held map, or `null` before the first poll.
   *
   * Referentially stable between changes — the reference only swaps when `set`
   * accepted a changed payload — so it is safe as a `useStoreValue` selector.
   */
  readAll(): MidsMap | null {
    return this.mids;
  }

  /** Milliseconds since the last successful poll; `null` before the first. */
  ageMs(now: number): number | null {
    return this.setAtMs === null ? null : now - this.setAtMs;
  }

  /** Bumped only when the map content changed. A primitive for selectors. */
  get version(): number {
    return this.versionCount;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // A throwing consumer must not break the feed for the others.
        logger.warn("mids.listener_failed", { error });
      }
    }
  }
}
