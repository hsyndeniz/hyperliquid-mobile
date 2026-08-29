/**
 * A value / P&L history window as an area chart — the portfolio's and the
 * vault detail's chart, once.
 *
 * The two were byte-identical clones, comments included: the same `xAxis`
 * gotcha note, the same `monotoneX` curve, the same `accent-success` /
 * `accent-danger` pair. That is exactly the shape that drifts — a fix applied
 * to the portfolio's copy silently leaves the vault's behind — so the anatomy
 * lives here and the screens keep only what genuinely differs between them
 * (their fetch states and their empty-window wording).
 *
 * Two things this adds over the clones:
 *
 * **A dashed baseline at the window's first value.** Without it, a rising area
 * and a falling one look the same until you read the axis: the fill starts at
 * the bottom of the chart, not at the opening value, so its *area* says
 * nothing about profit. With the line drawn, everything above it is gain over
 * the window and everything below is loss — which is the question the colour
 * was already trying to answer. It is drawn BEHIND the fill (the fill is 35%
 * opaque, so it reads through as a tint rather than a hard rule across the
 * series), and it is a Skia `DashPathEffect` because this is inside victory's
 * Skia canvas — RN's `borderStyle: "dashed"` renders solid on iOS, the reason
 * `DashedRule` exists in SVG form elsewhere.
 *
 * **A High/Low row**, from `seriesBounds` over the WIRE strings rather than
 * the charted floats: the y-axis has four ticks and none of them is the actual
 * peak, so the extremes were previously unreadable off a 160pt-tall chart.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { DashPathEffect, Line, vec } from "@shopify/react-native-skia";
import { Typography, useThemeColor } from "heroui-native";
import { AreaChart, EmptyState } from "heroui-native-pro";

import { seriesBounds, type ChartPeriod } from "@/components/portfolio/chartView";
import { UsdLabel } from "@/components/portfolio/primitives";
import { displayNumber } from "@/components/common/display";

export function HistoryChart({
  series,
  period,
  emptyDescription,
}: {
  /** `[timestampMs, value]` wire pairs — values stay strings until display. */
  series: readonly (readonly [number, string])[];
  /** Chooses the x-axis label format: a clock inside a day, a date beyond it. */
  period: ChartPeriod;
  /** Screen-specific wording for a window too short to draw. */
  emptyDescription: string;
}): JSX.Element {
  const mutedColor = useThemeColor("muted");

  // The single gate for "is there a chart here": stricter than the old
  // `points.length < 2`, which counted unparseable entries — and since
  // `displayNumber` maps junk to 0, two bad readings used to draw a
  // confident flat line at zero.
  const bounds = seriesBounds(series);

  if (bounds === null) {
    return (
      <EmptyState className="py-6">
        <EmptyState.Header>
          <EmptyState.Title className="font-semibold">Not enough history</EmptyState.Title>
          <EmptyState.Description className="font-normal">
            {emptyDescription}
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );
  }

  const points = series.map(([t, v]) => ({ t, v: displayNumber(v) }));
  const rising = displayNumber(bounds.last) >= displayNumber(bounds.first);

  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3">
        <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
          H <UsdLabel value={bounds.high} /> · L <UsdLabel value={bounds.low} />
        </Typography.Paragraph>
        {/* Names the dashed line rather than leaving it to be guessed at. */}
        <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
          start <UsdLabel value={bounds.first} />
        </Typography.Paragraph>
      </View>

      <AreaChart
        data={points}
        xKey="t"
        yKeys={["v"]}
        wrapperClassName="h-40 w-full"
        // `xAxis`/`yAxis`, NOT `axisOptions`: the Pro wrapper injects themed
        // xAxis/yAxis defaults, and victory ignores `axisOptions` whenever the
        // newer props are present — so formatting set there silently never
        // applies. These merge OVER the wrapper's defaults.
        xAxis={{
          tickCount: 4,
          formatXLabel: (t) =>
            period === "day"
              ? new Date(Number(t)).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : new Date(Number(t)).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                }),
        }}
        yAxis={[{ tickCount: 4, formatYLabel: (v) => `$${Number(v).toLocaleString()}` }]}
      >
        {({ points: chartPoints, chartBounds }) => {
          // The first plotted point's y IS the opening value in canvas
          // coordinates — no rescaling of our own, so the line cannot drift
          // from the series it annotates.
          const baseline = chartPoints.v[0]?.y;
          return (
            <>
              {typeof baseline === "number" ? (
                <Line
                  p1={vec(chartBounds.left, baseline)}
                  p2={vec(chartBounds.right, baseline)}
                  color={mutedColor}
                  strokeWidth={1}
                >
                  <DashPathEffect intervals={[4, 4]} />
                </Line>
              ) : null}
              <AreaChart.Area
                points={chartPoints.v}
                y0={chartBounds.bottom}
                colorClassName={rising ? "accent-success" : "accent-danger"}
                opacity={0.35}
                curveType="monotoneX"
                animate={{ type: "timing", duration: 300 }}
              />
            </>
          );
        }}
      </AreaChart>
    </View>
  );
}
