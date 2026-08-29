/**
 * Deposit — address-first.
 *
 * The primary path is **paying in from somewhere else**: a user's funds are on
 * an exchange or in another wallet, so what they need is an address, a QR code
 * and the rules of the send. Executing a transfer from this device's own wallet
 * is a secondary path and is not built yet.
 *
 * ## Why this screen looks nothing like Withdraw
 *
 * Withdraw is amount-first: the figure is the decision, so it gets a display-size
 * hero and a number pad. A deposit has **no amount to enter here at all** — the
 * amount is typed into whatever exchange or wallet is doing the sending. What
 * this screen has to do is hand over an address that cannot be mistyped and
 * state the rules that make the send land. So the QR is the hero, and the facts
 * are a list.
 *
 * ## What this screen must never do
 *
 * - **Offer a destination field.** `deposits/preflight.ts` calls that a
 *   phishing surface. The address comes from `depositNetwork(env)`.
 * - **Show a fee.** There is none — 262.001324 sent credited "262.001324".
 *   `deposits/network.ts` says a screen showing one is inventing it.
 * - **Say "USDC" on testnet.** The bridge there watches a token whose symbol is
 *   `USDC2`; Circle's Sepolia USDC is a different, real, 6-decimal token on the
 *   same chain that this bridge silently keeps. The symbol comes from the
 *   network, never a literal.
 * - **Claim a credit is "your" deposit.** This screen did not send anything, so
 *   an arriving credit is reported as *a* deposit, not *yours*.
 *
 * ## Watching for arrival
 *
 * `checkArrival` matches a specific transfer by amount and time, which this
 * path has neither of. So the watcher reports `{type: "deposit"}` ledger rows
 * newer than the moment the screen opened. It watches the **ledger**, not a
 * balance, and deposits credit **perp** — a screen watching spot waits forever,
 * which `state/spot.ts` used to get wrong.
 */

import type { JSX } from "react";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Dialog, Spinner, Typography } from "heroui-native";
import { EmptyState } from "heroui-native-pro";

import { BridgeAddressCard } from "@/components/money/BridgeAddressCard";
import { PerpSpotMove } from "@/components/money/PerpSpotMove";
import { Usd } from "@/components/portfolio/primitives";
import { shortTime, useNowHourly } from "@/components/common/display";
import { DEPOSIT_CREDIT_MS } from "@/hyperliquid/deposits/network";
import { useDepositNetwork, useIncomingDeposits } from "@/hyperliquid/hooks/deposit";
import { useAccountSummary, useSpotState } from "@/hyperliquid/hooks/account";
import { useCanTrade, useSessionAddress, useSessionState } from "@/hyperliquid/hooks/session";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

