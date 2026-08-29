/**
 * A token's artwork, with its leverage worn on the corner.
 *
 * Two things move off the title line by doing this. The chip stops competing
 * with the symbol for width — the old row shrank long symbols to make room for
 * `40x` — and leverage becomes a property of the ASSET rather than another
 * word in a sentence, which is what it actually is.
 *
 * The chip is tinted with the token's own brand colour rather than a semantic
 * one. Leverage is not a status: `40x` is neither good nor bad, and painting it
 * `success`/`danger` would make the row claim something it does not mean. The
 * brand tint says "this belongs to that mark" and nothing more. Where a token
 * has no artwork to read a colour from, it falls back to the theme's neutral
 * chip rather than inventing a hue.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Chip } from "heroui-native";

import { CoinBadge } from "@/components/portfolio/primitives";
import { readableTextColor, tokenColor } from "@/theme/tokenColor";

export interface TokenMarkProps {
  /** Wire coin — the spelling both the artwork and the colour resolve from. */
  coin: string;
  monogram?: string;
  size?: number;
  /** e.g. `40x`. Omitted entirely when the market has no leverage. */
  badge?: string | null;
}

export function TokenMark({
  coin,
  monogram,
  size = 44,
  badge = null,
}: TokenMarkProps): JSX.Element {
  const brand = tokenColor(coin);

  return (
    // `overflow-visible` so the chip may sit proud of the artwork's box; the
    // parent lays out for `size` alone, which keeps the row's rhythm even
    // though the chip overhangs it.
    <View style={{ width: size, height: size }} className="overflow-visible">
      <CoinBadge coin={coin} monogram={monogram} size={size} />
      {badge === null ? null : (
        // Inert in BOTH trees, the four-prop treatment this repo documents on
        // every chip inside a pressable row: heroui's `Chip` renders its own
        // Pressable, which steals real-finger taps from the row, AND registers
        // an accessibility element that swallows synthesized ones. The row is
        // the tap target; this is a label.
        <View
          className="absolute pointer-events-none"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ top: -3, left: -6 }}
        >
          <Chip
            size="sm"
            // `primary`, not `soft`. A soft chip is TRANSLUCENT by design, and over
            // a dark token mark — ARB's black circle — it read as a grey smudge
            // with the artwork showing through. Branded chips paint their own
            // opaque fill over the top; the unbranded fallback needs the opaque
            // variant to look like the same component.
            variant="primary"
            style={brand === null ? undefined : { backgroundColor: brand }}
          >
            <Chip.Label
              className="font-bold"
              style={brand === null ? undefined : { color: readableTextColor(brand) }}
            >
              {badge}
            </Chip.Label>
          </Chip>
        </View>
      )}
    </View>
  );
}
