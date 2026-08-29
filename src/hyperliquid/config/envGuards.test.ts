/**
 * Structural guard on the environment files.
 *
 * `EXPO_PUBLIC_` is not a naming convention — it is the contract Expo's tooling
 * uses to decide a value is publishable. Two mechanisms act on it, and only one
 * needs a source reference:
 *
 * - **Production:** `babel-preset-expo`'s `inline-env-vars` replaces any
 *   referenced `process.env.EXPO_PUBLIC_*` with a string literal in the bundle.
 * - **Development:** `@expo/metro-config`'s environment-variable serializer
 *   enumerates *every* `EXPO_PUBLIC_`-prefixed variable and writes it into the
 *   prelude of every dev bundle — **no source reference required**. Metro's dev
 *   server binds the LAN, so that bundle is retrievable by anything on the same
 *   network.
 *
 * A 32-byte hex value under that prefix is therefore key material being served,
 * whether or not any code reads it. This caught exactly that: an
 * `EXPO_PUBLIC_PRIVATE_KEY` sitting one line above the correctly-named
 * `HL_TESTNET_SIGNER_KEY`, whose own comment explains why the prefix must never
 * be used for a key — the file asserted an invariant it then violated.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** Every `.ts`/`.tsx` under the given roots. */
function sourceFilesFor(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

const ROOT = join(__dirname, "..", "..", "..");

/**
 * 32 bytes of hex — a secp256k1 private key, an agent key, or an AES key.
 *
 * The `0x` is OPTIONAL, and that is the point: several wallet UIs export a
 * private key bare, and requiring the prefix meant a developer pasting
 * `EXPO_PUBLIC_SIGNER=b3ee58…55ce` for a quick device test passed every guard
 * here while the dev serializer wrote the key into the prelude of every bundle
 * Metro served on the LAN. Matching only the decorated spelling is the exact
 * bare-form-versus-composite hole this project has been bitten by before.
 */
const KEY_MATERIAL = /^(0x)?[0-9a-fA-F]{64}$/;
/** A BIP39 phrase is 12 or 24 lowercase words. */
const MNEMONIC_SHAPED = /^([a-z]+\s+){11,23}[a-z]+$/;

function envEntries(file: string): { name: string; value: string; line: number }[] {
  const path = join(ROOT, file);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .map((raw, index) => ({ raw: raw.trim(), line: index + 1 }))
    .filter(({ raw }) => raw.length > 0 && !raw.startsWith("#") && raw.includes("="))
    .map(({ raw, line }) => {
      const at = raw.indexOf("=");
      return {
        name: raw.slice(0, at).trim(),
        // Strip surrounding quotes; a quoted key is still a key.
        value: raw
          .slice(at + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
        line,
      };
    });
}

const FILES = [".env", ".env.example", ".env.local", ".env.development", ".env.production"];

describe("no secret sits under a publishable prefix", () => {
  it.each(FILES)("%s has no EXPO_PUBLIC_ key holding 32-byte hex", (file) => {
    const offenders = envEntries(file)
      .filter((entry) => entry.name.startsWith("EXPO_PUBLIC_"))
      .filter((entry) => KEY_MATERIAL.test(entry.value))
      // Never the value — naming it in a failure message would put the secret
      // in CI output, which is the problem, not the report.
      .map((entry) => `${file}:${entry.line} ${entry.name}`);

    expect(offenders).toEqual([]);
  });

  it.each(FILES)("%s has no EXPO_PUBLIC_ key holding a recovery phrase", (file) => {
    const offenders = envEntries(file)
      .filter((entry) => entry.name.startsWith("EXPO_PUBLIC_"))
      .filter((entry) => MNEMONIC_SHAPED.test(entry.value))
      .map((entry) => `${file}:${entry.line} ${entry.name}`);

    expect(offenders).toEqual([]);
  });

  it.each(FILES)("%s has no EXPO_PUBLIC_ key whose NAME suggests a secret", (file) => {
    // Catches an empty or placeholder value that would later be filled in with
    // a real one — the name is the design mistake, not just the current value.
    //
    // UNANCHORED, and with the bare words added. End-anchoring let every
    // composite through — `EXPO_PUBLIC_API_KEY_PROD`, `EXPO_PUBLIC_TOKEN_2`,
    // `EXPO_PUBLIC_SIGNER_KEY` — which is the same gap as the hex regex above:
    // a guard that recognises only the tidiest spelling of the thing it is
    // meant to catch.
    const suspicious = /(PRIVATE_KEY|SECRET|MNEMONIC|SEED|PASSPHRASE|API_KEY|TOKEN|SIGNER|_KEY)/;
    const offenders = envEntries(file)
      .filter((entry) => entry.name.startsWith("EXPO_PUBLIC_") && suspicious.test(entry.name))
      .map((entry) => `${file}:${entry.line} ${entry.name}`);

    expect(offenders).toEqual([]);
  });
});

/**
 * The guards, tested against the spellings they used to miss.
 *
 * A pattern-matching guard is only worth what it MATCHES, and both patterns
 * above were verified green against the repo's real `.env` while blind to the
 * shapes a developer is most likely to paste. Asserting on synthetic strings
 * is the only way to see that: the real files are (correctly) clean, so they
 * exercise nothing.
 */
describe("the guards catch the spellings they used to miss", () => {
  it("matches 32-byte hex with OR without the 0x prefix", () => {
    const bare = "b3ee58".padEnd(64, "a");
    expect(KEY_MATERIAL.test(bare)).toBe(true);
    expect(KEY_MATERIAL.test(`0x${bare}`)).toBe(true);
    // And still refuses things that merely look hex-ish, so it is not simply
    // always true: too short, too long, and not hex at all.
    expect(KEY_MATERIAL.test(bare.slice(0, 63))).toBe(false);
    expect(KEY_MATERIAL.test(`${bare}a`)).toBe(false);
    expect(KEY_MATERIAL.test("not-a-key")).toBe(false);
  });

  it("flags a suspicious name ANYWHERE in it, not only at the end", () => {
    const suspicious = /(PRIVATE_KEY|SECRET|MNEMONIC|SEED|PASSPHRASE|API_KEY|TOKEN|SIGNER|_KEY)/;
    for (const name of [
      "EXPO_PUBLIC_API_KEY_PROD",
      "EXPO_PUBLIC_TOKEN_2",
      "EXPO_PUBLIC_SIGNER_KEY",
      "EXPO_PUBLIC_SIGNER",
      "EXPO_PUBLIC_SEED_PHRASE_BACKUP",
      "EXPO_PUBLIC_PRIVATE_KEY",
    ]) {
      expect(suspicious.test(name)).toBe(true);
    }
    // The names this project actually publishes must NOT trip it, or the guard
    // becomes noise someone silences.
    for (const name of [
      "EXPO_PUBLIC_HL_ENV",
      "EXPO_PUBLIC_HL_BUILDER_ADDRESS",
      "EXPO_PUBLIC_HL_MAX_BUILDER_FEE",
      "EXPO_PUBLIC_HL_REFERRAL_CODE",
    ]) {
      expect(suspicious.test(name)).toBe(false);
    }
  });
});

describe("the example file carries no real values", () => {
  it(".env.example has no key material at all, publishable or not", () => {
    // It is committed, so anything real in it is public permanently.
    const offenders = envEntries(".env.example")
      .filter((entry) => KEY_MATERIAL.test(entry.value) || MNEMONIC_SHAPED.test(entry.value))
      .map((entry) => `.env.example:${entry.line} ${entry.name}`);

    expect(offenders).toEqual([]);
  });
});

describe("no key from .env appears in the SOURCE", () => {
  /**
   * The check that would have caught a live signing key sitting in two test
   * files and 83 commits of history.
   *
   * `.env` is correctly gitignored and was never committed — but the value of
   * `HL_TESTNET_SIGNER_KEY` had been pasted into `wallet/accounts.test.ts` and
   * `wallet/wallet.test.ts` as a convenient valid key, which put the signer for
   * the testnet account (and its funds, vault position and open orders) into
   * the repository itself. That is invisible while the repo is private and
   * published the moment it is not.
   *
   * Compares against whatever `.env` holds right now rather than a literal, so
   * it keeps working after a rotation and never itself contains a secret.
   */
  it("no .env secret value is hardcoded anywhere under src/ or scripts/", () => {
    const secrets = envEntries(".env")
      .filter((entry) => !entry.name.startsWith("EXPO_PUBLIC_"))
      .map((entry) => entry.value)
      // Short or empty values would match half the codebase by accident.
      .filter((value) => value.length >= 20);

    if (secrets.length === 0) return; // No .env here (CI); nothing to compare.

    const offenders: string[] = [];
    for (const file of sourceFilesFor([join(ROOT, "src"), join(ROOT, "scripts")])) {
      const text = readFileSync(file, "utf8");
      for (const secret of secrets) {
        // Both spellings: a key is just as leaked without its 0x prefix.
        const bare = secret.replace(/^0x/i, "");
        if (text.includes(secret) || text.includes(bare)) {
          // The FILE, never the value — naming it would put the secret in CI output.
          offenders.push(file.replace(ROOT, ""));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the smoke signer key keeps its unpublishable name", () => {
  it("HL_TESTNET_SIGNER_KEY is not prefixed EXPO_PUBLIC_", () => {
    // The scripts read this name. Renaming it to the publishable prefix would
    // ship it, which is exactly the mistake this suite exists to prevent.
    const names = envEntries(".env").map((entry) => entry.name);
    expect(names).not.toContain("EXPO_PUBLIC_HL_TESTNET_SIGNER_KEY");
  });
});
