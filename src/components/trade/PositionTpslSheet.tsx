/**
 * Take profit / stop loss for a position that ALREADY EXISTS — the sheet
 * behind the row's TP/SL button.
 *
 * These are not the ticket's attached brackets. They stand alone under
 * `positionTpsl` grouping at size "0" (`positionTpslLegs`), which is what
 * makes them track the WHOLE position and resize with it instead of stranding
 * at the size it happened to be tonight; and they execute at market, so a gap
 * cannot jump them the way it jumps a resting limit. Both facts change what a
 * price here means, so both are stated on the surface where it is typed.
 *
 * Applying REPLACES: the action cancels this position's existing
 * whole-position brackets before placing what is typed here, because the
 * exchange otherwise stacks them — measured live, a second bracket joined the
 * first instead of superseding it, so nudging a stop would leave two. Empty
 * therefore CLEARS that side, and both fields empty is a real instruction
 * ("remove my brackets"), which is why Apply stays pressable with nothing
 * typed.
 *
 * The fields still seed EMPTY on every open, and nothing here reads what is
 * resting: which of two live trigger orders is the take-profit is only
 * knowable from the wire's open-ended `orderType` string, and a prefill that
 * guessed wrong would show a stop where a target is. The copy says
 * "replaces" instead, and Open Orders stays the honest record.
 *
 * `priceDecimals` arrives from the screen because the cap is per-asset
 * (`maxDecimals − szDecimals`); a fixed cap here would accept a price the
 * exchange truncates into a different trigger.
 */

import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, View, Pressable, type LayoutChangeEvent } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { ModalBottomSheet, type Detent } from "@swmansion/react-native-bottom-sheet";
import { X } from "lucide-react-native";
import { Button, InputGroup, Typography, useThemeColor } from "heroui-native";

import { acceptDecimalEdit } from "@/components/trade/orderForm";
import type { Position } from "@/hyperliquid/types/domain";

/** Applied only while the sheet is closed — never seen (VaultTransferSheet). */
const UNMEASURED_HEIGHT = 320;

/** The even dimming the transfer sheets settled on; without it the sheet's
    top edge reads as a rendering artefact, not a surface. */
const SCRIM_COLOR = "rgba(0, 0, 0, 0.4)";

/** The `pb-8` the sibling sheets carry, as a number the keyboard can replace. */
const RESTING_PAD = 32;

/** A read-only row in the ticket's spelling: quiet label left, figure right. */
function InfoLine({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>
      {/* `flex-1 text-right` so an exact liquidation price — the wire carries
          ten decimals, and a sheet keeps them — stays inside the row. */}
      <Typography.Paragraph
        className="flex-1 text-right text-xs tabular-nums font-medium"
        numberOfLines={1}
      >
        {value}
      </Typography.Paragraph>
    </View>
  );
}

/** One trigger field: label prefix, decimal pad, USDC suffix. */
function TriggerField({
  label,
  value,
  onEdit,
  decimals,
  isDisabled,
}: {
  label: string;
  value: string;
  onEdit: (next: string) => void;
  decimals: number;
  isDisabled: boolean;
}): JSX.Element {
  return (
    <InputGroup isDisabled={isDisabled}>
      <InputGroup.Prefix isDecorative className="pr-2">
        <Typography.Paragraph className="text-xs text-muted font-normal">
          {label}
        </Typography.Paragraph>
      </InputGroup.Prefix>
      <InputGroup.Input
        value={value}
        onChangeText={(next) => {
          const accepted = acceptDecimalEdit(next, decimals);
          if (accepted !== null) onEdit(accepted);
        }}
        placeholder="0"
        keyboardType="decimal-pad"
        inputMode="decimal"
        className="font-normal"
      />
      <InputGroup.Suffix isDecorative>
        <Typography.Paragraph className="text-xs text-muted font-normal">USDC</Typography.Paragraph>
      </InputGroup.Suffix>
    </InputGroup>
  );
}

