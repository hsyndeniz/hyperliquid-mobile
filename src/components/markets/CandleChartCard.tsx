/**
 * The detail screen's candle chart — `LiveChart` (react-native-livechart,
 * first use) fed from a `useCandleSeries` feed.
 *
 * ## The SharedValue contract
 *
 * The chart reads everything on the UI thread, so the series crosses over as
 * Reanimated `SharedValue`s. Arrays are updated **via `.modify` with worklet
 * functions** (never reassignment — the Reanimated 4 rule the library's own
 * README states), scalars and the nullable live candle via `.set`. The
 * line-mode `data`/`value` pair is populated **as well as** `candles`/
 * `liveCandle`: the chart's reveal and interpolation read them even in candle
 * mode, and leaving them empty renders an empty chart over real data.
 *
 * ## Framing
 *
 * `candleWidth` is the interval in seconds; `timeWindow` shows the last
 * the preferred bucket count of the 300-bar seed. An interval switch is a
 * retarget upstream (the store clears), and `snapKey={interval}` makes the
 * chart jump to the new framing in one frame instead of easing 1m geometry
 * into 1w. Panning left is real paging: `onReachStart` asks the feed for the
 * previous 300 bars.
 *
 * ## States
 *
 * `loading` is the seed in flight (breathing shell). A **deferred or failed
 * seed replaces the chart with a notice + Retry** — never an empty chart,
 * which would read as a market where nothing ever traded. The live feed
 * ticks regardless, so a retry lands on a chart already moving.
 */

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { useColorScheme, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { ChartCandlestick, ChartSpline, Settings2 } from "lucide-react-native";
import { LiveChart, type CandlePoint, type LiveChartPoint } from "react-native-livechart";
import { Button, Card, Typography, useThemeColor } from "heroui-native";
import { EmptyState, Segment } from "heroui-native-pro";
import { Presets } from "react-native-pulsar";

import { readableTextColor, tokenColor } from "@/theme/tokenColor";

import { readChartPrefs, writeChartPrefs, type ChartPrefs } from "@/components/markets/chartPrefs";
import { ChartSettingsSheet } from "@/components/markets/ChartSettingsSheet";
import {
  DETAIL_INTERVALS,
  formingToCandlePoint,
  toCandlePoints,
} from "@/components/markets/detailView";
import type { CandleSeriesFeed } from "@/hyperliquid/hooks/markets";
import { intervalSeconds } from "@/hyperliquid/state/candles";
import type { CandleInterval } from "@/hyperliquid/types/domain";

/** Which plot the card is drawing. */
export type ChartMode = "candle" | "line";

// Buckets visible at once now come from `ChartPrefs.bars` — a setting, not a
// constant. 300 are seeded; the rest are a pan away.

/**
 * The axis and badge typeface. Skia's `matchFont` only sees fonts the OS
 * installs, and SF Pro Rounded arrives through `expo-font` at runtime — so
 * the chart takes the FILE (`typeface`), not a family name. No `fontFamily`
 * override: the default (Menlo) covers the one frame while the asset loads,
 * whereas naming the rounded family there rendered INVISIBLE labels — Skia's
 * match for an unknown family drew nothing, observed on device. The field is
 * `typeface`; the doc prose says "fontAsset" and a pre-declared object dodges
 * excess-property checks, so tsc cannot catch that misspelling — the blank
 * axis is the only symptom.
 */
const CHART_FONT = {
  typeface: require("@/assets/fonts/SF-Pro-Rounded-Medium.otf") as number,
};

/** Probability axis labels — `0.624` → `62.4%`. Runs on the UI thread. */
function formatProbabilityValue(v: number): string {
  "worklet";
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Intraday buckets label as clock time, daily and weekly as month/day — the
 * default formatter prints `HH:MM:SS`, which renders every daily bar as
 * `00:00:00`. Numeric month/day, deliberately: worklets have no locale APIs.
 */
function formatBucketTimeIntraday(t: number): string {
  "worklet";
  const date = new Date(t * 1000);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatBucketTimeDaily(t: number): string {
  "worklet";
  const date = new Date(t * 1000);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function CandleChartCard({
  feed,
  interval,
  onIntervalChange,
  asProbability = false,
  chartHeight = 240,
  coin = null,
}: {
  feed: CandleSeriesFeed;
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
  /**
   * The market's wire coin, for the brand tint. Optional: without it the chart
   * uses the theme accent, which is what every caller did before.
   */
  coin?: string | null;
  /** Prediction charts plot the yes side's price as a probability. */
  asProbability?: boolean;
  /**
   * Plot height in points. The default matches the original fixed `h-60`;
   * the trade screen's compact/expanded chart states pass their own.
   */
  chartHeight?: number;
}): JSX.Element {
  const colorScheme = useColorScheme();
  const [accentColor, mutedColor] = useThemeColor(["accent", "muted"]);

  // Candles by default — this is a trading chart — with livechart's
  // line↔candle morph one tap away. The line/data pair is ALREADY populated
  // for candle mode (see the SharedValue contract above), so the toggle costs
  // nothing extra.
  const [mode, setMode] = useState<ChartMode>("candle");
  // Lazy read once per mount; every change writes through, so the next mount
  // opens where this one left off.
  const [prefs, setPrefs] = useState<ChartPrefs>(() => readChartPrefs());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const applyPrefs = (next: ChartPrefs): void => {
    setPrefs(next);
    writeChartPrefs(next);
  };

  const candlesSv = useSharedValue<CandlePoint[]>([]);
  const liveCandleSv = useSharedValue<CandlePoint | null>(null);
  const dataSv = useSharedValue<LiveChartPoint[]>([]);
  const valueSv = useSharedValue(0);

  const { series } = feed;

  // Committed history → candles + the close line. Replaced wholesale: the
  // store's committed array reference only changes when its content did.
  useEffect(() => {
    const points = toCandlePoints(series.committed);
    const line: LiveChartPoint[] = points.map((point) => ({
      time: point.time,
      value: point.close,
    }));
    candlesSv.modify((arr) => {
      "worklet";
      arr.length = 0;
      for (const point of points) arr.push(point);
      return arr;
    });
    dataSv.modify((arr) => {
      "worklet";
      arr.length = 0;
      for (const point of line) arr.push(point);
      return arr;
    });
  }, [series.committed, candlesSv, dataSv]);

  // Forming bucket → live candle + the interpolation value. Null is a real
  // state (a quiet market after a seed), which the chart's own type models.
  useEffect(() => {
    const live = formingToCandlePoint(series.forming);
    liveCandleSv.set(live);
    const committedTip = series.committed.at(-1);
    const tip = live?.close ?? (committedTip ? Number(committedTip.close) : null);
    if (tip !== null && Number.isFinite(tip)) valueSv.set(tip);
  }, [series.forming, series.committed, liveCandleSv, valueSv]);

  const seconds = intervalSeconds(interval);

  // The asset's own colour where it has one; the theme accent otherwise.
  const brand = (coin === null ? null : tokenColor(coin)) ?? accentColor;

  return (
    <View className="gap-3">
      {/* Zero padding, and the card clips. The chart draws its own price axis
          down the right edge and its time labels along the bottom, so a card
          that insets it fences those labels off from the edge they belong to
          and wastes the width the candles need. `overflow-hidden` is what lets
          the plot meet the corner radius instead of squaring it off. */}
      <Card className="overflow-hidden p-0">
        {feed.seed === "deferred" || feed.seed === "error" ? (
          <View className="w-full items-center justify-center" style={{ height: chartHeight }}>
            <EmptyState>
              <EmptyState.Header>
                <EmptyState.Title className="font-semibold">
                  {feed.seed === "deferred" ? "Chart deferred" : "Could not load chart"}
                </EmptyState.Title>
                <EmptyState.Description className="font-normal">
                  {feed.seed === "deferred"
                    ? "The request budget is protecting the connection. Try again shortly."
                    : "The candle history could not be fetched."}
                </EmptyState.Description>
              </EmptyState.Header>
              <EmptyState.Content>
                <Button size="sm" variant="tertiary" onPress={feed.retry}>
                  <Button.Label className="font-medium">Retry</Button.Label>
                </Button>
              </EmptyState.Content>
            </EmptyState>
          </View>
        ) : (
          <View className="w-full" style={{ height: chartHeight }}>
            <LiveChart
              mode={mode}
              candles={candlesSv}
              liveCandle={liveCandleSv}
              candleWidth={seconds}
              data={dataSv}
              value={valueSv}
              timeWindow={seconds * prefs.bars}
              snapKey={interval}
              volume={prefs.volume}
              nonNegative
              momentum={prefs.momentum}
              leftEdgeFade={prefs.leftEdgeFade}
              xAxis={prefs.timeAxis}
              valueLine={prefs.priceLine}
              scrub={prefs.scrub}
              zoom={prefs.zoom}
              {...(mode === "line" ? { gradient: prefs.gradient, dot: { ring: true } } : {})}
              {...(asProbability ? { maxValue: 1, formatValue: formatProbabilityValue } : {})}
              formatTime={seconds >= 86_400 ? formatBucketTimeDaily : formatBucketTimeIntraday}
              timeScroll={prefs.timeScroll}
              onReachStart={feed.loadOlder}
              loading={feed.seed === "loading"}
              theme={colorScheme === "light" ? "light" : "dark"}
              font={CHART_FONT}
              accentColor={brand}
              // The price line and its badge take the ASSET's colour, not the app's.
              // On a screen showing one market at a time this is the cheapest
              // possible "which market am I looking at" cue. Candles keep their
              // up/down colours — those are status, and status stays semantic.
              palette={{
                dashLine: brand,
                badgeBg: brand,
                badgeText: readableTextColor(brand),
              }}
            />
          </View>
        )}

        {/* The controls are the chart's FOOTER, not a strip floating under the
            card: interval and mode are properties of this plot, and drawing
            them inside its frame makes the card read as one instrument. The
            hairline is the only divider — the plot already owns the space
            above it. */}
        <View className="flex-row items-center gap-2 border-t border-separator px-2 py-1.5">
          {/* Two EQUAL buttons (user call, 2026-08-29): one toggles the mode
              — the icon names the mode it switches TO, and the label says it
              for VoiceOver — and one opens the settings sheet. Same
              component, same size, same variant: the pair reads as one
              instrument cluster. */}
          <Button
            isIconOnly
            size="sm"
            variant="tertiary"
            // `h-8` = the Segment sm track's exact height (28pt of item + 2pt
            // group padding each side) — the row's three controls read as one
            // bar only if they share one height.
            className="h-8 w-8"
            accessibilityLabel={mode === "candle" ? "Switch to line chart" : "Switch to candles"}
            onPress={() => {
              Presets.System.selection();
              setMode(mode === "candle" ? "line" : "candle");
            }}
          >
            {mode === "candle" ? (
              <ChartSpline size={14} color={mutedColor} />
            ) : (
              <ChartCandlestick size={14} color={mutedColor} />
            )}
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="tertiary"
            className="h-8 w-8"
            accessibilityLabel="Chart settings"
            onPress={() => setSettingsOpen(true)}
          >
            <Settings2 size={14} color={mutedColor} />
          </Button>

          {/* Values are wire interval spellings — `1m` is a minute and `1M`
              would be a month, so the labels render the value verbatim. */}
          <View className="flex-1">
            <Segment
              size="sm"
              value={interval}
              onValueChange={(value) => {
                Presets.System.selection();
                onIntervalChange(value as CandleInterval);
              }}
            >
              <Segment.Group>
                <Segment.ScrollView>
                  <Segment.Indicator />
                  {DETAIL_INTERVALS.map((entry) => (
                    <Segment.Item key={entry} value={entry}>
                      <Segment.Label className="font-medium">{entry}</Segment.Label>
                    </Segment.Item>
                  ))}
                </Segment.ScrollView>
              </Segment.Group>
            </Segment>
          </View>
        </View>
      </Card>

      {feed.isLoadingOlder ? (
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Loading older candles…
        </Typography.Paragraph>
      ) : null}

      <ChartSettingsSheet
        isOpen={settingsOpen}
        onOpenChange={setSettingsOpen}
        prefs={prefs}
        onChange={applyPrefs}
        mode={mode}
      />
    </View>
  );
}
