/**
 * Amount entry as the screen, not as a field.
 *
 * The figure being moved is the one thing a person is deciding, so it gets the
 * whole upper half at display size, and the keys that change it sit under the
 * thumb. A 44pt input box with a system keyboard covering two thirds of the
 * screen inverts that: the number is small and half-hidden behind the thing
 * used to type it.
 *
 * ## Why a pad and not the system keyboard
 *
 * `keyboardType="decimal-pad"` gives a keyboard whose layout, height and extra
 * keys belong to the OS. It also slides over the confirmation controls, which on
 * the withdraw screen meant the slide-to-confirm sat underneath it. `NumberPad`
 * is part of the layout, so nothing is ever occluded and the only keys that
 * exist are the ten that mean something here.
 *
 * ## The pad cannot produce an invalid amount
 *
 * Every keystroke goes through `acceptEdit`, which rejects a second decimal
 * point, a seventh decimal place, and anything that is not a digit. A rejected
 * key is inert — the value simply does not change — so there is no error state
 * to show and nothing to dismiss.
 */

import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { View } from "react-native";
import { Slider, Typography } from "heroui-native";
import { NumberPad } from "heroui-native-pro";

import {
  acceptEdit,
  amountForFraction,
  fractionOf,
  heroFontSize,
  heroText,
} from "@/components/money/amountEntry";

