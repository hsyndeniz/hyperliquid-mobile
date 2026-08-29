/**
 * The recovery phrase, shown once and gone.
 *
 * Shared by the wallet card ("back up later") and the wallet setup screen
 * (immediately after create — the single most important moment to show it).
 * The phrase arrives as a prop held by the caller only while the dialog is
 * open; this component never fetches, logs, or stores it.
 *
 * **Screen capture is blocked for as long as it is open.** The words were
 * drawn as ordinary text with nothing stopping a screenshot, a screen
 * recording, or — the one that needs no attacker at all — the app-switcher
 * snapshot the OS writes to disk the moment a notification pulls the user
 * away mid-backup. See `screenCapture.ts` for why every call there is
 * guarded, and note it is inert until the app is rebuilt with the native
 * module.
 */

import { useEffect, type JSX } from "react";
import { View } from "react-native";
import { Alert, Button, Dialog, Typography } from "heroui-native";

import { phraseWords } from "@/components/account/accountView";
import { setCaptureProtection } from "@/components/account/screenCapture";

export function RecoveryPhraseDialog({
  phrase,
  isOpen,
  onOpenChange,
  onWroteItDown,
  busy,
}: {
  /** `null` while closed — the caller clears it the moment the dialog shuts. */
  phrase: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onWroteItDown: () => void;
  busy: boolean;
}): JSX.Element {
  // Keyed on `isOpen`, not on mount: both callers keep this component mounted
  // and toggle the flag, so protecting on mount would leave capture blocked
  // for the whole screen's life — which is both wrong and invisible.
  useEffect(() => {
    void setCaptureProtection(isOpen, "recovery-phrase");
    // Released on close AND on unmount: an unmount while open (a navigation
    // away, a Fast Refresh) would otherwise leave the whole app unable to
    // screenshot anything until it restarts.
    return () => {
      void setCaptureProtection(false, "recovery-phrase");
    };
  }, [isOpen]);

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="gap-4 bg-background">
          <Dialog.ContentBackground className="bg-surface" />
          <Dialog.Title className="font-semibold">Recovery phrase</Dialog.Title>

          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title className="font-semibold">These words are the wallet</Alert.Title>
              <Alert.Description className="font-normal">
                Anyone who has them controls the funds. Write them on paper; never enter them
                anywhere but this app.
              </Alert.Description>
            </Alert.Content>
          </Alert>

          {phrase === null ? null : (
            <View className="flex-row flex-wrap gap-2">
              {phraseWords(phrase).map((entry) => (
                <View
                  key={entry.index}
                  className="flex-row items-center gap-1.5 rounded-xl bg-surface px-3 py-2"
                >
                  <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
                    {entry.index}
                  </Typography.Paragraph>
                  <Typography.Paragraph className="text-sm font-medium">
                    {entry.word}
                  </Typography.Paragraph>
                </View>
              ))}
            </View>
          )}

          <Button onPress={onWroteItDown} isDisabled={busy}>
            <Button.Label className="font-medium">I wrote it down</Button.Label>
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
