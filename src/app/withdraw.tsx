/**
 * Withdraw — USDC off Hyperliquid, to YOUR wallet on Arbitrum.
 *
 * ## No destination field, deliberately
 *
 * A product decision, not a shortcut: this screen withdraws to the connected
 * wallet's own address, always. Sending value to someone else is the Send
 * screen's job. What the split buys:
 *
 * - **The riskiest input on the screen disappears.** Every withdrawal-to-a-typo
 *   story starts at a destination field; a screen with no field cannot host one.
 * - **The remaining decision is just the amount** — which is why the figure gets
 *   the whole upper half and the pad sits under the thumb.
 *
 * The address is still shown (a static line above the slider, the full
 *  checksummed form in the confirmation sheet) because "no field" must not decay
 * into "no idea where it goes". `useWithdraw` is simply fed the session's own
 * address; the whole quote → echo → ticket chain is unchanged, and
 * `confirmWithdrawal` still refuses an echo whose displayed address differs.
 *
 * ## The mover appears when it is the answer
 *
 * `insufficient_balance` here usually means "your USDC is in spot", not "you
 * have none" — withdrawals debit **perp**. So the perp↔spot mover is not a
 * permanent card competing for space; it is offered from the blocker that it
 * resolves, and only then.
 *
 * ## What this screen still refuses to do
 *
 * - **Retry.** A withdrawal has no idempotency key and no cancel; re-sending is
 *   a second withdrawal. An `unknown` outcome says so and offers no button.
 * - **Sweep a sub-account.** That context blocks withdrawal outright. The screen
 *   names the remedy and does not perform it — sweeping moves real money.
 * - **Scan a QR.** `expo-camera` is not installed. Paste covers the case.
 */

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Alert, Button, Card, Chip, Dialog, Typography } from "heroui-native";
import { EmptyState } from "heroui-native-pro";

import { AddressText } from "@/components/money/AddressText";
import { AmountPad } from "@/components/money/AmountPad";
import { EchoSheet } from "@/components/money/EchoSheet";
import { PerpSpotMove } from "@/components/money/PerpSpotMove";
import { maxState } from "@/components/money/withdrawView";
import { validateDestination } from "@/hyperliquid/transfers/destination";
import { WITHDRAW_FEE_USDC } from "@/hyperliquid/config/constants";
import { useAccountSummary, useSpotState } from "@/hyperliquid/hooks/account";
import { useCanTrade, useSessionState } from "@/hyperliquid/hooks/session";
import { useWithdraw } from "@/hyperliquid/hooks/withdraw";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

export default function WithdrawScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const { session } = useHyperliquid();
  // `useSessionState`, never `session.state()` in a render path — React Compiler
  // memoises the call and freezes it at whatever it returned first.
  const sessionState = useSessionState(session);
  const canTrade = useCanTrade(session);
  const summary = useAccountSummary(session.stores.account);
  const spot = useSpotState(session.stores.spot);

  const [amount, setAmount] = useState("");
  const [isConfirming, setIsConfirming] = useState(false);
  const [isMoving, setIsMoving] = useState(false);

  // The server's own figure. `accountValue - marginUsed` ignores resting-order
  // reservations and was wrong by $67k in Phase 6.
  const available = summary?.withdrawable ?? null;
  // `available`, NOT `total`. A spot balance's `hold` is money already
  // committed to resting orders — `total` includes it, and the mover was
  // offering it: Max filled more than could move, the overdraw gate waved it
  // through, and the exchange refused. With no agent that costs a real wallet
  // prompt the user approves before learning it cannot work. `sendView.ts`
  // states this rule and `sendableTokens` obeys it; these three call sites did
  // not, and the perp leg one line away had the identical bug fixed in Phase 6.
  const spotUsdc = spot?.balances.find((b) => b.coin === "USDC")?.available ?? null;

  // The session's OWN address — see the header. Never an input.
  const selfAddress = sessionState?.identity.address ?? "";
  const { quote, isChecking, phase, submit, reset, refreshQuote } = useWithdraw(session, {
    destinationInput: selfAddress,
    amount,
    available,
  });

  if (sessionState === null) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">No session</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              Start a session from the Portfolio tab to withdraw.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </View>
    );
  }

  if (phase.kind === "sent" || phase.kind === "unknown") {
    return (
      <View className="flex-1 bg-background px-4 pt-4">
        <Outcome phase={phase} onDismiss={reset} />
      </View>
    );
  }

  const max = available === null ? null : maxState(available);
  const blockers = quote?.blockers ?? [];
  const isBusy = phase.kind === "sending";
  // One line, not a stack of cards: the first blocker is the one to fix.
  const stopper = blockers[0] ?? null;
  const canMove = stopper?.code === "insufficient_balance";

  return (
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom + 12 }}>
      <AmountPad
        amount={amount}
        onChange={(next) => {
          setAmount(next);
          // Also here, not only on Review: a frozen `withdrawal_in_flight`
          // blocker DISABLES Review, so the button cannot be the thing that
          // refreshes it. Editing is then the only way out.
          refreshQuote();
        }}
        token="USDC"
        available={available}
        onMax={max?.kind === "usable" ? () => setAmount(max.gross) : null}
        isDisabled={isBusy}
        captionTone={stopper !== null ? "danger" : "muted"}
        caption={captionFor({ stopper, quote, max, isChecking, phase })}
      >
        {/* Where it goes — stated, not asked. The full checksummed form is in
            the confirmation sheet; this line keeps the fact on screen. */}
        <View className="flex-row items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3">
          <Typography.Paragraph className="text-sm text-muted font-normal">To</Typography.Paragraph>
          <View className="flex-row items-center gap-2">
            <Typography.Paragraph className="text-sm font-normal">Your wallet</Typography.Paragraph>
            <SelfAddress address={selfAddress} />
          </View>
        </View>
      </AmountPad>

      <View className="gap-3 px-4 pt-4">
        {canMove ? (
          // Offered by the blocker it resolves, rather than parked on the screen.
          <Button variant="tertiary" onPress={() => setIsMoving(true)}>
            <Button.Label className="font-medium">Move USDC from spot</Button.Label>
          </Button>
        ) : null}

        <Button
          isDisabled={quote === null || blockers.length > 0 || isBusy}
          onPress={() => {
            // Before opening, not after: the quote is memoised against values
            // the compiler can see, and the clock is not one of them. Without
            // this the TTL runs from the last keystroke — and a re-tap replays
            // the identical expired quote, which is a dead end rather than a
            // retry. Batched with `setIsConfirming`, so it costs no render.
            refreshQuote();
            setIsConfirming(true);
          }}
        >
          <Button.Label className="font-medium">
            {isBusy ? "Signing…" : "Review withdrawal"}
          </Button.Label>
        </Button>
      </View>

      {quote !== null ? (
        <EchoSheet
          quote={quote}
          isOpen={isConfirming}
          onOpenChange={setIsConfirming}
          isBusy={isBusy}
          onConfirm={(echo) => {
            void submit(echo).then(() => setIsConfirming(false));
          }}
        />
      ) : null}

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
              initialDirection="toPerp"
              availableSpot={spotUsdc}
              availablePerp={available}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}

