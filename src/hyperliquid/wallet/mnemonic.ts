/**
 * Mnemonic generation and the seed derivation that follows it.
 *
 * The one performance decision in this module is load-bearing, so it is stated
 * plainly: **BIP39's mnemonic-to-seed step is PBKDF2-HMAC-SHA512 at 2048
 * iterations**, and doing it in JavaScript blocks the only thread the UI has.
 *
 * `react-native-quick-crypto`'s `install()` does **not** help with this. It
 * assigns `global.crypto` and `global.Buffer`, which is what viem's signing path
 * needs — but `@scure/bip39` calls `@noble/hashes`' own pure-JS PBKDF2 directly
 * and never looks at `global.crypto`. So `viem.mnemonicToAccount()` runs the
 * slow path no matter what the polyfill did.
 *
 * Measured: 34 ms on an M-series desktop, where PBKDF2 is roughly half the total
 * cost of `mnemonicToAccount`. Margelo measure the same operation at ~1500 ms on
 * older Android hardware and ~20 ms through the native binding. A second of
 * frozen UI on wallet import is the difference this module exists to avoid.
 *
 * Hence: the native `pbkdf2` when it is available, the pure-JS path when it is
 * not (tests, scripts, any non-RN runtime), and the same 64-byte seed either
 * way — asserted by a test that runs both and compares.
 */

import {
  generateMnemonic as scureGenerate,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
// The `.js` suffix is required: the package exports map names it that way and
// omitting it resolves under Metro but not under TypeScript or Jest.
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";

const logger = log.child("wallet.mnemonic");

/** BIP39 parameters. Fixed by the standard; not tunable. */
export const BIP39_ITERATIONS = 2048;
export const BIP39_SEED_BYTES = 64;
export const BIP39_DIGEST = "sha512";

/** 128 bits gives a 12-word phrase; 256 gives 24. */
export type MnemonicStrength = 128 | 256;

/**
 * The slice of `react-native-quick-crypto` this module needs.
 *
 * Injected rather than imported so the module stays testable off-device — the
 * real one is a Nitro binding that cannot load outside the app runtime.
 */
export interface NativePbkdf2 {
  (
    password: string,
    salt: string,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (error: Error | null, derived: Uint8Array) => void
  ): void;
}

let nativePbkdf2: NativePbkdf2 | null = null;

/**
 * Register the native implementation.
 *
 * Called once from the app bootstrap. Until it is, everything here still works
 * through the pure-JS path — slower, never wrong.
 */
export function registerNativePbkdf2(implementation: NativePbkdf2 | null): void {
  nativePbkdf2 = implementation;
  logger.info("mnemonic.pbkdf2_backend", { context: { native: implementation !== null } });
}

/** Whether the fast path is available. Exposed so a caller can warn before a slow import. */
export function hasNativePbkdf2(): boolean {
  return nativePbkdf2 !== null;
}

/**
 * A fresh mnemonic.
 *
 * Entropy comes from `@scure/bip39`, which reads `crypto.getRandomValues` — the
 * one thing `install()` *does* provide, and the reason the polyfill has to be
 * imported before anything that generates a key. On bare Hermes there is no
 * CSPRNG at all, and a mnemonic generated without one is not secret.
 */
export function generateMnemonic(strength: MnemonicStrength = 128): string {
  return scureGenerate(wordlist, strength);
}

/** Whether a phrase is a valid BIP39 mnemonic, checksum included. */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normaliseMnemonic(mnemonic), wordlist);
}

/**
 * Trim and collapse whitespace.
 *
 * Users paste mnemonics out of password managers and notes apps, which is a
 * reliable source of double spaces, newlines and a trailing space. The checksum
 * fails on any of them, and "invalid recovery phrase" for a phrase that is
 * actually correct is a bad way to lose someone their account.
 */
export function normaliseMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Mnemonic to seed, on the fastest available path.
 *
 * Async because the native binding is callback-based, and because a synchronous
 * API here would invite a caller to block the UI thread with the fallback.
 *
 * @throws {HlError} if the mnemonic fails BIP39 validation.
 */
export async function mnemonicToSeed(mnemonic: string, passphrase = ""): Promise<Uint8Array> {
  const phrase = normaliseMnemonic(mnemonic);
  if (!validateMnemonic(phrase, wordlist)) {
    throw new HlError("Recovery phrase is not a valid BIP39 mnemonic", {
      code: "validation_error",
      // Deliberately no context: nothing derived from the phrase may be logged.
    });
  }

  // BIP39 salt is the literal "mnemonic" concatenated with the passphrase.
  const salt = `mnemonic${passphrase}`;

  if (nativePbkdf2) {
    return new Promise<Uint8Array>((resolve, reject) => {
      nativePbkdf2!(
        phrase,
        salt,
        BIP39_ITERATIONS,
        BIP39_SEED_BYTES,
        BIP39_DIGEST,
        (error, derived) => {
          if (error) {
            reject(
              new HlError("Native key derivation failed", {
                code: "invalid_config",
                cause: error,
              })
            );
            return;
          }
          resolve(new Uint8Array(derived));
        }
      );
    });
  }

  // Pure JS. Correct, and slow enough to freeze a mid-range phone for about a
  // second — which is why `registerNativePbkdf2` exists.
  return mnemonicToSeedSync(phrase, passphrase);
}

/**
 * Word count for a strength, so a UI can say "12 words" without a magic number.
 */
export function wordCount(strength: MnemonicStrength): number {
  return strength === 128 ? 12 : 24;
}
