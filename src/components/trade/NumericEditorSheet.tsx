/**
 * A dialog for editing one number: a large field on the system keyboard,
 * preset chips, an optional live readout, one commit button.
 *
 * One component, retitled and re-chipped per field, rather than a bespoke
 * editor per input: every numeric field on the order sheet opens the same
 * surface, so the hand learns it once.
 *
 * ## Why the system keyboard here, and a NumberPad on the money screens
 *
 * `AmountPad` exists because a withdrawal is a whole SCREEN about one figure:
 * the amount gets the upper half at display size, and a system keyboard would
 * slide over the slide-to-confirm underneath it. An order field is the
 * opposite shape — a small correction to one of a dozen values on a ticket
 * you are still reading — so it gets a dialog and the OS keyboard, which
 * costs no layout and dismisses itself.
 *
 * ## The field cannot hold an invalid value
 *
 * Every edit goes through `acceptDecimalEdit(next, decimals)`; a rejected
 * string leaves the state untouched, and because the `TextInput` is
 * CONTROLLED, React rewrites the field back on the next render. That is the
 * whole guard — there is no error state because no invalid state is
 * representable. (`keyboardType="decimal-pad"` is a hint, not a contract:
 * hardware keyboards, paste and dictation all reach `onChangeText` freely.)
 * The locale separator is normalised first — see `normalizeDecimalInput`.
 *
 * ## A bottom sheet, and what that costs
 *
 * This was a heroui `Dialog` — chosen because `Dialog.Portal` renders through
 * an iOS `FullWindowOverlay` and so floated above the `/order` modal route
 * without ceremony, sidestepping the reparenting the sheet BEFORE it had
 * needed. It is a sheet again by request, so that ceremony is back and is
 * handled here rather than rediscovered:
 *
 * - **Detents are MEASURED, not `'content'`.** The library's content detent
 *   resolves to zero in this tree and silently falls back to full height (the
 *   `VaultTransferSheet` finding). Both stops must exist too — a single-detent
 *   array clamps index 1 to 0 and the sheet renders permanently open.
 * - **The library applies no keyboard avoidance, by design.** This editor
 *   `autoFocus`es a field, so the decimal pad would cover the commit button
 *   the number is being typed for. The content owns it: the pad grows the
 *   measured height, and the sheet rises with it.
 * - **Which portal it uses is empirical, not obvious.** `nativeOverlay`
 *   reparents into a window-level overlay, which is what a sheet opened inside
 *   a native modal screen needs; but `VaultTransferSheet` measured that flag
 *   NOT reparenting from a pushed screen. `/order` is now a native-stack screen
 *   inside a `containedTransparentModal` card, so the setting below is the one
 *   that was verified on device for THAT shape — do not flip it from first
 *   principles.
 */

import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { ModalBottomSheet, type Detent } from "@swmansion/react-native-bottom-sheet";
import { useKeyboardState } from "react-native-keyboard-controller";
import { Button, InputGroup, Typography } from "heroui-native";

import { acceptDecimalEdit } from "@/components/trade/orderForm";
import { normalizeDecimalInput } from "@/components/trade/orderSheetView";

/** Height used until the content reports its own — see the header. */
const UNMEASURED_HEIGHT = 320;

/** The even dimming the sibling sheets settled on. */
const SCRIM_COLOR = "rgba(0, 0, 0, 0.4)";

/** The resting bottom pad, as a number the keyboard can replace. */
const RESTING_PAD = 32;

export interface EditorChip {
  label: string;
  /** The draft this chip writes. `""` renders the chip disabled — the anchor
      it derives from is unread, and a dead chip is honest where a zero is
      a lie. */
  value: string;
}

