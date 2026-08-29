/**
 * A short-lived cache for user-scoped REST reads.
 *
 * ## Why this exists
 *
 * The per-IP weight budget is a **sliding window over the whole app**, not a
 * per-screen allowance, and a screen that refetches on every mount spends
 * against it every time the user switches tabs, navigates back, or triggers a
 * Fast Refresh. Measured on the Portfolio screen: adding the history sections
 * took one mount from 20 weight to 104, which drops the number of mounts that
 * fit in a minute from 58 to 11. Past that the budget starts declining calls —
 * and the first casualty is whichever read asks next, which showed up as the
 * account-value chart intermittently rendering "History deferred" instead of a
 * chart.
 *
 * Caching is the fix rather than "fetch less", because none of these reads
 * *changes* between two mounts a second apart. Re-asking was the bug.
 *
 * ## What it is deliberately not
 *
 * - **Not a store.** Nothing subscribes; there is no invalidation on a
 *   websocket event. Live data belongs in `state/`, which is pushed. This is
 *   for endpoints that are only ever pulled.
 * - **Not persistent.** It dies with the process. A cold start should read
 *   fresh, and a stale ledger surviving a relaunch would be worse than a
 *   request.
 * - **Not a substitute for a refresh.** Every caller keeps a `refresh()` that
 *   bypasses this, because "I just made a transfer and want to see it" must
 *   never be answered from a cache.
 *
 * Keys are `${request}:${user}` and must include the user: the whole point of
 * the identity scoping elsewhere in this module is that one account's data can
 * never render under another's, and a cache keyed on the endpoint alone would
 * reintroduce exactly that.
 */

import { log } from "@/hyperliquid/core/logger";

const logger = log.child("api.restCache");

interface Entry {
  at: number;
  value: unknown;
}

/**
 * How long a pulled read stays good.
 *
 * Chosen against what the data actually is: these endpoints only change when
 * the user acts, and every action that changes them also has a live websocket
 * counterpart that updates immediately — a new fill appears in the Trades list
 * from `userFills` regardless of what this holds for `historicalOrders`.
 */
export const REST_CACHE_TTL_MS = 60_000;

/** Prices move continuously, so they get a much shorter life than history. */
export const PRICE_CACHE_TTL_MS = 15_000;

export class RestCache {
  private entries = new Map<string, Entry>();

  private listeners = new Map<string, Set<() => void>>();

  /** The cached value, or `undefined` when absent or past `ttlMs`. */
  read<T>(key: string, now: number, ttlMs: number): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (now - entry.at >= ttlMs) {
      // Dropped rather than left to rot: the map is keyed by user, so a long
      // session across several accounts would otherwise grow without bound.
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  write(key: string, value: unknown, now: number): void {
    this.entries.set(key, { at: now, value });
  }

  /**
   * Forget entries, all of them or by key prefix.
   *
   * Call with the user's own suffix on sign-out: a cached ledger belonging to
   * an account that is no longer signed in must not be readable by the next
   * one, even though the key would not match.
   */
  invalidate(prefix?: string): void {
    if (prefix === undefined) {
      // Clear-all is the SIGN-OUT path. Deliberately silent: "forget
      // everything" does not mean "everyone refetch", and waking every mounted
      // reader here would spend weight re-asking for the departing account's
      // data.
      this.entries.clear();
      return;
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix) || key.endsWith(prefix)) this.entries.delete(key);
    }
    this.notify(prefix);
  }

  /**
   * Be told when `key` is invalidated. Returns an unsubscribe.
   *
   * The cache is shared but every reader holds its own copy of the value, so
   * dropping an entry only reaches whoever happens to re-read next. A vault
   * screen mounts THREE readers of the same equity — the position row and both
   * transfer sheets — and after a settled deposit only the sheet that submitted
   * refreshed. The other two went on showing the pre-deposit equity and an
   * expired lockup, and the withdraw quote was built from it.
   */
  onInvalidate(key: string, listener: () => void): () => void {
    const existing = this.listeners.get(key) ?? new Set<() => void>();
    existing.add(listener);
    this.listeners.set(key, existing);
    return () => {
      const set = this.listeners.get(key);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  private notify(prefix: string): void {
    for (const [key, set] of this.listeners) {
      if (!key.startsWith(prefix) && !key.endsWith(prefix)) continue;
      for (const listener of set) {
        try {
          listener();
        } catch {
          // A throwing reader must not stop the others being told.
        }
      }
    }
  }

  /** Entry count. For tests and diagnostics. */
  size(): number {
    return this.entries.size;
  }
}

export const restCache = new RestCache();

/** Key for a user-scoped read. The user is part of it, always. */
export function restCacheKey(request: string, user: string): string {
  return `${request}:${user.toLowerCase()}`;
}

/**
 * Read through the cache, falling back to `fetch`.
 *
 * Returns `{ value, cached }` so a caller can tell a fresh read from a reused
 * one — which is what makes the saving visible in a log rather than silent.
 */
/**
 * No in-flight dedupe here, deliberately — it was tried and removed.
 *
 * Collapsing concurrent readers of one key onto a single promise saves real
 * weight (a vault screen mounts three readers of the same equity), but it makes
 * a request that never settles wedge that key for the life of the process:
 * every later reader awaits a promise that will not resolve, and the surface
 * renders "loading" forever with nothing to retry. There is no timeout on these
 * fetches to bound it. A duplicated request is a cost; a wedged key on a money
 * path is a fault, and the two are not worth trading.
 *
 * If the duplication ever matters, the fix is to lift the shared read to the
 * screen and pass it down — one reader, no cache trickery.
 */

export async function readThrough<T>(params: {
  key: string;
  ttlMs: number;
  now: number;
  fetch: () => Promise<T | null>;
}): Promise<{ value: T | null; cached: boolean }> {
  const hit = restCache.read<T>(params.key, params.now, params.ttlMs);
  if (hit !== undefined) return { value: hit, cached: true };

  const value = await params.fetch();
  // `null` is the weight budget declining. Caching it would turn one deferral
  // into a minute of them, which is the opposite of what this is for.
  if (value !== null) restCache.write(params.key, value, params.now);
  else logger.debug("restCache.not_cached_deferred", { context: { key: params.key } });
  return { value, cached: false };
}
