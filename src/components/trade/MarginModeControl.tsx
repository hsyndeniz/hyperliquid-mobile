/**
 * Cross ⇄ Isolated for platforms without SwiftUI's confirmation dialog.
 *
 * The iOS build resolves `MarginModeControl.ios.tsx`; this is what Android and
 * web get. Same rule as there — margin mode moves the liquidation price of an
 * open position, so it must not apply on one tap — expressed with the universal
 * picker instead, where choosing IS the second step.
 */

import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";
import { Host, Picker } from "@expo/ui";
import { Typography } from "heroui-native";

import type { LeverageControl } from "@/components/trade/leverageControl";

export function MarginModeControl({ lev }: { lev: LeverageControl }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const current = lev.value;

  return (
    <View className="items-end gap-0.5">
      <Host matchContents>
        <Picker
          selectedValue={current === null ? "cross" : current.isCross ? "cross" : "isolated"}
          appearance="menu"
          enabled={current !== null && !lev.applying}
          onValueChange={(value) => {
            const isCross = value === "cross";
            if (current === null || lev.applying || isCross === current.isCross) return;
            setError(null);
            void lev.apply({ leverage: current.leverage, isCross }).then((result) => {
              if (result.kind === "failed") setError(result.error.message);
            });
          }}
        >
          <Picker.Item label="Cross" value="cross" />
          <Picker.Item label="Isolated" value="isolated" />
        </Picker>
      </Host>
      {error === null ? null : (
        <Typography.Paragraph className="text-xs text-danger font-normal" numberOfLines={1}>
          {error}
        </Typography.Paragraph>
      )}
    </View>
  );
}
