/**
 * Long/Short for platforms without the SwiftUI segmented picker.
 *
 * The iOS build takes `SideSegment.ios.tsx`; this is what Android and web
 * resolve to. `@expo/ui`'s universal `Picker` has no segmented appearance, so
 * this falls back to its `menu` form — correct, if less immediate.
 */

import type { JSX } from "react";
import { Host, Picker } from "@expo/ui";

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
  return (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <Picker
        selectedValue={value}
        onValueChange={(next) => onChange(next as OrderSide)}
        appearance="menu"
      >
        <Picker.Item label={longLabel} value="long" />
        <Picker.Item label={shortLabel} value="short" />
      </Picker>
    </Host>
  );
}