export function PositionTpslSheet({
  isOpen,
  onOpenChange,
  position,
  priceDecimals,
  apply,
  applying,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  position: Position | null;
  /** Decimals the trigger fields accept — the screen computes this. */
  priceDecimals: number;
  apply: (prices: { takeProfitPrice: string; stopLossPrice: string }) => Promise<
    | { kind: "done"; note: string }
    /**
     * Sent, answer never arrived. The sheet must NOT close on this: a replace
     * cancels the old brackets first, so an unknown outcome can leave a
     * position that had a stop with none.
     */
    | { kind: "unknown"; note: string }
    | { kind: "failed"; error: Error }
  >;
  applying: boolean;
}): JSX.Element {
  const mutedColor = useThemeColor("muted");

  // A fresh open is a fresh intent: prices typed against the last position
  // must not survive a close, and neither must their refusal. Render-phase
  // adoption, so the first open frame is already the clean one.
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setTakeProfit("");
      setStopLoss("");
      setError(null);
    }
  }

  // WE measure the content — the library's "content" detent resolves to zero
  // here and silently falls back to full height (the VaultTransferSheet
  // finding). Guarded set so identical layout passes don't re-render.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const onContentLayout = (event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height);
    setContentHeight((prev) => (prev === next ? prev : next));
  };

  // BOTH stops must exist: a single-detent array clamps index 1 to 0 and the
  // sheet renders permanently open.
  const detents: Detent[] = [0, contentHeight ?? UNMEASURED_HEIGHT];

  // The library applies NO keyboard avoidance, by design — the content owns
  // it, and the sheet rises because the measurement above grows with it. The
  // sibling sheets have no field to type into; this one's decimal pad would
  // otherwise cover the Apply button the prices are typed for.
  const keyboardHeight = useKeyboardState((state) => state.height);
  const keyboardPad = keyboardHeight > 0 ? keyboardHeight : RESTING_PAD;

  // Both fields empty is a real instruction — "clear this position's
  // brackets" — so it must stay pressable. Only the absence of a position
  // makes the button meaningless.
  const submit = () => {
    if (position === null) return;
    void apply({ takeProfitPrice: takeProfit, stopLossPrice: stopLoss }).then((result) => {
      if (result.kind === "done") {
        onOpenChange(false);
        return;
      }
      // An unknown outcome keeps the sheet OPEN and says so, with no retry
      // offered — the house rule for a submit whose answer never came. This
      // used to arrive as `done` carrying an explanatory note that nothing
      // rendered, so the sheet closed exactly as on success; because an apply
      // cancels the existing brackets FIRST, that could silently leave a
      // position unprotected. The reconciler settles it; pressing Apply again
      // would place a second bracket.
      setError(result.kind === "unknown" ? result.note : result.error.message);
    });
  };

  return (
    <ModalBottomSheet
      // Reparents above the natively-presented market sheet — without it the
      // sheet mounts, passes AX, and paints NOTHING (the documented trap;
      // verified again from `MarketAccountSection` on device, 2026-08-29).
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
        style={{ paddingBottom: keyboardPad }}
      >
        <View className="flex-row items-center justify-between">
          <Typography.Paragraph className="text-lg font-semibold">
            Take Profit / Stop Loss
          </Typography.Paragraph>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            className="p-1"
            onPress={() => onOpenChange(false)}
          >
            <X size={20} color={mutedColor} />
          </Pressable>
        </View>

        <TriggerField
          label="Take profit"
          value={takeProfit}
          onEdit={setTakeProfit}
          decimals={priceDecimals}
          isDisabled={position === null}
        />
        <TriggerField
          label="Stop loss"
          value={stopLoss}
          onEdit={setStopLoss}
          decimals={priceDecimals}
          isDisabled={position === null}
        />

        {/* Says REPLACES, not "adds": applying cancels whatever brackets this
            position already carries and sets exactly what is typed here, so
            an empty field clears that side rather than leaving it untouched.
            The fields deliberately do not prefill — which of two live trigger
            orders is the take-profit is only knowable from the wire's
            open-ended `orderType` string, and guessing it wrong would show a
            stop where a target is. Open Orders is the honest record. */}
        <Typography.Paragraph className="text-xs text-muted font-normal">
          Applying replaces any take profit or stop loss already set on this position. Leave a field
          empty to clear that side.
        </Typography.Paragraph>

        {/* The server's own figures, verbatim — what the triggers are aimed
            between. */}
        <View className="gap-2">
          <InfoLine
            label="Position"
            value={position === null ? "--" : `${position.side} ${position.size} ${position.coin}`}
          />
          {/* `entryPxDisplay` is the truncated wire value, and the domain type
              allows it exactly here — a display leaf, never an input to PnL. */}
          <InfoLine label="Entry" value={position?.entryPxDisplay ?? "--"} />
          <InfoLine label="Liquidation price" value={position?.liquidationPx ?? "--"} />
        </View>

        <Typography.Paragraph className="text-xs text-muted font-normal">
          These track the whole position and resize with it. Both execute at market once triggered,
          so the fill can land past the price you set.
        </Typography.Paragraph>

        {error !== null ? (
          <Typography.Paragraph className="text-xs text-danger font-normal" numberOfLines={2}>
            {error}
          </Typography.Paragraph>
        ) : null}

        <Button variant="primary" isDisabled={position === null || applying} onPress={submit}>
          <Button.Label className="font-medium">{applying ? "Applying…" : "Apply"}</Button.Label>
        </Button>
      </View>
    </ModalBottomSheet>
  );
}