export default function DepositScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const { session } = useHyperliquid();
  const sessionState = useSessionState(session);
  // `useSessionAddress`, not `session.address()` — a render-path method call is
  // memoised by React Compiler and freezes at whatever it returned first.
  const address = useSessionAddress(session);
  // THE MASTER, deliberately — not the effective (acting) address above.
  //
  // A bridge deposit is an Arbitrum ERC-20 transfer, and Hyperliquid credits
  // whichever wallet SENT it. A sub-account exists only inside the exchange:
  // nobody can send from it on Arbitrum, and nothing sent from the master
  // credits it. Feeding the acting address to the "must be sent from" fact
  // therefore named an address the user cannot send from, so the one check
  // that row exists for was made against the wrong value — and the arrival
  // watcher, keyed the same way, would never see the deposit that did land.
  const now = useNowHourly();
  const masterAddress = sessionState?.identity.address ?? null;
  const isSubAccount = masterAddress !== null && address !== null && masterAddress !== address;

  const env = sessionState?.config.env ?? null;
  const network = useDepositNetwork(env ?? "mainnet");
  const { credits } = useIncomingDeposits(masterAddress);
  const canTrade = useCanTrade(session);
  const spot = useSpotState(session.stores.spot);
  const summary = useAccountSummary(session.stores.account);
  const [isMoving, setIsMoving] = useState(false);

  // `null` until the first frame — the mover renders that as "loading", never
  // as an empty balance.
  // `available`, NOT `total`. A spot balance's `hold` is money already
  // committed to resting orders — `total` includes it, and the mover was
  // offering it: Max filled more than could move, the overdraw gate waved it
  // through, and the exchange refused. With no agent that costs a real wallet
  // prompt the user approves before learning it cannot work. `sendView.ts`
  // states this rule and `sendableTokens` obeys it; these three call sites did
  // not, and the perp leg one line away had the identical bug fixed in Phase 6.
  const spotUsdc = spot?.balances.find((b) => b.coin === "USDC")?.available ?? null;
  const perpUsdc = summary?.withdrawable ?? null;

  if (sessionState === null) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">No session</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              Start a session from the Portfolio tab to see your deposit address.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </View>
    );
  }

  if (network === null) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">Deposits unavailable</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              This network has no bridge configured. Nothing sent to it would be credited.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-4 gap-4"
      contentContainerStyle={{ paddingTop: 12, paddingBottom: insets.bottom + 24 }}
    >
      <Typography.Paragraph className="text-center text-sm text-muted font-normal">
        Send {network.usdcSymbol} on {network.chainName} to this address, from your own wallet. It
        credits your perps balance in about {Math.ceil(DEPOSIT_CREDIT_MS.observedMax / 1000)}{" "}
        seconds.
      </Typography.Paragraph>

      <BridgeAddressCard network={network} depositor={masterAddress} />
      {/* Said plainly rather than left to be inferred: the balance on screen
          belongs to the sub-account, and this deposit will not land in it. */}
      {isSubAccount ? (
        <Typography.Paragraph className="text-xs text-muted font-normal">
          A deposit always credits your main account, even while a sub-account is selected.
        </Typography.Paragraph>
      ) : null}

      <Card className="gap-3">
        <View className="flex-row items-center justify-between gap-3">
          <Typography.Paragraph className="text-sm font-semibold leading-5">
            Incoming
          </Typography.Paragraph>
          {credits.length === 0 ? (
            <View className="flex-row items-center gap-2">
              <Spinner size="sm" />
              <Typography.Paragraph className="text-xs text-muted font-normal">
                watching
              </Typography.Paragraph>
            </View>
          ) : null}
        </View>

        {credits.length === 0 ? (
          <Typography.Paragraph className="text-xs text-muted font-normal">
            {/* Measured, not documented: 5.7–10.0 s across five deposits. And
                nothing here can conclude a deposit is lost — absence is not
                evidence, so this never becomes an error. */}
            Nothing yet. A deposit usually credits within{" "}
            {Math.ceil(DEPOSIT_CREDIT_MS.observedMax / 1000)} seconds of confirming on{" "}
            {network.chainName}.
          </Typography.Paragraph>
        ) : (
          credits.map((credit) => (
            <View
              key={`${credit.at}:${credit.hash ?? ""}`}
              className="flex-row items-center justify-between gap-3 py-1"
            >
              {/* "A deposit", not "your deposit" — this screen did not send it
                  and cannot claim it. */}
              <Typography.Paragraph className="text-sm font-normal">
                A deposit arrived
              </Typography.Paragraph>
              <View className="items-end">
                <Typography.Paragraph className="text-sm font-semibold tabular-nums">
                  <Usd value={credit.usdc} />
                </Typography.Paragraph>
                <Typography.Paragraph className="text-xs text-muted tabular-nums font-normal">
                  {shortTime(credit.at, now)}
                </Typography.Paragraph>
              </View>
            </View>
          ))
        )}
      </Card>

      {/* Secondary, and phrased for what happens AFTER a deposit lands: it
          credits perp, so trading spot or predictions needs a move across. */}
      <Button variant="tertiary" onPress={() => setIsMoving(true)}>
        <Button.Label className="font-medium">Move between perps and spot</Button.Label>
      </Button>

      <Dialog isOpen={isMoving} onOpenChange={setIsMoving}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gap-4 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            {/* Title only — the Segment says the direction, the caption says
                the balances, and "instant and free" was furniture. */}
            <Dialog.Title className="font-semibold">Move USDC</Dialog.Title>
            <PerpSpotMove
              session={session}
              canTrade={canTrade}
              initialDirection="toSpot"
              availableSpot={spotUsdc}
              availablePerp={perpUsdc}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </ScrollView>
  );
}
