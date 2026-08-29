/**
 * Add or remove margin on an ISOLATED position — the sheet behind the row's
 * margin button.
 *
 * **The sign is the verb.** `updateIsolatedMargin` carries no direction field:
 * a positive amount adds margin and a negative one removes it, so Remove
 * submits the negated string. An unsigned removal is an ADD of the same size,
 * accepted and confirmed, moving the money the wrong way — which is why the
 * submitted string is derived from the mode here rather than kept in step with
 * it by hand.
 *
 * A cross position renders disabled WITH the reason rather than not at all.
 * Cross margin is the account's, not the position's, so there is nothing of
 * its own to move and the exchange refuses outright; the user opened this
 * deliberately and gets the reason instead of a dead Apply button.
 *
 * Nothing here predicts the resulting margin or liquidation price. The account
 * channel pushes what the server actually applied, and a projected figure
 * sitting beside a real one is exactly the disagreement a margin screen cannot
 * afford — the same rule `adjustIsolatedMargin`'s note follows.
 */

import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, View, Pressable, type LayoutChangeEvent } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { ModalBottomSheet, type Detent } from "@swmansion/react-native-bottom-sheet";
import { X } from "lucide-react-native";
import { Button, InputGroup, Typography, useThemeColor } from "heroui-native";
import { Segment } from "heroui-native-pro";

import { acceptDecimalEdit } from "@/components/trade/orderForm";
import { toBigNumber } from "@/hyperliquid/core/precision";
import type { Position } from "@/hyperliquid/types/domain";

/** Applied only while the sheet is closed — never seen (VaultTransferSheet). */
const UNMEASURED_HEIGHT = 320;

/** The even dimming the transfer sheets settled on; without it the sheet's
    top edge reads as a rendering artefact, not a surface. */
const SCRIM_COLOR = "rgba(0, 0, 0, 0.4)";

/** The `pb-8` the sibling sheets carry, as a number the keyboard can replace. */
const RESTING_PAD = 32;

/** USDC's wire precision — the cap `updateIsolatedMargin` truncates to, so a
    seventh decimal is a keystroke that could never reach the exchange. */
const USDC_DECIMALS = 6;

/** Which way the money moves. NOT the position's side — see the header. */
type AdjustMode = "add" | "remove";

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

export function MarginAdjustSheet({
  isOpen,
  onOpenChange,
  position,
  apply,
  applying,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** null while no position is targeted — render nothing meaningful. */
  position: Position | null;
  /** Positive adds margin, negative removes it. Resolves after the server answers. */
  apply: (amountUsd: string) => Promise<
    | { kind: "done"; note: string }
    /** Sent, answer never arrived — the sheet stays open and offers no retry. */
    | { kind: "unknown"; note: string }
    | { kind: "failed"; error: Error }
  >;
  applying: boolean;
}): JSX.Element {
  const mutedColor = useThemeColor("muted");

  // A fresh open is a fresh intent: an amount typed against the last position
  // must not survive a close, and neither must its refusal. Render-phase
  // adoption, so the first open frame is already the clean one.
  const [mode, setMode] = useState<AdjustMode>("add");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setMode("add");
      setAmount("");
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
  // otherwise cover the Apply button the amount is typed for.
  const keyboardHeight = useKeyboardState((state) => state.height);
  const keyboardPad = keyboardHeight > 0 ? keyboardHeight : RESTING_PAD;

  const isCross = position !== null && position.marginMode !== "isolated";
  const fieldsDisabled = position === null || isCross;

  // `toBigNumber`, not `new BigNumber`: the constructor THROWS on `""` and on
  // a half-typed `"."`, both of which are normal states of a live field.
  const typed = toBigNumber(amount);
  const hasAmount = typed.isFinite() && typed.gt(0);

  const submit = () => {
    if (position === null || isCross || !hasAmount) return;
    // The sign IS the verb — never an unsigned removal.
    void apply(mode === "remove" ? `-${amount}` : amount).then((result) => {
      if (result.kind === "done") {
        onOpenChange(false);
        return;
      }
      // Unknown keeps the sheet open with the note and no retry: a margin
      // move whose answer was lost may well have applied, and re-sending it
      // would move the margin twice.
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
            {position === null ? "Adjust Margin" : `${position.coin} Margin`}
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

        <Segment
          value={mode}
          isDisabled={fieldsDisabled}
          onValueChange={(value) => setMode(value as AdjustMode)}
        >
          <Segment.Group>
            <Segment.ScrollView>
              <Segment.Indicator />
              <Segment.Item value="add">
                <Segment.Label className="font-medium">Add</Segment.Label>
              </Segment.Item>
              <Segment.Item value="remove">
                <Segment.Label className="font-medium">Remove</Segment.Label>
              </Segment.Item>
            </Segment.ScrollView>
          </Segment.Group>
        </Segment>

        <InputGroup isDisabled={fieldsDisabled}>
          <InputGroup.Prefix isDecorative className="pr-2">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              Amount
            </Typography.Paragraph>
          </InputGroup.Prefix>
          <InputGroup.Input
            value={amount}
            onChangeText={(next) => {
              const accepted = acceptDecimalEdit(next, USDC_DECIMALS);
              if (accepted !== null) setAmount(accepted);
            }}
            placeholder="0"
            keyboardType="decimal-pad"
            inputMode="decimal"
            className="font-normal"
          />
          <InputGroup.Suffix isDecorative>
            <Typography.Paragraph className="text-xs text-muted font-normal">
              USDC
            </Typography.Paragraph>
          </InputGroup.Suffix>
        </InputGroup>

        {/* The server's own figures, verbatim — the two this action moves. */}
        <View className="gap-2">
          <InfoLine
            label="Position margin"
            value={position === null ? "--" : `${position.marginUsed} USDC`}
          />
          <InfoLine label="Liquidation price" value={position?.liquidationPx ?? "--"} />
        </View>

        {isCross ? (
          <Typography.Paragraph className="text-xs text-muted font-normal">
            This position is cross: it draws on the whole account for margin and has none of its own
            to move. Switch it to isolated first.
          </Typography.Paragraph>
        ) : (
          <Typography.Paragraph className="text-xs text-muted font-normal">
            Adding margin moves the liquidation price further away; removing it brings the
            liquidation price closer.
          </Typography.Paragraph>
        )}

        {error !== null ? (
          <Typography.Paragraph className="text-xs text-danger font-normal" numberOfLines={2}>
            {error}
          </Typography.Paragraph>
        ) : null}

        <Button
          variant="primary"
          isDisabled={position === null || isCross || applying || !hasAmount}
          onPress={submit}
        >
          <Button.Label className="font-medium">{applying ? "Applying…" : "Apply"}</Button.Label>
        </Button>
      </View>
    </ModalBottomSheet>
  );
}
