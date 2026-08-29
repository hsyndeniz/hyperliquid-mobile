/**
 * The address to send USDC to, and everything that must be true about the send.
 *
 * ## Why the address is not a field
 *
 * It is rendered, copyable and scannable — never editable, and never passed in
 * from a caller. It comes from `depositNetwork(env)` and nowhere else, because
 * `deposits/preflight.ts` is explicit: *"a deposit form with a destination
 * field is a phishing surface."* A component that accepted an address prop
 * would be that field wearing a different hat.
 *
 * ## One warning, then plain facts
 *
 * A deposit is a plain ERC-20 transfer on Arbitrum. Wrong chain, wrong token,
 * wrong decimals and below-minimum **all confirm on-chain** and are all
 * unrecoverable — there is no revert to learn from. That deserves one alarming
 * sentence at the top, not a "required" badge on every row: a screen where
 * everything is flagged reads as a screen where nothing is. The consequences
 * stay attached to the facts they belong to, in `depositFacts.ts`, and are shown
 * on the critical rows only.
 *
 * ## The QR payload is the bare address
 *
 * Not an EIP-681 `ethereum:…@42161/transfer?…` URI. Every exchange withdrawal
 * field accepts a bare address; EIP-681 parsing is inconsistent, and a
 * *partial* parse of a transfer URI is a native-token send to a contract
 * address — which is a new way to lose the funds, invented by the QR code.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCodeStyled from "react-native-qrcode-styled";
import { Alert, Button, Card, Typography, useThemeColor } from "heroui-native";

import { AddressText } from "@/components/money/AddressText";
import { depositFacts } from "@/components/money/depositFacts";
import type { DepositNetwork } from "@/hyperliquid/deposits/network";

/** How long the copied confirmation stays up. */
const COPIED_MS = 2_000;

export function BridgeAddressCard({
  network,
  depositor,
}: {
  network: DepositNetwork;
  /**
   * The session address. Shown as the "Must be sent from" fact — the one thing
   * this screen could not previously tell a user, and the one its primary flow
   * (copy the address into an exchange withdrawal) gets wrong.
   */
  depositor?: string | null;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const foreground = useThemeColor("foreground");

  const onCopy = useCallback(() => {
    void Clipboard.setStringAsync(network.bridge).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  }, [network.bridge]);

  return (
    <View className="gap-4">
      <Card className="items-center gap-5 py-6">
        <View className="rounded-3xl bg-background p-4">
          {/* The bare address — see the header for why not EIP-681. */}
          {/* `size`, not `pieceSize` — the SVG variant omits the latter. */}
          <QRCodeStyled data={network.bridge} size={168} padding={0} color={foreground} />
        </View>

        {/* Continuous, with the first and last four characters BOLD — the parts
            a human compares against the receiving screen. */}
        <View className="px-4">
          <AddressText
            address={network.bridge}
            className="text-center text-sm tabular-nums font-normal"
          />
        </View>

        <Button variant="secondary" onPress={onCopy}>
          <Button.Label className="font-medium">{copied ? "Copied" : "Copy address"}</Button.Label>
        </Button>
      </Card>

      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title className="font-semibold">
            Only {network.usdcSymbol} on {network.chainName}
          </Alert.Title>
          <Alert.Description className="font-normal">
            {/* The whole hazard in one sentence. Every wrong send here confirms
                on chain and is unrecoverable — there is nothing to revert. */}
            Anything else — another chain, another token, less than the minimum, or sent from an
            address that is not yours — confirms on chain and is gone.
          </Alert.Description>
        </Alert.Content>
      </Alert>

      <Card className="gap-0 py-1">
        {depositFacts(network, depositor).map((fact, index) => (
          <View
            key={fact.label}
            className={index === 0 ? "gap-1 py-3" : "gap-1 border-t border-border py-3"}
          >
            <View className="flex-row items-start justify-between gap-4">
              <Typography.Paragraph className="text-sm text-muted font-normal">
                {fact.label}
              </Typography.Paragraph>
              <Typography.Paragraph className="flex-1 text-right text-sm tabular-nums font-normal">
                {fact.value}
              </Typography.Paragraph>
            </View>
            {fact.consequence === undefined ? null : (
              // The consequence, not a generic caution. "It confirms and is not
              // credited" is what makes someone check; "be careful" is not.
              <Typography.Paragraph className="text-xs text-warning text-right font-normal">
                {fact.consequence}
              </Typography.Paragraph>
            )}
          </View>
        ))}
      </Card>
    </View>
  );
}
