/**
 * Load `.env` into `process.env` for the e2e run.
 *
 * Bun does this automatically for `bun run scripts/*.ts`, which is why the smoke
 * scripts never needed it — but Jest does not, so `HL_TESTNET_SIGNER_KEY` would
 * be undefined and every e2e test would skip for the wrong reason.
 *
 * Deliberately minimal and dependency-free: this parses `KEY=value`, ignores
 * comments and blank lines, strips one layer of quotes, and never overwrites a
 * variable already set in the environment (so `HL_E2E=1 bun run test:e2e` and CI
 * overrides both win).
 */
const { readFileSync, existsSync } = require("fs");
const { join } = require("path");

const ENV_PATH = join(__dirname, "..", "..", "..", ".env");

if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
