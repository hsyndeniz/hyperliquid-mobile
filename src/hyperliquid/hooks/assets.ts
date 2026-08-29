/**
 * The symbol → asset-id table, as a screen needs it.
 *
 * Any screen that cancels, closes or places anything needs `{ assetId,
 * szDecimals, marketType }` for a coin, and the only way to get it is a
 * `SymbolConverter` built from live metadata. That build is expensive and
 * shared, so it lives here once rather than in a ref per screen.
 *
 * ## Two traps, both already paid for
 *
 * - **`dexs` is left off deliberately.** `SymbolConverter.create({ dexs: true })`
 *   loads metadata for every HIP-3 builder dex on the network, which on testnet
 *   was heavy enough to 429 the account before a single order was placed. A
 *   screen trading a builder dex must name it (`dexs: ["xyz"]`) rather than
 *   asking for all of them.
 * - **A failed build must not be cached.** Caching the rejected promise makes
 *   every later attempt replay the same rejection, so the screen can never
 *   recover without a reload.
 *
 * This is a module-level cache, not a store: the table is the exchange's, not
 * an account's, and it does not change while the app is open.
 */

import { useCallback } from "react";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";

import { getHttpTransport } from "@/hyperliquid/api/clients";
import { wrapSymbolConverter, type AssetIndex } from "@/hyperliquid/core/assetIds";

let building: Promise<SymbolConverter> | null = null;

/**
 * The asset table, built once.
 *
 * Exported as a plain async function as well as a hook: actions run from event
 * handlers, where a promise is more useful than a rendered value.
 */
export async function assetIndex(): Promise<AssetIndex> {
  building ??= SymbolConverter.create({ transport: getHttpTransport() });
  try {
    return wrapSymbolConverter(await building);
  } catch (error) {
    // Not cached — see the header. The next call rebuilds.
    building = null;
    throw error;
  }
}

/** The same table, as a stable callback for components. */
export function useAssetIndex(): () => Promise<AssetIndex> {
  return useCallback(() => assetIndex(), []);
}
