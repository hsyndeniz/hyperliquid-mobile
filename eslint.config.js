const expoConfig = require("eslint-config-expo/flat");

module.exports = [
  ...expoConfig,
  {
    ignores: ["dist/*", ".expo/*", "node_modules/*", "expo-env.d.ts", "uniwind-types.d.ts"],
  },
  {
    // Jest `setupFiles` run before any module interop, so they must be CommonJS
    // and therefore see Node globals like `__dirname` that the app never has.
    files: ["src/hyperliquid/__e2e__/*.js", "jest.config.js", "jest.e2e.config.js"],
    languageOptions: {
      globals: { __dirname: "readonly", module: "writable", require: "readonly" },
    },
  },
];
