/**
 * The Long/Short choice, as a real UIKit segmented control.
 *
 * SwiftUI, not the universal layer: `@expo/ui`'s universal `Picker` exposes
 * only `menu` and `wheel` appearances and takes no `modifiers`, so a segmented
 * style is unreachable from it. `pickerStyle('segmented')` is a SwiftUI
 * modifier, which means this file is iOS-only — hence the `.ios.tsx` split and
 * the plain sibling for every other platform.
 *
 * A binary, always-visible choice is the one case where a dropdown is the wrong
 * control: the alternative has to be readable without opening anything, because
 * picking the wrong side is the most expensive mistake this screen allows.
 */

import type { JSX } from "react";
import { Host } from "@expo/ui";
import { Picker, Text } from "@expo/ui/swift-ui";
import { font, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";

import type { OrderSide } from "@/components/trade/orderForm";

export function SideSegment({
  value,
  longLabel,
  shortLabel,
  onChange,
}: {
  value: OrderSide;
  longLabel: string;
  shortLabel: string;
  onChange: (side: OrderSide) => void;
}): JSX.Element {
  // `vertical` only: the host takes its HEIGHT from the SwiftUI content but its
  // WIDTH from the RN layout. With `matchContents` on both axes the segmented
  // control sized to its own labels and sat as a stub in the corner.
  return (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <Picker
        selection={value}
        onSelectionChange={(next) => onChange(next as OrderSide)}
        modifiers={[pickerStyle("segmented")]}
      >
        {/* `design: "rounded"` — the segmented control is the one strip of
            system type on this screen, and SF Rounded is the app's face. */}
        <Text modifiers={[tag("long"), font({ design: "rounded", weight: "medium" })]}>
          {longLabel}
        </Text>
        <Text modifiers={[tag("short"), font({ design: "rounded", weight: "medium" })]}>
          {shortLabel}
        </Text>
      </Picker>
    </Host>
  );
}
