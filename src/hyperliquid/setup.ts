/**
 * Hyperliquid module bootstrap.
 *
 * Imported once at app entry. Keep it side-effect-light: it must not open a
 * websocket or touch the network — those are created on first use.
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "react-native-quick-crypto";

import { registerClockStorage } from "@/hyperliquid/core/clock";
import { addLogSink, createConsoleSink, log } from "@/hyperliquid/core/logger";
import { createSentrySink, type SentryApi } from "@/hyperliquid/core/sentrySink";
import { registerNativePbkdf2 } from "@/hyperliquid/wallet/mnemonic";
import { registerVaultCrypto } from "@/hyperliquid/wallet/vault";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";

let started = false;

export interface SetupOptions {
  /**
   * The Sentry SDK, injected rather than imported.
   *
   * `@sentry/react-native` is a native module, and importing it inside the
   * module would put it in the path of `moduleImports.test.ts` — the same
   * hazard MMKV needs a mock for. The app passes it from `_layout.tsx`, where
   * `Sentry.init` has already run.
   *
   * Omit it and the module simply has no remote sink; nothing throws.
   */
  sentry?: SentryApi;
}

/**
 * Wire up the module.
 *
 * Without a sink the logger silently discards every event. That was the state of
 * every **release** build until this took an options bag: the console sink is
 * registered only under `__DEV__`, so a shipped app produced no diagnostics at
 * all — the one build where a log is the only way to find out what happened.
 */
export function setupHyperliquid(options: SetupOptions = {}): void {
  if (started) return;
  started = true;

  if (__DEV__) {
    addLogSink(createConsoleSink());
  }

  // Unconditional, unlike the console sink. This is the one that survives into
  // a release build.
  if (options.sentry) {
    addLogSink(createSentrySink(options.sentry));
  }

  // Hand the wallet layer the native PBKDF2. Without this it silently falls
  // back to pure JS, which is correct but runs BIP39's 2048 iterations on the
  // JS thread — measured by the vendor at ~1500 ms on older Android against
  // ~20 ms native. `install()` in `polyfills.ts` does NOT cover this: it
  // assigns `global.crypto`, and `@scure/bip39` never reads it.
  registerNativePbkdf2(pbkdf2 as unknown as Parameters<typeof registerNativePbkdf2>[0]);

  // The vault's AES-256-GCM backend. Without it the vault refuses to operate
  // rather than falling back to anything weaker — storing a recovery phrase in
  // plaintext is not a degraded mode worth having.
  registerVaultCrypto({
    randomBytes,
    createCipheriv,
    createDecipheriv,
  } as unknown as Parameters<typeof registerVaultCrypto>[0]);

  // The clock's persistence, injected for the same reason the Sentry SDK is:
  // a static import inside `core/clock` puts react-native in the path of every
  // module that transitively imports it — which is nearly all of them — and
  // that is what killed the smoke scripts. Without this the offset is still
  // learned from the feed within seconds; it just loses its head start.
  registerClockStorage(hlStringStorage);

  log.info("module.ready");
}
