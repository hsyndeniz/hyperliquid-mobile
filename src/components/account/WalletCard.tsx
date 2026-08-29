/**
 * The wallet's standing state — what exists, whether it is backed up, and the
 * one destructive exit.
 *
 * Creating and importing live on the `/wallet` screen, not here: a
 * secret-entry field between a status card and an about card reads as
 * furniture, and a screen of its own gives the decision the space it needs.
 * The body of the Account screen's Wallet section. It keeps what is *ongoing*:
 * the backup nudge and slide-to-forget, the app's most destructive action. The
 * "not backed up" warning itself rides on the section's collapsed measure
 * (`walletMeasure`), so the nudge is visible without opening anything.
 *
 * The phrase dialog is `RecoveryPhraseDialog`, shared with the setup screen —
 * fetched when the dialog opens, cleared when it closes, never logged.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Button, Typography } from "heroui-native";
import { SlideButton } from "heroui-native-pro";

import { walletLine } from "@/components/account/accountView";
import { InfoRow } from "@/components/account/primitives";
import { RecoveryPhraseDialog } from "@/components/account/RecoveryPhraseDialog";
import { toHlError } from "@/hyperliquid/core/errors";
import {
  forgetWallet,
  markBackedUp,
  revealRecoveryPhrase,
  type WalletState,
} from "@/hyperliquid/wallet/accounts";

export function WalletCard({
  wallet,
  onWalletChanged,
  stopSession,
}: {
  /** `null` while the async Keychain read is in flight. */
  wallet: WalletState | null;
  /** Re-reads the vault after any mutation here. */
  onWalletChanged: () => void;
  /** Stops the live session before the wallet under it changes. */
  stopSession: () => Promise<void>;
}): JSX.Element {
  const line = walletLine(wallet);
  const ready = wallet?.kind === "ready" ? wallet.metadata : null;

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const [phrase, setPhrase] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);

  const onForget = useCallback(async () => {
    setBusy(true);
    try {
      await stopSession();
      await forgetWallet();
      setNote("Wallet removed from this device.");
      onWalletChanged();
    } catch (caught) {
      setNote(toHlError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [onWalletChanged, stopSession]);

  const onReveal = useCallback(async () => {
    setBusy(true);
    try {
      // Fetched at open, cleared at close — the phrase never outlives the
      // dialog in JS state.
      setPhrase(await revealRecoveryPhrase("export"));
      setIsRevealing(true);
    } catch (caught) {
      setNote(toHlError(caught).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const onCloseReveal = useCallback((open: boolean) => {
    setIsRevealing(open);
    if (!open) setPhrase(null);
  }, []);

  const onWroteItDown = useCallback(async () => {
    setBusy(true);
    try {
      await markBackedUp();
      onCloseReveal(false);
      onWalletChanged();
    } catch (caught) {
      setNote(toHlError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [onCloseReveal, onWalletChanged]);

  return (
    <View className="gap-3">
      <InfoRow label={line.title} value={line.detail} tone={line.tone} />

      {note.length === 0 ? null : (
        <Typography.Paragraph className="text-xs text-muted font-normal">
          {note}
        </Typography.Paragraph>
      )}

      <View className="flex-row flex-wrap gap-2">
        {ready?.kind === "seeded" ? (
          <Button size="sm" variant="secondary" onPress={() => void onReveal()} isDisabled={busy}>
            <Button.Label className="font-medium">
              {ready.backedUp ? "Show recovery phrase" : "Back up recovery phrase"}
            </Button.Label>
          </Button>
        ) : null}
        <Button
          size="sm"
          {...(wallet?.kind === "none" ? {} : { variant: "tertiary" as const })}
          onPress={() => router.push("/wallet")}
          isDisabled={busy}
        >
          <Button.Label className="font-medium">
            {wallet?.kind === "none" ? "Set up wallet" : "Replace wallet"}
          </Button.Label>
        </Button>
      </View>

      {wallet !== null && wallet.kind !== "none" ? (
        // The label is OUR overlay, not `SlideButton.UnderlayContent`: the
        // library clips the underlay to a measured track width, and on this
        // eagerly-mounted tab the measurement never lands — the send screen's
        // dialog-mounted instance is fine, this one rendered an empty grey
        // track (observed live). A static centred layer cannot be clipped away.
        <View className="relative">
          <SlideButton
            variant="danger"
            isDisabled={busy}
            autoReset
            onComplete={() => void onForget()}
          >
            <SlideButton.ContainerBackground />
            <SlideButton.Thumb>
              <SlideButton.ThumbBackground />
            </SlideButton.Thumb>
          </SlideButton>
          <View
            className="absolute inset-0 items-center justify-center pointer-events-none"
            pointerEvents="none"
          >
            <Typography.Paragraph className="text-sm text-danger font-medium">
              Slide to forget wallet
            </Typography.Paragraph>
          </View>
        </View>
      ) : null}

      <RecoveryPhraseDialog
        phrase={phrase}
        isOpen={isRevealing}
        onOpenChange={onCloseReveal}
        onWroteItDown={() => void onWroteItDown()}
        busy={busy}
      />
    </View>
  );
}