export function NumericEditorSheet({
  isOpen,
  onOpenChange,
  title,
  subtitle,
  unit,
  decimals,
  value,
  chips,
  commitLabel = "Set",
  onCommit,
  onClear,
  clearLabel = "Remove",
  renderReadout,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  /** Shown beside the field — a currency or the asset symbol. */
  unit?: string;
  /** Fraction cap for `acceptDecimalEdit`; `<= 0` means whole numbers only. */
  decimals: number;
  /** The committed value this editor opens on. Seeds the draft per open. */
  value: string;
  chips?: readonly EditorChip[];
  commitLabel?: string;
  onCommit: (value: string) => void;
  /** When present, a second action that commits "empty" — TP/SL removal. */
  onClear?: () => void;
  clearLabel?: string;
  /** Live readout rows under the field, recomputed per keystroke. */
  renderReadout?: (draft: string) => ReactNode;
}): JSX.Element {
  // Render-phase adoption per open: the first frame shows the committed
  // value, and no stale draft survives a close.
  const [draft, setDraft] = useState(value);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setDraft(value);
  }

  const commit = () => {
    if (draft === "") return;
    onCommit(draft);
    onOpenChange(false);
  };

  // WE measure the content; `'content'` resolves to zero here. Guarded set so
  // identical layout passes do not re-render.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const onContentLayout = (event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height);
    setContentHeight((prev) => (prev === next ? prev : next));
  };
  const detents: Detent[] = [0, contentHeight ?? UNMEASURED_HEIGHT];

  const keyboardHeight = useKeyboardState((state) => state.height);
  const keyboardPad = keyboardHeight > 0 ? keyboardHeight : RESTING_PAD;

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
        style={{ paddingBottom: keyboardPad }}
      >
        <View className="gap-1">
          <Typography.Paragraph className="text-lg font-semibold">{title}</Typography.Paragraph>
          {subtitle === undefined ? null : (
            <Typography.Paragraph className="text-sm text-muted tabular-nums font-normal">
              {subtitle}
            </Typography.Paragraph>
          )}
        </View>

        <InputGroup>
          <InputGroup.Input
            value={draft}
            onChangeText={(next) => {
              // The comma first: a `decimal-pad` shows the LOCALE
              // separator, and this simulator's own locale renders "," —
              // without normalising, its only separator key is rejected
              // on every press and a fraction cannot be typed at all.
              const accepted = acceptDecimalEdit(normalizeDecimalInput(next), decimals);
              if (accepted !== null) setDraft(accepted);
            }}
            // A hint, not a guard — the filter above is the guard.
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder="0"
            autoFocus
            // The field opens on a committed value; selecting it means the
            // first keystroke REPLACES rather than appends, which is what
            // "edit this number" almost always means.
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={commit}
            className="text-2xl tabular-nums font-semibold"
          />
          {unit === undefined ? null : (
            // `isDecorative`: the unit is a label, so a tap on it should
            // focus the field underneath rather than swallow the touch.
            <InputGroup.Suffix isDecorative>
              <Typography.Paragraph className="text-base text-muted font-normal">
                {unit}
              </Typography.Paragraph>
            </InputGroup.Suffix>
          )}
        </InputGroup>

        {chips === undefined ? null : (
          <View className="flex-row gap-2">
            {chips.map((chip) => (
              <Button
                key={chip.label}
                variant="tertiary"
                size="sm"
                className="flex-1"
                isDisabled={chip.value === ""}
                onPress={() => {
                  // Truncated to THIS editor's precision: a 6dp chip in a
                  // 2dp editor would seed a draft the filter then rejects
                  // every edit to. Slice, not round — for positive amounts
                  // that is ROUND_DOWN, so a Max chip can never exceed
                  // what it was cut from.
                  const [whole = "", fraction] = chip.value.split(".");
                  setDraft(
                    fraction === undefined || decimals <= 0
                      ? whole
                      : `${whole}.${fraction.slice(0, decimals)}`
                  );
                }}
              >
                <Button.Label className="text-xs tabular-nums font-medium">
                  {chip.label}
                </Button.Label>
              </Button>
            ))}
          </View>
        )}

        {renderReadout === undefined ? null : renderReadout(draft)}

        <View className="flex-row gap-3">
          {onClear === undefined ? null : (
            <Button
              variant="tertiary"
              className="flex-1"
              onPress={() => {
                onClear();
                onOpenChange(false);
              }}
            >
              <Button.Label className="font-medium">{clearLabel}</Button.Label>
            </Button>
          )}
          <Button variant="primary" className="flex-1" isDisabled={draft === ""} onPress={commit}>
            <Button.Label className="font-medium">{commitLabel}</Button.Label>
          </Button>
        </View>
      </View>
    </ModalBottomSheet>
  );
}
