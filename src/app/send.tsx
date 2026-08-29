/**
 * Send — a spot token to another Hyperliquid account.
 *
 * ## Same shape as Withdraw, different flow underneath
 *
 * Amount-first: hero figure, slider, pad, context rows between them. The
 * differences are the whole reason this is a separate screen rather than a mode:
 *
 * - **Any held token**, not USDC-only — `spotSend` carries a `token` field that
 *   `withdraw3` does not have. The picker offers what the balances hold, never
 *   the full catalogue: a zero-balance token in the list is a refusal waiting to
 *   be misread as a bug.
 * - **No fee, no floor, no bridge.** The money never leaves Hyperliquid, so
 *   showing a fee row here would be inventing one — the same rule
 *   `deposits/network.ts` states for deposits.
 * - **Instant.** No arrival watch, no settlement floor, no in-flight guard.
 *
 * What it keeps from Withdraw is finality: no cancel, no undo, so the confirm
 * dialog renders the checksummed destination in full and commits by slide.
 *
 * ## Not from a sub-account
 *
 * `spotSend` is master-signed and debits the master, whatever context the app
 * is viewing. Blocking is honest; silently sending the master's money while the
 * UI says a sub-account would be the worst version.
 */

import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Alert, Button, Card, Chip, Dialog, PressableFeedback, Typography } from "heroui-native";
import { EmptyState, SlideButton } from "heroui-native-pro";

import { AddressText } from "@/components/money/AddressText";
import { AmountPad } from "@/components/money/AmountPad";
import { amountForFraction } from "@/components/money/amountEntry";
import { CoinBadge } from "@/components/portfolio/primitives";
import { DestinationRow } from "@/components/money/DestinationRow";
import { planSend, sendableTokens, type SendableToken } from "@/components/money/sendView";
import { useSpotState } from "@/hyperliquid/hooks/account";
import { useSend } from "@/hyperliquid/hooks/send";
import { useSessionState } from "@/hyperliquid/hooks/session";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

