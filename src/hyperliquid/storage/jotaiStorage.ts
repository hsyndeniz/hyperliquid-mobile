/**
 * Jotai persistence over MMKV.
 *
 * Because MMKV is synchronous, atoms built on this stay synchronous — unlike
 * the AsyncStorage path in jotai's docs, where every atom value becomes a
 * promise and updates must await the previous value. That matters at tick
 * rates and removes a whole class of await-the-previous-value bugs.
 */

import { atomWithStorage, createJSONStorage } from "jotai/utils";
import type { WritableAtom } from "jotai";

import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

/** JSON-serialising storage backed by the Hyperliquid MMKV instance. */
export const hlJsonStorage = createJSONStorage<unknown>(() => hlStringStorage);

/**
 * A persisted atom.
 *
 * `getOnInit: true` is deliberate. The default (`false`) renders `initialValue`
 * first and swaps the stored value in afterwards — a visible flash on cold
 * start, and a hazard for anything gating a trading action on persisted state.
 *
 * Pass a `validate` predicate for anything that feeds a trading path: a
 * schema-drifted or hand-edited MMKV entry must not become live state.
 */
export function persistedAtom<Value>(
  key: string,
  initialValue: Value,
  options?: { validate?: (value: unknown) => value is Value }
): WritableAtom<Value, [Value | ((prev: Value) => Value)], void> {
  const storage = createJSONStorage<Value>(() => hlStringStorage);

  const guarded = options?.validate
    ? {
        ...storage,
        getItem: (itemKey: string, fallback: Value): Value => {
          const stored = storage.getItem(itemKey, fallback);
          // Storage is synchronous here, so this is a value, not a promise.
          return options.validate!(stored) ? stored : fallback;
        },
      }
    : storage;

  return atomWithStorage<Value>(key, initialValue, guarded, {
    getOnInit: true,
  }) as WritableAtom<Value, [Value | ((prev: Value) => Value)], void>;
}

/**
 * Namespaced key builder.
 *
 * Keys are prefixed so a wipe of Hyperliquid state is a prefix scan, and so
 * they cannot collide with anything else sharing the instance.
 */
export function hlKey(...parts: string[]): string {
  return ["hl", ...parts].join(":");
}
