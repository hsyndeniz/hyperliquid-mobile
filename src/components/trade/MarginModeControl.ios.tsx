/**
 * Cross ⇄ Isolated, behind a native confirmation dialog.
 *
 * This used to be a chip that applied on a single tap. Margin mode is not a
 * display preference: it decides whether this position is backed by the whole
 * account or only by the margin posted against it, which moves the liquidation
 * price of a position that may already be open. One tap, one on-chain write, no
 * chance to reconsider — for a control sitting inches from the size slider.
 *
 * A SwiftUI `confirmationDialog` is the platform's own answer to "a choice with
 * consequences": it names the two modes and says what changes before anything
 * is written. Applying happens once, on the chosen action.
 *
 * Verified on device: hosted in a `Host` rather than at the root, SwiftUI
 * presents this as an anchored POPOVER, not a bottom action sheet — and in a
 * popover it drops the explicit Cancel button, because the full-screen
 * `PopoverDismissRegion` behind it already cancels on an outside tap. The
 * `role="cancel"` button below is therefore not rendered in this presentation.
 * It is kept because it IS shown in the sheet presentation, and losing it there
 * would leave the sheet with two destructive-looking options and no way out.
 *
 * iOS-only, hence the `.ios.tsx` split — `ConfirmationDialog` lives in
 * `@expo/ui/swift-ui` and importing it elsewhere crashes at runtime.
 */

import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";
import { Host } from "@expo/ui";
import { Button, ConfirmationDialog, Text } from "@expo/ui/swift-ui";
import { font } from "@expo/ui/swift-ui/modifiers";
import { Typography } from "heroui-native";

import type { LeverageControl } from "@/components/trade/leverageControl";

export function MarginModeControl({ lev }: { lev: LeverageControl }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const current = lev.value;
  const label = current === null ? "--" : current.isCross ? "Cross" : "Isolated";

  const choose = (isCross: boolean): void => {
    setIsOpen(false);
    if (current === null || lev.applying || isCross === current.isCross) return;
    setError(null);
    void lev.apply({ leverage: current.leverage, isCross }).then((result) => {
      if (result.kind === "failed") setError(result.error.message);
    });
  };

  return (
    <View className="items-end gap-0.5">
      <Host matchContents>
        <ConfirmationDialog
          title="Margin mode"
          isPresented={isOpen}
          onIsPresentedChange={setIsOpen}
          titleVisibility="visible"
        >
          <ConfirmationDialog.Trigger>
            <Button onPress={() => setIsOpen(true)}>
              <Text modifiers={[font({ design: "rounded", weight: "medium" })]}>
                {lev.applying ? "Applying…" : `${label} ⇄`}
              </Text>
            </Button>
          </ConfirmationDialog.Trigger>
          <ConfirmationDialog.Message>
            <Text>
              Cross backs this position with the whole account. Isolated risks only the margin
              posted against it. Switching moves the liquidation price of an open position.
            </Text>
          </ConfirmationDialog.Message>
          <ConfirmationDialog.Actions>
            <Button label="Cross" onPress={() => choose(true)} />
            <Button label="Isolated" onPress={() => choose(false)} />
            <Button label="Cancel" role="cancel" onPress={() => setIsOpen(false)} />
          </ConfirmationDialog.Actions>
        </ConfirmationDialog>
      </Host>
      {error === null ? null : (
        <Typography.Paragraph className="text-xs text-danger font-normal" numberOfLines={1}>
          {error}
        </Typography.Paragraph>
      )}
    </View>
  );
}
