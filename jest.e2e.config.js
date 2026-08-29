/**
 * End-to-end config: the SAME modules as `bun run test`, but against the **live
 * Hyperliquid testnet**.
 *
 * Separate from `jest.config.js` for two reasons.
 *
 * 1. `bun run test` must stay fast and offline. Everything here talks to a real
 *    exchange over a real websocket, takes a minute, and can fail for reasons
 *    that are not this codebase's fault. Mixing the two would make the fast
 *    suite untrustworthy as a gate.
 * 2. **It deliberately does NOT use the `jest-expo` preset.** That preset exists
 *    to simulate React Native, and simulating React Native is exactly what
 *    breaks this: its setup installs RN's `whatwg-fetch` polyfill over Node's
 *    native `fetch`, and that polyfill needs an `XMLHttpRequest` which does not
 *    exist here. The symptom was a raw `fetch(...).then(r => r.text())`
 *    resolving to `undefined`, and the SDK failing with "Cannot read properties
 *    of undefined (reading 'slice')" in 87 ms — far too fast to have touched a
 *    network. Overriding `setupFiles` does not help: Jest **merges** that key
 *    with the preset's rather than replacing it, so RN's setup runs regardless.
 *
 * So this configures Babel directly and runs on plain Node, which has native
 * `fetch` and `WebSocket`. The only React Native left is the `__mocks__`
 * storage shims, which are plain JS and need no RN globals — and which are real
 * in-memory implementations rather than stubs. Everything else is production
 * code: the vault and its AES-GCM, the agent gate, the transports, the stores,
 * the order path.
 *
 * Test files are `*.e2e.ts`, which `jest.config.js` deliberately does not match.
 */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.[jt]sx?$": ["babel-jest", { presets: ["babel-preset-expo"] }],
  },
  // The same ESM allowlist the fast suite needs: `@nktkas/hyperliquid` and its
  // crypto stack are ESM-only, and the failure surfaces one level deep in a
  // transitive `@noble/hashes` import.
  // `expo` is in the list because `babel-preset-expo` rewrites `process.env`
  // access to a virtual ESM module (`expo/virtual/env`); leaving it untransformed
  // fails with "Unexpected token 'export'" the moment `config/env.ts` loads.
  transformIgnorePatterns: [
    "node_modules/(?!(expo|@expo/.*|@nktkas/.*|@noble/.*|@scure/.*|viem|ox))",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testMatch: ["**/*.e2e.ts"],
  setupFiles: ["<rootDir>/src/hyperliquid/__e2e__/loadEnv.js"],
  // `__DEV__` comes from RN's setup, which is not running here.
  globals: { __DEV__: true },
  // A websocket round-trip plus an order placement is not a two-second test.
  testTimeout: 120_000,
  // One at a time: these share one testnet account, one action budget and one
  // agent allowance, so parallel files would race each other.
  maxWorkers: 1,
};
