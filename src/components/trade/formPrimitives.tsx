/**
 * Small shared pieces of the order ticket that are chrome, not rules.
 *
 * `ControlCheckbox` is the EchoSheet acknowledgement pattern — the repo's one
 * proven Checkbox markup — as a whole-row pressable: the reference's checkbox
 * rows ("Reduce Only", "Randomize") are tapped by their label at least as
 * often as by their box, and a 20pt square alone is a miss target at form
 * density.
 */

import type { JSX } from "react";
import { Pressable, View } from "react-native";
import { Checkbox, Typography } from "heroui-native";

export function ControlCheckbox({
  label,
  isSelected,
  onSelectedChange,
  isCompact = false,
}: {
  label: string;
  isSelected: boolean;
  onSelectedChange: (next: boolean) => void;
  /**
   * Ticket density. The order form packs two of these between the size field
   * and the submit, so its labels run a step smaller than the sheet and tab
   * uses of this same row — opt-in rather than a global shrink, which would
   * have quietly restyled the confirm sheet and the balances filter too.
   */
  isCompact?: boolean;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected }}
      accessibilityLabel={label}
      onPress={() => onSelectedChange(!isSelected)}
      className={isCompact ? "flex-row items-center gap-1.5" : "flex-row items-center gap-2 py-0.5"}
    >
      {/* Inert — the ROW owns the tap, and a nested interactive checkbox
          would race it (the chip-inside-pressable lesson). */}
      <View
        className="pointer-events-none"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Checkbox isSelected={isSelected} onSelectedChange={() => {}} />
      </View>
      <Typography.Paragraph
        className={isCompact ? "text-xs font-normal" : "text-sm font-normal"}
        numberOfLines={1}
      >
        {label}
      </Typography.Paragraph>
    </Pressable>
  );
}
