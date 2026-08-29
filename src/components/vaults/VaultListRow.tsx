/**
 * One directory entry as a card: monogram badge, verbatim name with its hazard
 * chips and a chevron; the approximate APR — qualified by the vault's age —
 * beside a static month sparkline; and the TVL figure.
 *
 * Three bands separated by SPACING, not rules. It used to carry two dashed
 * rules, which cost a rule plus an extra flex gap each and drew a line between
 * bands that a size change and a sparkline already separate. The bands differ
 * enough in weight and content to read apart on their own; the rules were
 * habit, and on a list of these they were the dominant texture on screen.
 *
 * The sparkline is **free**. `pnls` rides the directory blob that is already
 * downloaded and already outside the weight budget, so every vault gets a month
 * of shape at zero request cost — see `readPeriodPnl`. Its anatomy is
 * `MarketHighlightCard`'s proven one: livechart's `static` mode (no animation
 * loop, their documented pattern for lists), SharedValues written via `.modify`
 * worklets, `nowOverride` a plain number, all chrome off.
 *
 * Three non-negotiables carry over from `MarketListRow`:
 *
 * - Every chip sits in the four-attribute inert wrapper — heroui `Chip` renders
 *   an inner Pressable that steals finger taps AND registers an AX element that
 *   swallows synthesized ones. The APR/sparkline row wears the same wrapper,
 *   because a Skia canvas inside a Pressable is exactly the thing that eats the
 *   tap the whole card exists to receive.
 * - The title carries `leading-5` so its line box matches the 20px `sm` chip.
 * - The "shared name" chip is the impersonation defence's visible half: 222
 *   vaults share a normalised name, one of them a live HLP impostor one space
 *   apart.
 *
 * APR stays `≈` text and is never a TrendChip — the wire value is
 * `ApproximateNumber`, float-damaged upstream, so only display-leaf colouring
 * is allowed and it is never signed, summed or compared.
 *
 * Nothing here animates a digit: `NumberFlow` in a list row costs ~150
 * components per price (measured at 1.4 s commits), so the figures are plain
 * `Text`.
 */

