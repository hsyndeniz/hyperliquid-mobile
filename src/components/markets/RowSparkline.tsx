/**
 * The 24-hour shape for one market row.
 *
 * A native SVG polyline — see `sparkPath.ts` for why a list row does not get
 * the Skia chart the highlight cards use.
 *
 * The slot is a FIXED box that renders even when there is no line. Rows fill
 * in as their dwell requests land, and a slot that appeared with the data
 * would shove the price column sideways on every arrival; an empty slot that
 * fills is calm, and it keeps every price in the list on one right edge.
 *
 * Colour follows `sparkTrend` — first close against last, the same comparison
 * the row's 24h chip makes, so the line and the chip can never disagree.
 */

import type { JSX } from "react";
import { useId } from "react";
import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Polyline, Stop } from "react-native-svg";
import { useThemeColor } from "heroui-native";

import { sparkArea, sparkPath, sparkTrend, type SparkPoints } from "@/components/markets/sparkPath";

/** Sized to sit between the metrics column and the price without crowding. */
export const SPARK_ROW_WIDTH = 56;
export const SPARK_ROW_HEIGHT = 24;

export function RowSparkline({
  points,
  /**
   * The asset's brand colour, when it has one.
   *
   * Preferred over the trend colour because the row already says up-or-down
   * twice — in the change chip and in the price's flash — and a third copy adds
   * nothing. What the line CAN add is identity: orange reads as Bitcoin before
   * the letters do. Falls back to the trend colour where no artwork exists, so
   * a row is never left with an arbitrary line.
   */
  color = null,
}: {
  points: SparkPoints | null;
  color?: string | null;
}): JSX.Element {
  const [success, danger, muted] = useThemeColor(["success", "danger", "muted"]);
  // Gradient ids share one SVG namespace, and FlashList RECYCLES these rows —
  // a fixed id would make every line reuse whichever row mounted first.
  const gradientId = `spark-${useId()}`;

  const path = sparkPath(points, SPARK_ROW_WIDTH, SPARK_ROW_HEIGHT);
  const area = sparkArea(path, SPARK_ROW_WIDTH, SPARK_ROW_HEIGHT);
  const trend = sparkTrend(points);
  const stroke = color ?? (trend === "up" ? success : trend === "down" ? danger : muted);
  const last = path?.slice(path.lastIndexOf(" ") + 1).split(",") ?? null;

  return (
    <View style={{ width: SPARK_ROW_WIDTH, height: SPARK_ROW_HEIGHT }}>
      {path === null ? null : (
        <Svg width={SPARK_ROW_WIDTH} height={SPARK_ROW_HEIGHT}>
          {/* The fill fades to nothing before it reaches the baseline, so the
              line keeps its weight and the row keeps its air. */}
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={stroke} stopOpacity={0.28} />
              <Stop offset="1" stopColor={stroke} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {area === null ? null : <Path d={area} fill={`url(#${gradientId})`} />}
          {/* `strokeLinejoin`/`Linecap` round: at 1.5pt over 24 points the
              default mitre spikes on a sharp reversal. */}
          <Polyline
            points={path}
            fill="none"
            stroke={stroke}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* The latest close, marked. It is the only point on the line a
              reader is actually looking for. */}
          {last === null ? null : <Circle cx={last[0]} cy={last[1]} r={2.25} fill={stroke} />}
        </Svg>
      )}
    </View>
  );
}
