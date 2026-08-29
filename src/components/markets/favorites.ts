/**
 * Pinned markets — the persistent set behind the picker's Favorites tab.
 *
 * Keyed by WIRE coin (`BTC`, `@107`, `PURR/USDC`), not display symbol: two
 * spot pairs can share a base symbol, and the wire spelling is the identity
 * every other layer already scopes by. Persisted as a JSON string array under
 * one MMKV key, loaded lazily — MMKV is a Nitro module, and touching it at
 * import time would make merely importing this file require the native
 * runtime (the rule `storage/mmkv.ts` documents for its own instance).
 *
 * `read()` returns the SAME Set instance until a toggle: consumers subscribe
 * through `useStoreValue`, which compares snapshots with `Object.is`, and a
 * fresh Set per call would re-render forever.
 */

import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

const STORAGE_KEY = "hl:markets:favorites";

type Listener = () => void;

function load(): ReadonlySet<string> {
  const raw = hlStringStorage.getItem(STORAGE_KEY);
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    // Corrupt storage reads as "nothing pinned" — a picker preference is not
    // worth a crash, and the next toggle rewrites the key wholesale anyway.
    return new Set();
  }
}

export class FavoritesStore {
  /** `null` until first read, so importing this module never touches MMKV. */
  private held: ReadonlySet<string> | null = null;
  private readonly listeners = new Set<Listener>();

  /** The pinned wire coins. Identity is stable until the next {@link toggle}. */
  read(): ReadonlySet<string> {
    if (this.held === null) this.held = load();
    return this.held;
  }

  /** Pin or unpin one market. Persists before notifying, like every store here. */
  toggle(wireCoin: string): void {
    const next = new Set(this.read());
    if (next.has(wireCoin)) next.delete(wireCoin);
    else next.add(wireCoin);
    this.held = next;
    hlStringStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** The app's one instance — screens read it through `useStoreValue`. */
export const favoritesStore = new FavoritesStore();
