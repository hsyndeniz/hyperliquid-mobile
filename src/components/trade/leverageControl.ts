/**
 * The leverage/margin surface the screen hands down whole.
 *
 * The screen owns `useAssetLeverage` and passes this object to the ticket —
 * components never touch @/hyperliquid hooks themselves, so the acting
 * address, the weight budget, and the re-read logic live in exactly one
 * place. It sits in its own module because both the ticket and its two sheets
 * need the type, and neither should have to import the other to get it.
 */

import type { AssetLeverageView, LeverageResult } from "@/hyperliquid/hooks/leverage";

export interface LeverageControl {
  /** The server's CONFIRMED pair, or null before the first read lands. */
  value: AssetLeverageView | null;
  deferred: boolean;
  refresh: () => void;
  apply: (next: AssetLeverageView) => Promise<LeverageResult>;
  applying: boolean;
}
