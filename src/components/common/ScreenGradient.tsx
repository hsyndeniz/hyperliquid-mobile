/**
 * The soft wash behind a tab screen.
 *
 * A Skia `LinearGradient` over the theme background, painted absolutely at the
 * back of a screen so everything else draws on top of it.
 *
 * ## It TINTS, it does not replace
 *
 * The stops end at zero alpha and the screen keeps its `bg-background` class,
 * so this can only ever add a wash over whatever the theme already paints.
 * That is deliberate: the background token is `oklch()` in `global.css`, Skia
 * parses hex/rgb and not `oklch`, and `useThemeColor` hands back whatever
 * uniwind resolved. Painting opaque stops here would mean hard-coding a copy
 * of the background colour that drifts the day the token changes — and drifts
 * invisibly, because a background that is *nearly* right looks fine until you
 * put it beside the real one. Translucent stops cannot drift; they tint
 * whatever is underneath.
 *
 * Scheme-keyed constants rather than theme tokens, for the same reason
 * `glass.tsx` keys its tints that way: these are alpha washes, not semantic
 * colours, and there is no token that means "a whisper of light from the top".
 *
 * ## Cost
 *
 * One static gradient rect per mounted tab. Its props are the window size and
 * the scheme, both stable, so it renders once and then never again — which
 * matters here more than usual, because the native tab host keeps every
 * visited tab mounted and re-rendering (see the freeze note in the tabs
 * layout). A flat gradient is not the SVG-filter trap either: no offscreen
 * buffer, no per-frame rasterisation.
 */

import type { JSX } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import { Canvas, LinearGradient, Rect, vec } from "@shopify/react-native-skia";
import { useUniwind } from "uniwind";

/**
 * Light above, the theme's own background through the middle, a cool deepening
 * below.
 *
 * **Three stops, and the middle one is why.** With only two — white at the top
 * fading into slate at the bottom — Skia interpolates BOTH the colour and the
 * alpha, so halfway down you get the slate at ~50% alpha: the muddiest point
 * of the gradient lands in the middle of the screen, where the content is.
 * Dropping the bottom stop's alpha barely moved it (measured: 209 → 209),
 * because the midpoint is set by the interpolation, not by the end.
 *
 * So the middle stop is fully transparent. Each half now fades a single colour
 * in and out against the untouched background, the page reads as lit from
 * above and grounded below, and nowhere does a colour appear that neither end
 * asked for.
 *
 * ## The two themes are not mirror images, and cannot be
 *
 * **They have their headroom in opposite places.** Dark's background is
 * `rgb(10,11,12)`, so it has almost nothing below it and plenty above: its
 * range is the top lift, 28 levels with a blue cast, and its bottom stop is
 * very nearly a no-op. Light's is `rgb(244,245,247)` — eleven levels short of
 * white — so lifting is the half that cannot work, and everything it has is
 * below.
 *
 * Tuned symmetrically, that asymmetry is exactly what went wrong: dark read
 * well and light looked flat, because light was spending its budget on the
 * eleven levels it had rather than the range it could reach going the other
 * way. So light hands the top lift a narrow band (nearly invisible either way)
 * and gives the deepening most of the screen, while dark keeps the balanced
 * split.
 *
 * **And light changes TEMPERATURE where dark changes brightness.** That is the
 * other half of why a symmetric tuning failed, and it took three passes to see
 * it. Dark's lift is chromatic against near-black, so it reads as *light*. Any
 * bottom stop darker than a pale page, however, reads as a *shadow* — and
 * chasing that with lower and lower alpha only trades the shadow for nothing
 * at all, which is the loop the first three attempts were stuck in.
 *
 * The way out is a tint whose luminance already MATCHES the background, so
 * blending it changes hue and nothing else. `rgb(232,246,255)` at 0.7 lands on
 * `rgb(236,246,253)`: the blue cast goes `+3 → +17` while luminance moves by
 * one level. The page cools toward the bottom instead of dimming, and there is
 * no shadow to see because nothing got darker.
 *
 * Measured on device down the MIDDLE of the Account screen, which is the only
 * place with tall bands of untouched background — the list screens' margins
 * pick up coin badges, and the phone's corner radius poisons anything within a
 * few points of an edge. Light holds its brightness the whole way down
 * (luminance `251 → 245 → 245 → 243` against a base of 245) while the blue
 * cast climbs `+1 → +9 → +12 → +14`: it cools without ever dimming. Dark lifts
 * and settles: `38 → 28 → 17 → 13`.
 *
 * The first cut of this component lifted the top by six levels out of 255 and
 * was invisible — measuring "a gradient is present" is not the same as seeing
 * one, and the eye is the instrument that matters here. The second was visible
 * in dark and flat in light, for the headroom reason above; both were caught
 * by looking, not by the numbers.
 */
const LIGHT = {
  colors: ["rgba(255, 255, 255, 1)", "rgba(255, 255, 255, 0)", "rgba(232, 246, 255, 0.7)"],
  positions: [0, 0.3, 1],
};

const DARK = {
  colors: ["rgba(160, 180, 225, 0.2)", "rgba(160, 180, 225, 0)", "rgba(0, 0, 0, 0.35)"],
  positions: [0, 0.45, 1],
};

/**
 * The gradient runs the WHOLE height. Fading out partway meant the lower half
 * was flat, so the only place it could be seen was the one place a floating
 * header already covered.
 */
const FADE_FRACTION = 1;

/** A gentle diagonal: enough to feel like a direction, not a stripe. */
const DIAGONAL_FRACTION = 0.35;

export function ScreenGradient(): JSX.Element {
  // `useUniwind()`, NOT `useColorScheme()`. Uniwind paints the app's theme;
  // React Native's `Appearance` — which `useColorScheme` reads — is a separate
  // system that this app has measured going out of sync with it (see the
  // "Two systems have to agree" note in `account/appearance.ts`). Built on
  // `useColorScheme` this component painted the LIGHT wash over the dark
  // theme: measured rgb(128,129,129) at the top of a dark Markets tab where
  // the background is rgb(10,11,12).
  const { theme } = useUniwind();
  const { width, height } = useWindowDimensions();
  const stops = theme === "dark" ? DARK : LIGHT;

  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Rect x={0} y={0} width={width} height={height}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(width * DIAGONAL_FRACTION, height * FADE_FRACTION)}
          colors={stops.colors}
          positions={stops.positions}
        />
      </Rect>
    </Canvas>
  );
}
