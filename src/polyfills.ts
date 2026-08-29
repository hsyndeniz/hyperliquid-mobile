/**
 * Crypto polyfills. MUST be imported before anything that signs.
 *
 * `install()` overrides `global.crypto` and `global.Buffer` with
 * react-native-quick-crypto's JSI-backed implementations. viem's signing path
 * (@noble/curves + @noble/hashes) needs `crypto.getRandomValues` to exist, and
 * key generation needs a real CSPRNG — Hermes provides neither on its own.
 *
 * This module has an import side effect and no exports on purpose: importing it
 * for its side effect is the whole contract. It is imported first in
 * `src/app/_layout.tsx`.
 *
 * react-native-quick-crypto is a Nitro module, so changes here require a native
 * rebuild (`bun run ios` / `bun run android`), not just a Metro reload.
 */
import { install } from "react-native-quick-crypto";

install();
