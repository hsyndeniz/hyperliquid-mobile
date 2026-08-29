/**
 * The appearance control: System / Light / Dark.
 *
 * A `Segment` rather than a Switch or a Select because the choice is a small,
 * fixed, mutually-exclusive set where seeing the options IS the affordance —
 * a "Dark mode" toggle cannot express "follow the system" at all, and a Select
 * hides two of three options behind a tap.
 *
 * The selected value is DERIVED from `useUniwind()`, not held here — see
 * `appearance.ts` for why a second copy would drift from the one painting the
 * screen. That also makes this correct for free when the OS flips while the
 * app is open on "System": Uniwind notifies, this re-renders, and the measure
 * follows.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Typography } from "heroui-native";
import { Segment } from "heroui-native-pro";
import { useUniwind } from "uniwind";

import {
  APPEARANCE_OPTIONS,
  resolveChoice,
  writeAppearance,
  type AppearanceChoice,
} from "@/components/account/appearance";
import { applyAppearance } from "@/components/account/applyAppearance";

export function AppearanceCard(): JSX.Element {
  const { theme, hasAdaptiveThemes } = useUniwind();
  const choice = resolveChoice(theme, hasAdaptiveThemes);

  return (
    <View className="gap-3">
      <Segment
        size="sm"
        value={choice}
        onValueChange={(value) => {
          const next = value as AppearanceChoice;
          // Apply first, storage second: the repaint is what the user is
          // waiting for, and a storage failure must not cost them the change
          // they can already see. The write is the durable echo, not the act.
          // `applyAppearance` sets BOTH Uniwind and RN's `Appearance` — see
          // that function for why the native half cannot be left to Uniwind.
          applyAppearance(next);
          writeAppearance(next);
        }}
      >
        {/* No `Segment.ScrollView` and `flex-1` on each item — three short
            labels sized to their own text would huddle at the left edge
            instead of splitting the row. */}
        <Segment.Group>
          <Segment.Indicator />
          {APPEARANCE_OPTIONS.map((option) => (
            <Segment.Item key={option.value} value={option.value} className="flex-1">
              <Segment.Label className="font-medium">{option.label}</Segment.Label>
            </Segment.Item>
          ))}
        </Segment.Group>
      </Segment>

      <Typography.Paragraph className="text-sm text-muted font-normal">
        {choice === "system"
          ? "Following your device setting."
          : "Overrides your device setting for this app."}
      </Typography.Paragraph>
    </View>
  );
}