export default function SendScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const { session } = useHyperliquid();
  // `useSessionState`, never `session.state()` in a render path — React Compiler
  // memoises the call and freezes it at whatever it returned first.
  const sessionState = useSessionState(session);
  const spot = useSpotState(session.stores.spot);

  const [tokenName, setTokenName] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [destinationInput, setDestinationInput] = useState("");
  const [isPicking, setIsPicking] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  const { phase, send, reset } = useSend(session);

  if (sessionState === null) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title className="font-semibold">No session</EmptyState.Title>
            <EmptyState.Description className="font-normal">
              Start a session from the Portfolio tab to send.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </View>
    );
  }

  const tokens = sendableTokens(spot?.balances ?? null);
  // A token the user PICKED is never substituted — it resolves to itself or to
  // nothing.
  //
  // `tokens` comes from the live spot store, so a balance reaching zero (a
  // resting sell filling, a transfer from another device) removes that token
  // from the list mid-session. A blanket `?? tokens[0]` therefore silently
  // re-pointed an explicit choice at the largest OTHER holding — including
  // while the confirm dialog was already open on the original one, which
  // would have sent the wrong asset. Falling through to `null` raises the
  // existing `no_token` blocker instead, which is the honest answer: the
  // thing you chose is no longer sendable.
  //
  // The default (nothing picked yet) keeps its old behaviour: USDC when held,
  // else the largest holding.
  const token: SendableToken | null =
    tokenName === null
      ? (tokens.find((t) => t.name === "USDC") ?? tokens[0] ?? null)
      : (tokens.find((t) => t.name === tokenName) ?? null);

  const plan = planSend({
    token,
    amount,
    destinationInput,
    selfAddress: sessionState.identity.address,
    subAccount: sessionState.identity.subAccount,
  });
  const isBusy = phase.kind === "sending";
  const stopper = plan.blockers[0] ?? null;
  // Only surface a blocker the user has started tripping — an untouched form
  // reading "Enter an amount" in red is nagging, not information.
  const visibleStopper =
    stopper !== null &&
    (amount.length > 0 || destinationInput.length > 0) &&
    stopper.code !== "no_token"
      ? stopper
      : null;

  if (phase.kind === "sent" || phase.kind === "unknown") {
    return (
      <View className="flex-1 bg-background px-4 pt-4">
        <Outcome
          phase={phase}
          onDismiss={() => {
            reset();
            setAmount("");
          }}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom + 12 }}>
      <AmountPad
        amount={amount}
        onChange={setAmount}
        token={token?.name ?? "—"}
        available={token?.available ?? null}
        // Rounded, like every other amount route on this screen. The raw
        // balance is `total - hold` at full wire precision, and 28 of the 72
        // sendable rows in the checked-in testnet fixture carry more than
        // `AMOUNT_DECIMALS` places — including USDC, the default selection.
        // Writing it verbatim passed every blocker and then threw at
        // `canonicalAmount`, on the final slide of an irreversible screen,
        // under a figure the screen itself had offered.
        onMax={token === null ? null : () => setAmount(amountForFraction(token.available, 1))}
        isDisabled={isBusy}
        captionTone={visibleStopper !== null ? "danger" : "muted"}
        caption={
          visibleStopper !== null
            ? visibleStopper.detail
            : phase.kind === "rejected"
              ? phase.message
              : "Instant, between Hyperliquid accounts."
        }
      >
        {/* Token first, destination second: the token decides what the hero
            figure means, so it reads before the amount does. */}
        <PressableFeedback
          onPress={() => setIsPicking(true)}
          isDisabled={isBusy || tokens.length === 0}
          className="flex-row items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3"
        >
          <Typography.Paragraph className="text-sm text-muted font-normal">
            Token
          </Typography.Paragraph>
          <View className="flex-row items-center gap-2">
            {token !== null ? <CoinBadge coin={token.name} /> : null}
            <Typography.Paragraph className="text-sm font-semibold">
              {token === null ? "Nothing to send" : token.name}
            </Typography.Paragraph>
            <Typography.Paragraph className="text-sm text-muted font-normal">
              ›
            </Typography.Paragraph>
          </View>
        </PressableFeedback>

        <DestinationRow
          value={destinationInput}
          onChange={setDestinationInput}
          isDisabled={isBusy}
          editorNote="A Hyperliquid account address. A send cannot be reversed."
        />
      </AmountPad>

      <View className="gap-3 px-4 pt-4">
        <Button
          isDisabled={plan.blockers.length > 0 || isBusy}
          onPress={() => setIsConfirming(true)}
        >
          <Button.Label className="font-medium">{isBusy ? "Signing…" : "Review send"}</Button.Label>
        </Button>
      </View>

      {/* ---------------------------------------------------- token picker */}
      <Dialog isOpen={isPicking} onOpenChange={setIsPicking}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gap-4 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            <View className="gap-1">
              <Dialog.Title className="font-semibold">What to send</Dialog.Title>
              <Dialog.Description className="font-normal">
                Only tokens this account holds are listed.
              </Dialog.Description>
            </View>
            <View className="gap-1">
              {tokens.map((t) => (
                <PressableFeedback
                  key={t.name}
                  onPress={() => {
                    setTokenName(t.name);
                    // A different token means a different balance; an amount
                    // carried across can silently overdraw the new one.
                    setAmount("");
                    setIsPicking(false);
                  }}
                  className={
                    t.name === token?.name
                      ? "flex-row items-center justify-between gap-3 rounded-xl bg-surface px-3 py-3"
                      : "flex-row items-center justify-between gap-3 rounded-xl px-3 py-3"
                  }
                >
                  <View className="flex-row items-center gap-3">
                    <CoinBadge coin={t.name} />
                    <Typography.Paragraph className="text-sm font-semibold">
                      {t.name}
                    </Typography.Paragraph>
                  </View>
                  <View className="items-end">
                    <Typography.Paragraph className="text-sm tabular-nums font-normal">
                      {t.available}
                    </Typography.Paragraph>
                    <Typography.Paragraph className="text-xs text-muted font-normal">
                      available
                    </Typography.Paragraph>
                  </View>
                </PressableFeedback>
              ))}
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* --------------------------------------------------------- confirm */}
      <Dialog isOpen={isConfirming} onOpenChange={setIsConfirming}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className="gap-4 bg-background">
            <Dialog.ContentBackground className="bg-surface" />
            <View className="gap-1">
              <Dialog.Title className="font-semibold">Confirm send</Dialog.Title>
              <Dialog.Description className="font-normal">
                A send cannot be reversed once signed.
              </Dialog.Description>
            </View>

            <View className="gap-3">
              <View className="flex-row items-start justify-between gap-3">
                <Typography.Paragraph className="text-xs text-muted font-normal">
                  To
                </Typography.Paragraph>
                <View className="flex-1 items-end">
                  {/* The full checksummed form, bold ends — the reading that
                      gates the signature, same renderer as everywhere else. */}
                  <AddressText
                    address={plan.destinationDisplay ?? ""}
                    className="text-sm tabular-nums text-right"
                  />
                </View>
              </View>
              {plan.isSelf ? (
                <Typography.Paragraph className="text-xs text-muted text-right font-normal">
                  This is your own address.
                </Typography.Paragraph>
              ) : (
                <Typography.Paragraph className="text-xs text-warning text-right font-normal">
                  Not your own address — sends are final.
                </Typography.Paragraph>
              )}
              <ConfirmRow label="Amount" emphasis>
                {`${amount} ${token?.name ?? ""}`}
              </ConfirmRow>
              {/* Measured, not assumed: sending to a NEVER-USED address costs a
                  1 USDC activation fee, debited from the sender's PERPS balance
                  while the full amount still arrives (live, 2026-08-14 — 0.5
                  sent, 0.5 arrived, perps -1.0). Until the destination probe
                  lands (sendPreflight), the honest fee row is conditional. */}
              <ConfirmRow label="Fee">
                None — unless the address is new to Hyperliquid, then 1 USDC
              </ConfirmRow>
              <ConfirmRow label="Arrives">Instantly, on Hyperliquid</ConfirmRow>
            </View>

            <SlideButton
              variant="danger"
              isDisabled={plan.blockers.length > 0 || isBusy || token === null}
              autoReset={false}
              onComplete={() => {
                if (token === null) return;
                void send({ tokenName: token.name, amount, destination: destinationInput }).then(
                  () => setIsConfirming(false)
                );
              }}
            >
              <SlideButton.ContainerBackground />
              <SlideButton.UnderlayContent>
                <SlideButton.Label className="font-medium">
                  {isBusy ? "Signing…" : "Slide to send"}
                </SlideButton.Label>
              </SlideButton.UnderlayContent>
              <SlideButton.OverlayContent>
                <SlideButton.Label className="font-medium">Release to send</SlideButton.Label>
              </SlideButton.OverlayContent>
              <SlideButton.Thumb>
                <SlideButton.ThumbBackground />
              </SlideButton.Thumb>
            </SlideButton>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </View>
  );
}