import type { JSX } from "react";
import { useEffect } from "react";
import { Pressable, useColorScheme, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { Chip, Typography, useThemeColor } from "heroui-native";
import { ChevronRight, Landmark } from "lucide-react-native";
import { LiveChart, type LiveChartPoint } from "react-native-livechart";

import { TONE_TEXT } from "@/components/account/accountView";
import { compactUsd } from "@/components/portfolio/fetchedView";
import { CoinBadge } from "@/components/portfolio/primitives";
import {
  ageLabel,
  aprLabel,
  pnlSpark,
  pnlSparkAbsence,
  vaultMonogram,
  type PnlSpark,
} from "@/components/vaults/vaultsView";
import type { VaultSummary } from "@/hyperliquid/vaults/types";

/**
 * The sparkline slot, fixed so a drawn line and an honest empty gap occupy the
 * same space — a card that changes height depending on whether the vault traded
 * would make the list jump as it loads.
 */
const SPARK_WIDTH = 112;
const SPARK_HEIGHT = 48;

export function VaultListRow({
  vault,
  isAmbiguous,
  nowMs,
  onPress,
}: {
  vault: VaultSummary;
  /** The vault's name collides with another once whitespace is ignored. */
  isAmbiguous: boolean;
  /**
   * "Now", **floored to the day** by the caller. The age line is day-granular,
   * so a 15 s clock passed raw would re-render every card four times a minute
   * for a label that cannot change until midnight. Never `Date.now()` here.
   */
  nowMs: number;
  onPress: () => void;
}): JSX.Element {
  const apr = aprLabel(vault.apr);
  const spark = pnlSpark(vault.monthPnl);
  const absence = pnlSparkAbsence(vault.monthPnl);
  const age = ageLabel(vault.createdAtMs, nowMs);
  const mutedColor = useThemeColor("muted");

  return (
    <Pressable
      accessible={false}
      className="gap-3 rounded-2xl bg-surface px-4 py-3"
      onPress={onPress}
    >
      <View className="flex-row items-center gap-3">
        <CoinBadge coin={vault.name} monogram={vaultMonogram(vault.name)} />

        <View className="flex-1 flex-row items-stretch gap-2">
          <View className="justify-center flex-shrink">
            <Typography.Paragraph className="font-medium leading-5" numberOfLines={1}>
              {vault.name}
            </Typography.Paragraph>
          </View>
          {isAmbiguous ? (
            <View
              className="justify-center pointer-events-none"
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Chip size="sm" color="warning" variant="soft">
                <Chip.Label className="font-medium">shared name</Chip.Label>
              </Chip>
            </View>
          ) : null}
          {vault.relationship.kind === "parent" ? (
            <View
              className="justify-center pointer-events-none"
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Chip size="sm" variant="soft">
                <Chip.Label className="font-medium">parent</Chip.Label>
              </Chip>
            </View>
          ) : null}
        </View>

        <View
          className="pointer-events-none"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <ChevronRight size={18} color={mutedColor} />
        </View>
      </View>

      <View
        className="flex-row items-center justify-between gap-3 pointer-events-none"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View className="gap-0.5">
          {/* `text-xl`, not `text-2xl`. At 2xl the APR was the largest thing on
              the card — larger than the vault's own name, which is the identity
              you scan for. It is still the biggest number here, just no longer
              competing with the title. */}
          <Typography.Paragraph className={`text-xl tabular-nums font-bold ${TONE_TEXT[apr.tone]}`}>
            {apr.label}
          </Typography.Paragraph>
          {/* Age rides WITH the APR, because that is what it qualifies: a
              three-day-old vault showing 200% is noise, and the reader needs
              both figures in one glance to know which they are looking at. */}
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {age === null ? "APR" : `APR · ${age}`}
          </Typography.Paragraph>
        </View>

        <View style={{ width: SPARK_WIDTH, height: SPARK_HEIGHT }}>
          {/* `series` is redundant with `spark` for the reader but not for the
              type checker — and it must be the SAME reference the summary
              holds, never a `?? []` fallback that is fresh on every render. */}
          {spark !== null && vault.monthPnl !== null ? (
            <VaultSpark spark={spark} series={vault.monthPnl} />
          ) : (
            // The same gap, said out loud. A flat line drawn at mid-height
            // would read as "held steady" on a vault that did nothing at all.
            <View className="flex-1 items-end justify-center">
              <Typography.Paragraph className="text-xs text-muted font-normal">
                {absence}
              </Typography.Paragraph>
            </View>
          )}
        </View>
      </View>

      {/* Age is gone from here — see the APR block. It sat under this row as a
          second line, which put "1216 days old" directly beneath the words
          "Total value locked" and read as a caption of the TVL rather than a
          fact about the vault. */}
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2">
          <Landmark size={14} color={mutedColor} />
          <Typography.Paragraph className="text-sm text-muted font-normal">
            Total value locked
          </Typography.Paragraph>
        </View>
        <Typography.Paragraph className="text-sm tabular-nums font-semibold">
          {compactUsd(vault.tvl)}
        </Typography.Paragraph>
      </View>
    </Pressable>
  );
}

/**
 * The static month sparkline.
 *
 * Its own component so the SharedValues are allocated only for vaults that have
 * a line — 8 of the 18 recorded mainnet entries do not, and a list of 200 cards
 * should not pay for reanimated state it never writes.
 *
 * `dot` and `pulse` are OFF, unlike the markets strip. There they mark a live
 * mid arriving over a websocket; here the series is a once-a-day CDN snapshot,
 * and a heartbeat on it would claim a feed that does not exist.
 */
function VaultSpark({
  spark,
  /**
   * The wire series, passed only as the effect's identity. `spark` is derived
   * state rebuilt each render; `monthPnl` is the stable reference off the
   * parsed summary, so keying on it is what stops the worklet re-running on
   * every scroll frame.
   */
  series,
}: {
  spark: PnlSpark;
  series: readonly string[];
}): JSX.Element {
  const colorScheme = useColorScheme();
  const successColor = useThemeColor("success");
  const dangerColor = useThemeColor("danger");
  const mutedColor = useThemeColor("muted");
  const surface = useThemeColor("surface");
  const accent =
    spark.trend === "up" ? successColor : spark.trend === "down" ? dangerColor : mutedColor;

  // SharedValues because that is livechart's contract even in static mode;
  // written in an effect via `.modify` (never reassigned) per its docs.
  const data = useSharedValue<LiveChartPoint[]>([]);
  const value = useSharedValue(0);
  const tip = spark.points[spark.points.length - 1].value;
  useEffect(() => {
    data.modify((arr) => {
      "worklet";
      arr.length = 0;
      for (const point of spark.points) arr.push(point);
      return arr;
    });
    value.set(tip);
    // The points are derived state; the wire series is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, data, value]);

  return (
    <LiveChart
      static
      theme={colorScheme === "light" ? "light" : "dark"}
      data={data}
      value={value}
      // The dataset's own end plus a zero buffer: livechart's documented
      // historical-fill pattern, so the series spans the canvas edge to edge.
      nowOverride={spark.end}
      timeWindow={spark.window}
      windowBuffer={0}
      accentColor={accent}
      badge={false}
      yAxis={false}
      xAxis={false}
      pulse={false}
      dot={false}
      scrub={false}
      style={{ backgroundColor: surface }}
      gradient
    />
  );
}
