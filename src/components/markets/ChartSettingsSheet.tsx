/**
 * The chart's settings, in a bottom sheet.
 *
 * Same sheet mechanics as `NumericEditorSheet`, for the same empirically-won
 * reasons: **measured detents** (the library's `content` detent falls back to
 * full height), and **`nativeOverlay`** so the sheet paints above the
 * natively-presented market sheet — verified for this shape on device; do not
 * flip it from first principles.
 *
 * Every row writes through immediately: a chart preference has no commit
 * step worth a button — the plot behind the sheet updates as the switch
 * moves, which IS the preview.
 */

import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { ModalBottomSheet, type Detent } from "@swmansion/react-native-bottom-sheet";
import { ListGroup, Switch, Typography } from "heroui-native";
import { Segment } from "heroui-native-pro";

import { BAR_CHOICES, type BarChoice, type ChartPrefs } from "@/components/markets/chartPrefs";

/** Until the first layout lands — roughly the sheet's natural height. */
const UNMEASURED_HEIGHT = 380;
const SCRIM_COLOR = "rgba(0, 0, 0, 0.4)";
const RESTING_PAD = 32;

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <ListGroup.Item disabled>
      <ListGroup.ItemContent>
        <ListGroup.ItemTitle className="font-normal">{label}</ListGroup.ItemTitle>
        {hint === undefined ? null : (
          <ListGroup.ItemDescription className="font-normal">{hint}</ListGroup.ItemDescription>
        )}
      </ListGroup.ItemContent>
      <ListGroup.ItemSuffix>
        <Switch isSelected={value} onSelectedChange={onChange}>
          <Switch.Background />
          <Switch.Thumb />
        </Switch>
      </ListGroup.ItemSuffix>
    </ListGroup.Item>
  );
}

export function ChartSettingsSheet({
  isOpen,
  onOpenChange,
  prefs,
  onChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: ChartPrefs;
  onChange: (next: ChartPrefs) => void;
}): JSX.Element {
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const onContentLayout = (event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height);
    setContentHeight((prev) => (prev === next ? prev : next));
  };
  const detents: Detent[] = [0, contentHeight ?? UNMEASURED_HEIGHT];

  return (
    <ModalBottomSheet
      nativeOverlay
      detents={detents}
      index={isOpen ? 1 : 0}
      onIndexChange={(next) => onOpenChange(next > 0)}
      scrimColor={SCRIM_COLOR}
      surface={<View style={StyleSheet.absoluteFill} className="rounded-t-3xl bg-background" />}
    >
      <View
        onLayout={onContentLayout}
        className="gap-4 px-5 pt-4"
        style={{ paddingBottom: RESTING_PAD }}
      >
        <Typography.Paragraph className="text-lg font-semibold">
          Chart settings
        </Typography.Paragraph>

        <ListGroup>
          <ToggleRow
            label="Volume"
            hint="Bars under the plot"
            value={prefs.volume}
            onChange={(volume) => onChange({ ...prefs, volume })}
          />
          <ToggleRow
            label="Momentum"
            hint="Shade by direction"
            value={prefs.momentum}
            onChange={(momentum) => onChange({ ...prefs, momentum })}
          />
          <ToggleRow
            label="Gradient fill"
            hint="Line chart only"
            value={prefs.gradient}
            onChange={(gradient) => onChange({ ...prefs, gradient })}
          />
          <ToggleRow
            label="Edge fade"
            hint="Fade the oldest bars"
            value={prefs.leftEdgeFade}
            onChange={(leftEdgeFade) => onChange({ ...prefs, leftEdgeFade })}
          />
        </ListGroup>

        <View className="gap-2">
          <Typography.Paragraph className="text-sm text-muted font-normal">
            Bars on screen
          </Typography.Paragraph>
          <Segment
            value={String(prefs.bars)}
            onValueChange={(value) => onChange({ ...prefs, bars: Number(value) as BarChoice })}
          >
            <Segment.Group>
              <Segment.Indicator />
              {BAR_CHOICES.map((choice) => (
                <Segment.Item key={choice} value={String(choice)} className="flex-1">
                  <Segment.Label className="font-medium">{String(choice)}</Segment.Label>
                </Segment.Item>
              ))}
            </Segment.Group>
          </Segment>
        </View>
      </View>
    </ModalBottomSheet>
  );
}
