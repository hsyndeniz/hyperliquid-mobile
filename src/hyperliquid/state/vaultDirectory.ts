/**
 * The directory snapshot, held for every screen that needs it.
 *
 * A module-level store rather than hook-local state or `restCache`, for two
 * reasons the hook design records:
 *
 * - **TTL must gate refetching, never rendering.** `restCache` deletes at
 *   expiry; for a 14 MB download the last-known directory must stay renderable
 *   with an age chip while a background refresh runs. This store never evicts.
 * - **Two mounted consumers share one download.** The list screen and the
 *   transfer sheet (which needs `collisions`) both read here; the single-flight
 *   coordinator in `hooks/vaults.ts` writes here.
 *
 * `read()` returns the held object, replaced wholesale on `set` — the
 * referential stability `useSyncExternalStore` requires (`useStore.ts` states
 * the rule; a fresh object per read re-renders forever).
 */

import type { HlEnv, Hex } from "@/hyperliquid/types/domain";
import type { VaultDirectory, VaultIndexEntry } from "@/hyperliquid/vaults/directory";

export interface VaultDirectoryFetchState {
  isFetching: boolean;
  /** The last refresh that failed. Scoped, so an old env's failure never haunts a new one. */
  lastFailure: { env: HlEnv; message: string; atMs: number } | null;
}

type Listener = () => void;

const IDLE_FETCH: VaultDirectoryFetchState = { isFetching: false, lastFailure: null };

export class VaultDirectoryStore {
  private directory: VaultDirectory | null = null;
  private fetch: VaultDirectoryFetchState = IDLE_FETCH;
  private readonly listeners = new Set<Listener>();

  /** The snapshot, or `null` before the first successful fetch. */
  read(): VaultDirectory | null {
    return this.directory;
  }

  fetchState(): VaultDirectoryFetchState {
    return this.fetch;
  }

  set(directory: VaultDirectory): void {
    this.directory = directory;
    this.emit();
  }

  setFetchState(next: VaultDirectoryFetchState): void {
    this.fetch = next;
    this.emit();
  }

  /**
   * Teach the index one entry a detail visit just confirmed.
   *
   * The measured need: a HELD vault can be absent from the directory (testnet
   * HLP), and its detail response carries the name. Patching the index names
   * the position row permanently, at no cost. The directory object is replaced
   * wholesale so snapshots stay referentially honest.
   */
  upsertIndex(address: Hex, entry: VaultIndexEntry): void {
    if (this.directory === null) return;
    const existing = this.directory.index.get(address.toLowerCase() as Hex);
    if (existing && existing.name === entry.name && existing.isClosed === entry.isClosed) return;
    const index = new Map(this.directory.index);
    index.set(address.toLowerCase() as Hex, entry);
    this.directory = { ...this.directory, index };
    this.emit();
  }

  clear(): void {
    this.directory = null;
    this.fetch = IDLE_FETCH;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
