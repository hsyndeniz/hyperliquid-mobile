/**
 * Persistent storage for Hyperliquid state.
 *
 * A dedicated MMKV instance, separate from app-level storage, so clearing the
 * trading cache cannot disturb unrelated app state.
 *
 * **Never store secrets here.** MMKV is unencrypted by default; agent private
 * keys go to the device Keychain (`@/hyperliquid/auth/keychain`).
 */

import { createMMKV } from "react-native-mmkv";

import type { MMKV } from "react-native-mmkv";

/**
 * MMKV v4 exposes `createMMKV(config)` — there is no `MMKV` class to `new`
 * (that was the v2/v3 pattern), and `Configuration.id` is required.
 *
 * Created lazily rather than at module scope: MMKV is a Nitro module, so
 * instantiating it at import time makes merely *importing* anything downstream
 * require the native runtime. That breaks tests and any tooling that loads
 * these modules outside the app.
 */
let instance: MMKV | null = null;

function getStorage(): MMKV {
  if (!instance) {
    instance = createMMKV({ id: "hyperliquid" });
  }
  return instance;
}

/**
 * Web-Storage-shaped adapter.
 *
 * Synchronous by design: MMKV is a sync API, which keeps jotai atoms synchronous
 * (an async storage would make every atom value a promise). Note the delete
 * method is `remove`, not `delete`.
 */
export interface SyncStringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const hlStringStorage: SyncStringStorage = {
  getItem: (key) => getStorage().getString(key) ?? null,
  setItem: (key, value) => getStorage().set(key, value),
  removeItem: (key) => {
    getStorage().remove(key);
  },
};

/** Direct access, for callers that need typed getters or key enumeration. */
export function hlStorage(): MMKV {
  return getStorage();
}

/**
 * The vault's namespace inside this instance.
 *
 * Owned here rather than in `wallet/vault.ts` because this is the module that
 * has to skip it, and the dependency already points this way.
 */
export const VAULT_KEY_PREFIX = "hl:vault:";

/**
 * Wipe the Hyperliquid **cache** without touching app-level storage — or the
 * vault.
 *
 * `clearAll()` would take the vault's blobs with it, including the encrypted
 * recovery phrase. Worse than the loss is how it presents: the Keychain master
 * key survives, so `inspectVault()` sees a key and zero blobs and reports
 * `ready` — a clean, empty, working wallet — rather than the `key_lost` state
 * that exists precisely to say "your data is unrecoverable". The user is told
 * nothing went wrong.
 *
 * Use `destroyVault()` to remove a wallet deliberately; that clears the key too,
 * so the states stay consistent.
 */
export function clearHlStorage(): void {
  const storage = getStorage();
  for (const key of storage.getAllKeys()) {
    if (key.startsWith(VAULT_KEY_PREFIX)) continue;
    storage.remove(key);
  }
}
