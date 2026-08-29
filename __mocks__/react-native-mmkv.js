/**
 * In-memory MMKV for tests.
 *
 * `react-native-mmkv` initialises Nitro at import time, so merely importing
 * anything downstream of it needs the native runtime. Jest picks this file up
 * automatically for the `react-native-mmkv` module (root `__mocks__` applies to
 * node_modules packages without an explicit `jest.mock` call).
 *
 * It is a real key-value store rather than a set of no-op stubs, so storage
 * round-trips can be asserted for real.
 */

const stores = new Map();

function storeFor(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  return stores.get(id);
}

function createMMKV(configuration = {}) {
  const id = configuration.id ?? "mmkv.default";
  const store = storeFor(id);

  return {
    set(key, value) {
      store.set(key, value);
    },
    getString(key) {
      const value = store.get(key);
      return typeof value === "string" ? value : undefined;
    },
    getNumber(key) {
      const value = store.get(key);
      return typeof value === "number" ? value : undefined;
    },
    getBoolean(key) {
      const value = store.get(key);
      return typeof value === "boolean" ? value : undefined;
    },
    getBuffer(key) {
      const value = store.get(key);
      return value instanceof ArrayBuffer ? value : undefined;
    },
    contains(key) {
      return store.has(key);
    },
    // v4 names this `remove`, not `delete`.
    remove(key) {
      return store.delete(key);
    },
    getAllKeys() {
      return [...store.keys()];
    },
    clearAll() {
      store.clear();
    },
  };
}

/** Test helper: drop every instance's data between tests. */
function __resetAllMMKV() {
  stores.clear();
}

module.exports = { createMMKV, __resetAllMMKV };
