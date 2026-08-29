/**
 * The confirmation, and the only place a withdrawal echo is constructed.
 *
 * ## Why the echo is built here and not by the screen
 *
 * `confirmWithdrawal` throws unless every echoed value equals the quoted one by
 * exact string comparison. That proves the values were **computed**. It cannot
 * prove they were **shown** — a handler can assemble a valid echo having
 * rendered nothing, which is exactly what `diagnostics.tsx` does.
 *
 * So this component renders `describeWithdrawal(quote).rows` and hands back
 * `describeWithdrawal(quote).echo` from the same result. The two cannot drift
 * without `withdrawView.test.ts` failing.
 *
 * ## The slide, not a button
 *
 * A withdrawal is final: no cancel, no status endpoint, no idempotency key. A
 * `SlideButton` costs a deliberate gesture rather than a tap that can happen by
 * accident on a scrolling list. `autoReset` is off — a completed slide has
 * already fired, and resetting it would invite a second one.
 *
 * ## Warnings are ticked, not skimmed
 *
 * `confirmWithdrawal` refuses unless `acknowledged` covers every warning code.
 * This sheet makes that a real interaction: the slide stays disabled until each
 * warning is checked, so the acknowledgement means something.
 */

import type { JSX } from "react";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Alert, Button, Checkbox, Dialog, Typography } from "heroui-native";
import { SlideButton } from "heroui-native-pro";

import { AddressText } from "@/components/money/AddressText";
import { describeWithdrawal } from "@/components/money/withdrawView";
import type { WithdrawalEcho, WithdrawalQuote } from "@/hyperliquid/transfers/preflight";

export function EchoSheet({
  quote,
  isOpen,
  onOpenChange,
  onConfirm,
  isBusy,
}: {
  quote: WithdrawalQuote;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives exactly the values this sheet displayed. */
  onConfirm: (echo: Omit<WithdrawalEcho, "acknowledged">) => void;
  isBusy: boolean;
}): JSX.Element {
  // Rows and echo from ONE call. Splitting this into two would be the bug.
  const described = describeWithdrawal(quote);

  // Ticks are stored against the quote token, which hashes every field of the
  // quote. Edit the amount and the token changes, so an acknowledgement made
  // against the old figures stops counting — otherwise a warning could be
  // satisfied by a tick the user gave to a different withdrawal.
  const [ticked, setTicked] = useState<{ token: string; codes: Record<string, boolean> }>({
    token: quote.token,
    codes: {},
  });
  const codes = ticked.token === quote.token ? ticked.codes : {};

  const outstanding =
    described.kind === "ready"
      ? described.mustAcknowledge.filter((code) => codes[code] !== true)
      : [];
  const canSlide = described.kind === "ready" && outstanding.length === 0 && !isBusy;

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="gap-4 bg-background">
          <Dialog.ContentBackground className="bg-surface" />

          <View className="gap-1">
            <Dialog.Title className="font-semibold">Confirm withdrawal</Dialog.Title>
            <Dialog.Description className="font-normal">
              This cannot be cancelled or reversed once sent.
            </Dialog.Description>
          </View>

          <ScrollView className="max-h-96" contentContainerClassName="gap-4">
            <View className="gap-3">
              {described.rows.map((row) => (
                <View key={row.label} className="gap-1">
                  <View className="flex-row items-stretch justify-between gap-3">
                    <View className="justify-center">
                      <Typography.Paragraph className="text-xs text-muted font-normal">
                        {row.label}
                      </Typography.Paragraph>
                    </View>
                    <View className="flex-1 items-end justify-center">
                      {/* An address renders continuous with BOLD ends — the
                          parts a human compares — via the one shared renderer.
                          Its spans reassemble to `row.value` exactly, so this
                          is emphasis, never a rewrite. */}
                      {row.chunks !== undefined ? (
                        <AddressText
                          address={row.value}
                          className="text-sm tabular-nums text-right font-normal"
                        />
                      ) : (
                        <Typography.Paragraph
                          className={
                            row.emphasis
                              ? "text-sm font-semibold tabular-nums text-right"
                              : "text-sm tabular-nums text-right font-normal"
                          }
                        >
                          {row.value}
                        </Typography.Paragraph>
                      )}
                    </View>
                  </View>
                  {row.caveat !== undefined ? (
                    <Typography.Paragraph className="text-xs text-muted text-right font-normal">
                      {row.caveat}
                    </Typography.Paragraph>
                  ) : null}
                </View>
              ))}
            </View>

            {described.advisories.map((advisory) => (
              <Alert key={advisory.code} status={advisory.tone}>
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title className="font-semibold">{titleFor(advisory.code)}</Alert.Title>
                  <Alert.Description className="font-normal">{advisory.detail}</Alert.Description>
                </Alert.Content>
              </Alert>
            ))}

            {described.kind === "ready"
              ? described.mustAcknowledge.map((code) => (
                  <View key={code} className="flex-row items-stretch gap-3">
                    <View className="justify-center">
                      <Checkbox
                        isSelected={codes[code] === true}
                        onSelectedChange={(next) =>
                          setTicked({ token: quote.token, codes: { ...codes, [code]: next } })
                        }
                      />
                    </View>
                    <View className="flex-1 justify-center">
                      <Typography.Paragraph className="text-sm leading-5 font-normal">
                        {ACKNOWLEDGEMENTS[code] ?? "I understand."}
                      </Typography.Paragraph>
                    </View>
                  </View>
                ))
              : null}
          </ScrollView>

          {described.kind === "ready" ? (
            <SlideButton
              variant="danger"
              isDisabled={!canSlide}
              // A completed slide has already fired. Resetting it would offer a
              // second withdrawal dressed as the same one.
              autoReset={false}
              onComplete={() => onConfirm(described.echo)}
            >
              <SlideButton.ContainerBackground />
              <SlideButton.UnderlayContent>
                <SlideButton.Label className="font-medium">
                  {isBusy
                    ? "Signing…"
                    : outstanding.length > 0
                      ? "Tick the warnings above"
                      : "Slide to withdraw"}
                </SlideButton.Label>
              </SlideButton.UnderlayContent>
              <SlideButton.OverlayContent>
                <SlideButton.Label className="font-medium">Release to send</SlideButton.Label>
              </SlideButton.OverlayContent>
              <SlideButton.Thumb>
                <SlideButton.ThumbBackground />
              </SlideButton.Thumb>
            </SlideButton>
          ) : (
            // A plain Button, not `Dialog.Close` — that is a round CloseButton
            // and clips a text label inside a circle.
            <Button variant="tertiary" onPress={() => onOpenChange(false)}>
              <Button.Label className="font-medium">Close</Button.Label>
            </Button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}

/** Short headings, so the Alert body carries the detail rather than repeating it. */
function titleFor(code: string): string {
  return code
    .split("_")
    .map((word, index) => (index === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * What ticking a warning actually asserts.
 *
 * Deliberately first-person and specific. "I understand" against an unexplained
 * code is a checkbox, not an acknowledgement.
 */
const ACKNOWLEDGEMENTS: Record<string, string> = {
  new_destination_account:
    "I know this address has never been seen on Hyperliquid, and I have checked it character by character.",
  destination_never_transacted:
    "I know this address has never sent a transaction, and I have checked it character by character.",
  third_party_destination: "I know this is not my own account, and funds sent here are gone.",
  checks_incomplete:
    "I know the destination could not be checked, and I am relying on my own verification.",
  balance_source_derived:
    "I know the available balance was estimated rather than read from the server.",
};
