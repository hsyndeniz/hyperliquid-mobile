/**
 * One headliner in the home strip: badge + symbol, a role caption ("Top
 * volume" / "Top gainer" / "Top loser"), the price, the 24h change, and a
 * STATIC sparkline of the last 24 hourly closes.
 *
 * `static` is livechart's sparkline mode — no animation loop, so a strip of
 * these costs nearly nothing at rest (their documented pattern for lists).
 * The line takes the change's colour: green rising, red falling, muted when
 * the change is unknowable. A missing sparkline renders as an empty gap, not
 * a notice — the price and change ARE the information; the line is garnish
 * (`useSparkline` documents the same rule from the data side).
 *
 * The whole card is one Pressable into the market's detail; everything inside
 * is touch-inert for the same two reasons as `MarketListRow`'s chips (the Chip
 * Pressable and the AX element both steal the tap).
 *
 * ## The surface is LIQUID GLASS where the OS offers it
 *
 * The card body is a `LiquidGlassView` (iOS 26's material, via
 * @callstack/liquid-glass) — this strip is the trial surface for the
 * material: the most visible card in the app, three instances side by side,
 * nothing money-path about it. `interactive` gives the native press shimmer,
 * which is honest here because the card IS a button. Where the effect is
 * unsupported (Android, iOS < 26) `isLiquidGlassSupported` is false and the
 * card keeps its old `bg-surface` skin — the constant is compile-time-ish
 * per platform, so the branch costs nothing at render. The sparkline's own
 * background goes transparent under glass: an opaque patch inside the
 * material would read as a hole punched in it.
 *
 * `tintColor` is load-bearing, not decoration. The material refracts what is
 * BEHIND it, and behind this strip is the flat page background — untinted
 * glass over a featureless field renders as a murky grey card with an uneven
 * sheen (observed on device: the strip read dirtier than the plain
 * `bg-surface` cards it replaced). Tinting toward the surface colour at ~half
 * alpha lifts the card back to the app's crisp white/dark card language while
 * keeping the press shimmer. The values are rgba literals rather than theme
 * tokens because the tint NEEDS an alpha channel and the tokens carry none;
 * the unsupported branch stays fully token-driven. The sparkline's `gradient`
 * wash is also glass-off: a translucent colour field floating on translucent
 * material reads as a stain, not a fill.
 *
 * `effect="clear"` rather than `"regular"`, and that choice is measured, not
 * taste: regular's material paints a dimming fringe onto the backdrop just
 * OUTSIDE the view's bounds, and between two adjacent cards the fringes
 * overlapped and painted the 12pt gaps a visibly darker grey than the page
 * (229 vs 245; the strip's `LiquidGlassContainerView` unions them to one
 * fringe, 236, still visible). Clear has no dimming ring — with it the gaps
 * measure exactly the page colour — and the tint above carries the surface
 * that regular's material would otherwise have provided.
 *
 * ## Accessibility
 *
 * The touch-inertness and the AX-hiding used to be the same wrapper, which
 * left the card contributing ZERO accessibility elements — badge, role, symbol,
 * price and change all hidden at once. `MarketListRow` applies the two AX props
 * only to its sparkline and price column, leaving symbol and subtitle readable;
 * here the hide had been hoisted above everything.
 *
 * The price is deliberately still not exposed as rendered: `FlashPrice` draws a
 * NumberFlow digit strip that carries EVERY digit 0-9 per slot, so reading it
 * aloud produces "nine zero one two three…" rather than a number — which is why
 * the sibling row hides its price column too. Instead the identity group
 * becomes one labelled element carrying the whole card's information as text.
 */

