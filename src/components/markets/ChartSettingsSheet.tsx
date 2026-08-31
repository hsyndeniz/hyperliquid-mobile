/**
 * The chart's settings, in a bottom sheet.
 *
 * Same sheet mechanics as `NumericEditorSheet`, for the same empirically-won
 * reasons: **measured detents** (the library's `content` detent falls back to
 * full height), and **`nativeOverlay`** so the sheet paints above the
 * natively-presented market sheet — verified for this shape on device; do not
 * flip it from first principles.
 *
 * Everything writes through immediately: a chart preference has no commit step
 * worth a button — the plot updates as the control moves, which IS the preview.
 *
 * ## The shape, after four rejected attempts
 *
 * `ListGroup` switch rows → a two-column grid of switch tiles → wrapped pills →
 * a one-line scrolled pill strip. Every one of those was an attempt to make the
 * panel SHORTER, and shortness was never what was wanted: squeezing ten
 * settings onto one line turns each into a bare word with no room to say what
 * it does, and the reader is left guessing what "Pan" or "Momentum" means.
 *
 * So this one spends height instead of saving it. Three `Widget` sections —
 * a titled card over a nested content surface, which is the anatomy that
 * component exists for — each holding full-width rows. Every toggle is a
 * `ControlField`, so the WHOLE ROW is the hit target rather than a 48pt switch
 * at the far edge, and each carries a line saying what it changes. `bars` gets
 * a Pro `NumberStepper`: it is a magnitude, and −/+ around the number states
 * it exactly with no gesture to learn. A `WheelPicker` sat here first and came
 * out for a concrete reason worth keeping — it is FlatList-backed, and React
 * Native judges "VirtualizedList nested in a ScrollView" from REACT CONTEXT,
 * not the native tree, so the market screen's page scroller raised the nesting
 * error through the sheet even though `nativeOverlay` presents it in a window
 * of its own. Moving it around inside the sheet changed nothing; only
 * rendering the sheet outside that scroller would have, at the cost of
 * hoisting this state up to the screen. A stepper has no list in it at all.
 *
 * The sheet scrolls, and on a small screen it must: the content is taller than
 * an iPhone SE. `SHEET_MAX_FRACTION` caps the detent; the `ScrollView` covers
 * the rest.
 */