export function AmountPad({
  amount,
  onChange,
  /** The unit shown beside the figure. Never inferred — spot sends any token. */
  token,
  /** Under the hero: what they will receive, or why they cannot proceed. */
  caption,
  /** `danger` turns the caption red without needing a second component. */
  captionTone = "muted",
  /** The balance this is a share of. `null` while unread — the bar reads empty. */
  available,
  /** `null` when Max would offer something unusable; the caption then explains. */
  onMax,
  isDisabled,
  /**
   * Context rows, between the figure and the keys.
   *
   * Deliberately a slot rather than props: a withdrawal needs a destination, a
   * spot send needs a destination *and* a token, and a perp↔spot move needs
   * neither. Naming them here would make this component grow a field per caller.
   */
  children,
}: {
  amount: string;
  onChange: (value: string) => void;
  token: string;
  caption?: ReactNode;
  captionTone?: "muted" | "danger" | "success";
  available: string | null;
  onMax: (() => void) | null;
  isDisabled?: boolean;
  children?: ReactNode;
}): JSX.Element {
  // Bumped whenever a keystroke is refused, to remount `NumberPad` and clear
  // the internal ref it advanced before asking us. See the `key` below.
  const [padEpoch, setPadEpoch] = useState(0);
  const share = fractionOf(amount, available);

  return (
    <View className="flex-1 justify-between gap-4">
      <View className="flex-1 items-center justify-center gap-3 px-6">
        <View className="flex-row items-baseline gap-2">
          <Typography.Paragraph
            className="font-semibold tabular-nums"
            // `style`, not a `text-*` class: HeroUI's own size variant is part of
            // the component's className and wins the cascade, so a display size
            // set that way silently reverts to body text. The library documents
            // `style` as taking precedence, and this is what that is for.
            style={{ fontSize: heroFontSize(heroText(amount)), lineHeight: 72 }}
            numberOfLines={1}
          >
            {/* Never reformatted. A separator inserted here is a character the
                user did not type, inside the number they are approving. */}
            {heroText(amount)}
          </Typography.Paragraph>
          <Typography.Paragraph className="text-muted font-normal" style={{ fontSize: 26 }}>
            {token}
          </Typography.Paragraph>
        </View>

        {caption === undefined ? null : (
          <Typography.Paragraph
            className={
              captionTone === "danger"
                ? "text-sm text-danger text-center font-normal"
                : captionTone === "success"
                  ? "text-sm text-success text-center font-normal"
                  : "text-sm text-muted text-center font-normal"
            }
          >
            {caption}
          </Typography.Paragraph>
        )}
      </View>

      <View className="gap-4 px-4">
        {children}

        {/* A SLIDER, not a progress bar: the reference interaction is dragging
            a share of the balance, with the pad as the precise alternative.
            The two stay in lockstep — typing moves the thumb via `fractionOf`,
            dragging writes the amount via `amountForFraction`, and the float
            only ever exists as a gesture: money re-enters as a BigNumber string
            rounded DOWN to wire precision. */}
        <View className="gap-2">
          <View className="flex-row items-center justify-between gap-3">
            <Typography.Paragraph className="text-xs text-muted font-normal">
              {available === null
                ? "Balance loading…"
                : `Sending ${Math.round(share * 100)}% of your balance`}
            </Typography.Paragraph>
            {/* Max is the single most-used control on a screen like this.
                `null` disables it — see `maxState`, where "Max returned a value"
                is not the same as "Max is withdrawable". */}
            <MaxKey onPress={onMax} isDisabled={isDisabled} />
          </View>
          <Slider
            value={share}
            minValue={0}
            maxValue={1}
            step={0.01}
            isDisabled={isDisabled === true || available === null}
            onChange={(value) => {
              const fraction = Array.isArray(value) ? value[0] : value;
              onChange(amountForFraction(available, fraction));
            }}
          >
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        </View>

        <NumberPad
          // `key` REMOUNTS the pad, and that is the whole fix.
          //
          // `NumberPad` is semi-controlled: it advances its internal `valueRef`
          // to the proposed string BEFORE calling `onValueChange`, and resyncs
          // that ref from `value` only during a render. So when we reject an
          // edit nothing changes, nothing re-renders, the resync never runs,
          // and the phantom string stays in the ref — every later key appends
          // to it and is rejected too. The pad goes permanently dead with no
          // error state, and the React Compiler memoises this element, so an
          // ambient re-render from the live balance cannot heal it.
          //
          // Reached by fat-fingering `.` on `0.5`, or by typing a 7th decimal —
          // one key away right after Max, which fills six. Only backspace
          // recovers, which nobody discovers on a pad that looks broken.
          key={padEpoch}
          value={amount}
          isDisabled={isDisabled}
          onValueChange={(next) => {
            const accepted = acceptEdit(next);
            // Remount on anything that does not move the value forward.
            // `accepted === amount` covers the silent drift too: typing `0`
            // onto `0` proposes `"00"`, which normalises back to `"0"` and
            // would otherwise leave `"00"` behind in the ref.
            if (accepted === null || accepted === amount) {
              setPadEpoch((n) => n + 1);
              return;
            }
            onChange(accepted);
          }}
        >
          <NumberPad.Row>
            <NumberPad.Key value="1">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Key value="2">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Key value="3">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
          </NumberPad.Row>
          <NumberPad.Row>
            <NumberPad.Key value="4">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Key value="5">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Key value="6">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
          </NumberPad.Row>
          <NumberPad.Row>
            <NumberPad.Key value="7">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Key value="8">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Key value="9">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
          </NumberPad.Row>
          <NumberPad.Row>
            <NumberPad.Key value=".">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Key value="0">
              <NumberPad.KeyLabel className="font-medium" />
            </NumberPad.Key>
            <NumberPad.Backspace />
          </NumberPad.Row>
        </NumberPad>
      </View>
    </View>
  );
}

/**
 * Max, styled as part of the balance line rather than as a form control.
 *
 * Kept a plain pressable label: a filled button here competes with the primary
 * action at the bottom of every screen this appears on.
 */
function MaxKey({
  onPress,
  isDisabled,
}: {
  onPress: (() => void) | null;
  isDisabled?: boolean;
}): JSX.Element {
  const usable = onPress !== null && isDisabled !== true;

  return (
    <Typography.Paragraph
      className={usable ? "text-sm font-semibold text-accent" : "text-sm text-muted font-normal"}
      onPress={usable ? onPress : undefined}
      suppressHighlighting={!usable}
    >
      Max
    </Typography.Paragraph>
  );
}
