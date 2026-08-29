/**
 * Deposit / withdraw, quote → echo → slide.
 *
 * A **bottom sheet**, not a centre dialog. This surface is a form the reader
 * types into and watches: the amount field, the fraction buttons and the live
 * quote all update together, and a bottom sheet keeps that column anchored
 * above the keyboard where a centred dialog fights it. It also matches how
 * every reference wallet presents a transfer.
 *
 * The echo section is not decoration — `confirmVaultTransfer` THROWS unless
 * the screen passes back exactly what it displayed: the vault's verbatim
 * name, the EIP-55 checksummed address, and the amount. A sheet that showed
 * only a friendly name literally could not construct the echo; that is the
 * preflight's defence against the live name-impersonation attack, and why
 * the address chunks render here in full.
 *
 * Warnings are DISPLAYED, every one, and auto-acknowledged on submit — the
 * `useWithdraw` arrangement. Blockers disable the slide.
 *
 * `unknown` renders the never-resend copy and offers no retry: a vault
 * transfer has no idempotency key, and a repeated deposit is a second
 * deposit that re-locks the whole balance.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { ModalBottomSheet, type Detent } from "@swmansion/react-native-bottom-sheet";
import { Alert, Button, Chip, Typography } from "heroui-native";
import { SlideButton } from "heroui-native-pro";

import { AddressText } from "@/components/money/AddressText";
import { AmountField } from "@/components/money/AmountField";
import { acceptEdit, amountForFraction } from "@/components/money/amountEntry";
import { useVaultTransfer } from "@/hyperliquid/hooks/vaults";
import { VAULT_LOCKUP_MS } from "@/hyperliquid/vaults/lockup";
import type { HyperliquidSession } from "@/hyperliquid/session";
import type { VaultDetail } from "@/hyperliquid/vaults/types";

/** Breathing room under the slide button when no keyboard is up. */
const RESTING_PAD = 32;

/**
 * Height used for the one layout pass before our own measurement lands. Only
 * ever applied while the sheet is closed, so it is never seen.
 */
const UNMEASURED_HEIGHT = 320;

/**
 * The dimming behind the sheet. Deliberate and even: without it the sheet's
 * top edge cuts a hard square line straight through whatever card it lands on,
 * which reads as a rendering artefact rather than a surface (observed live).
 * `scrimOpacities` defaults to 0 at a closed detent and 1 at an open one, so
 * this alpha IS the open value and the scrim fades in as the sheet rises.
 */
const SCRIM_COLOR = "rgba(0, 0, 0, 0.4)";

/** The shortcut fractions, as the reference wallets offer them. */
const FRACTIONS: [number, string][] = [
  [0.25, "25%"],
  [0.5, "50%"],
  [0.75, "75%"],
];