/**
 * The OWN address, checksummed then truncated with bold ends — recognisable in
 * one line, and the same emphasis every other address rendering uses.
 */
function SelfAddress({ address }: { address: string }): JSX.Element | null {
  const result = validateDestination(address);
  if (!result.ok) return null;
  return <AddressText address={result.value.display} truncated />;
}

/**
 * The single line under the figure.
 *
 * Priority order matters: a blocker outranks the fee arithmetic, because a
 * "you will receive" under an amount that cannot be sent is noise. Below that,
 * "you will receive" outranks the standing fee note, since once an amount exists
 * the net is the more specific version of the same fact.
 */
function captionFor({
  stopper,
  quote,
  max,
  isChecking,
  phase,
}: {
  stopper: { code: string; detail: string } | null;
  quote: { amount: { net: string; gross: string } } | null;
  max: { kind: "usable" } | { kind: "unusable"; reason: string } | null;
  isChecking: boolean;
  phase: { kind: string; message?: string };
}): string {
  if (phase.kind === "rejected") return phase.message ?? "Not sent.";
  if (stopper !== null) return stopper.detail;
  if (isChecking) return "Checking this address…";
  if (quote !== null) return `You receive ${quote.amount.net} USDC after the fee`;
  if (max?.kind === "unusable") return max.reason;
  return `A ${WITHDRAW_FEE_USDC} USDC fee comes out of the amount. Arrives on Arbitrum in ~4 minutes.`;
}

/**
 * What happened, once something has been signed.
 *
 * Two outcomes reach here, and they are not the same thing wearing different
 * words. `sent` is a fact. `unknown` is an absence of one — and it must never
 * offer a retry, because the signature may have landed and a withdrawal has no
 * idempotency key.
 */
function Outcome({
  phase,
  onDismiss,
}: {
  phase: { kind: "sent"; net: string; arrivesAtMs: number } | { kind: "unknown"; message: string };
  onDismiss: () => void;
}): JSX.Element {
  if (phase.kind === "unknown") {
    return (
      <Card className="gap-3">
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title className="font-semibold">
              We do not know whether this was sent
            </Alert.Title>
            <Alert.Description className="font-normal">
              {/* Never "failed": absence of confirmation is not evidence of
                  absence. Never a retry: re-sending is a SECOND withdrawal. */}
              Check your Arbitrum wallet and the transfer history before doing anything else. Do not
              send it again — there is no way to cancel a withdrawal, so a second attempt would move
              the money twice.
            </Alert.Description>
          </Alert.Content>
        </Alert>
        <Typography.Paragraph className="text-xs text-muted font-normal">
          {phase.message}
        </Typography.Paragraph>
        <Button variant="tertiary" onPress={onDismiss}>
          <Button.Label className="font-medium">Back</Button.Label>
        </Button>
      </Card>
    );
  }

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <Typography.Paragraph className="text-sm font-semibold leading-5">
          Withdrawal sent
        </Typography.Paragraph>
        <Chip size="sm" variant="soft" color="success">
          <Chip.Label className="font-medium">on its way</Chip.Label>
        </Chip>
      </View>
      <Typography.Paragraph className="text-sm font-normal">
        {phase.net} USDC will arrive on Arbitrum <Countdown target={phase.arrivesAtMs} />.
      </Typography.Paragraph>
      <Typography.Paragraph className="text-xs text-muted font-normal">
        You can leave this screen. The next withdrawal is held until this one settles.
      </Typography.Paragraph>
      <Button variant="tertiary" onPress={onDismiss}>
        <Button.Label className="font-medium">Done</Button.Label>
      </Button>
    </Card>
  );
}

/**
 * Time until the expected arrival, ticking.
 *
 * A static "in about 4 minutes" is only true for the instant it was rendered,
 * and this screen is one a user watches. Past the estimate it says so rather
 * than counting up — a withdrawal running long is normal (the observed spread is
 * wide) and must never read as failed.
 */
function Countdown({ target }: { target: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const remainingMs = target - now;
  if (remainingMs <= 0) {
    // Never "late", never "failed". `reconcileWithdrawals` is the thing that
    // decides whether it landed, and absence is not evidence either way.
    return <>any moment now — check your Arbitrum wallet</>;
  }
  return <>in about {Math.max(1, Math.round(remainingMs / 60_000))} minutes</>;
}
