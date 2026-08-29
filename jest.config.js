/**
 * Jest config.
 *
 * `@nktkas/hyperliquid` is ESM-only, and so is the crypto stack it pulls in
 * (`@noble/hashes` and `@nktkas/rews` both declare `"type": "module"`). Every
 * one of them must be transformed or Jest throws "Cannot use import statement
 * outside a module" the first time a signing path is imported.
 *
 * Allowlisting only `@nktkas/hyperliquid` is not enough — the failure surfaces
 * one level deeper, in the transitive `@noble/hashes` import inside the SDK's
 * signing module, and stack traces point at sourcemapped `@nktkas/src/*.ts`
 * paths that do not exist on disk, which makes it easy to misdiagnose.
 *
 * `standard-navigation` is the same class: expo-router v6 is built on it (not
 * on `@react-navigation/native-stack`), it declares `"type": "module"`, and
 * any hook that imports `useFocusEffect` from `expo-router` pulls it in. Its
 * stack traces are sourcemapped to `expo-router/src/*.tsx` paths that are not
 * in the published package either.
 */
module.exports = {
  preset: "jest-expo",
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@nktkas/.*|@noble/.*|@scure/.*|viem|ox|@web3icons/.*|standard-navigation)",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
};
