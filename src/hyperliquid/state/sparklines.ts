/**
 * Sparkline closes, shared by every row and card that wants one.
 *
 * A module store rather than per-component state, for one reason that only
 * shows up in a list: rows RECYCLE. A hook that owned its own fetch would
 * restart it every time a cell was reused for another coin, and the same coin
 * scrolled past twice would be fetched twice. Here a coin is fetched once, and
 * every row that ever displays it reads the same array.
 *
 * **Listeners are per coin.** A store-wide notify would re-render all ~12
 * mounted rows on every arrival — 20 arrivals × 12 rows is 240 row renders for
 * 20 lines. Subscribing by coin makes each arrival re-render exactly the one
 * row that gained a line.
 *
 * Arrays are held by reference and never rebuilt, so `useSyncExternalStore`'s
 * `Object.is` snapshot check stays honest (the rule `useStore.ts` states).
 */

/** `[openTimeMs, close]` wire pairs — closes stay strings until the display leaf. */
export type SparkCloses = readonly (readonly [number, string])[];

type Listener = () => void;

export class SparklineStore {
  private readonly closes = new Map<string, SparkCloses>();
  private readonly listeners = new Map<string, Set<Listener>>();

  /** The coin's closes, or `null` when we have not (or could not) read them. */
  read(key: string | null): SparkCloses | null {
    if (key === null) return null;
    return this.closes.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.closes.has(key);
  }

  set(key: string, closes: SparkCloses): void {
    this.closes.set(key, closes);
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  subscribe(key: string | null, listener: Listener): () => void {
    if (key === null) return () => undefined;
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      // Empty sets are dropped: a 1,309-row list would otherwise leave a Set
      // per coin behind after a single scroll to the bottom.
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  /** Drop everything — an env switch invalidates every series at once. */
  clear(): void {
    const keys = [...this.closes.keys()];
    this.closes.clear();
    for (const key of keys) {
      for (const listener of this.listeners.get(key) ?? []) listener();
    }
  }

  size(): number {
    return this.closes.size;
  }
}

/** Shared across screens — a coin's last 24 hourly closes are not per-screen. */
export const sparklines = new SparklineStore();
