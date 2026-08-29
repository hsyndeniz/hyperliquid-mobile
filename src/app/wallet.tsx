/**
 * Wallet setup — create or import, on its own screen.
 *
 * Split out of the Account tab because putting a secret-entry field on a
 * browsing surface invited exactly the wrong glance: a paste box between a
 * status card and an about card reads as furniture. Here the field is the
 * whole screen, with room for the one decision that matters — new phrase, or
 * a secret you already hold.
 *
 * **One field accepts both secrets.** `importKind` classifies the paste (64
 * hex characters → private key, a BIP-39 word count → recovery phrase) and
 * the screen routes to `importPrivateKey` or `importMnemonic`; the caption
 * says what the field currently holds so a truncated paste is caught before
 * the button, not after. Classification is not validation — the import
 * functions still checksum for real.
 *
 * **Create reveals the phrase immediately.** The moment after generation is
 * the one time a user demonstrably has the phrase on screen; deferring the
 * backup prompt to "later" on the Account tab is how wallets end up holding
 * funds with `backedUp: false` forever.
 *
 * Both paths stop the live session first — its subscriptions carry the old
 * address — and both replace whatever wallet exists, which the header warns
 * about whenever there is one to lose.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Alert, Button, Card, Input, Typography } from "heroui-native";

import { importCaption, importKind } from "@/components/account/accountView";
import { RecoveryPhraseDialog } from "@/components/account/RecoveryPhraseDialog";
import { setCaptureProtection } from "@/components/account/screenCapture";
import { toHlError } from "@/hyperliquid/core/errors";
import {
  createWallet,
  importMnemonic,
  importPrivateKey,
  markBackedUp,
  revealRecoveryPhrase,
  walletState,
} from "@/hyperliquid/wallet/accounts";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

export default function WalletScreen(): JSX.Element {
  const { stop } = useHyperliquid();

  // The whole screen, not just the field: a typed or pasted recovery phrase is
  // on screen here exactly as it is in the reveal dialog, and the app-switcher
  // snapshot does not care that it sits in an input. `secureTextEntry` masks
  // it from a shoulder, not from the OS.
  useEffect(() => {
    void setCaptureProtection(true, "wallet-import");
    return () => {
      void setCaptureProtection(false, "wallet-import");
    };
  }, []);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [hasExisting, setHasExisting] = useState(false);
  useEffect(() => {
    void walletState().then((state) => setHasExisting(state.kind !== "none"));
  }, []);

  const [secret, setSecret] = useState("");
  const kind = importKind(secret);

  const [phrase, setPhrase] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);

  const onPaste = useCallback(() => {
    void Clipboard.getStringAsync().then((pasted) => {
      if (pasted) setSecret(pasted);
    });
  }, []);

  const onCreate = useCallback(async () => {
    setBusy(true);
    try {
      await stop();
      await createWallet();
      // The phrase, immediately — see the header. Read back through the vault
      // rather than kept from the create call, so this is the same words a
      // later reveal would show.
      setPhrase(await revealRecoveryPhrase("setup"));
      setIsRevealing(true);
    } catch (caught) {
      setNote(toHlError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [stop]);

  const onWroteItDown = useCallback(async () => {
    setBusy(true);
    try {
      await markBackedUp();
      setIsRevealing(false);
      setPhrase(null);
      router.back();
    } catch (caught) {
      setNote(toHlError(caught).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const onCloseReveal = useCallback((open: boolean) => {
    setIsRevealing(open);
    // Closing without confirming keeps the wallet (it exists either way) but
    // leaves backedUp false — the Account tab's warning chip carries it on.
    if (!open) {
      setPhrase(null);
      router.back();
    }
  }, []);

  const onImport = useCallback(async () => {
    if (kind === "invalid") return;
    setBusy(true);
    try {
      await stop();
      const imported =
        kind === "privateKey"
          ? await importPrivateKey(secret.trim())
          : await importMnemonic(secret.trim());
      setSecret("");
      setNote(`Imported ${imported.address.slice(0, 8)}…`);
      router.back();
    } catch (caught) {
      setNote(toHlError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [kind, secret, stop]);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 p-4">
      {hasExisting ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title className="font-semibold">This device already has a wallet</Alert.Title>
            <Alert.Description className="font-normal">
              Creating or importing replaces it. The current wallet stays recoverable only through
              its own phrase or key.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {note.length === 0 ? null : (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title className="font-semibold">That did not work</Alert.Title>
            <Alert.Description className="font-normal">{note}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <Card className="gap-3">
        <Typography.Paragraph className="font-semibold">New wallet</Typography.Paragraph>
        <Typography.Paragraph className="text-sm text-muted font-normal">
          Generates a recovery phrase on this device and shows it once, immediately. The phrase is
          kept in the Keychain and never leaves the phone.
        </Typography.Paragraph>
        <Button onPress={() => void onCreate()} isDisabled={busy}>
          <Button.Label className="font-medium">Create wallet</Button.Label>
        </Button>
      </Card>

      <Card className="gap-3">
        <Typography.Paragraph className="font-semibold">Import</Typography.Paragraph>
        <Input
          placeholder="Private key or recovery phrase"
          value={secret}
          onChangeText={setSecret}
          autoCapitalize="none"
          autoCorrect={false}
          // Masked like the secret it is; the caption below says what the
          // field holds, so visibility is not needed to know the paste took.
          secureTextEntry
          className="font-normal"
          testID="wallet-secret-input"
        />
        <Typography.Paragraph
          className={`text-xs font-normal ${
            kind === "invalid" && secret.trim().length > 0 ? "text-warning" : "text-muted"
          }`}
        >
          {importCaption(kind, secret)}
        </Typography.Paragraph>
        <View className="flex-row gap-2">
          <Button size="sm" variant="tertiary" onPress={onPaste} isDisabled={busy}>
            <Button.Label className="font-medium">Paste</Button.Label>
          </Button>
          <View className="flex-1">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => void onImport()}
              isDisabled={busy || kind === "invalid"}
            >
              <Button.Label className="font-medium">
                {kind === "mnemonic" ? "Import phrase" : "Import key"}
              </Button.Label>
            </Button>
          </View>
        </View>
      </Card>

      <RecoveryPhraseDialog
        phrase={phrase}
        isOpen={isRevealing}
        onOpenChange={onCloseReveal}
        onWroteItDown={() => void onWroteItDown()}
        busy={busy}
      />
    </ScrollView>
  );
}