export function VaultTransferSheet({
  session,
  kind,
  vault,
  isOpen,
  onOpenChange,
}: {
  session: HyperliquidSession;
  kind: "deposit" | "withdraw";
  vault: VaultDetail;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [amount, setAmount] = useState("");
  const transfer = useVaultTransfer(session, { kind, vault, amount });
  const { quote, phase, position, available, refreshQuote } = transfer;

  // Every amount change restamps the quote's TTL. The quote is memoised
  // against the values the compiler can see it read, and the clock is not one
  // of them — without this it freezes at the first render and the slide is
  // refused for an expired quote it can never replace. See `useQuoteBasis`.
  // Batched with the amount update in the same handler, so it costs no render.
  const applyAmount = useCallback(
    (next: string) => {
      setAmount(next);
      refreshQuote();
    },
    [refreshQuote]
  );

  // A fresh open is a fresh intent — stale amounts and phases must not
  // survive a close. Deferred a tick so the effect never sets state
  // synchronously (the house rule every mount effect follows).
  useEffect(() => {
    // Opening is the other end of the window: the TTL should run from when the
    // user starts reading, not from whenever this sheet last rendered.
    if (isOpen) {
      refreshQuote();
      return;
    }
    const timer = setTimeout(() => {
      setAmount("");
      transfer.reset();
    }, 0);
    return () => clearTimeout(timer);
    // `transfer.reset` and `refreshQuote` are both stable (useCallback, no deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const max = kind === "deposit" ? available : (position?.equity ?? null);
  const onMax = useCallback(() => {
    if (max !== null) applyAmount(max);
  }, [max, applyAmount]);

  // The same fractions the reference wallets offer. `amountForFraction` is
  // the tested helper the Move sheet uses, so a quarter here is the same
  // arithmetic as a quarter there.
  const onFraction = useCallback(
    (fraction: number) => {
      if (max !== null) applyAmount(amountForFraction(max, fraction));
    },
    [max, applyAmount]
  );

  // Rejects a second decimal point, letters, a leading run of zeros — the
  // field never holds a string the quote cannot parse.
  const onChangeAmount = useCallback(
    (next: string) => {
      const accepted = acceptEdit(next);
      if (accepted !== null) applyAmount(accepted);
    },
    [applyAmount]
  );

  const lockupHours = Math.round(VAULT_LOCKUP_MS.maximum / (60 * 60 * 1000));

  // The library applies NO keyboard avoidance of its own, by design — the
  // content owns it. Growing the content by the keypad's height is what
  // raises the sheet, because the measurement below grows with it.
  // Selector-scoped so only the height re-renders this, not every keyboard
  // property.
  const keyboardHeight = useKeyboardState((state) => state.height);
  const keyboardPad = keyboardHeight > 0 ? keyboardHeight : RESTING_PAD;

  // WE measure the content; the library's `"content"` detent does not resolve
  // here. It takes the height from a marker view the library appends after
  // `children`, read back natively as `marker.frame.minY` — in this app that
  // arrives as 0, and `resolveDetent` then silently falls back to `maxHeight`.
  // Measured live: both transfer sheets sized to exactly 894pt (the window
  // less the status bar) despite having visibly different content, and the
  // open one parked with 84pt showing. An `onLayout` height is the same
  // dynamic sizing without that dependency.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height);
    // Guarded: an unconditional set re-renders on every identical layout pass,
    // and the sheet re-measures on each one.
    setContentHeight((current) => (current === next ? current : next));
  }, []);

  // Closed, then exactly as tall as the content we measured. BOTH stops must
  // exist: with a single-detent array `index={1}` clamps to 0, and the sheet
  // then renders permanently open — which looks exactly like content laid out
  // inline at the bottom of the page.
  const detents: Detent[] = [0, contentHeight ?? UNMEASURED_HEIGHT];

  const blocker = quote?.blockers[0] ?? null;
  const busy = phase.kind === "sending";
  const done = phase.kind === "sent";

  return (
    <ModalBottomSheet
      // Through the provider's portal, NOT `nativeOverlay`. With that flag the
      // native reparent never happened here: measured live, the sheet's
      // ancestors still ran `RNSScreenView → RNSScreenContentWrapper →
      // RNSSafeAreaView`, so it stayed trapped inside the pushed screen, sized
      // to that screen's box rather than the window, and drew no scrim.
      // `BottomSheetProvider` is mounted at the root above the navigator,
      // which is the geometry a modal sheet needs.
      detents={detents}
      index={isOpen ? 1 : 0}
      onIndexChange={(next) => onOpenChange(next > 0)}
      scrimColor={SCRIM_COLOR}
      surface={
        // Sized natively to the full sheet, so a shrinking content height
        // never exposes blank space behind it — hence `absoluteFill` rather
        // than a background on the content itself. `bg-background` rather than
        // a literal white so the sheet follows the theme.
        <View style={StyleSheet.absoluteFill} className="rounded-t-3xl bg-background" />
      }
    >
      <View
        onLayout={onContentLayout}
        className="gap-4 px-5 pt-4"
        style={{ paddingBottom: keyboardPad }}
      >
        <Typography.Paragraph className="text-lg font-semibold">
          {kind === "deposit" ? "Deposit to vault" : "Withdraw from vault"}
        </Typography.Paragraph>

        {done ? (
          <>
            <Alert status="success">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title className="font-semibold">Done</Alert.Title>
                <Alert.Description className="font-normal">{phase.note}</Alert.Description>
              </Alert.Content>
            </Alert>
            <Button onPress={() => onOpenChange(false)}>
              <Button.Label className="font-medium">Close</Button.Label>
            </Button>
          </>
        ) : phase.kind === "unknown" ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title className="font-semibold">Outcome unknown</Alert.Title>
              <Alert.Description className="font-normal">
                {/* No retry control, by design: a resend is a second
                    transfer, and a second deposit re-locks the whole
                    balance. The positions above have been re-read. */}
                The request may have gone through — check your position before doing anything else.
                Do not send it again.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <>
            <AmountField
              label={kind === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
              value={amount}
              onChange={onChangeAmount}
              onMax={max === null ? null : onMax}
              note={
                max === null
                  ? "Waiting for your balances…"
                  : `${kind === "deposit" ? "Available" : "Position equity"}: ${max} USDC`
              }
              error={blocker?.detail ?? null}
            />

            {/* Fractions of the SAME max the field's Max button uses, so the
                two can never disagree. Buttons, not a TagGroup: these are
                momentary actions that fill the field, not a selection that
                stays lit — a "50%" left highlighted would claim the amount
                is still half after the field was edited by hand. */}
            <View className="flex-row gap-2">
              {FRACTIONS.map(([value, label]) => (
                <View key={label} className="flex-1">
                  <Button
                    size="sm"
                    variant="tertiary"
                    isDisabled={max === null}
                    onPress={() => onFraction(value)}
                  >
                    <Button.Label className="font-medium">{label}</Button.Label>
                  </Button>
                </View>
              ))}
            </View>

            {/* Stated BEFORE a quote exists, because it is the thing most
                worth knowing before typing an amount — and the warning that
                carries it only appears once there is something to warn
                about. `maximum` is HLP's window; ordinary vaults are 24h. */}
            {kind === "deposit" ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title className="font-semibold">Deposits lock the balance</Alert.Title>
                  <Alert.Description className="font-normal">
                    A deposit re-locks your WHOLE position in this vault, not just the new money —
                    up to {lockupHours} hours here. The clock restarts on every deposit.
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}

            {phase.kind === "rejected" ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title className="font-semibold">Not sent</Alert.Title>
                  <Alert.Description className="font-normal">{phase.message}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}

            {quote !== null ? (
              <View className="gap-3 rounded-2xl bg-surface p-4">
                {/* The echo, visibly: verbatim name + checksummed address.
                    What renders here is what submit() passes back. */}
                <View className="gap-1">
                  <Typography.Paragraph className="text-xs text-muted font-normal">
                    {kind === "deposit" ? "Depositing to" : "Withdrawing from"}
                  </Typography.Paragraph>
                  <Typography.Paragraph className="font-semibold" numberOfLines={1}>
                    {quote.vault.name}
                  </Typography.Paragraph>
                  <AddressText
                    address={quote.vault.display}
                    className="text-xs tabular-nums font-normal"
                  />
                </View>

                <View className="flex-row items-center justify-between">
                  <Typography.Paragraph className="text-xs text-muted font-normal">
                    Amount
                  </Typography.Paragraph>
                  <Typography.Paragraph className="tabular-nums font-semibold">
                    {quote.amount} USDC
                  </Typography.Paragraph>
                </View>

                {quote.warnings.map((warning) => (
                  <View key={warning.code} className="flex-row items-start gap-2">
                    <Chip size="sm" color="warning" variant="soft">
                      <Chip.Label className="font-medium">!</Chip.Label>
                    </Chip>
                    <Typography.Paragraph className="flex-1 text-xs font-normal">
                      {warning.detail}
                    </Typography.Paragraph>
                  </View>
                ))}
              </View>
            ) : null}

            <View className="relative">
              <SlideButton
                variant="danger"
                isDisabled={quote === null || blocker !== null || busy}
                autoReset={false}
                // CONTROLLED, so a rejection re-arms the control.
                //
                // Uncontrolled with `autoReset={false}` the thumb latches
                // forever — `slide-button.animation.js` early-returns from both
                // `onBegin` and `onUpdate` while completed — so a transfer the
                // exchange REFUSED left a sheet showing a finished slider with
                // an error under it and no way to try again. The commonest way
                // in is mundane: read the lockup warning for longer than the
                // 60 s quote TTL and `confirmVaultTransfer` throws.
                //
                // Always `false`, and the type checker is what proves that is
                // right: at this point `phase.kind` narrows to `idle | rejected`,
                // because `sent` and `unknown` render their own branches above
                // and never reach here. Every phase that should LOOK completed
                // renders something else, so whenever this control exists at
                // all it should be armed.
                //
                // `unknown` keeping its own branch is what preserves the house
                // rule: that outcome means the transfer may have landed, and it
                // offers no retry control of any kind rather than a re-armed one.
                isCompleted={false}
                onComplete={() => {
                  if (quote === null) return;
                  void transfer.submit({
                    token: quote.token,
                    vaultAddressDisplayed: quote.vault.display,
                    vaultNameDisplayed: quote.vault.name,
                    amountDisplayed: quote.amount,
                  });
                }}
              >
                <SlideButton.ContainerBackground />
                <SlideButton.Thumb>
                  <SlideButton.ThumbBackground />
                </SlideButton.Thumb>
              </SlideButton>
              {/* Our overlay label — the beta clips UnderlayContent labels on
                  eagerly-mounted trees (the Account screen's measured fix,
                  same construction). */}
              <View
                className="absolute inset-0 items-center justify-center pointer-events-none"
                pointerEvents="none"
              >
                <Typography.Paragraph className="text-sm text-danger font-medium">
                  {busy
                    ? "Signing…"
                    : kind === "deposit"
                      ? "Slide to deposit"
                      : "Slide to withdraw"}
                </Typography.Paragraph>
              </View>
            </View>
          </>
        )}
      </View>
    </ModalBottomSheet>
  );
}
