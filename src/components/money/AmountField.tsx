/**
 * A money amount, kept a **string** end to end.
 *
 * The house rule is that wire amounts never become numbers before the signature.
 * `canonicalAmount` accepts `string | BigNumber` and **not** `number`, by type —
 * a field that parsed here could not feed it. So this component never calls
 * `Number()` on what the user typed, and `onChange` hands back the raw text.
 *
 * ## Max is a claim that can be false
 *
 * `maxWithdrawable` returns the whole balance as the gross, deliberately not
 * fee-adjusted — pre-subtracting is the mistake that strands a dollar in the
 * account permanently. The consequence is that Max can return a value the floor
 * then rejects: `maxWithdrawable("1.5", "1")` is `"1.5"`, below the 2 USDC UI
 * floor. So the caller passes `onMax: null` when the number would not be usable,
 * and `maxNote` to say why — a disabled button with no explanation reads as a
 * bug.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Button, FieldError, InputGroup, Typography } from "heroui-native";

export function AmountField({
  label,
  value,
  onChange,
  /** `null` disables Max — the balance is unknown, or would not be usable. */
  onMax,
  /** Why Max is unavailable, or what the balance is. */
  note,
  /** Shown only once the field has been touched. */
  error,
  token = "USDC",
  isDisabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onMax: (() => void) | null;
  note?: string;
  error?: string | null;
  token?: string;
  isDisabled?: boolean;
}): JSX.Element {
  const isInvalid = value.trim().length > 0 && typeof error === "string" && error.length > 0;

  return (
    <View className="gap-2">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>

      <InputGroup isDisabled={isDisabled}>
        <InputGroup.Prefix isDecorative>
          <Typography.Paragraph className="text-sm text-muted font-normal">
            {token}
          </Typography.Paragraph>
        </InputGroup.Prefix>
        <InputGroup.Input
          value={value}
          onChangeText={onChange}
          placeholder="0.00"
          keyboardType="decimal-pad"
          inputMode="decimal"
          isInvalid={isInvalid}
        />
        <InputGroup.Suffix>
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={onMax === null || isDisabled}
            onPress={onMax ?? (() => {})}
          >
            <Button.Label className="font-medium">Max</Button.Label>
          </Button>
        </InputGroup.Suffix>
      </InputGroup>

      {note !== undefined ? (
        <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
          {note}
        </Typography.Paragraph>
      ) : null}

      <FieldError isInvalid={isInvalid}>{error ?? ""}</FieldError>
    </View>
  );
}