function ConfirmRow({
  label,
  emphasis,
  children,
}: {
  label: string;
  emphasis?: boolean;
  children: string;
}): JSX.Element {
  return (
    <View className="flex-row items-start justify-between gap-3">
      <Typography.Paragraph className="text-xs text-muted font-normal">
        {label}
      </Typography.Paragraph>
      <Typography.Paragraph
        className={
          emphasis
            ? "flex-1 text-right text-sm font-semibold tabular-nums"
            : "flex-1 text-right text-sm tabular-nums font-normal"
        }
      >
        {children}
      </Typography.Paragraph>
    </View>
  );
}

/**
 * `sent` is a fact; `unknown` is the absence of one, and offers no retry —
 * a send has no idempotency key, so re-sending is a second send.
 */
function Outcome({
  phase,
  onDismiss,
}: {
  phase:
    | { kind: "sent"; token: string; amount: string; destinationTail: string }
    | { kind: "unknown"; message: string };
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
              Check the transfer history before doing anything else. Do not send it again — a second
              attempt would move the money twice.
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
          Sent
        </Typography.Paragraph>
        <Chip size="sm" variant="soft" color="success">
          <Chip.Label className="font-medium">done</Chip.Label>
        </Chip>
      </View>
      <Typography.Paragraph className="text-sm font-normal">
        {phase.amount} {phase.token} went to …{phase.destinationTail}. It is already there — sends
        between Hyperliquid accounts are instant.
      </Typography.Paragraph>
      <Button variant="tertiary" onPress={onDismiss}>
        <Button.Label className="font-medium">Done</Button.Label>
      </Button>
    </Card>
  );
}