import type { JSX } from "react";
import { useEffect } from "react";
import { Pressable, useColorScheme, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { Typography, useThemeColor } from "heroui-native";
import { TrendChip } from "heroui-native-pro";
import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import { LiveChart, type LiveChartPoint } from "react-native-livechart";

import { glassScheme, glassSurfaceTint } from "@/components/common/glass";
import { SPARK_WINDOW_SECONDS, toSparkPoints } from "@/components/markets/detailView";
import { FlashPrice } from "@/components/markets/FlashPrice";
import { changeTrend, formatChangePct } from "@/components/markets/marketsView";
import { CoinBadge } from "@/components/portfolio/primitives";
import { useMid, useSparkline } from "@/hyperliquid/hooks/markets";
import { change24hPct, type MarketRow } from "@/hyperliquid/markets/rows";

export function MarketHighlightCard({
  row,
  role,
  onPress,
}: {
  row: MarketRow;
  /** "Top volume" / "Top gainer" / "Top loser" — why this card is here. */
  role: string;
  onPress: () => void;
}): JSX.Element {
  const colorScheme = useColorScheme();
  const mid = useMid(row.wireCoin);
  const px = mid ?? row.px;
  const closes = useSparkline(row.wireCoin);

  const trend = changeTrend(px, row.prevDayPx);
  const pct = change24hPct(px, row.prevDayPx);

  const successColor = useThemeColor("success");
  const dangerColor = useThemeColor("danger");
  const mutedColor = useThemeColor("muted");
  const surface = useThemeColor("surface");
  const accent = trend === "up" ? successColor : trend === "down" ? dangerColor : mutedColor;

  // SharedValues because that is livechart's contract even in static mode;
  // written in an effect via `.modify` (never reassigned) per its docs.
  const sparkData = useSharedValue<LiveChartPoint[]>([]);
  const sparkValue = useSharedValue(0);
  const points = closes === null ? null : toSparkPoints(closes);
  // `nowOverride` is a plain number (the dataset's own end, not the wall
  // clock) — only the series and its tip cross over as SharedValues.
  const lastPoint = points?.at(-1) ?? null;
  useEffect(() => {
    if (points === null || lastPoint === null) return;
    sparkData.modify((arr) => {
      "worklet";
      arr.length = 0;
      for (const point of points) arr.push(point);
      return arr;
    });
    sparkValue.set(lastPoint.value);
    // The points array is derived state; the closes reference is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closes, sparkData, sparkValue]);

  return (
    <Pressable
      // `accessible={false}` is the app-wide posture for a tappable row (vaults,
      // portfolio and trade all do it) and is left alone; what changed is that
      // the card's CONTENT is no longer hidden along with it.
      accessible={false}
      className={`w-44 rounded-2xl ${isLiquidGlassSupported ? "" : "bg-surface"}`}
      onPress={onPress}
    >
      <LiquidGlassView
        interactive
        effect="clear"
        // Surface-toward tint with alpha — see the header note on why untinted
        // glass reads as a dirty grey card over the flat page background.
        tintColor={glassSurfaceTint(glassScheme(colorScheme))}
        colorScheme={glassScheme(colorScheme)}
        style={{ borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 }}
      >
        <View className="gap-2 pointer-events-none" pointerEvents="none">
          <View
            className="flex-row items-center gap-2"
            // One element for the whole card, spoken as text. The visible price
            // and chip stay hidden below (digit strips and a tap-stealing Chip),
            // so this label is the only place the numbers are announced.
            accessible
            accessibilityLabel={`${role}: ${row.symbol}, ${px ?? "price unavailable"}, ${
              pct === null ? "change unknown" : formatChangePct(pct)
            }`}
          >
            <CoinBadge
              coin={row.kind === "prediction" ? row.wireCoin : row.symbol}
              monogram={row.kind === "prediction" ? row.symbol : undefined}
            />
            <View className="flex-shrink">
              <Typography.Paragraph className="text-xs text-muted font-normal">
                {role}
              </Typography.Paragraph>
              <Typography.Paragraph className="font-semibold leading-5" numberOfLines={1}>
                {row.symbol}
              </Typography.Paragraph>
            </View>
          </View>

          {/* Static sparkline: no loop, no chrome — the strip stays cheap. An
            unavailable one is an honest empty gap of the same height. Hidden
            from AX like the sibling row's: a line has nothing to say aloud. */}
          <View
            className="h-12"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {lastPoint !== null ? (
              <LiveChart
                static
                theme={colorScheme === "light" ? "light" : "dark"}
                data={sparkData}
                value={sparkValue}
                nowOverride={lastPoint.time}
                timeWindow={SPARK_WINDOW_SECONDS}
                accentColor={accent}
                badge={false}
                yAxis={false}
                xAxis={false}
                pulse={true}
                dot={true}
                scrub={false}
                style={{ backgroundColor: isLiquidGlassSupported ? "transparent" : surface }}
                gradient={!isLiquidGlassSupported}
              />
            ) : null}
          </View>

          {/* Hidden for two distinct reasons, both of them the sibling row's:
            the TrendChip's AX element swallows synthesized taps, and
            `FlashPrice`'s digit strips read as a run of every digit rather than
            a price. Both values are in the label above instead. */}
          <View
            className="flex-row items-center justify-between gap-2"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <FlashPrice value={px} asProbability={row.kind === "prediction"} />
            {pct === null ? (
              <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
                --
              </Typography.Paragraph>
            ) : (
              <TrendChip size="sm" variant="soft" trend={trend ?? "neutral"}>
                <TrendChip.Value className="font-medium">{formatChangePct(pct)}</TrendChip.Value>
              </TrendChip>
            )}
          </View>
        </View>
      </LiquidGlassView>
    </Pressable>
  );
}
