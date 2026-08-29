/**
 * Who this device is, and the four things you actually came here to do.
 *
 * Replaces the flip card. The flip was clever and wrong: it hid the actions
 * behind a gesture nobody is told about, spent a fixed 224pt of height on a
 * decorative back face, and put the QR at 52pt on the front — too small to
 * scan, so the "receive" case still needed the flip. Every reference wallet
 * does the same simpler thing instead: identity on top, a row of circular
 * actions beneath, and the QR full-size in a sheet when asked for.
 *
 * The actions are one `PressableFeedback` each, wrapping a plain circular
 * `View` — deliberately NOT a `Button` inside a `Pressable`. Nesting two
 * pressables is what made chips swallow row taps twice (the inner one eats the
 * finger, its AX element eats the synthesized tap), and here the label sits
 * outside the circle, so the tappable unit has to be the whole column.
 *
 * The address is the MASTER wallet's. Acting-as (a selected sub-account) is
 * session detail and lives in the Session section; a QR of a sub-account
 * address would be a deposit trap, since sub-accounts cannot receive bridge
 * deposits.
 *
 * The QR payload is the bare address, not an EIP-681 URI — the same decision
 * `BridgeAddressCard` documents: a *partial* parse of a transfer URI is a
 * native-token send to a contract address, a way to lose funds invented by the
 * QR code itself.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import QRCodeStyled from "react-native-qrcode-styled";
import { Avatar, Chip, Dialog, PressableFeedback, Typography, useThemeColor } from "heroui-native";
import { Check, Copy, LogIn, LogOut, QrCode, Wallet, type LucideIcon } from "lucide-react-native";

import { avatarLabel, type StatusLine } from "@/components/account/accountView";
import { StatusDot } from "@/components/account/primitives";
import { TONE_TEXT } from "@/components/account/accountView";
import { AddressText } from "@/components/money/AddressText";
import type { HlEnv } from "@/hyperliquid/types/domain";

/** How long the copied confirmation stays up. */
const COPIED_MS = 2_000;

/** Big enough to scan off a screen at arm's length. */
const QR_SIZE = 220;

export function IdentityHero({
  address,
  env,
  phase,
  isLive,
  busy,
  onSignIn,
  onSignOut,
}: {
  /** The master wallet address, or `null` while none exists. */
  address: string | null;
  env: HlEnv;
  phase: StatusLine;
  /** Drives the fourth action between sign-in and sign-out. */
  isLive: boolean;
  busy: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const onCopy = useCallback(() => {
    if (address === null) return;
    void Clipboard.setStringAsync(address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  }, [address]);

  const envChip =
    env === "testnet" ? (
      <Chip size="sm" color="warning" variant="soft">
        <Chip.Label className="font-medium">Testnet</Chip.Label>
      </Chip>
    ) : (
      <Chip size="sm" color="success" variant="soft">
        <Chip.Label className="font-medium">Mainnet</Chip.Label>
      </Chip>
    );

  return (
    <View className="gap-4 rounded-3xl bg-surface p-5">
      <View className="flex-row items-center gap-3">
        <Avatar size="lg" alt={address === null ? "no wallet" : `wallet ${avatarLabel(address)}`}>
          <Avatar.Fallback>
            <Typography.Paragraph className="font-semibold">
              {avatarLabel(address)}
            </Typography.Paragraph>
          </Avatar.Fallback>
        </Avatar>

        <View className="flex-1 gap-1">
          {address === null ? (
            <Typography.Heading className="font-bold">No wallet</Typography.Heading>
          ) : (
            <AddressText address={address} truncated className="text-xl tabular-nums font-normal" />
          )}
          <View className="flex-row items-center gap-2">
            <StatusDot tone={phase.tone} />
            <Typography.Paragraph className={`text-sm font-medium ${TONE_TEXT[phase.tone]}`}>
              {phase.label}
            </Typography.Paragraph>
          </View>
        </View>

        {envChip}
      </View>

      <View className="flex-row gap-2">
        {/* Receive and Copy need an address to mean anything; with no wallet
            they are disabled rather than hidden, so the row does not reflow
            into three wide columns the moment a wallet appears. */}
        <HeroAction
          icon={QrCode}
          label="Receive"
          onPress={() => setShowQr(true)}
          isDisabled={address === null}
        />
        <HeroAction
          icon={copied ? Check : Copy}
          label={copied ? "Copied" : "Copy"}
          onPress={onCopy}
          isDisabled={address === null}
        />
        <HeroAction icon={Wallet} label="Wallet" onPress={() => router.push("/wallet")} />
        <HeroAction
          icon={isLive ? LogOut : LogIn}
          label={isLive ? "Sign out" : "Sign in"}
          onPress={isLive ? onSignOut : onSignIn}
          // Only the sign-OUT direction is subordinate. See `isQuiet`.
          isQuiet={isLive}
          // Signing in needs something to sign in AS.
          isDisabled={busy || (!isLive && address === null)}
        />
      </View>

      <Dialog isOpen={showQr} onOpenChange={setShowQr}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="items-center gap-4 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            <Dialog.Title className="font-semibold">Receive address</Dialog.Title>
            {address === null ? null : (
              <>
                {/* White plate under the code: a dark-theme QR drawn in the
                    foreground colour on a dark surface is low-contrast enough
                    that some scanners refuse it. */}
                <View className="rounded-2xl bg-background p-4">
                  <QRCodeStyled data={address} size={QR_SIZE} padding={0} color={foreground} />
                </View>
                {/* Full, untruncated — the code is only trustworthy if the
                    address under it can be read in full. */}
                <AddressText address={address} className="text-sm tabular-nums font-normal" />
                <Typography.Paragraph className="text-center text-xs text-muted font-normal">
                  This is the master wallet on {env === "testnet" ? "testnet" : "mainnet"}. Sending
                  from another network loses the funds.
                </Typography.Paragraph>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}

/** One circular action: icon in a circle, label beneath, both one target. */
function HeroAction({
  icon: Icon,
  label,
  onPress,
  isDisabled = false,
  isQuiet = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  /**
   * Subordinate weight — muted icon and label, no filled disc.
   *
   * For an action that ENDS something. Sign out sat here in the same filled
   * circle as Copy, at identical weight, which put "put an address on the
   * clipboard" and "tear down the session" on one visual footing. It is not
   * destructive (you sign back in), so this is hierarchy rather than a
   * safeguard — a quieter treatment, not a confirmation dialog.
   *
   * Applied by DIRECTION, not to the slot: when the session is down, that same
   * slot reads "Sign in" and is the most important control on the screen, so it
   * keeps full weight. Quieting the slot rather than the verb would have hidden
   * the one thing a signed-out user needs.
   */
  isQuiet?: boolean;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  const mutedColor = useThemeColor("muted");
  const iconColor = isDisabled || isQuiet ? mutedColor : foreground;

  return (
    <PressableFeedback
      className="flex-1 items-center gap-2"
      onPress={onPress}
      isDisabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View
        className={`h-14 w-14 items-center justify-center rounded-full ${
          isQuiet ? "" : "bg-background"
        } ${isDisabled ? "opacity-40" : ""}`}
      >
        <Icon size={20} color={iconColor} />
      </View>
      <Typography.Paragraph
        className={`text-xs font-medium ${isDisabled || isQuiet ? "text-muted" : ""}`}
        numberOfLines={1}
      >
        {label}
      </Typography.Paragraph>
    </PressableFeedback>
  );
}
