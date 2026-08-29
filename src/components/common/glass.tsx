/**
 * The app's Liquid Glass vocabulary — every glass surface draws its recipe
 * from here so the trial stays ONE material, not a drift of per-site tints.
 *
 * What the Markets-strip trial established (measured on device, 2026-08-29;
 * the long version lives on `MarketHighlightCard`):
 *
 * - `effect="clear"`, never `"regular"`: regular's material paints a dimming
 *   fringe onto the backdrop just outside the view's bounds, which reads as
 *   dirty grey channels between adjacent glass views on this app's flat
 *   pages. Clear has no dimming ring; the tint carries the surface instead.
 * - The tint is load-bearing: untinted glass over a featureless page renders
 *   as murk. Tints are rgba literals because they NEED an alpha channel and
 *   the theme tokens carry none — every non-glass fallback stays fully
 *   token-driven, so the literals never leak past `isLiquidGlassSupported`.
 * - Adjacent glass views must share one `LiquidGlassContainerView` (effects
 *   render in a single pass; per-view artifacts cannot stack across gaps).
 * - Glass goes on CONTROLS the user touches — a card that is a button, a
 *   CTA — never on content lists (a recycled row per effect view is a native
 *   view the list pays for on every recycle) and never nested inside a
 *   heroui `Card` (glass-on-surface doubles depth layers and the material
 *   has nothing behind it but the card).
 *
 * ## The vocabulary is deliberately COMPLETE at two surfaces
 *
 * A repo-wide survey (2026-08-29; 172 tappable/chrome surfaces inventoried,
 * three-judge panel) confirmed the full set: the Markets highlight strip
 * (surface tint) and `GlassCta` (accent tint) — plus the native tab bar,
 * which is the platform's own glass already. Everything else was skipped for
 * a reason that still holds: it is content, sits inside a heroui surface, is
 * a recycled row, is a money/security confirm, converts a stock heroui
 * component the plain-heroui rule protects, or belongs to a visual class
 * (filter pills, action tiles, vault cards) whose other members cannot take
 * glass — and same-looking elements wear ONE material. Stack headers were
 * tried and reverted (see `stackChrome.ts`). Before adding a glass surface,
 * check the new site against those tests rather than the other way round.
 */

import type { JSX } from "react";
import { Pressable, useColorScheme, View } from "react-native";
import { Button, Typography } from "heroui-native";
import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";

/** The scheme string the glass props want — RN's nullable scheme, pinned. */
export type GlassScheme = "light" | "dark";

export function glassScheme(scheme: ReturnType<typeof useColorScheme>): GlassScheme {
  return scheme === "light" ? "light" : "dark";
}

/**
 * Surface-toward tint for glass CARDS (the Markets strip): lifts the material
 * to the app's crisp white/dark card language at ~half alpha, keeping the
 * press shimmer and edge treatment visible.
 */
export function glassSurfaceTint(scheme: GlassScheme): string {
  return scheme === "light" ? "rgba(255, 255, 255, 0.55)" : "rgba(24, 24, 27, 0.5)";
}

/**
 * Accent-toward tint for glass CTAs — the glass twin of the primary Button.
 * Mirrors the theme's `--accent` per scheme (charcoal in light, near-white in
 * dark — the app's accent override in global.css), denser than the card tint
 * because a white/dark label must stay readable on it.
 */
export function glassAccentTint(scheme: GlassScheme): string {
  return scheme === "light" ? "rgba(43, 46, 49, 0.85)" : "rgba(249, 249, 250, 0.85)";
}

/**
 * A full-width primary CTA rendered as iOS 26 prominent glass, falling back
 * to the stock heroui `Button` everywhere else — same geometry either way
 * (Button md: 48pt tall, 24pt radius, 16pt inline padding, `--font-medium`
 * base-size label), so the two branches are indistinguishable in layout and
 * only the surface material differs. `text-accent-foreground` tracks the
 * tint automatically: the tint mirrors `--accent`, and that token's
 * foreground already flips per scheme.
 *
 * Deliberately NOT used on money confirms — hold-to-confirm surfaces keep
 * the app's boring, token-driven chrome.
 */
export function GlassCta({ label, onPress }: { label: string; onPress: () => void }): JSX.Element {
  const scheme = glassScheme(useColorScheme());

  if (!isLiquidGlassSupported) {
    return (
      <Button className="w-full" onPress={onPress}>
        <Button.Label className="font-medium">{label}</Button.Label>
      </Button>
    );
  }

  return (
    <Pressable
      className="w-full"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
    >
      <LiquidGlassView
        interactive
        effect="clear"
        tintColor={glassAccentTint(scheme)}
        colorScheme={scheme}
        style={{
          height: 48,
          borderRadius: 24,
          paddingHorizontal: 16,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View pointerEvents="none">
          <Typography.Paragraph className="text-base font-medium text-accent-foreground">
            {label}
          </Typography.Paragraph>
        </View>
      </LiquidGlassView>
    </Pressable>
  );
}