import type { JSX } from "react";
import { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { ModalBottomSheet, type Detent } from "@swmansion/react-native-bottom-sheet";
import { Button, CloseButton, ControlField, Typography } from "heroui-native";
import { NumberStepper, Widget } from "heroui-native-pro";

import {
  BARS_MAX,
  BARS_MIN,
  BARS_STEP,
  DEFAULT_CHART_PREFS,
  type ChartPrefs,
} from "@/components/markets/chartPrefs";

/** Until the first layout lands — roughly the sheet's natural height. */
const UNMEASURED_HEIGHT = 640;
const SCRIM_COLOR = "rgba(0, 0, 0, 0.4)";
const RESTING_PAD = 32;
/** Leaves the market's price header uncovered even at full extension. */
const SHEET_MAX_FRACTION = 0.86;

type FlagKey = Exclude<keyof ChartPrefs, "bars">;

interface Setting {
  key: FlagKey;
  label: string;
  /** One line on what it changes — the reason this layout is tall. */
  hint: string;
}

const PLOT: readonly Setting[] = [
  { key: "volume", label: "Volume", hint: "Traded size as bars under the plot" },
  { key: "momentum", label: "Momentum", hint: "Colour the live marker by direction" },
  { key: "gradient", label: "Gradient", hint: "Fill the area under the line" },
  { key: "leftEdgeFade", label: "Edge fade", hint: "Fade the oldest bars out to the left" },
];

const GUIDES: readonly Setting[] = [
  { key: "timeAxis", label: "Time axis", hint: "Clock labels along the bottom" },
  { key: "priceLine", label: "Price line", hint: "Dashed guide across the live price" },
  { key: "scrub", label: "Crosshair", hint: "Drag the plot to read one bar" },
  { key: "zoom", label: "Pinch to zoom", hint: "Two fingers change the framing" },
  { key: "timeScroll", label: "Pan history", hint: "Drag sideways to load older bars" },
];

function SettingRow({
  setting,
  prefs,
  onChange,
  isDisabled = false,
  hint,
}: {
  setting: Setting;
  prefs: ChartPrefs;
  onChange: (next: ChartPrefs) => void;
  isDisabled?: boolean;
  /** Overrides the setting's own line — used to say why one is inert. */
  hint?: string;
}): JSX.Element {
  return (
    <ControlField
      isSelected={prefs[setting.key]}
      isDisabled={isDisabled}
      onSelectedChange={(value) => onChange({ ...prefs, [setting.key]: value })}
    >
      <View className="flex-1 gap-0.5">
        <Typography.Paragraph className="text-sm font-medium">{setting.label}</Typography.Paragraph>
        <Typography.Paragraph className="text-xs text-muted font-normal">
          {hint ?? setting.hint}
        </Typography.Paragraph>
      </View>
      <ControlField.Indicator variant="switch" />
    </ControlField>
  );
}

function Section({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <Widget>
      <Widget.Header>
        <Widget.Title>{title}</Widget.Title>
      </Widget.Header>
      <Widget.Content>{children}</Widget.Content>
    </Widget>
  );
}

export function ChartSettingsSheet({
  isOpen,
  onOpenChange,
  prefs,
  onChange,
  mode,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: ChartPrefs;
  onChange: (next: ChartPrefs) => void;
  /** The plot the settings are read against — see the gradient row. */
  mode: "candle" | "line";
}): JSX.Element {
  const { height: windowHeight } = useWindowDimensions();
  // Two measurements because the sheet is two regions — see the pinned/scrolled
  // split below. Their sum is the height the sheet WANTS; the cap is what it
  // gets.
  const [pinnedHeight, setPinnedHeight] = useState<number | null>(null);
  const [scrolledHeight, setScrolledHeight] = useState<number | null>(null);
  const measure =
    (set: (next: number | null) => void) =>
    (event: LayoutChangeEvent): void => {
      const next = Math.ceil(event.nativeEvent.layout.height);
      set(next);
    };
  const maxHeight = Math.round(windowHeight * SHEET_MAX_FRACTION);
  const natural =
    pinnedHeight === null || scrolledHeight === null
      ? UNMEASURED_HEIGHT
      : pinnedHeight + scrolledHeight;
  const sheetHeight = Math.min(natural, maxHeight);
  const detents: Detent[] = [0, sheetHeight];

  const isLine = mode === "line";

  return (
    <ModalBottomSheet
      nativeOverlay
      detents={detents}
      index={isOpen ? 1 : 0}
      onIndexChange={(next) => onOpenChange(next > 0)}
      scrimColor={SCRIM_COLOR}
      surface={<View style={StyleSheet.absoluteFill} className="rounded-t-3xl bg-background" />}
    >
      <View style={{ height: sheetHeight }}>
        {/* PINNED: the title row and the bars control. Only the settings
            below scroll, so the count someone came to change never leaves the
            screen while they hunt for a toggle. */}
        <View onLayout={measure(setPinnedHeight)} className="gap-3 px-5 pt-4">
          <View className="flex-row items-center justify-between gap-3">
            <Typography.Paragraph className="text-lg font-semibold">
              Chart settings
            </Typography.Paragraph>
            <View className="flex-row items-center gap-2">
              <Button size="sm" variant="tertiary" onPress={() => onChange(DEFAULT_CHART_PREFS)}>
                <Button.Label className="font-medium">Reset</Button.Label>
              </Button>
              <CloseButton
                accessibilityLabel="Close chart settings"
                onPress={() => onOpenChange(false)}
              />
            </View>
          </View>

          {/* A plain row, not a `Widget`. The sections below are cards
              because they group many settings; this is ONE control, and
              wrapping a single stepper in a titled card over a nested surface
              gave it more frame than content. */}
          <View className="flex-row items-center justify-between gap-3 px-1">
            <View className="gap-0.5">
              <Typography.Paragraph className="text-sm font-medium">
                Bars on screen
              </Typography.Paragraph>
              <Typography.Paragraph className="text-xs text-muted font-normal">
                {`${String(prefs.bars)} of 300 loaded`}
              </Typography.Paragraph>
            </View>
            <NumberStepper
              value={prefs.bars}
              minValue={BARS_MIN}
              maxValue={BARS_MAX}
              step={BARS_STEP}
              onValueChange={(bars) => onChange({ ...prefs, bars })}
            >
              <NumberStepper.DecrementButton />
              <NumberStepper.Value />
              <NumberStepper.IncrementButton />
            </NumberStepper>
          </View>
        </View>

        {/* SCROLLS. `flex-1` so it takes whatever the pinned region leaves —
            without it the ScrollView sizes to its content and overflows the
            sheet instead of scrolling inside it. */}
        <ScrollView bounces={false} showsVerticalScrollIndicator={false} className="flex-1">
          <View
            onLayout={measure(setScrolledHeight)}
            className="gap-3 px-5 pt-3"
            style={{ paddingBottom: RESTING_PAD }}
          >
            <Section title="Plot">
              <View className="gap-4">
                {PLOT.map((setting) => (
                  <SettingRow
                    key={setting.key}
                    setting={setting}
                    prefs={prefs}
                    onChange={onChange}
                    // Gradient fills under a LINE. Rather than hide the row, it
                    // stays and says why it is inert — a full-width row has the
                    // space for that, which is exactly what the one-line layouts
                    // did not.
                    isDisabled={setting.key === "gradient" && !isLine}
                    hint={
                      setting.key === "gradient" && !isLine
                        ? "Line chart only — switch the plot to use it"
                        : undefined
                    }
                  />
                ))}
              </View>
            </Section>

            <Section title="Guides & gestures">
              <View className="gap-4">
                {GUIDES.map((setting) => (
                  <SettingRow
                    key={setting.key}
                    setting={setting}
                    prefs={prefs}
                    onChange={onChange}
                  />
                ))}
              </View>
            </Section>
          </View>
        </ScrollView>
      </View>
    </ModalBottomSheet>
  );
}
