/**
 * A two-tap button for actions that spend money.
 *
 * Closing a position and cancelling an order are both irreversible in the sense
 * that matters: you cannot un-fill a market close, and a cancelled order loses
 * its queue position. Neither deserves a modal — a modal on every row is worse
 * than the mistake it prevents — but neither may be a single tap next to a
 * scrolling list either.
 *
 * So the first tap arms, the second commits, and an armed button **disarms
 * itself** after {@link ARM_MS}. That last part is the point: an armed button
 * left on screen becomes a single-tap button for whoever picks the phone up
 * next, which is the failure mode this was supposed to prevent.
 *
 * The armed label states the action in full ("Close 0.0002 BTC?"), because
 * "Confirm?" beside eight rows does not say which row is armed.
 *
 * Colour follows the same two steps: `danger-soft` at rest, solid `danger`
 * armed. Soft still reads as destructive — which it is, at both steps — without
 * turning a list of positions into a wall of red.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "heroui-native";

/** How long an armed button stays armed. */
export const ARM_MS = 4_000;

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  isBusy = false,
  isDisabled = false,
}: {
  label: string;
  /** Shown while armed. Name the specific thing, not "Confirm?". */
  confirmLabel: string;
  onConfirm: () => void;
  isBusy?: boolean;
  isDisabled?: boolean;
}): JSX.Element {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const onPress = useCallback(() => {
    if (!armed) {
      setArmed(true);
      return;
    }
    // Disarm BEFORE running: the action is async, and leaving it armed while
    // in flight allows a second commit on a double tap.
    setArmed(false);
    onConfirm();
  }, [armed, onConfirm]);

  return (
    <Button
      size="sm"
      // `danger-soft` at rest, solid `danger` when armed: the action is
      // destructive either way, so hiding that until the second tap understates
      // it — but a row of solid red buttons reads as an alarm rather than as a
      // control. The two-step colour matches the two-step commit.
      variant={armed ? "danger" : "danger-soft"}
      isDisabled={isDisabled || isBusy}
      onPress={onPress}
    >
      <Button.Label className="font-medium">
        {isBusy ? "…" : armed ? confirmLabel : label}
      </Button.Label>
    </Button>
  );
}
